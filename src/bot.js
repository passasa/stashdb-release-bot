// Bot Discord — suivi des nouvelles sorties StashDB.
//
// Annonce dans un ou plusieurs salons NSFW les nouvelles scènes publiées par
// les studios mis en favori sur le compte StashDB. Une seule commande,
// /sorties, réservée aux gestionnaires du serveur.
// Logique : releases.js (règles pures) et tracker.js (base + tour).

const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
require('dotenv').config({ path: path.join(ROOT_DIR, '.env') });
const {
  Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder,
  PermissionFlagsBits, MessageFlags, ChannelType, Events,
} = require('discord.js');
const Database = require('better-sqlite3');
const {
  todayIn, parsePollInterval, parseMaxAgeDays, buildReleaseEmbed,
  escapeMarkdown, truncate, formatDate, sceneUrl, DEFAULT_TIMEZONE,
} = require('./releases');
const { migrate, createStore, runRound } = require('./tracker');

// ── Configuration ──────────────────────────────────────────────────────────
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const STASH_ENDPOINT = process.env.STASH_ENDPOINT || 'https://stashdb.org/graphql';
const STASH_API_KEY = process.env.STASH_API_KEY || '';
const POLL_MS = parsePollInterval(process.env.POLL_STASHDB_MS);
const MAX_AGE_DAYS = parseMaxAgeDays(process.env.RELEASES_MAX_AGE_DAYS);
const TIMEZONE = process.env.BOT_TIMEZONE || DEFAULT_TIMEZONE;
const SCENES_PER_STUDIO = 25;
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

/** Studios favoris du compte StashDB. Lève en cas d'échec (jamais de liste vide « par défaut »). */
async function fetchFavoriteStudios() {
  const query = `query FavoriteStudios($input: StudioQueryInput!) {
    queryStudios(input: $input) { count studios { id name } }
  }`;
  const all = [];
  for (let page = 1; page <= 20; page++) {
    const data = await stashGraphQL(query, { input: { is_favorite: true, per_page: 100, page } });
    const result = data.queryStudios;
    if (!result || !Array.isArray(result.studios)) throw new Error('favoris StashDB illisibles');
    all.push(...result.studios);
    if (result.studios.length < 100 || all.length >= (result.count || 0)) break;
  }
  return all;
}

async function fetchStudioScenes(studio) {
  const query = `query StudioScenes($input: SceneQueryInput!) {
    queryScenes(input: $input) {
      scenes {
        id title release_date duration
        studio { id name }
        performers { performer { name } }
        images { url }
      }
    }
  }`;
  const data = await stashGraphQL(query, {
    input: { studios: { value: [studio.id], modifier: 'INCLUDES' }, sort: 'DATE', direction: 'DESC', per_page: SCENES_PER_STUDIO, page: 1 },
  });
  if (!Array.isArray(data.queryScenes?.scenes)) throw new Error('scènes illisibles');
  return data.queryScenes.scenes;
}

// ── Discord ────────────────────────────────────────────────────────────────
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
  allowedMentions: { parse: [] },
});

/** Envoie une annonce dans un salon. Rend true seulement si le message est parti. */
async function sendToChannel(row, embed) {
  let reason;
  try {
    const channel = await client.channels.fetch(row.channel_id).catch(() => null);
    if (!channel || !channel.isTextBased() || typeof channel.send !== 'function') {
      reason = 'salon introuvable ou inaccessible';
    } else if (!channel.nsfw) {
      reason = 'salon non NSFW';
    } else {
      await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
      store.channelOk(row.channel_id);
      return true;
    }
  } catch (err) {
    reason = err.message;
  }
  const disabled = store.channelFailed(row.channel_id, reason);
  console.log(`  ⚠ Salon ${row.channel_id} : ${reason}${disabled ? ' — désactivé après échecs répétés (le redéfinir avec /sorties salon)' : ''}`);
  return false;
}

async function deliver(scene) {
  const channels = store.activeChannels();
  if (channels.length === 0) return { channels: 0, sent: 0 };
  const embed = buildReleaseEmbed(scene, STASH_ENDPOINT);
  let sent = 0;
  for (const row of channels) {
    if (await sendToChannel(row, embed)) sent++;
  }
  if (sent > 0) console.log(`  ✓ ${scene.studio?.name || '?'} — ${scene.title} (${sent} salon(s))`);
  return { channels: channels.length, sent };
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
        store, fetchFavoriteStudios, fetchStudioScenes, deliver,
        today: todayIn(TIMEZONE), maxAgeDays: MAX_AGE_DAYS, maxPerRound: MAX_PER_ROUND,
        pauseMs: 300, log: console.log,
      });
      store.kvSet('last_round_at', started.toISOString());
      store.kvSet('last_round_summary', JSON.stringify(summary));
      store.kvSet('last_round_error', '');
      console.log(`  → ${summary.studios} studio(s), ${summary.sent} annoncée(s), ${summary.seeded} amorcée(s)`
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
  .addSubcommand((s) => s.setName('studios').setDescription('Studios suivis (favoris StashDB)'))
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
  const parts = [`${s.studios} studio(s) vérifié(s)`, `${s.sent} sortie(s) annoncée(s)`];
  if (s.seeded) parts.push(`${s.seeded} amorcée(s) sans annonce`);
  if (s.failures) parts.push(`⚠ ${s.failures} studio(s) en erreur`);
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

  if (sub === 'studios') {
    const studios = store.activeStudios();
    if (studios.length === 0) return interaction.reply(ephemeral('Aucun studio suivi. Ajoutez des studios en favori sur votre compte StashDB, puis `/sorties verifier`.'));
    const lines = studios.map((s) => `• ${escapeMarkdown(s.name)}${s.last_error ? ' ⚠' : ''}`);
    let text = `**${studios.length} studio(s) suivi(s)** (favoris StashDB)\n${lines.join('\n')}`;
    if (studios.some((s) => s.last_error)) text += '\n\n⚠ = erreur au dernier tour, repris au suivant';
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
      `**Studios suivis** : ${store.activeStudios().length}`,
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
