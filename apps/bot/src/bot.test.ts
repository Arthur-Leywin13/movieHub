import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApiClient } from './api-client.ts';
import { FileSessionStore } from './session.ts';
import { Driver } from './testing/fake-telegram.ts';
import { ADMIN_ID, BOT_TOKEN, startApiHarness } from './testing/harness.ts';
import { makeBot } from './testing/make-bot.ts';

const MiB = 1024 * 1024;
const h = await startApiHarness();
after(() => h.close());
const direct = new ApiClient({ baseUrl: h.baseUrl, serviceToken: BOT_TOKEN });
type J = Record<string, any>;
const pub = async (path: string): Promise<{ status: number; json: J }> => {
  const r = await fetch(h.baseUrl + path);
  return { status: r.status, json: (await r.json()) as J };
};
const created = async (body: J): Promise<J> => (await direct.call(ADMIN_ID, 'POST', '/admin/contents', body))['content'];

/** Parcours minimal d'ajout d'un film. */
async function addMovie(d: Driver, o: { title: string; year: number; confirm: 'publish' | 'draft'; video?: number; audio?: string[] }): Promise<void> {
  await d.say('/addfilm');
  await d.press('skip'); // affiche
  await d.say(o.title);
  await d.press('skip'); // titres alternatifs
  await d.press('skip'); // description
  await d.say(String(o.year));
  await d.press('skip'); // genres
  await d.press('skip'); // date de sortie
  for (const l of o.audio ?? ['fr']) await d.press(`m:${l}`);
  await d.press('ok'); // audio annoncé
  await d.press('ok'); // sous-titres annoncés (aucun)
  await d.press('skip'); // bande-annonce
  if (o.video) {
    await d.file('video', 'film.mkv', o.video, 'video/x-matroska');
    await d.press('m:fr');
    await d.press('ok');
    await d.press('skip'); // sous-titres du fichier
  } else await d.press('skip'); // fichier vidéo
  await d.press(`c:${o.confirm}`);
}

test('accès : un compte non autorisé est refusé et aucune conversation n’est créée', async () => {
  const { bot, tg } = await makeBot(h);
  after(() => tg.cleanup());
  const intruder = new Driver(bot, tg, 999);
  await intruder.say('/addfilm');
  assert.match(intruder.text(), /Accès réservé aux administrateurs/);
  await intruder.say('/help');
  assert.match(intruder.text(), /Accès réservé/);
});

test('aide, commande inconnue, message hors parcours', async () => {
  const { admin, tg } = await makeBot(h);
  after(() => tg.cleanup());
  await admin.say('/start');
  assert.match(admin.text(), /\/addfilm/);
  assert.match(admin.text(), /\/addanime/);
  await admin.say('/nimporte');
  assert.match(admin.text(), /Commande inconnue/);
  await admin.say('bonjour');
  assert.match(admin.text(), /pas compris/);
  await admin.say('/cancel');
  assert.match(admin.text(), /Rien à annuler/);
  await admin.say('/resume');
  assert.match(admin.text(), /Rien à reprendre/);
});

