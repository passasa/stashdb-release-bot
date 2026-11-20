// Bot Discord — suivi des nouvelles sorties StashDB.
//
// Annonce dans un ou plusieurs salons NSFW les nouvelles scènes publiées par
// les studios et interprètes mis en favori sur le compte StashDB. Une seule commande,
// /sorties, réservée aux gestionnaires du serveur.
// Logique : releases.js (règles pures) et tracker.js (base + tour).

const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
require('dotenv').config({ path: path.join(ROOT_DIR, '.env') });
const {
  Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder,
  PermissionFlagsBits, MessageFlags, ChannelType, Events, DiscordAPIError,
} = require('discord.js');
const Database = require('better-sqlite3');
const {
  todayIn, parsePollInterval, parseMaxAgeDays, buildReleaseEmbed,
  buildReleaseComponents, parseImageButton, imageFileName, safeImage,
  escapeMarkdown, truncate, formatDate, sceneUrl, DEFAULT_TIMEZONE,
} = require('./releases');
const { migrate, createStore, createDeliverer, runRound } = require('./tracker');

// ── Configuration ──────────────────────────────────────────────────────────
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const STASH_ENDPOINT = process.env.STASH_ENDPOINT || 'https://stashdb.org/graphql';
const STASH_API_KEY = process.env.STASH_API_KEY || '';
const POLL_MS = parsePollInterval(process.env.POLL_STASHDB_MS);
const MAX_AGE_DAYS = parseMaxAgeDays(process.env.RELEASES_MAX_AGE_DAYS);
const TIMEZONE = process.env.BOT_TIMEZONE || DEFAULT_TIMEZONE;
const SCENES_PER_FOLLOW = 25;
const FOLLOW_PERFORMERS = !/^(0|false|non|no)$/i.test(process.env.FOLLOW_PERFORMERS || '');
const MAX_PER_ROUND = 20;
const ALLOWED_GUILDS = (process.env.ALLOWED_GUILDS || '').split(',').map((s) => s.trim()).filter(Boolean);
// Répertoire de données : ./data par défaut, le volume /data en Docker.
const BOT_DATA_DIR = process.env.BOT_DATA_DIR
  ? path.resolve(process.env.BOT_DATA_DIR)
  : path.join(ROOT_DIR, 'data');
const BOT_DB_PATH = path.join(BOT_DATA_DIR, 'bot.db');

if (!DISCORD_TOKEN) { console.error('[ERREUR] DISCORD_TOKEN manquant'); process.exit(1); }
if (!CLIENT_ID) { console.error('[ERREUR] CLIENT_ID manquant'); process.exit(1); }
if (!STASH_API_KEY) { console.error('[ERREUR] STASH_API_KEY manquant : impossible de lire les favoris StashDB'); process.exit(1); }
try { new URL(STASH_ENDPOINT); } catch { console.error('[ERREUR] STASH_ENDPOINT invalide'); process.exit(1); }

// ── Base ───────────────────────────────────────────────────────────────────
// Le répertoire est créé AVANT l'ouverture : un volume Docker peut être vide,
// et better-sqlite3 ne crée pas les parents.
fs.mkdirSync(BOT_DATA_DIR, { recursive: true });
const db = new Database(BOT_DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');
migrate(db);
const store = createStore(db);

// ── StashDB ────────────────────────────────────────────────────────────────
async function stashGraphQL(query, variables = {}) {
  const payload = JSON.stringify({ query, variables });
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(STASH_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ApiKey: STASH_API_KEY },
        body: payload,
        signal: AbortSignal.timeout(20000),
      });
      const text = await res.text();
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
      const data = JSON.parse(text);
      if (data.errors?.length) throw new Error(`GraphQL : ${data.errors.map((e) => e.message).join('; ').slice(0, 200)}`);
      if (!data.data) throw new Error('réponse sans données');
      return data.data;
    } catch (err) {
      lastError = err;
      if (attempt < 2) await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
    }
  }
  throw new Error(`StashDB : ${lastError.message}`);
}

const SCENE_FIELDS = `
  id title release_date duration
  studio { id name }
  performers { performer { name } }
  images { url }
`;

/** Lit toutes les pages d'une liste de favoris. Lève en cas d'échec (jamais de liste vide « par défaut »). */
async function fetchFavoritePages(query, field, listField) {
  const all = [];
  for (let page = 1; page <= 20; page++) {
    const data = await stashGraphQL(query, { input: { is_favorite: true, per_page: 100, page } });
    const result = data[field];
    if (!result || !Array.isArray(result[listField])) throw new Error('favoris StashDB illisibles');
    all.push(...result[listField]);
    if (result[listField].length < 100 || all.length >= (result.count || 0)) break;
  }
  return all;
}

