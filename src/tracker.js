// Stockage (bot.db) et tour de vérification du suivi des sorties.
// La base et les appels StashDB/Discord sont injectés : le module est testé
// sans réseau ni Discord (test/releases.test.js).

const { selectNewReleases, sortChronologically } = require('./releases');

const MAX_CHANNEL_ERRORS = 5;
const FOLLOW_KINDS = ['studio', 'performer'];

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS release_channels (
    channel_id TEXT PRIMARY KEY,
    guild_id TEXT,
    error_count INTEGER NOT NULL DEFAULT 0,
    disabled INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  -- Studios et interprètes suivis (favoris StashDB).
  CREATE TABLE IF NOT EXISTS follows (
    kind TEXT NOT NULL CHECK (kind IN ('studio', 'performer')),
    entity_id TEXT NOT NULL,
    name TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    seeded INTEGER NOT NULL DEFAULT 0,
    last_checked_at TEXT,
    last_error TEXT,
    PRIMARY KEY (kind, entity_id)
  );
  CREATE TABLE IF NOT EXISTS releases (
    scene_id TEXT PRIMARY KEY,
    studio_id TEXT,
    studio_name TEXT,
    title TEXT,
    release_date TEXT,
    state TEXT NOT NULL CHECK (state IN ('seeded', 'sent')),
    recorded_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_releases_state ON releases(state, recorded_at);
  -- Journal des envois : un identifiant de scène n'est posté qu'une fois par
  -- salon. La ligne est écrite AVANT l'envoi ('sending'), confirmée après
  -- ('sent') et supprimée seulement si Discord a refusé le message.
  CREATE TABLE IF NOT EXISTS deliveries (
    scene_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('sending', 'sent')),
    claimed_at TEXT DEFAULT (datetime('now')),
    sent_at TEXT,
    PRIMARY KEY (scene_id, channel_id)
  );
  CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`;

/**
 * Crée le schéma (idempotent). Une base de la version 1.0 (table
 * `followed_studios`) est reprise telle quelle : studios déjà amorcés compris,
 * donc aucune sortie n'est réannoncée ni perdue.
 */
function migrate(db) {
  db.exec(SCHEMA);
  const legacy = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'followed_studios'").get();
  if (!legacy) return { migrated: false };
  const copied = db.transaction(() => {
    const n = db.prepare(`
      INSERT OR IGNORE INTO follows (kind, entity_id, name, active, seeded, last_checked_at, last_error)
      SELECT 'studio', studio_id, name, active, seeded, last_checked_at, last_error FROM followed_studios
    `).run().changes;
    db.exec('DROP TABLE followed_studios');
    return n;
  })();
  return { migrated: true, studios: copied };
}

function createStore(db) {
  const q = {
    kvGet: db.prepare('SELECT value FROM kv WHERE key = ?'),
    kvSet: db.prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)'),
    channelUpsert: db.prepare(`
      INSERT INTO release_channels (channel_id, guild_id) VALUES (?, ?)
      ON CONFLICT(channel_id) DO UPDATE SET guild_id = excluded.guild_id, error_count = 0, disabled = 0, last_error = NULL
    `),
    channelDelete: db.prepare('DELETE FROM release_channels WHERE channel_id = ?'),
    channels: db.prepare('SELECT * FROM release_channels ORDER BY created_at'),
    activeChannels: db.prepare('SELECT * FROM release_channels WHERE disabled = 0 ORDER BY created_at'),
    channelOk: db.prepare('UPDATE release_channels SET error_count = 0, last_error = NULL WHERE channel_id = ?'),
    channelFailed: db.prepare(`
      UPDATE release_channels
      SET error_count = error_count + 1, last_error = ?,
          disabled = CASE WHEN error_count + 1 >= ${MAX_CHANNEL_ERRORS} THEN 1 ELSE disabled END
      WHERE channel_id = ?
    `),
    channelGet: db.prepare('SELECT * FROM release_channels WHERE channel_id = ?'),
    followGet: db.prepare('SELECT * FROM follows WHERE kind = ? AND entity_id = ?'),
    followUpsert: db.prepare(`
      INSERT INTO follows (kind, entity_id, name, active, seeded) VALUES (?, ?, ?, 1, 0)
      ON CONFLICT(kind, entity_id) DO UPDATE SET name = excluded.name, active = 1
    `),
    followDeactivate: db.prepare('UPDATE follows SET active = 0, seeded = 0 WHERE kind = ? AND entity_id = ?'),
    followSeeded: db.prepare('UPDATE follows SET seeded = 1 WHERE kind = ? AND entity_id = ?'),
    followChecked: db.prepare("UPDATE follows SET last_checked_at = datetime('now'), last_error = ? WHERE kind = ? AND entity_id = ?"),
    followsActive: db.prepare('SELECT * FROM follows WHERE active = 1 ORDER BY kind DESC, name COLLATE NOCASE'),
    knownIds: db.prepare('SELECT scene_id FROM releases'),
    record: db.prepare(`
      INSERT OR IGNORE INTO releases (scene_id, studio_id, studio_name, title, release_date, state)
      VALUES (?, ?, ?, ?, ?, ?)
    `),
    latestSent: db.prepare("SELECT * FROM releases WHERE state = 'sent' AND title IS NOT NULL ORDER BY recorded_at DESC, rowid DESC LIMIT ?"),
    countByState: db.prepare('SELECT state, COUNT(*) AS n FROM releases GROUP BY state'),
    claim: db.prepare("INSERT OR IGNORE INTO deliveries (scene_id, channel_id, state) VALUES (?, ?, 'sending')"),
    confirm: db.prepare("UPDATE deliveries SET state = 'sent', sent_at = datetime('now') WHERE scene_id = ? AND channel_id = ?"),
    release: db.prepare("DELETE FROM deliveries WHERE scene_id = ? AND channel_id = ? AND state = 'sending'"),
    deliveriesOf: db.prepare('SELECT channel_id, state FROM deliveries WHERE scene_id = ?'),
  };

  const record = (scene, state) => q.record.run(
    scene.id, scene.studio?.id ?? null, scene.studio?.name ?? null,
    scene.title ?? null, scene.release_date ?? null, state,
  );

  return {
    kvGet: (key) => q.kvGet.get(key)?.value ?? null,
    kvSet: (key, value) => q.kvSet.run(key, String(value)),

    setChannel: (channelId, guildId) => q.channelUpsert.run(channelId, guildId),
    removeChannel: (channelId) => q.channelDelete.run(channelId).changes > 0,
    channels: () => q.channels.all(),
    activeChannels: () => q.activeChannels.all(),
    channelOk: (channelId) => q.channelOk.run(channelId),
    /** Rend true si le salon vient d'être désactivé. */
    channelFailed: (channelId, reason) => {
      const before = q.channelGet.get(channelId);
      q.channelFailed.run(String(reason).slice(0, 300), channelId);
      const after = q.channelGet.get(channelId);
      return !!(before && after && !before.disabled && after.disabled);
    },

    /**
     * Aligne la liste suivie sur les favoris StashDB ({ kind, id, name }).
     * Un suivi nouveau (ou retiré puis remis en favori) repart non « amorcé ».
     */
    syncFollows: db.transaction((follows) => {
      const present = new Set(follows.map((f) => `${f.kind}:${f.id}`));
      for (const row of q.followsActive.all()) {
        if (!present.has(`${row.kind}:${row.entity_id}`)) q.followDeactivate.run(row.kind, row.entity_id);
      }
      for (const f of follows) q.followUpsert.run(f.kind, f.id, f.name || f.id);
    }),
    isSeeded: (f) => !!q.followGet.get(f.kind, f.id)?.seeded,
    markSeeded: (f) => q.followSeeded.run(f.kind, f.id),
    markChecked: (f, error = null) => q.followChecked.run(error ? String(error).slice(0, 300) : null, f.kind, f.id),
    activeFollows: (kind = null) => q.followsActive.all().filter((r) => !kind || r.kind === kind),

    knownIds: () => new Set(q.knownIds.all().map((r) => r.scene_id)),
    recordSeeded: db.transaction((scenes) => { for (const s of scenes) record(s, 'seeded'); }),
    recordSent: (scene) => record(scene, 'sent'),
    latestSent: (limit = 10) => q.latestSent.all(limit),
    counts: () => Object.fromEntries(q.countByState.all().map((r) => [r.state, r.n])),

    /** Réserve l'envoi d'une scène dans un salon. false = déjà envoyée (ou en cours) : ne pas renvoyer. */
    claimDelivery: (sceneId, channelId) => q.claim.run(sceneId, channelId).changes > 0,
    confirmDelivery: (sceneId, channelId) => q.confirm.run(sceneId, channelId),
    releaseDelivery: (sceneId, channelId) => q.release.run(sceneId, channelId),
    deliveriesOf: (sceneId) => q.deliveriesOf.all(sceneId),
  };
}

/**
 * Fabrique la fonction d'envoi utilisée par runRound : chaque identifiant de
 * scène est enregistré par salon AVANT l'envoi, pour qu'aucune scène ne soit
 * jamais postée deux fois dans le même salon (nouveau tour, redémarrage,
 * plantage entre l'envoi et l'enregistrement, scène trouvée par plusieurs
 * suivis…).
 *
 * send(row, scene, via) rend :
 *  - 'sent'      : message posté → envoi confirmé ;
 *  - 'failed'    : Discord a refusé (ou salon invalide) → réservation libérée,
 *                  la scène pourra être retentée ;
 *  - 'uncertain' : issue inconnue (coupure réseau…) → réservation gardée :
 *                  dans le doute, on ne renvoie pas (pas de doublon).
 */
function createDeliverer({ store, send }) {
  return async function deliver(scene, via = []) {
    const channels = store.activeChannels();
    if (channels.length === 0) return { channels: 0, sent: 0, posted: 0, skipped: 0 };
    let posted = 0;
    let skipped = 0;
    for (const row of channels) {
      if (!store.claimDelivery(scene.id, row.channel_id)) { skipped++; continue; }
      let outcome;
      try {
        outcome = await send(row, scene, via);
      } catch {
        outcome = 'uncertain';
      }
      if (outcome === 'sent' || outcome === true) {
        store.confirmDelivery(scene.id, row.channel_id);
        posted++;
      } else if (outcome === 'uncertain') {
        skipped++;
      } else {
        store.releaseDelivery(scene.id, row.channel_id);
      }
    }
    // « sent » : salons où la scène est (ou est présumée) publiée.
    return { channels: channels.length, sent: posted + skipped, posted, skipped };
  };
}

const kindLabel = (kind) => (kind === 'performer' ? 'Interprète' : 'Studio');

/**
 * Un tour de vérification.
 *
 * Règles :
 *  - Les favoris illisibles ⇒ le tour entier lève : on ne lit JAMAIS un
 *    échec comme « plus rien n'est suivi ».
 *  - Un suivi en erreur est sauté pour ce tour : aucune de ses scènes n'est
 *    évaluée ni consommée, il est repris au tour suivant.
 *  - Une scène n'est enregistrée « annoncée » que si elle est réellement
 *    partie dans au moins un salon. Sinon elle sera retentée.
 *  - Premier passage d'un suivi (nouveau favori) : ses sorties récentes sont
 *    amorcées en silence, pour ne pas inonder le salon de l'historique.
 *    Les suivis déjà amorcés passent EN PREMIER : une sortie d'un studio
 *    suivi n'est jamais avalée par l'amorçage d'un interprète ajouté le même
 *    jour (et inversement).
 *  - Une scène trouvée par plusieurs suivis n'est annoncée qu'une fois, avec
 *    tous ses motifs (« via »).
 *  - Avec createDeliverer, l'identifiant de chaque scène est enregistré par
 *    salon dès l'envoi : jamais deux fois la même scène dans un salon.
 */
async function runRound({
  store, fetchFollows, fetchScenes, deliver,
  today, maxAgeDays, maxPerRound = 20, pauseMs = 0, log = () => {},
}) {
  const follows = await fetchFollows();
  if (!Array.isArray(follows) || follows.some((f) => !FOLLOW_KINDS.includes(f?.kind) || !f.id)) {
    throw new Error('liste des favoris StashDB illisible');
  }
  store.syncFollows(follows);

  const summary = {
    studios: follows.filter((f) => f.kind === 'studio').length,
    performers: follows.filter((f) => f.kind === 'performer').length,
    failures: 0, seeded: 0, sent: 0, waiting: 0, deferred: 0, noChannel: false,
  };
  const known = store.knownIds();
  const pending = new Map(); // scene_id → { scene, via: [libellés] }

  // Suivis amorcés d'abord, nouveaux ensuite (voir règles).
  const ordered = [...follows].sort((a, b) => Number(!store.isSeeded(a)) - Number(!store.isSeeded(b)));

  for (const follow of ordered) {
    const label = `${kindLabel(follow.kind)} « ${follow.name} »`;
    try {
      const scenes = await fetchScenes(follow);
      const seeded = store.isSeeded(follow);
      if (seeded) {
        for (const s of scenes || []) {
          const p = pending.get(s?.id);
          if (p && !p.via.includes(follow.name)) p.via.push(follow.name);
        }
      }
      const fresh = selectNewReleases(scenes, known, today, maxAgeDays);
      for (const s of fresh) known.add(s.id);
      if (!seeded) {
        store.recordSeeded(fresh);
        store.markSeeded(follow);
        summary.seeded += fresh.length;
        if (fresh.length) log(`  ${label} : nouveau suivi, ${fresh.length} sortie(s) récente(s) amorcée(s) sans annonce`);
      } else {
        for (const s of fresh) pending.set(s.id, { scene: s, via: [follow.name] });
      }
      store.markChecked(follow, null);
    } catch (err) {
      summary.failures++;
      store.markChecked(follow, err.message);
      log(`  ⚠ ${label} non vérifié : ${err.message}`);
    }
    if (pauseMs) await new Promise((r) => setTimeout(r, pauseMs));
  }
  if (summary.failures > 0) {
    log(`  ⚠ ${summary.failures}/${follows.length} suivi(s) non vérifié(s) : repris au tour suivant.`);
  }

  const queue = sortChronologically([...pending.values()].map((p) => p.scene));
  const batch = queue.slice(0, maxPerRound);
  summary.deferred = queue.length - batch.length;

  for (let i = 0; i < batch.length; i++) {
    const scene = batch[i];
    const { channels, sent } = await deliver(scene, pending.get(scene.id).via);
    if (channels === 0) {
      summary.noChannel = true;
      summary.waiting = batch.length - i;
      log(`  En attente d'un canal : ${summary.waiting} sortie(s) non annoncée(s), conservées pour le prochain tour.`);
      break;
    }
    if (sent === 0) {
      summary.waiting = batch.length - i;
      log(`  ⚠ Envoi impossible dans tous les salons : « ${scene.title} » et ${summary.waiting - 1} autre(s) sera retentée au prochain tour.`);
      break;
    }
    store.recordSent(scene);
    summary.sent++;
  }
  return summary;
}

module.exports = { MAX_CHANNEL_ERRORS, FOLLOW_KINDS, migrate, createStore, createDeliverer, runRound };