test('film complet : affiche, titres, genres, langues, bande-annonce, vidéo de 20 Mo, sous-titres, publication → visible côté public', async () => {
  const { admin, tg } = await makeBot(h);
  after(() => tg.cleanup());
  await admin.say('/addfilm');
  assert.match(admin.text(), /Affiche/);
  await admin.file('photo', 'p.jpg', 50_000);
  assert.match(admin.text(), /Titre du film/);
  await admin.say('Film Complet Bot');
  await admin.say('Complete Test Movie; Film d’essai complet');
  await admin.say('Une description de test.');
  await admin.say('2024');
  await admin.say('Action, Drame');
  await admin.say('2024-02-28');
  await admin.press('m:fr');
  await admin.press('m:ja');
  await admin.press('ok');
  await admin.press('m:fr');
  await admin.press('m:en');
  await admin.press('ok');
  await admin.say('https://www.youtube.com/watch?v=abc123');
  await admin.file('video', 'film.mkv', 20 * MiB, 'video/x-matroska');
  await admin.press('m:fr');
  await admin.press('ok');
  await admin.file('document', 'fr.srt', 2000);
  await admin.press('c:fr');
  await admin.press('skip');
  assert.match(admin.text(), /Vérification/);
  assert.match(admin.text(), /Film Complet Bot/);
  assert.match(admin.text(), /Audio annoncé : fr, ja/);
  await admin.press('c:publish');
  await admin.settle();
  assert.match(admin.text(), /✅ Publié : « Film Complet Bot » \(2024\)/);
  assert.ok(admin.hasButton('Ouvrir la fiche'));

  const d = await pub('/contents/film-complet-bot-2024');
  assert.equal(d.status, 200);
  assert.deepEqual([d.json['available'], d.json['genres'], d.json['audioLanguages'], d.json['altTitles']], [true, ['Action', 'Drame'], ['fr', 'ja'], ['Complete Test Movie', 'Film d’essai complet']]);
  assert.equal(d.json['versions'].length, 1);
  assert.deepEqual(d.json['versions'][0].audioLanguages, ['fr']);
  assert.deepEqual(d.json['versions'][0].subtitles, [{ language: 'fr', source: 'EXTERNAL', format: 'SRT' }]);
  assert.equal(d.json['versions'][0].sizeBytes, 20 * MiB);
  assert.match(d.json['poster'].url, /\/image\//);
  assert.deepEqual([d.json['trailer'].external, d.json['trailer'].url], [true, 'https://www.youtube.com/watch?v=abc123']);
  assert.equal(d.json['releaseDate'], '2024-02-28');
  assert.ok([...h.mock.objects.values()].some((o) => o.body.length === 20 * MiB), 'la vidéo est bien dans le stockage');
  assert.equal(h.audit.entries.filter((e) => e.source === 'TELEGRAM_BOT').length > 0, true);
});

test('saisie : valeurs invalides refusées sans avancer ; mauvais type de fichier ; annulation', async () => {
  const { admin, tg } = await makeBot(h);
  after(() => tg.cleanup());
  await admin.say('/addfilm');
  await admin.file('video', 'x.mp4', 1000); // une vidéo à la place de l'affiche
  assert.match(admin.text(), /⚠️.*image/s);
  await admin.press('skip');
  await admin.say('Titre Valide');
  await admin.press('skip');
  await admin.press('skip');
  await admin.say('abc');
  assert.match(admin.text(), /⚠️.*nombre/s);
  await admin.say('1500');
  assert.match(admin.text(), /⚠️.*entre 1888 et 2100/s);
  await admin.say('2020');
  await admin.press('skip');
  await admin.say('28/02/2020');
  assert.match(admin.text(), /⚠️.*Date invalide/s);
  await admin.say('2020-02-30');
  assert.match(admin.text(), /⚠️.*Date invalide/s);
  await admin.press('x:cancel');
  assert.match(admin.text(), /Opération annulée/);
  assert.equal((await pub('/contents?limit=50')).json['items'].some((i: J) => i['title'] === 'Titre Valide'), false);
});

test('brouillon : enregistré mais invisible côté public, retrouvable par /search', async () => {
  const { admin, tg } = await makeBot(h);
  after(() => tg.cleanup());
  await addMovie(admin, { title: 'Film Brouillon Bot', year: 2022, confirm: 'draft' });
  await admin.settle();
  assert.match(admin.text(), /✅ Enregistré en brouillon/);
  assert.equal((await pub('/contents/film-brouillon-bot-2022')).status, 404);
  await admin.say('/search brouillon bot');
  assert.equal(admin.hasButton('Film Brouillon Bot (2022) — Film [Brouillon]'), true);
});

test('doublon : l’échec est expliqué avec le contenu existant ; annulation propre', async () => {
  const { admin, tg } = await makeBot(h);
  after(() => tg.cleanup());
  await addMovie(admin, { title: 'Film Doublon', year: 2021, confirm: 'draft' });
  await admin.settle();
  await addMovie(admin, { title: 'FILM DOUBLON', year: 2021, confirm: 'draft' });
  await admin.settle();
  assert.match(admin.text(), /❌.*« Film Doublon \(2021\) » existe déjà/s);
  await admin.say('/addfilm');
  assert.match(admin.text(), /traitement interrompu attend/);
  await admin.say('/cancel');
  assert.match(admin.text(), /Opération annulée/);
  await admin.say('/addfilm');
  assert.match(admin.text(), /Affiche/);
});

test('animé : saison, épisode 1 en français ET japonais, épisode 2, publication par saison', async () => {
  const { admin, tg } = await makeBot(h);
  after(() => tg.cleanup());
  await admin.say('/addanime');
  await admin.press('skip'); // affiche
  await admin.say('Anime Bot');
  await admin.press('skip');
  await admin.press('skip');
  await admin.say('2024');
  await admin.press('skip'); // genres
  await admin.press('m:fr');
  await admin.press('m:ja');
  await admin.press('ok');
  await admin.press('ok'); // sous-titres annoncés : aucun
  await admin.press('skip'); // bande-annonce
  await admin.press('n:1'); // saison 1 (suggestion)
  await admin.say('2024-04-01');
  await admin.press('c:add');
  await admin.press('n:1');
  await admin.file('video', 'e1-fr.mkv', 1 * MiB, 'video/x-matroska');
  await admin.press('m:fr');
  await admin.press('ok');
  await admin.press('skip');
  await admin.press('c:lang'); // même épisode, autre langue
  await admin.file('video', 'e1-ja.mkv', 1 * MiB, 'video/x-matroska');
  await admin.press('m:ja');
  await admin.press('ok');
  await admin.press('skip');
  await admin.press('c:add');
  await admin.press('n:2'); // suggestion automatique : épisode suivant
  await admin.file('video', 'e2-fr.mkv', 1 * MiB, 'video/x-matroska');
  await admin.press('m:fr');
  await admin.press('ok');
  await admin.press('skip');
  await admin.press('c:done');
  assert.match(admin.text(), /Saison 1 — sortie 2024-04-01/);
  assert.match(admin.text(), /Épisode 1 : fr \(e1-fr\.mkv\) \+ ja \(e1-ja\.mkv\)/);
  await admin.press('c:publish');
  await admin.settle();
  assert.match(admin.text(), /✅ Publié : « Anime Bot »/);

  const detail = (await pub('/contents/anime-bot-2024')).json;
  assert.equal(detail['seasons'].length, 1);
  assert.deepEqual([detail['seasons'][0].episodeCount, detail['available']], [2, true]);
  const eps = (await pub(`/seasons/${detail['seasons'][0].id}/episodes`)).json['episodes'] as J[];
  assert.deepEqual(eps.map((e) => e['number']), [1, 2]);
  assert.deepEqual(eps[0]!['versions'].map((v: J) => v['audioLanguages'][0]).sort(), ['fr', 'ja']);
  assert.deepEqual(eps[1]!['versions'].map((v: J) => v['audioLanguages'][0]), ['fr']);
});

test('coupure réseau : le traitement échoue proprement puis /resume reprend sans recréer ni renvoyer en double', async () => {
  const { admin, tg, api } = await makeBot(h);
  after(() => tg.cleanup());
  const before = [...h.media.files.values()].filter((f) => f.kind === 'VIDEO').length;
  api.failPuts = 4; // 1 essai + 3 nouvelles tentatives
  await addMovie(admin, { title: 'Film Coupure', year: 2020, confirm: 'publish', video: 1 * MiB });
  await admin.settle();
  assert.match(admin.text(), /❌.*Envoi vers le stockage échoué/s);
  assert.equal((await pub('/contents/film-coupure-2020')).status, 404);

  await admin.say('/addfilm');
  assert.match(admin.text(), /interrompu attend/);
  await admin.say('/resume');
  await admin.settle();
  assert.match(admin.text(), /✅ Publié : « Film Coupure »/);
  const d = await pub('/contents/film-coupure-2020');
  assert.equal(d.json['versions'].length, 1);
  assert.equal([...h.media.files.values()].filter((f) => f.kind === 'VIDEO').length, before + 1, 'un seul envoi vidéo, jamais de doublon');
  assert.equal((await pub('/contents?limit=50')).json['items'].filter((i: J) => i['title'] === 'Film Coupure').length, 1);
});

test('interruption en cours de traitement : /cancel interrompt, les autres messages sont refusés, /resume termine', async () => {
  const { admin, tg, api } = await makeBot(h);
  after(() => tg.cleanup());
  let reached!: () => void;
  const reachedP = new Promise<void>((r) => (reached = r));
  let release!: () => void;
  api.gate = new Promise<void>((r) => (release = r));
  api.onGate = reached;

  await addMovie(admin, { title: 'Film Interrompu', year: 2019, confirm: 'publish', video: 1 * MiB });
  await reachedP; // l'envoi du morceau est en cours (bloqué)
  await admin.say('coucou');
  assert.match(admin.text(), /traitement est en cours/);
  await admin.say('/addanime');
  assert.match(admin.text(), /traitement est en cours/);
  await admin.say('/cancel');
  assert.match(admin.text(), /Interruption demandée/);

  api.gate = null;
  release();
  await admin.settle();
  assert.match(admin.text(), /⏹ Traitement interrompu/);
  assert.equal((await pub('/contents/film-interrompu-2019')).status, 404);

  await admin.say('/resume');
  await admin.settle();
  assert.match(admin.text(), /✅ Publié : « Film Interrompu »/);
  assert.equal((await pub('/contents/film-interrompu-2019')).json['versions'].length, 1);
});

test('annulation après échec : l’envoi en cours est abandonné côté serveur, le contenu créé reste en brouillon', async () => {
  const { admin, tg, api } = await makeBot(h);
  after(() => tg.cleanup());
  api.failPuts = 4;
  await addMovie(admin, { title: 'Film Abandon', year: 2018, confirm: 'publish', video: 1 * MiB });
  await admin.settle();
  assert.match(admin.text(), /❌/);
  const pending = [...h.media.files.values()].filter((f) => f.status === 'PENDING' && f.kind === 'VIDEO');
  assert.equal(pending.length, 1);
  await admin.say('/cancel');
  assert.match(admin.text(), /Opération annulée.*brouillon/s);
  assert.equal(h.media.files.get(pending[0]!.id)?.status, 'FAILED');
  await admin.say('/search film abandon');
  assert.equal(admin.hasButton('[Brouillon]'), true);
});

test('reprise après redémarrage du bot : la conversation continue là où elle s’était arrêtée', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'movieshub-restart-'));
  after(() => rm(dir, { recursive: true, force: true }));
  const sessions = new FileSessionStore(dir);
  const first = await makeBot(h, { sessions });
  after(() => first.tg.cleanup());
  await first.admin.say('/addfilm');
  await first.admin.press('skip');
  await first.admin.say('Film Redemarrage');
  assert.match(first.admin.text(), /Titres alternatifs/);

  const second = await makeBot(h, { sessions }); // « redémarrage » : nouvelle instance, mêmes sessions
  after(() => second.tg.cleanup());
  await second.admin.press('skip').catch(() => undefined);
  await second.admin.say('Alt Redemarrage');
  assert.match(second.admin.text(), /Description/);
});