/** Studios (et interprètes, sauf FOLLOW_PERFORMERS=false) favoris du compte StashDB. */
async function fetchFollows() {
  const studios = await fetchFavoritePages(`query FavoriteStudios($input: StudioQueryInput!) {
    queryStudios(input: $input) { count studios { id name } }
  }`, 'queryStudios', 'studios');
  const performers = FOLLOW_PERFORMERS ? await fetchFavoritePages(`query FavoritePerformers($input: PerformerQueryInput!) {
    queryPerformers(input: $input) { count performers { id name } }
  }`, 'queryPerformers', 'performers') : [];
  return [
    ...studios.map((s) => ({ kind: 'studio', id: s.id, name: s.name })),
    ...performers.map((p) => ({ kind: 'performer', id: p.id, name: p.name })),
  ];
}

/** Dernières scènes d'un studio ou d'un interprète suivi. */
async function fetchScenes(follow) {
  const filter = follow.kind === 'performer' ? 'performers' : 'studios';
  const data = await stashGraphQL(`query FollowScenes($input: SceneQueryInput!) {
    queryScenes(input: $input) { scenes { ${SCENE_FIELDS} } }
  }`, {
    input: { [filter]: { value: [follow.id], modifier: 'INCLUDES' }, sort: 'DATE', direction: 'DESC', per_page: SCENES_PER_FOLLOW, page: 1 },
  });
  if (!Array.isArray(data.queryScenes?.scenes)) throw new Error('scènes illisibles');
  return data.queryScenes.scenes;
}

// ── Discord ────────────────────────────────────────────────────────────────
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
  allowedMentions: { parse: [] },
});

/**
 * Envoie une annonce dans un salon. Rend 'sent', 'failed' (refus certain :
 * réessayable) ou 'uncertain' (issue inconnue : jamais renvoyée, pas de doublon).
 */
async function sendToChannel(row, message) {
  let reason;
  let outcome = 'failed';
  try {
    const channel = await client.channels.fetch(row.channel_id).catch(() => null);
    if (!channel || !channel.isTextBased() || typeof channel.send !== 'function') {
      reason = 'salon introuvable ou inaccessible';
    } else if (!channel.nsfw) {
      reason = 'salon non NSFW';
    } else {
      await channel.send({ ...message, allowedMentions: { parse: [] } });
      store.channelOk(row.channel_id);
      return 'sent';
    }
  } catch (err) {
    reason = err.message;
    // Réponse d'erreur de Discord (statut HTTP) = message refusé. Sinon
    // (délai dépassé, coupure) il a pu partir : on ne le renverra pas.
    if (!(err instanceof DiscordAPIError) && typeof err?.status !== 'number') outcome = 'uncertain';
  }
  const disabled = store.channelFailed(row.channel_id, reason);
  console.log(`  ⚠ Salon ${row.channel_id} : ${reason}${disabled ? ' — désactivé après échecs répétés (le redéfinir avec /sorties salon)' : ''}`
    + (outcome === 'uncertain' ? ' — issue inconnue, la scène ne sera pas renvoyée dans ce salon' : ''));
  return outcome;
}

// Chaque identifiant de scène est enregistré par salon au moment de l'envoi :
// une scène n'est jamais postée deux fois dans le même salon.
const deliverOnce = createDeliverer({
  store,
  send: (row, scene, via) => sendToChannel(row, {
    embeds: [buildReleaseEmbed(scene, STASH_ENDPOINT, via)],
    components: buildReleaseComponents(scene),
  }),
});

// ── Bouton « Télécharger image » ───────────────────────────────────────────
const IMAGE_MAX_BYTES = 8 * 1024 * 1024;
const IMAGE_COOLDOWN_MS = 5000;
const imageCooldown = new Map(); // userId → horodatage du dernier clic

/** Télécharge l'image (https seulement, image/* seulement, 8 Mo au plus). */
async function downloadImage(url) {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (!/^https:/i.test(res.url || url)) throw new Error('redirection non sécurisée');
  const type = res.headers.get('content-type') || '';
  if (!/^image\//i.test(type)) throw new Error('le lien ne mène pas à une image');
  if (Number(res.headers.get('content-length')) > IMAGE_MAX_BYTES) throw new Error('image trop lourde');
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > IMAGE_MAX_BYTES) throw new Error('image trop lourde');
  return { buffer, type };
}

