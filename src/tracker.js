// Stockage (bot.db) et tour de vérification du suivi des sorties.
// La base et les appels StashDB/Discord sont injectés : le module est testé
// sans réseau ni Discord (test/tracker.test.js).

const { selectNewReleases, sortChronologically } = require('./releases');

const MAX_CHANNEL_ERRORS = 5;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS release_channels (
    channel_id TEXT PRIMARY KEY,
    guild_id TEXT,
    error_count INTEGER NOT NULL DEFAULT 0,
    disabled INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS followed_studios (
    studio_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    seeded INTEGER NOT NULL DEFAULT 0,
    last_checked_at TEXT,
    last_error TEXT
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
  CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`;

/** Crée le schéma s'il n'existe pas (idempotent). */
function migrate(db) {
  db.exec(SCHEMA);
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
    studioGet: db.prepare('SELECT * FROM followed_studios WHERE studio_id = ?'),
    studioUpsert: db.prepare(`
      INSERT INTO followed_studios (studio_id, name, active, seeded) VALUES (?, ?, 1, 0)
      ON CONFLICT(studio_id) DO UPDATE SET name = excluded.name, active = 1
    `),
    studioDeactivate: db.prepare('UPDATE followed_studios SET active = 0, seeded = 0 WHERE studio_id = ?'),
    studioSeeded: db.prepare('UPDATE followed_studios SET seeded = 1 WHERE studio_id = ?'),
    studioChecked: db.prepare("UPDATE followed_studios SET last_checked_at = datetime('now'), last_error = ? WHERE studio_id = ?"),
    studiosActive: db.prepare('SELECT * FROM followed_studios WHERE active = 1 ORDER BY name COLLATE NOCASE'),
    knownIds: db.prepare('SELECT scene_id FROM releases'),
    record: db.prepare(`
      INSERT OR IGNORE INTO releases (scene_id, studio_id, studio_name, title, release_date, state)
      VALUES (?, ?, ?, ?, ?, ?)
    `),
    latestSent: db.prepare("SELECT * FROM releases WHERE state = 'sent' AND title IS NOT NULL ORDER BY recorded_at DESC, rowid DESC LIMIT ?"),
    countByState: db.prepare('SELECT state, COUNT(*) AS n FROM releases GROUP BY state'),
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
     * Aligne la liste suivie sur les favoris StashDB. Un studio nouveau (ou
     * retiré puis remis en favori) repart non « amorcé ».
     */
    syncStudios: db.transaction((studios) => {
      const present = new Set(studios.map((s) => s.id));
      for (const row of q.studiosActive.all()) {
        if (!present.has(row.studio_id)) q.studioDeactivate.run(row.studio_id);
      }
      for (const s of studios) q.studioUpsert.run(s.id, s.name || s.id);
    }),
    isSeeded: (studioId) => !!q.studioGet.get(studioId)?.seeded,
    markSeeded: (studioId) => q.studioSeeded.run(studioId),
    markChecked: (studioId, error = null) => q.studioChecked.run(error ? String(error).slice(0, 300) : null, studioId),
    activeStudios: () => q.studiosActive.all(),

    knownIds: () => new Set(q.knownIds.all().map((r) => r.scene_id)),
    recordSeeded: db.transaction((scenes) => { for (const s of scenes) record(s, 'seeded'); }),
    recordSent: (scene) => record(scene, 'sent'),
    latestSent: (limit = 10) => q.latestSent.all(limit),
    counts: () => Object.fromEntries(q.countByState.all().map((r) => [r.state, r.n])),
  };
}

/**
 * Un tour de vérification.
 *
 * Règles :
 *  - Les favoris illisibles ⇒ le tour entier lève : on ne lit JAMAIS un
 *    échec comme « aucun studio suivi ».
 *  - Un studio en erreur est sauté pour ce tour : aucune de ses scènes n'est
 *    évaluée ni consommée, il est repris au tour suivant.
 *  - Une scène n'est enregistrée « annoncée » que si elle est réellement
 *    partie dans au moins un salon. Sinon elle sera retentée.
 *  - Premier passage d'un studio (nouveau favori) : ses sorties récentes sont
 *    amorcées en silence, pour ne pas inonder le salon de l'historique.
 */
async function runRound({
  store, fetchFavoriteStudios, fetchStudioScenes, deliver,
  today, maxAgeDays, maxPerRound = 20, pauseMs = 0, log = () => {},
}) {
  const studios = await fetchFavoriteStudios();
  if (!Array.isArray(studios)) throw new Error('liste des favoris StashDB illisible');
  store.syncStudios(studios);

  const summary = { studios: studios.length, failures: 0, seeded: 0, sent: 0, waiting: 0, deferred: 0, noChannel: false };
  const known = store.knownIds();
  const pending = [];

  for (const studio of studios) {
    try {
      const scenes = await fetchStudioScenes(studio);
      const fresh = selectNewReleases(scenes, known, today, maxAgeDays);
      for (const s of fresh) known.add(s.id);
      if (!store.isSeeded(studio.id)) {
        store.recordSeeded(fresh);
        store.markSeeded(studio.id);
        summary.seeded += fresh.length;
        if (fresh.length) log(`  "${studio.name}" : nouveau studio suivi, ${fresh.length} sortie(s) récente(s) amorcée(s) sans annonce`);
      } else {
        pending.push(...fresh);
      }
      store.markChecked(studio.id, null);
    } catch (err) {
      summary.failures++;
      store.markChecked(studio.id, err.message);
      log(`  ⚠ Studio "${studio.name}" non vérifié : ${err.message}`);
    }
    if (pauseMs) await new Promise((r) => setTimeout(r, pauseMs));
  }
  if (summary.failures > 0) {
    log(`  ⚠ ${summary.failures}/${studios.length} studio(s) non vérifié(s) : repris au tour suivant.`);
  }

  const queue = sortChronologically(pending);
  const batch = queue.slice(0, maxPerRound);
  summary.deferred = queue.length - batch.length;

  for (let i = 0; i < batch.length; i++) {
    const scene = batch[i];
    const { channels, sent } = await deliver(scene);
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

module.exports = { MAX_CHANNEL_ERRORS, migrate, createStore, runRound };