// ---------------- personnalisation ----------------
const openCard = async (d: Driver, id: string, q: string): Promise<void> => {
  await d.say(`/search ${q}`);
  await d.press(`sel:${id}`);
};

test('personnaliser : description avec résumé avant confirmation ; annulation sans effet', async () => {
  const c = await created({ type: 'MOVIE', title: 'Film Custom Desc', year: 2023, audioLanguages: ['fr'] });
  const { admin, tg } = await makeBot(h);
  after(() => tg.cleanup());
  await openCard(admin, c['id'], 'custom desc');
  assert.match(admin.text(), /Film — Film Custom Desc \(2023\)/);
  assert.match(admin.text(), /Statut : Brouillon/);
  await admin.press(`act:desc:${c['id']}`);
  await admin.say('Nouvelle description détaillée');
  assert.match(admin.text(), /Description : ∅ → Nouvelle description détaillée/);
  await admin.press('x:cancel');
  assert.equal((await direct.call(ADMIN_ID, 'GET', `/admin/contents/${c['id']}`))['content'].description, null);

  await openCard(admin, c['id'], 'custom desc');
  await admin.press(`act:desc:${c['id']}`);
  await admin.say('Nouvelle description détaillée');
  await admin.press('c:ok');
  await admin.settle();
  assert.match(admin.text(), /✅ Modification appliquée/);
  assert.equal((await direct.call(ADMIN_ID, 'GET', `/admin/contents/${c['id']}`))['content'].description, 'Nouvelle description détaillée');
});