/** Réponse au clic (éphémère) : l'image de la scène en pièce jointe. */
async function handleImageButton(interaction, sceneId) {
  const last = imageCooldown.get(interaction.user.id) || 0;
  if (Date.now() - last < IMAGE_COOLDOWN_MS) {
    return interaction.reply(ephemeral('Doucement : un téléchargement toutes les 5 secondes.'));
  }
  if (imageCooldown.size > 1000) {
    for (const [id, t] of imageCooldown) if (Date.now() - t >= IMAGE_COOLDOWN_MS) imageCooldown.delete(id);
  }
  imageCooldown.set(interaction.user.id, Date.now());
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const data = await stashGraphQL(
    'query FindScene($id: ID!) { findScene(id: $id) { id title release_date studio { name } images { url } } }',
    { id: sceneId },
  ).catch(() => null);
  const scene = data?.findScene;
  if (!scene) return interaction.editReply({ content: 'Scène introuvable sur StashDB.' });
  const url = safeImage(scene);
  if (!url) return interaction.editReply({ content: 'Aucune image pour cette scène.' });

  try {
    const { buffer, type } = await downloadImage(url);
    const name = imageFileName(scene, type);
    return interaction.editReply({
      content: `**${escapeMarkdown(name)}**`,
      files: [{ attachment: buffer, name }],
      allowedMentions: { parse: [] },
    });
  } catch (err) {
    return interaction.editReply({ content: `Image indisponible : ${truncate(err.message, 200)}` });
  }
}

async function deliver(scene, via = []) {
  const result = await deliverOnce(scene, via);
  if (result.posted > 0) console.log(`  ✓ ${scene.studio?.name || '?'} — ${scene.title} (${result.posted} salon(s))`);
  if (result.skipped > 0) console.log(`  · ${scene.title} : déjà envoyée dans ${result.skipped} salon(s), pas de doublon`);
  return result;
}

// ── Tour de vérification ───────────────────────────────────────────────────
let running = null;
let nextRoundAt = null;
let timer = null;

function check() {
  if (running) return running;
  running = (async () => {
    const started = new Date();
    console.log(`[${started.toLocaleString('fr-FR', { timeZone: TIMEZONE })}] Vérification des sorties StashDB…`);
    try {
      const summary = await runRound({
        store, fetchFollows, fetchScenes, deliver,
        today: todayIn(TIMEZONE), maxAgeDays: MAX_AGE_DAYS, maxPerRound: MAX_PER_ROUND,
        pauseMs: 300, log: console.log,
      });
      store.kvSet('last_round_at', started.toISOString());
      store.kvSet('last_round_summary', JSON.stringify(summary));
      store.kvSet('last_round_error', '');
      console.log(`  → ${summary.studios} studio(s), ${summary.performers} interprète(s), ${summary.sent} annoncée(s), ${summary.seeded} amorcée(s)`
        + `${summary.waiting ? `, ${summary.waiting} en attente` : ''}${summary.deferred ? `, ${summary.deferred} reportée(s)` : ''}`);
      return summary;
    } catch (err) {
      // Favoris illisibles : rien n'est évalué ni consommé, reprise au tour suivant.
      store.kvSet('last_round_at', started.toISOString());
      store.kvSet('last_round_error', err.message);
      console.log(`  ⚠ Tour annulé : ${err.message} — reprise au tour suivant.`);
      throw err;
    } finally {
      running = null;
    }
  })();
  return running;
}

function schedule(delay) {
  clearTimeout(timer);
  nextRoundAt = Date.now() + delay;
  timer = setTimeout(async () => {
    await check().catch(() => {});
    schedule(POLL_MS);
  }, delay);
}

// ── Commande /sorties ──────────────────────────────────────────────────────
const command = new SlashCommandBuilder()
  .setName('sorties')
  .setDescription('Suivi des nouvelles sorties StashDB')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setDMPermission(false)
  .addSubcommand((s) => s.setName('salon').setDescription('Annoncer les nouvelles sorties dans ce salon (NSFW)')
    .addChannelOption((o) => o.setName('canal').setDescription('Salon NSFW').setRequired(true)
      .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)))
  .addSubcommand((s) => s.setName('retirer-salon').setDescription('Ne plus annoncer dans ce salon')
    .addChannelOption((o) => o.setName('canal').setDescription('Salon').setRequired(true)))
  .addSubcommand((s) => s.setName('suivis').setDescription('Studios et interprètes suivis (favoris StashDB)'))
  .addSubcommand((s) => s.setName('dernieres').setDescription('Dernières sorties annoncées'))
  .addSubcommand((s) => s.setName('etat').setDescription('État du suivi'))
  .addSubcommand((s) => s.setName('verifier').setDescription('Vérifier les sorties maintenant'));

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  // PUT remplace la liste entière des commandes globales de l'application.
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: [command.toJSON()] });
  console.log('  ✓ Commande /sorties enregistrée');
}

