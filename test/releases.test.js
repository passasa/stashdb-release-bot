import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import releases from '../src/releases.js';
import tracker from '../src/tracker.js';

const TODAY = '2026-11-16';
const ENDPOINT = 'https://stash.example/graphql';

const scene = (id, release_date, studio = 's1') => ({
  id, title: `Scène ${id}`, release_date, studio: { id: studio, name: `Studio ${studio}` },
});

describe('règles des sorties', () => {
  it('todayIn donne la date du fuseau, pas celle de UTC', () => {
    // 23 h 30 UTC le 15 = 0 h 30 le 16 à Paris.
    expect(releases.todayIn('Europe/Paris', new Date('2026-11-15T23:30:00Z'))).toBe('2026-11-16');
    expect(releases.todayIn('UTC', new Date('2026-11-15T23:30:00Z'))).toBe('2026-11-15');
  });

  it('une scène future n’est pas encore une sortie, une scène trop ancienne non plus', () => {
    expect(releases.isReleased(scene('a', '2026-11-16'), TODAY, 30)).toBe(true);
    expect(releases.isReleased(scene('a', '2026-11-17'), TODAY, 30)).toBe(false);
    expect(releases.isReleased(scene('a', '2026-10-17'), TODAY, 30)).toBe(true);
    expect(releases.isReleased(scene('a', '2026-10-16'), TODAY, 30)).toBe(false); // 31 jours

    expect(releases.isReleased(scene('a', undefined), TODAY, 30)).toBe(true);
    expect(releases.isReleased(scene('a', 'n/a'), TODAY, 30)).toBe(false);
  });

  it('selectNewReleases écarte connues et doublons, trie de la plus ancienne à la plus récente', () => {
    const out = releases.selectNewReleases(
      [scene('c', '2026-11-15'), scene('a', '2026-11-10'), scene('b', '2026-11-12'), scene('a', '2026-11-10'), scene('z', '2026-12-01')],
      new Set(['b']), TODAY, 30,
    );
    expect(out.map((s) => s.id)).toEqual(['a', 'c']);
  });

  it('intervalle : défaut 1 h, plancher 5 min', () => {
    expect(releases.parsePollInterval(undefined)).toBe(3600000);
    expect(releases.parsePollInterval('abc')).toBe(3600000);
    expect(releases.parsePollInterval('1000')).toBe(300000);
    expect(releases.parsePollInterval('900000')).toBe(900000);
  });

  it('embed : Markdown échappé, limites Discord, lien déduit du point GraphQL', () => {
    const embed = releases.buildReleaseEmbed({
      id: '0b1c2d3e-aaaa-bbbb-cccc-123456789abc',
      title: `**gras** @everyone ${'x'.repeat(400)}`,
      release_date: '2026-11-16',
      duration: 1865,
      studio: { id: 's', name: 'Some_Studio' },
      performers: [{ performer: { name: 'A' } }, { performer: { name: 'B' } }],
      images: [{ url: 'http://insecure.example/i.jpg' }],
    }, ENDPOINT);
    expect(embed.title.length).toBeLessThanOrEqual(256);
    expect(embed.title.startsWith('\\*\\*gras\\*\\* \\@everyone')).toBe(true);
    expect(embed.url).toBe('https://stash.example/scenes/0b1c2d3e-aaaa-bbbb-cccc-123456789abc');
    expect(embed.image).toBeUndefined(); // seulement https
    const fields = Object.fromEntries(embed.fields.map((f) => [f.name, f.value]));
    expect(fields).toMatchObject({ Studio: 'Some\\_Studio', Sortie: '16/11/2026', Durée: '31 min 05 s', Interprètes: 'A, B' });
  });

  it('sceneUrl refuse un identifiant ou un protocole douteux', () => {
    expect(releases.sceneUrl(ENDPOINT, '../admin')).toBeNull();
    expect(releases.sceneUrl('javascript:alert(1)', 'abcdef12')).toBeNull();
  });
});

function setup() {
  const db = new Database(':memory:');
  tracker.migrate(db);
  return { db, store: tracker.createStore(db) };
}

function harness(store, opts) {
  const delivered = [];
  return {
    delivered,
    run: () => tracker.runRound({
      store,
      today: TODAY,
      maxAgeDays: 30,
      fetchFavoriteStudios: async () => (typeof opts.studios === 'function' ? opts.studios() : opts.studios),
      fetchStudioScenes: async (s) => {
        const r = opts.scenes[s.id] ?? [];
        if (r instanceof Error) throw r;
        return r;
      },
      deliver: async (sc) => {
        const channels = opts.channels ?? 1;
        if (channels === 0) return { channels: 0, sent: 0 };
        if (opts.sendOk === false) return { channels, sent: 0 };
        delivered.push(sc.id);
        return { channels, sent: channels };
      },
    }),
  };
}

