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
    expect(embed.description).toBe('**Studio:** Some\\_Studio\n**Date:** 2026-11-16\n**Durée:** 31m\n**Performeurs:** A, B');
    expect(embed.color).toBe(0x00bfff);
    expect(embed.timestamp).toBe('2026-11-16T00:00:00.000Z');
    expect(embed.description.length).toBeLessThanOrEqual(4096);
  });

  it('présentation : date douteuse ignorée, durée compacte, pas de champ vide', () => {
    expect(releases.formatShortDuration(2045)).toBe('34m');
    expect(releases.formatShortDuration(3900)).toBe('1h05m');
    expect(releases.formatShortDuration(42)).toBe('42s');
    expect(releases.formatShortDuration(0)).toBeNull();
    const e = releases.buildReleaseEmbed({ id: 'abcdef12', title: 'T', release_date: '2026-11-16T00:00<@1>', studio: null }, ENDPOINT);
    expect(e.description).toBe('**Studio:** Inconnu');
    expect(e.timestamp).toBeUndefined();
  });

  it('bouton « Télécharger image » : seulement avec une image https et un identifiant valide', () => {
    const withImage = { id: '0b1c2d3e-aaaa-bbbb-cccc-123456789abc', images: [{ url: 'https://cdn.example/i.jpg' }] };
    const [row] = releases.buildReleaseComponents(withImage);
    expect(row.components).toEqual([expect.objectContaining({
      type: 2, style: 1, label: 'Télécharger image', custom_id: 'stashdl:0b1c2d3e-aaaa-bbbb-cccc-123456789abc',
    })]);
    expect(releases.buildReleaseComponents({ ...withImage, images: [{ url: 'http://x/i.jpg' }] })).toEqual([]);
    expect(releases.buildReleaseComponents({ ...withImage, images: [] })).toEqual([]);
    expect(releases.buildReleaseComponents({ ...withImage, id: '../../x' })).toEqual([]);
    // Aucun bouton de demande.
    expect(JSON.stringify(releases.buildReleaseComponents(withImage))).not.toMatch(/demand/i);
  });

  it('clic sur le bouton : identifiant vérifié, nom de fichier sans caractère interdit', () => {
    expect(releases.parseImageButton('stashdl:0b1c2d3e-aaaa')).toBe('0b1c2d3e-aaaa');
    expect(releases.parseImageButton('stashdl:../../etc')).toBeNull();
    expect(releases.parseImageButton('request:0b1c2d3e')).toBeNull();
    expect(releases.parseImageButton(undefined)).toBeNull();
    expect(releases.imageFileName({ studio: { name: 'A/B' }, release_date: '2026-11-16', title: 'x:y?' }, 'image/png'))
      .toBe('A_B - 2026-11-16 - x_y_.png');
    expect(releases.imageFileName({}, 'image/jpeg')).toBe('Inconnu - Sans titre.jpg');
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
    expect(e.footer.text).toBe('StashDB — Nouvelle sortie · suivi : Studio s1, Interprète p1');
    expect(releases.buildReleaseEmbed(scene('abcdef12', TODAY), ENDPOINT).footer.text).toBe('StashDB — Nouvelle sortie');
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

describe('identifiants envoyés : aucun doublon', () => {
  const S1 = { id: 's1', name: 'Studio s1' };

  // Vrai createDeliverer, sur deux salons ; send(row, scene) est simulé.
  function realDelivery(store, outcomeFor = () => 'sent') {
    store.setChannel('c1', 'g');
    store.setChannel('c2', 'g');
    const posts = [];
    const deliver = tracker.createDeliverer({
      store,
      send: async (row, sc) => {
        const outcome = outcomeFor(row, sc);
        if (outcome === 'sent' || outcome === 'uncertain') posts.push(`${sc.id}@${row.channel_id}`);
        if (outcome instanceof Error) throw outcome;
        return outcome;
      },
    });
    return { posts, deliver };
  }

  it('l’identifiant est enregistré par salon : un second envoi de la même scène ne poste rien', async () => {
    const { store } = setup();
    const { posts, deliver } = realDelivery(store);
    const sc = scene('a', '2026-11-16');
    expect(await deliver(sc)).toMatchObject({ channels: 2, sent: 2, posted: 2, skipped: 0 });
    expect(await deliver(sc)).toMatchObject({ channels: 2, sent: 2, posted: 0, skipped: 2 });
    expect(posts).toEqual(['a@c1', 'a@c2']);
    expect(store.deliveriesOf('a').map((d) => d.state)).toEqual(['sent', 'sent']);
  });

  it('plantage entre l’envoi et l’enregistrement de la sortie : rien n’est reposté au tour suivant', async () => {
    const { store } = setup();
    const { posts, deliver } = realDelivery(store);
    const opts = { studios: [S1], scenes: { s1: [] } };
    const run = () => tracker.runRound({
      store, today: TODAY, maxAgeDays: 30,
      fetchFollows: async () => opts.studios.map((f) => ({ kind: 'studio', ...f })),
      fetchScenes: async () => opts.scenes.s1,
      deliver,
    });
    await run(); // amorçage
    opts.scenes.s1 = [scene('a', '2026-11-16')];

    const recordSent = store.recordSent;
    store.recordSent = () => { throw new Error('arrêt brutal'); };
    await expect(run()).rejects.toThrow('arrêt brutal');
    store.recordSent = recordSent;

    expect(await run()).toMatchObject({ sent: 1 });
    expect(posts).toEqual(['a@c1', 'a@c2']); // une seule fois par salon
    expect(await run()).toMatchObject({ sent: 0 });
    expect(posts).toHaveLength(2);
  });

  it('refus de Discord : la réservation est libérée et la scène retentée dans ce salon seulement', async () => {
    const { store } = setup();
    let c2Down = true;
    const { posts, deliver } = realDelivery(store, (row) => (row.channel_id === 'c2' && c2Down ? 'failed' : 'sent'));
    const sc = scene('a', '2026-11-16');
    expect(await deliver(sc)).toMatchObject({ posted: 1 });
    c2Down = false;
    expect(await deliver(sc)).toMatchObject({ posted: 1, skipped: 1 });
    expect(posts).toEqual(['a@c1', 'a@c2']);
  });

  it('issue inconnue (coupure, exception) : dans le doute, jamais renvoyée', async () => {
    const { store } = setup();
    let first = true;
    const { posts, deliver } = realDelivery(store, (row) => {
      if (!first) return 'sent';
      return row.channel_id === 'c1' ? 'uncertain' : new Error('socket hang up');
    });
    const sc = scene('a', '2026-11-16');
    expect(await deliver(sc)).toMatchObject({ posted: 0, skipped: 2, sent: 2 });
    first = false;
    expect(await deliver(sc)).toMatchObject({ posted: 0, skipped: 2 });
    expect(posts).toEqual(['a@c1']);
  });

  it('un nouveau salon reçoit les scènes suivantes, sans rejouer celles déjà envoyées ailleurs', async () => {
    const { store } = setup();
    const { posts, deliver } = realDelivery(store);
    await deliver(scene('a', '2026-11-16'));
    store.setChannel('c3', 'g');
    await deliver(scene('b', '2026-11-16'));
    await deliver(scene('a', '2026-11-16'));
    expect(posts).toEqual(['a@c1', 'a@c2', 'b@c1', 'b@c2', 'b@c3', 'a@c3']);
  });
});