function isGuildAllowed(guildId) {
  return ALLOWED_GUILDS.length === 0 || ALLOWED_GUILDS.includes(guildId);
}

const ephemeral = (content) => ({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });

function describeSummary(s) {
  if (!s) return 'aucun tour terminé';
  const parts = [`${s.studios} studio(s) et ${s.performers ?? 0} interprète(s) vérifiés`, `${s.sent} sortie(s) annoncée(s)`];
  if (s.seeded) parts.push(`${s.seeded} amorcée(s) sans annonce`);
  if (s.failures) parts.push(`⚠ ${s.failures} suivi(s) en erreur`);
  if (s.noChannel) parts.push(`⚠ ${s.waiting} en attente d'un salon`);
  else if (s.waiting) parts.push(`⚠ ${s.waiting} à retenter`);
  if (s.deferred) parts.push(`${s.deferred} reportée(s) au tour suivant`);
  return parts.join(' · ');
}

const discordTime = (ms) => `<t:${Math.floor(ms / 1000)}:R>`;

async function handleSorties(interaction) {
  const sub = interaction.options.getSubcommand();

  if (sub === 'salon') {
    const channel = interaction.options.getChannel('canal', true);
    if (channel.guildId !== interaction.guildId) return interaction.reply(ephemeral('Ce salon n\'appartient pas à ce serveur.'));
    if (!channel.nsfw) return interaction.reply(ephemeral(`${channel} n'est pas marqué NSFW : les annonces contiennent des images adultes.`));
    const perms = channel.permissionsFor(interaction.client.user);
    const needed = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks];
    if (!perms || !perms.has(needed)) return interaction.reply(ephemeral(`Il me faut les permissions Voir le salon, Envoyer des messages et Intégrer des liens dans ${channel}.`));
    store.setChannel(channel.id, interaction.guildId);
    return interaction.reply(ephemeral(`✓ Les nouvelles sorties seront annoncées dans ${channel}.`));
  }

  if (sub === 'retirer-salon') {
    const channel = interaction.options.getChannel('canal', true);
    const removed = store.removeChannel(channel.id);
    return interaction.reply(ephemeral(removed ? `✓ ${channel} ne recevra plus les sorties.` : `${channel} n'était pas configuré.`));
  }

  if (sub === 'suivis') {
    const follows = store.activeFollows();
    if (follows.length === 0) {
      return interaction.reply(ephemeral("Rien n'est suivi. Mettez des studios ou des interprètes en favori sur votre compte StashDB, puis `/sorties verifier`."));
    }
    const section = (kind, title) => {
      const rows = follows.filter((f) => f.kind === kind);
      if (rows.length === 0) return null;
      const items = rows.map((f) => '• ' + escapeMarkdown(f.name) + (f.last_error ? ' ⚠' : ''));
      return '**' + title + ' (' + rows.length + ')**\n' + items.join('\n');
    };
    let text = [section('studio', 'Studios'), section('performer', 'Interprètes')].filter(Boolean).join('\n\n');
    if (follows.some((f) => f.last_error)) text += '\n\n⚠ = erreur au dernier tour, repris au suivant';
    if (!FOLLOW_PERFORMERS) text += '\n\nSuivi des interprètes désactivé (FOLLOW_PERFORMERS=false).';
    return interaction.reply(ephemeral(truncate(text, 2000)));
  }

  if (sub === 'dernieres') {
    const rows = store.latestSent(10);
    if (rows.length === 0) return interaction.reply(ephemeral('Aucune sortie annoncée pour l\'instant.'));
    const lines = rows.map((r) => {
      const url = sceneUrl(STASH_ENDPOINT, r.scene_id);
      const title = truncate(escapeMarkdown(r.title), 80);
      const date = formatDate(r.release_date);
      return `• ${url ? `[${title}](<${url}>)` : title} — ${escapeMarkdown(r.studio_name || '?')}${date ? ` (${date})` : ''}`;
    });
    return interaction.reply(ephemeral(truncate(lines.join('\n'), 2000)));
  }

  if (sub === 'etat') {
    const channels = store.channels().filter((c) => c.guild_id === interaction.guildId);
    const lastAt = store.kvGet('last_round_at');
    const lastError = store.kvGet('last_round_error');
    let summary = null;
    try { summary = JSON.parse(store.kvGet('last_round_summary') || 'null'); } catch { /* ignoré */ }
    const counts = store.counts();
    const lines = [
      `**Salons** : ${channels.length ? channels.map((c) => `<#${c.channel_id}>${c.disabled ? ' (désactivé)' : c.error_count ? ` (⚠ ${c.error_count} échec(s))` : ''}`).join(', ') : 'aucun — `/sorties salon`'}`,
      `**Suivis** : ${store.activeFollows('studio').length} studio(s), ${store.activeFollows('performer').length} interprète(s)${FOLLOW_PERFORMERS ? '' : ' (interprètes désactivés)'}`,
      `**Sorties annoncées** : ${counts.sent || 0}`,
      `**Dernier tour** : ${lastAt ? discordTime(Date.parse(lastAt)) : 'jamais'}${running ? ' (en cours)' : ''}`,
      lastError ? `⚠ ${truncate(lastError, 300)}` : describeSummary(summary),
      `**Prochain tour** : ${nextRoundAt ? discordTime(nextRoundAt) : '—'} (toutes les ${Math.round(POLL_MS / 60000)} min, sorties de moins de ${MAX_AGE_DAYS} jours)`,
    ];
    return interaction.reply(ephemeral(lines.join('\n')));
  }

  if (sub === 'verifier') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const summary = await check();
      schedule(POLL_MS);
      return interaction.editReply({ content: `✓ Vérification terminée : ${describeSummary(summary)}.`, allowedMentions: { parse: [] } });
    } catch (err) {
      return interaction.editReply({ content: `⚠ Vérification impossible : ${truncate(err.message, 300)}`, allowedMentions: { parse: [] } });
    }
  }

  return interaction.reply(ephemeral('Sous-commande inconnue.'));
}