test('personnaliser : ajout de la langue japonaise sans toucher au français', async () => {
  const c = await created({ type: 'MOVIE', title: 'Film Custom Langue', year: 2023, audioLanguages: ['fr'], subtitleLanguages: ['fr'] });
  const { admin, tg } = await makeBot(h);
  after(() => tg.cleanup());
  await openCard(admin, c['id'], 'custom langue');
  await admin.press(`act:lang:${c['id']}`);
  await admin.press('c:audio');
  assert.equal(admin.hasButton('c:fr'), false, 'une langue déjà annoncée n’est pas reproposée');
  await admin.press('c:ja');
  assert.match(admin.text(), /Langues audio : fr → fr, ja/);
  await admin.press('c:ok');
  await admin.settle();
  const after2 = (await direct.call(ADMIN_ID, 'GET', `/admin/contents/${c['id']}`))['content'];
  assert.deepEqual([after2.audioLanguages, after2.subtitleLanguages], [['fr', 'ja'], ['fr']]);
});

test('personnaliser : nouvelle affiche = ancienne archivée (conservée) puis restauration depuis « Médias »', async () => {
  const c = await created({ type: 'MOVIE', title: 'Film Custom Affiche', year: 2023 });
  const { admin, tg } = await makeBot(h);
  after(() => tg.cleanup());
  for (const _ of [1, 2]) {
    await openCard(admin, c['id'], 'custom affiche');
    await admin.press(`act:poster:${c['id']}`);
    await admin.file('photo', 'a.jpg', 30_000);
    assert.match(admin.text(), /ancienne sera archivée/);
    await admin.press('c:ok');
    await admin.settle();
    assert.match(admin.text(), /Nouvelle affiche principale en place/);
  }
  let detail = await direct.call(ADMIN_ID, 'GET', `/admin/contents/${c['id']}`);
  const posters = detail['posters'] as J[];
  assert.equal(posters.length, 2);
  const archived = posters.find((p) => p['archivedAt'])!;
  assert.notEqual(detail['content'].primaryPosterId, archived['id']);

  await openCard(admin, c['id'], 'custom affiche');
  await admin.press(`act:media:${c['id']}`);
  assert.match(admin.text(), /archivée/);
  await admin.press(`mp:pr:${archived['id']}`);
  assert.match(admin.text(), /✅/);
  detail = await direct.call(ADMIN_ID, 'GET', `/admin/contents/${c['id']}`);
  assert.equal((detail['posters'] as J[]).every((p) => !p['archivedAt']), true);
});

