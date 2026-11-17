// Règles pures du suivi des sorties StashDB : aucune E/S, aucun état.
// Testées par test/releases.test.js.

const DEFAULT_TIMEZONE = 'Europe/Paris';
const DEFAULT_MAX_AGE_DAYS = 30;
const MIN_POLL_MS = 5 * 60 * 1000;
const DEFAULT_POLL_MS = 60 * 60 * 1000;
const EMBED_COLOR = 0xe11d48;

/** Date du jour (AAAA-MM-JJ) dans le fuseau donné. */
function todayIn(timeZone = DEFAULT_TIMEZONE, now = new Date()) {
  // en-CA formate en AAAA-MM-JJ.
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** Décale une date AAAA-MM-JJ de `days` jours (calcul en UTC, sans fuseau). */
function shiftDate(isoDate, days) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Une scène est une « sortie » annonçable si elle est déjà sortie (date ≤
 * aujourd'hui) et pas trop ancienne. Une scène annoncée à l'avance (date
 * future) n'est PAS éligible : elle le deviendra le jour de sa sortie.
 * Sans date, on la considère comme sortie aujourd'hui.
 */
function isReleased(scene, today, maxAgeDays = DEFAULT_MAX_AGE_DAYS) {
  const date = typeof scene.release_date === 'string' ? scene.release_date.slice(0, 10) : '';
  if (!date) return true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  return date <= today && date >= shiftDate(today, -maxAgeDays);
}

/**
 * Sélectionne les nouvelles sorties parmi les scènes d'un studio :
 * éligibles, jamais enregistrées, sans doublon. Triées de la plus ancienne à
 * la plus récente, pour que le salon les reçoive dans l'ordre chronologique.
 */
function selectNewReleases(scenes, knownIds, today, maxAgeDays = DEFAULT_MAX_AGE_DAYS) {
  const seen = new Set();
  const out = [];
  for (const scene of scenes || []) {
    if (!scene || !scene.id || seen.has(scene.id) || knownIds.has(scene.id)) continue;
    if (!isReleased(scene, today, maxAgeDays)) continue;
    seen.add(scene.id);
    out.push(scene);
  }
  return sortChronologically(out);
}

function sortChronologically(scenes) {
  return [...scenes].sort((a, b) => (a.release_date || '').localeCompare(b.release_date || ''));
}

/** Intervalle de sondage : défaut 1 h, plancher 5 min (respect de StashDB). */
function parsePollInterval(raw) {
  const n = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_POLL_MS;
  return Math.max(n, MIN_POLL_MS);
}

function parseMaxAgeDays(raw) {
  const n = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_MAX_AGE_DAYS;
  return Math.min(n, 365);
}

/** Échappe le Markdown Discord d'un texte venant de StashDB. */
function escapeMarkdown(text) {
  return String(text ?? '').replace(/[\\*_~`|>#<@[\]()-]/g, '\\$&');
}

function truncate(text, max) {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function formatDuration(seconds) {
  const s = Number(seconds);
  if (!Number.isFinite(s) || s <= 0) return null;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const pad = (v) => String(v).padStart(2, '0');
  return h > 0 ? `${h} h ${pad(m)} min` : `${m} min ${pad(sec)} s`;
}

/** 2026-11-16 → 16/11/2026 */
function formatDate(isoDate) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDate || '');
  return m ? `${m[3]}/${m[2]}/${m[1]}` : null;
}

/**
 * Lien public de la scène, déduit de l'origine du point GraphQL configuré
 * (aucun domaine en dur). Seuls http(s) sont acceptés.
 */
function sceneUrl(endpoint, sceneId) {
  try {
    const u = new URL(endpoint);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (!/^[0-9a-f-]{8,64}$/i.test(String(sceneId))) return null;
    return `${u.origin}/scenes/${sceneId}`;
  } catch {
    return null;
  }
}

/** Image : uniquement une URL https, sinon rien. */
function safeImage(scene) {
  const url = scene.images?.find((i) => typeof i?.url === 'string')?.url;
  return url && /^https:\/\//i.test(url) ? url : null;
}

/** Embed Discord (objet APIEmbed) d'une sortie, borné aux limites Discord. */
function buildReleaseEmbed(scene, endpoint) {
  const studio = scene.studio?.name || 'Studio inconnu';
  const performers = (scene.performers || [])
    .map((p) => p?.performer?.name || p?.name)
    .filter(Boolean);
  const fields = [{ name: 'Studio', value: truncate(escapeMarkdown(studio), 1024), inline: true }];
  const date = formatDate(scene.release_date);
  if (date) fields.push({ name: 'Sortie', value: date, inline: true });
  const duration = formatDuration(scene.duration);
  if (duration) fields.push({ name: 'Durée', value: duration, inline: true });
  if (performers.length) {
    fields.push({ name: performers.length > 1 ? 'Interprètes' : 'Interprète', value: truncate(performers.map(escapeMarkdown).join(', '), 1024) });
  }
  const embed = {
    title: truncate(escapeMarkdown(scene.title || 'Sans titre'), 256),
    color: EMBED_COLOR,
    fields,
    footer: { text: 'Nouvelle sortie' },
  };
  const url = sceneUrl(endpoint, scene.id);
  if (url) embed.url = url;
  const image = safeImage(scene);
  if (image) embed.image = { url: image };
  return embed;
}

module.exports = {
  DEFAULT_TIMEZONE,
  DEFAULT_MAX_AGE_DAYS,
  MIN_POLL_MS,
  DEFAULT_POLL_MS,
  todayIn,
  shiftDate,
  isReleased,
  selectNewReleases,
  sortChronologically,
  parsePollInterval,
  parseMaxAgeDays,
  escapeMarkdown,
  truncate,
  formatDuration,
  formatDate,
  sceneUrl,
  buildReleaseEmbed,
};