client.on(Events.InteractionCreate, async (interaction) => {
  // Bouton « Télécharger image » des annonces : ouvert à tout membre du serveur.
  if (interaction.isButton()) {
    const sceneId = parseImageButton(interaction.customId);
    if (!sceneId) return;
    try {
      if (!interaction.inGuild() || !isGuildAllowed(interaction.guildId)) {
        return await interaction.reply(ephemeral('Indisponible ici.'));
      }
      await handleImageButton(interaction, sceneId);
    } catch (err) {
      console.error('[Bouton image]', err);
      const msg = ephemeral('Une erreur est survenue.');
      if (interaction.deferred || interaction.replied) await interaction.editReply(msg).catch(() => {});
      else await interaction.reply(msg).catch(() => {});
    }
    return;
  }
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'sorties') return;
  try {
    // Contrôles à l'exécution, en plus de la permission déclarée.
    if (!interaction.inGuild() || !isGuildAllowed(interaction.guildId)) {
      return await interaction.reply(ephemeral('Commande indisponible ici.'));
    }
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      return await interaction.reply(ephemeral('Réservé aux gestionnaires du serveur.'));
    }
    await handleSorties(interaction);
  } catch (err) {
    console.error('[Commande]', err);
    const msg = ephemeral('Une erreur est survenue.');
    if (interaction.deferred || interaction.replied) await interaction.editReply(msg).catch(() => {});
    else await interaction.reply(msg).catch(() => {});
  }
});

client.on(Events.GuildCreate, (guild) => {
  if (!isGuildAllowed(guild.id)) {
    console.log(`[Serveur] ${guild.id} non autorisé, départ.`);
    guild.leave().catch(() => {});
  }
});

client.once(Events.ClientReady, async () => {
  console.log(`✓ Connecté à Discord : ${client.user.tag}`);
  for (const guild of client.guilds.cache.values()) {
    if (!isGuildAllowed(guild.id)) await guild.leave().catch(() => {});
  }
  try { await registerCommands(); } catch (err) { console.error('  ⚠ Enregistrement de /sorties impossible :', err.message); }
  console.log(`  Vérification toutes les ${Math.round(POLL_MS / 60000)} min, sorties de moins de ${MAX_AGE_DAYS} jours.`);
  schedule(15000);
});

// ── Arrêt propre ───────────────────────────────────────────────────────────
let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`\n[${signal}] Arrêt…`);
  clearTimeout(timer);
  try { await Promise.race([running, new Promise((r) => setTimeout(r, 10000))]); } catch { /* ignoré */ }
  try { db.close(); } catch { /* ignoré */ }
  try { await client.destroy(); } catch { /* ignoré */ }
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => console.error('[Rejet non géré]', err));

console.log('Démarrage du bot (suivi des sorties StashDB)…');
client.login(DISCORD_TOKEN).catch((err) => {
  console.error('[ERREUR] Connexion Discord impossible :', err.message);
  process.exit(1);
});