test('personnaliser : bande-annonce secondaire par lien, puis archivage depuis « Médias »', async () => {
  const c = await created({ type: 'MOVIE', title: 'Film Custom Trailer', year: 2023 });
  const { admin, tg } = await makeBot(h);
  after(() => tg.cleanup());
  for (const [url, main] of [['https://www.youtube.com/watch?v=one', 'c:main'], ['https://www.youtube.com/watch?v=two', 'c:second']] as const) {
    await openCard(admin, c['id'], 'custom trailer');
    await admin.press(`act:trailer:${c['id']}`);
    await admin.say(url);
    await admin.press(main);
    await admin.settle();
    assert.match(admin.text(), /✅ Bande-annonce ajoutée/);
  }
  let detail = await direct.call(ADMIN_ID, 'GET', `/admin/contents/${c['id']}`);
  const [t1, t2] = detail['trailers'] as J[];
  assert.equal(detail['content'].primaryTrailerId, t1!['id']);
  await openCard(admin, c['id'], 'custom trailer');
  await admin.press(`act:media:${c['id']}`);
  await admin.press(`mp:ta:${t2!['id']}`);
  detail = await direct.call(ADMIN_ID, 'GET', `/admin/contents/${c['id']}`);
  assert.ok((detail['trailers'] as J[]).find((t) => t['id'] === t2!['id'])!['archivedAt']);
});