describe('tour de vérification', () => {
  const S1 = { id: 's1', name: 'Studio s1' };

  it('premier passage d’un studio : amorçage silencieux, puis seules les nouveautés sont annoncées', async () => {
    const { store } = setup();
    const opts = { studios: [S1], scenes: { s1: [scene('a', '2026-11-10'), scene('b', '2026-11-12')] } };
    const h = harness(store, opts);
    expect(await h.run()).toMatchObject({ seeded: 2, sent: 0 });
    expect(h.delivered).toEqual([]);

    opts.scenes.s1 = [scene('c', '2026-11-16'), ...opts.scenes.s1];
    expect(await h.run()).toMatchObject({ seeded: 0, sent: 1 });
    expect(h.delivered).toEqual(['c']);

    // Rien de neuf : rien ne repart.
    expect(await h.run()).toMatchObject({ sent: 0 });
  });

  it('une scène annoncée à l’avance part le jour de sa sortie, pas avant ni jamais', async () => {
    const { store } = setup();
    const opts = { studios: [S1], scenes: { s1: [scene('future', '2026-11-20')] } };
    await harness(store, opts).run(); // amorçage : la future n'est PAS enregistrée
    expect(store.knownIds().has('future')).toBe(false);
    const h = harness(store, { ...opts, scenes: { s1: [scene('future', TODAY)] } });
    expect(await h.run()).toMatchObject({ sent: 1 });
  });

  it('sans salon : rien n’est consommé, tout part quand un salon arrive', async () => {
    const { store } = setup();
    await harness(store, { studios: [S1], scenes: { s1: [] } }).run();
    const scenes = { s1: [scene('a', '2026-11-15')] };
    expect(await harness(store, { studios: [S1], scenes, channels: 0 }).run()).toMatchObject({ noChannel: true, waiting: 1, sent: 0 });
    expect(store.knownIds().has('a')).toBe(false);
    const h = harness(store, { studios: [S1], scenes });
    expect(await h.run()).toMatchObject({ sent: 1 });
    expect(h.delivered).toEqual(['a']);
  });

  it('envoi échoué partout : la scène sera retentée', async () => {
    const { store } = setup();
    await harness(store, { studios: [S1], scenes: { s1: [] } }).run();
    const scenes = { s1: [scene('a', '2026-11-15')] };
    expect(await harness(store, { studios: [S1], scenes, sendOk: false }).run()).toMatchObject({ waiting: 1, sent: 0 });
    expect(await harness(store, { studios: [S1], scenes }).run()).toMatchObject({ sent: 1 });
  });

  it('studio en erreur : sauté ce tour-ci, ses scènes reprises au suivant', async () => {
    const { store } = setup();
    const S2 = { id: 's2', name: 'Studio s2' };
    await harness(store, { studios: [S1, S2], scenes: {} }).run();
    const r = await harness(store, { studios: [S1, S2], scenes: { s1: new Error('HTTP 502'), s2: [scene('b', TODAY, 's2')] } }).run();
    expect(r).toMatchObject({ failures: 1, sent: 1 });
    expect(store.activeStudios().find((s) => s.studio_id === 's1').last_error).toBe('HTTP 502');
    const h = harness(store, { studios: [S1, S2], scenes: { s1: [scene('a', TODAY)] } });
    expect(await h.run()).toMatchObject({ failures: 0, sent: 1 });
    expect(h.delivered).toEqual(['a']);
  });

  it('favoris illisibles : le tour lève, aucun studio n’est retiré', async () => {
    const { store } = setup();
    await harness(store, { studios: [S1], scenes: {} }).run();
    await expect(harness(store, { studios: () => { throw new Error('HTTP 500'); }, scenes: {} }).run()).rejects.toThrow('HTTP 500');
    expect(store.activeStudios().map((s) => s.studio_id)).toEqual(['s1']);
  });

  it('studio retiré puis remis en favori : réamorcé, pas d’avalanche', async () => {
    const { store } = setup();
    await harness(store, { studios: [S1], scenes: {} }).run();
    await harness(store, { studios: [], scenes: {} }).run();
    expect(store.activeStudios()).toEqual([]);
    const h = harness(store, { studios: [S1], scenes: { s1: [scene('a', '2026-11-10')] } });
    expect(await h.run()).toMatchObject({ seeded: 1, sent: 0 });
  });

  it('au plus maxPerRound annonces par tour, le reste au tour suivant', async () => {
    const { store } = setup();
    await harness(store, { studios: [S1], scenes: {} }).run();
    const many = Array.from({ length: 25 }, (_, i) => scene(`x${String(i).padStart(2, '0')}`, '2026-11-15'));
    const h = harness(store, { studios: [S1], scenes: { s1: many } });
    expect(await h.run()).toMatchObject({ sent: 20, deferred: 5 });
    expect(await h.run()).toMatchObject({ sent: 5, deferred: 0 });
  });

  it('salon désactivé après 5 échecs consécutifs, réactivé en le redéfinissant', () => {
    const { store } = setup();
    store.setChannel('c1', 'g1');
    for (let i = 0; i < 4; i++) expect(store.channelFailed('c1', 'non NSFW')).toBe(false);
    expect(store.channelFailed('c1', 'non NSFW')).toBe(true);
    expect(store.activeChannels()).toEqual([]);
    store.setChannel('c1', 'g1');
    expect(store.activeChannels()).toHaveLength(1);
  });
});
