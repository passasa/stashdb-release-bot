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

// opts.studios : suivis { id, name, kind? } (kind 'studio' par défaut).
// opts.scenes : scènes par id de suivi, ou Error pour simuler une panne.
function harness(store, opts) {
  const delivered = [];
  const via = {};
  return {
    delivered,
    via,
    run: () => tracker.runRound({
      store,
      today: TODAY,
      maxAgeDays: 30,
      fetchFollows: async () => (typeof opts.studios === 'function' ? opts.studios() : opts.studios)
        .map((f) => ({ kind: 'studio', ...f })),
      fetchScenes: async (s) => {
        const r = opts.scenes[s.id] ?? [];
        if (r instanceof Error) throw r;
        return r;
      },
      deliver: async (sc, v) => {
        const channels = opts.channels ?? 1;
        if (channels === 0) return { channels: 0, sent: 0 };
        if (opts.sendOk === false) return { channels, sent: 0 };
        delivered.push(sc.id);
        via[sc.id] = v;
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
    expect(store.activeFollows().find((s) => s.entity_id === 's1').last_error).toBe('HTTP 502');
    const h = harness(store, { studios: [S1, S2], scenes: { s1: [scene('a', TODAY)] } });
    expect(await h.run()).toMatchObject({ failures: 0, sent: 1 });
    expect(h.delivered).toEqual(['a']);
  });

  it('favoris illisibles : le tour lève, aucun studio n’est retiré', async () => {
    const { store } = setup();
    await harness(store, { studios: [S1], scenes: {} }).run();
    await expect(harness(store, { studios: () => { throw new Error('HTTP 500'); }, scenes: {} }).run()).rejects.toThrow('HTTP 500');
    expect(store.activeFollows().map((s) => s.entity_id)).toEqual(['s1']);
  });

  it('studio retiré puis remis en favori : réamorcé, pas d’avalanche', async () => {
    const { store } = setup();
    await harness(store, { studios: [S1], scenes: {} }).run();
    await harness(store, { studios: [], scenes: {} }).run();
    expect(store.activeFollows()).toEqual([]);
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

describe('suivi des interprètes', () => {
  const S1 = { id: 's1', name: 'Studio s1' };
  const P1 = { id: 'p1', name: 'Interprète p1', kind: 'performer' };

  it('les sorties d’un interprète suivi sont annoncées, quel que soit le studio', async () => {
    const { store } = setup();
    await harness(store, { studios: [P1], scenes: {} }).run();
    const h = harness(store, { studios: [P1], scenes: { p1: [scene('x', TODAY, 'autre')] } });
    expect(await h.run()).toMatchObject({ studios: 0, performers: 1, sent: 1 });
    expect(h.via.x).toEqual(['Interprète p1']);
  });

  it('une scène trouvée par un studio ET un interprète part une seule fois, avec les deux motifs', async () => {
    const { store } = setup();
    await harness(store, { studios: [S1, P1], scenes: {} }).run();
    const x = scene('x', TODAY);
    const h = harness(store, { studios: [S1, P1], scenes: { s1: [x], p1: [x] } });
    expect(await h.run()).toMatchObject({ sent: 1 });
    expect(h.delivered).toEqual(['x']);
    expect(h.via.x).toEqual(['Studio s1', 'Interprète p1']);
  });

  it('un interprète ajouté le jour d’une sortie de studio suivi ne l’avale pas', async () => {
    // L'interprète, nouveau, est amorcé : sans l'ordre « amorcés d'abord »,
    // il enregistrerait la scène comme vue avant que le studio ne l'annonce.
    const { store } = setup();
    await harness(store, { studios: [S1], scenes: {} }).run();
    const x = scene('x', TODAY);
    const h = harness(store, { studios: [P1, S1], scenes: { s1: [x], p1: [x, scene('old', '2026-11-01', 'autre')] } });
    expect(await h.run()).toMatchObject({ sent: 1, seeded: 1 });
    expect(h.delivered).toEqual(['x']);
  });

  it('studio et interprète de même identifiant restent deux suivis distincts', async () => {
    const { store } = setup();
    await harness(store, { studios: [{ id: 'same', name: 'A' }, { id: 'same', name: 'B', kind: 'performer' }], scenes: {} }).run();
    expect(store.activeFollows().map((f) => f.kind).sort()).toEqual(['performer', 'studio']);
  });

  it('un suivi de type inconnu fait échouer le tour (favoris illisibles)', async () => {
    const { store } = setup();
    await expect(harness(store, { studios: [{ id: 'x', name: 'x', kind: 'tag' }], scenes: {} }).run()).rejects.toThrow('illisible');
  });

  it('l’embed indique pourquoi la scène est annoncée', () => {
    const e = releases.buildReleaseEmbed(scene('abcdef12', TODAY), ENDPOINT, ['Studio s1', 'Interprète p1']);
    expect(e.footer.text).toBe('Nouvelle sortie · suivi : Studio s1, Interprète p1');
    expect(releases.buildReleaseEmbed(scene('abcdef12', TODAY), ENDPOINT).footer.text).toBe('Nouvelle sortie');
  });
});

describe('migration depuis la version 1.0', () => {
  it('reprend les studios suivis avec leur amorçage, sans rien réannoncer', async () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE followed_studios (studio_id TEXT PRIMARY KEY, name TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
        seeded INTEGER NOT NULL DEFAULT 0, last_checked_at TEXT, last_error TEXT);
      INSERT INTO followed_studios (studio_id, name, active, seeded) VALUES ('s1', 'Studio s1', 1, 1);
    `);
    expect(tracker.migrate(db)).toEqual({ migrated: true, studios: 1 });
    expect(tracker.migrate(db)).toEqual({ migrated: false });
    const store = tracker.createStore(db);
    expect(store.isSeeded({ kind: 'studio', id: 's1' })).toBe(true);
    // Amorcé : une nouveauté est annoncée directement, pas réamorcée.
    const h = harness(store, { studios: [{ id: 's1', name: 'Studio s1' }], scenes: { s1: [scene('n', TODAY)] } });
    expect(await h.run()).toMatchObject({ seeded: 0, sent: 1 });
  });
});