test('personnaliser : version japonaise ajoutée à un film déjà publié en français — la version française reste', async () => {
  const c = await created({ type: 'MOVIE', title: 'Film Custom Version', year: 2023, audioLanguages: ['fr'] });
  const { admin, tg } = await makeBot(h);
  after(() => tg.cleanup());
  // version française publiée
  await openCard(admin, c['id'], 'custom version');
  await admin.press(`act:version:${c['id']}`);
  await admin.file('video', 'vf.mp4', 1 * MiB, 'video/mp4');
  await admin.press('m:fr');
  await admin.press('ok');
  await admin.press('skip');
  await admin.press('c:publish');
  await admin.settle();
  assert.match(admin.text(), /Version ajoutée et publiée/);
  // publication du film
  await openCard(admin, c['id'], 'custom version');
  await admin.press(`act:status:${c['id']}`);
  await admin.press('c:PUBLISHED');
  await admin.settle();
  assert.equal((await pub('/contents/film-custom-version-2023')).json['versions'].length, 1);

  // version japonaise en brouillon
  await openCard(admin, c['id'], 'custom version');
  await admin.press(`act:version:${c['id']}`);
  await admin.file('video', 'vo.mkv', 1 * MiB, 'video/x-matroska');
  await admin.press('m:ja');
  await admin.press('ok');
  await admin.press('skip');
  await admin.press('c:draft');
  await admin.settle();
  assert.match(admin.text(), /Version ajoutée \(brouillon\)/);
  assert.match(admin.text(), /⚠️.*ja/s, 'avertissement : langue non annoncée sur la fiche');
  const detail = await direct.call(ADMIN_ID, 'GET', `/admin/contents/${c['id']}`);
  assert.equal((detail['versions'] as J[]).length, 2);
  const pubVersions = (await pub('/contents/film-custom-version-2023')).json['versions'] as J[];
  assert.deepEqual(pubVersions.map((v) => v['audioLanguages'][0]), ['fr'], 'la nouvelle langue reste invisible tant qu’elle n’est pas publiée');
});

test('personnaliser : statut — options selon l’état, publication puis dépublication ; /delete mène au même choix', async () => {
  const c = await created({ type: 'MOVIE', title: 'Film Custom Statut', year: 2023 });
  const { admin, tg } = await makeBot(h);
  after(() => tg.cleanup());
  await openCard(admin, c['id'], 'custom statut');
  await admin.press(`act:status:${c['id']}`);
  assert.equal(admin.hasButton('c:UNPUBLISHED'), false, 'impossible de dépublier un brouillon');
  await admin.press('c:PUBLISHED');
  await admin.settle();
  assert.match(admin.text(), /Statut mis à jour : PUBLISHED/);
  assert.equal((await pub('/contents/film-custom-statut-2023')).status, 200);

  await admin.say('/delete custom statut');
  await admin.press(`del:${c['id']}`);
  assert.match(admin.text(), /Statut actuel : Publié/);
  assert.equal(admin.hasButton('c:DRAFT'), false);
  await admin.press('c:UNPUBLISHED');
  await admin.settle();
  assert.equal((await pub('/contents/film-custom-statut-2023')).status, 404);
  assert.equal((await direct.call(ADMIN_ID, 'GET', `/admin/contents/${c['id']}`))['content'].status, 'UNPUBLISHED');
});

test('personnaliser : nouvelle saison, nouveaux épisodes, version d’un nouvel épisode', async () => {
  const c = await created({ type: 'ANIME', title: 'Anime Custom Bot', year: 2024, audioLanguages: ['fr'] });
  const { admin, tg } = await makeBot(h);
  after(() => tg.cleanup());
  await openCard(admin, c['id'], 'anime custom');
  await admin.press(`act:season:${c['id']}`);
  await admin.press('n:1');
  await admin.say('2024-05-01');
  await admin.settle();
  assert.match(admin.text(), /Saison 1 créée/);

  await openCard(admin, c['id'], 'anime custom');
  await admin.press(`act:episodes:${c['id']}`);
  await admin.press('Saison 1');
  await admin.press('c:add');
  await admin.press('n:1');
  await admin.file('video', 'e1.mkv', 1 * MiB, 'video/x-matroska');
  await admin.press('m:fr');
  await admin.press('ok');
  await admin.press('skip');
  await admin.press('c:done');
  assert.match(admin.text(), /Créer 1 épisode/);
  await admin.press('c:ok');
  await admin.settle();
  assert.match(admin.text(), /1 épisode\(s\) créé\(s\) en brouillon/);

  await openCard(admin, c['id'], 'anime custom');
  await admin.press(`act:epversion:${c['id']}`);
  await admin.press('Saison 1');
  assert.equal(admin.hasButton('Épisode 1'), true);
  await admin.press('c:new');
  await admin.press('n:2');
  await admin.file('video', 'e2.mkv', 1 * MiB, 'video/x-matroska');
  await admin.press('m:fr');
  await admin.press('ok');
  await admin.press('skip');
  await admin.press('c:draft');
  await admin.settle();
  assert.match(admin.text(), /Version ajoutée \(brouillon\)/);

  const detail = await direct.call(ADMIN_ID, 'GET', `/admin/contents/${c['id']}`);
  const eps = detail['seasons'][0].episodes as J[];
  assert.deepEqual(eps.map((e) => e['episode'].number), [1, 2]);
  assert.deepEqual(eps.map((e) => e['versions'].length), [1, 1]);
});

test('personnaliser : une série sans saison explique quoi faire ; statistiques du catalogue', async () => {
  const c = await created({ type: 'SERIES', title: 'Serie Sans Saison', year: 2024 });
  const { admin, tg } = await makeBot(h);
  after(() => tg.cleanup());
  await openCard(admin, c['id'], 'sans saison');
  await admin.press(`act:epversion:${c['id']}`);
  assert.match(admin.text(), /pas encore de saison/);
  await admin.say('/stats');
  assert.match(admin.text(), /Films : \d+/);
  assert.match(admin.text(), /Séries : \d+/);
  assert.match(admin.text(), /Brouillons : \d+/);
  await admin.say('/search zzz-introuvable');
  assert.match(admin.text(), /Aucun résultat/);
});

test('la fiche affiche les boutons adaptés au type (film ≠ série)', async () => {
  const film = await created({ type: 'MOVIE', title: 'Film Boutons', year: 2023 });
  const serie = await created({ type: 'SERIES', title: 'Serie Boutons', year: 2023 });
  const { admin, tg } = await makeBot(h);
  after(() => tg.cleanup());
  await openCard(admin, film['id'], 'film boutons');
  assert.equal(admin.hasButton(`act:version:${film['id']}`), true);
  assert.equal(admin.hasButton(`act:season:${film['id']}`), false);
  await openCard(admin, serie['id'], 'serie boutons');
  assert.equal(admin.hasButton(`act:season:${serie['id']}`), true);
  assert.equal(admin.hasButton(`act:episodes:${serie['id']}`), true);
  assert.equal(admin.hasButton(`act:version:${serie['id']}`), false);
});
