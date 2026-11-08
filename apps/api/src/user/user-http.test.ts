import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { UploadService } from '../admin/upload-service.ts';
import { buildApp } from '../app.ts';
import { ActorResolver } from '../auth/actor.ts';
import { AuthService } from '../auth/auth-service.ts';
import { CatalogReadService } from '../catalog/read-service.ts';
import { createHttpServer } from '../http/server.ts';
import { ACTOR, CTX, catalogFixture } from '../testing/catalog-fixture.ts';
import { MemoryUserDataRepo } from '../testing/memory-user-data-repo.ts';
import { MemoryAdminRepo, MemorySessionRepo, MemoryUserRepo } from '../testing/memory-repos.ts';
import { UserDataService } from './service.ts';

const NOW = new Date('2026-11-05T12:00:00Z');
const fx = catalogFixture();
const userRepo = new MemoryUserDataRepo(fx.repo);
const read = new CatalogReadService({ repo: fx.repo, signer: fx.r2, stats: userRepo, now: () => NOW });
const auth = new AuthService({ users: new MemoryUserRepo(), sessions: new MemorySessionRepo() }, { accessSecret: 'a'.repeat(40), refreshPepper: 'p'.repeat(40), passwordParams: { N: 2 ** 10, r: 8, p: 1 } });
const actors = new ActorResolver({ auth, admins: new MemoryAdminRepo(), botServiceToken: 'b'.repeat(40) });
const svc = new UserDataService({ repo: userRepo, catalog: fx.repo, read, signer: fx.r2, now: () => NOW, downloadsPerHour: 5 });
const uploads = new UploadService({ r2: fx.r2, media: fx.media, audit: fx.audit, bucket: 'b' });
const server = createHttpServer({ router: buildApp({ auth, actors, uploads, catalogAdmin: fx.admin, catalogRead: read, userData: svc }) });
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => server.close());

type J = Record<string, any>;
async function call(method: string, path: string, o: { body?: unknown; token?: string; headers?: Record<string, string> } = {}): Promise<{ status: number; json: J; raw: string }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(o.body === undefined ? {} : { 'content-type': 'application/json' }), ...(o.token ? { authorization: `Bearer ${o.token}` } : {}), ...(o.headers ?? {}) },
    ...(o.body === undefined ? {} : { body: JSON.stringify(o.body) }),
  });
  const raw = await res.text();
  return { status: res.status, json: raw ? (JSON.parse(raw) as J) : {}, raw };
}
const login = async (email: string): Promise<{ token: string; userId: string }> => {
  const r = await auth.register({ email, password: 'Motdepasse-Solide1', displayName: 'U' }, { ip: `ip-${email}`, userAgent: null });
  return { token: r.accessToken, userId: r.user.id };
};
const u1 = await login('u1@exemple.com');
const u2 = await login('u2@exemple.com');
const u3 = await login('u3@exemple.com');
const UUID0 = '0a1b2c3d-0000-4000-8000-000000000001';

async function publishMovie(title: string, releaseDate: string | null, o: { version?: boolean } = {}) {
  const c = await fx.admin.createContent(ACTOR, { type: 'MOVIE', title, year: 2026, ...(releaseDate ? { releaseDate } : {}), audioLanguages: ['fr', 'ja'] }, CTX);
  let versionId = '';
  if (o.version !== false) {
    const { version } = await fx.admin.addMovieVersion(ACTOR, c.id, { mediaFileId: await fx.readyMedia('VIDEO', 'mkv'), audioLanguages: ['fr'] }, CTX);
    await fx.admin.setVersionStatus(ACTOR, version.id, 'PUBLISHED', CTX);
    versionId = version.id;
  }
  await fx.admin.setContentStatus(ACTOR, c.id, 'PUBLISHED', CTX);
  return { id: c.id, slug: c.slug, versionId };
}

async function publishAnime(title: string) {
  const c = await fx.admin.createContent(ACTOR, { type: 'ANIME', title, year: 2026, audioLanguages: ['fr'] }, CTX);
  const season = await fx.admin.createSeason(ACTOR, c.id, { number: 1, releaseDate: '2026-06-01', featuredAsNewSeason: true }, CTX);
  const ep = await fx.admin.createEpisode(ACTOR, season.id, { number: 1, title: 'Début' }, CTX);
  const { version } = await fx.admin.addEpisodeVersion(ACTOR, ep.id, { mediaFileId: await fx.readyMedia('VIDEO', 'mkv'), audioLanguages: ['fr'] }, CTX);
  await fx.admin.setVersionStatus(ACTOR, version.id, 'PUBLISHED', CTX);
  await fx.admin.setEpisodeStatus(ACTOR, ep.id, 'PUBLISHED', CTX);
  await fx.admin.setSeasonStatus(ACTOR, season.id, 'PUBLISHED', CTX);
  await fx.admin.setContentStatus(ACTOR, c.id, 'PUBLISHED', CTX);
  return { id: c.id, slug: c.slug, seasonId: season.id, episodeId: ep.id, versionId: version.id };
}
const statOf = (contentId: string, field: 'views' | 'downloads' | 'favorites' | 'plays'): number => [...userRepo.stats.values()].filter((r) => r.contentId === contentId).reduce((n, r) => n + r[field], 0);

test('connexion obligatoire sur toutes les routes utilisateur', async () => {
  const routes: [string, string][] = [
    ['GET', '/me/favorites'], ['PUT', `/me/favorites/${UUID0}`], ['DELETE', `/me/favorites/${UUID0}`], ['GET', '/me/follows'], ['PUT', `/me/follows/${UUID0}`],
    ['GET', '/me/history'], ['PUT', '/me/history'], ['DELETE', '/me/history'], ['GET', '/me/settings'], ['PATCH', '/me/settings'],
    ['GET', '/me/search-history'], ['POST', '/me/search-history'], ['POST', `/versions/${UUID0}/download`], ['POST', `/downloads/${UUID0}/status`],
  ];
  for (const [m, p] of routes) assert.equal((await call(m, p, { body: m === 'GET' || m === 'DELETE' ? undefined : {} })).status, 401, `${m} ${p}`);
});

test('favoris : ajout idempotent, publié seulement, retenu si dépublié, isolé par utilisateur', async () => {
  const film = await publishMovie('Favori Un', '2026-01-10');
  assert.equal((await call('PUT', `/me/favorites/${film.id}`, { token: u1.token })).status, 204);
  assert.equal((await call('PUT', `/me/favorites/${film.id}`, { token: u1.token })).status, 204);
  assert.equal(statOf(film.id, 'favorites'), 1, 'compté une seule fois');
  const list = await call('GET', '/me/favorites', { token: u1.token });
  assert.deepEqual(list.json['items'].map((i: J) => i['title']), ['Favori Un']);
  assert.equal((await call('GET', '/me/favorites', { token: u2.token })).json['total'], 0);

  const draft = await fx.admin.createContent(ACTOR, { type: 'MOVIE', title: 'Favori Brouillon', year: 2026 }, CTX);
  assert.equal((await call('PUT', `/me/favorites/${draft.id}`, { token: u1.token })).status, 404);
  assert.equal((await call('PUT', `/me/favorites/${UUID0}`, { token: u1.token })).status, 404);
  assert.equal((await call('PUT', '/me/favorites/pas-un-uuid', { token: u1.token })).status, 400);

  await fx.admin.setContentStatus(ACTOR, film.id, 'UNPUBLISHED', CTX);
  assert.equal((await call('GET', '/me/favorites', { token: u1.token })).json['total'], 0, 'masqué tant que dépublié');
  await fx.admin.setContentStatus(ACTOR, film.id, 'PUBLISHED', CTX);
  assert.equal((await call('GET', '/me/favorites', { token: u1.token })).json['total'], 1, 'retrouvé à la republication');

  await fx.repo.updateContent(film.id, { status: 'WITHDRAWN' });
  assert.equal((await call('PUT', `/me/favorites/${film.id}`, { token: u2.token })).status, 410);
  await fx.repo.updateContent(film.id, { status: 'PUBLISHED' });
  assert.equal((await call('DELETE', `/me/favorites/${film.id}`, { token: u1.token })).status, 204);
  assert.equal((await call('GET', '/me/favorites', { token: u1.token })).json['total'], 0);
});

test('suivi : séries et animés seulement, notifications par série, désabonnement', async () => {
  const anime = await publishAnime('Suivi Anime');
  const film = await publishMovie('Suivi Film', null);
  const r = await call('PUT', `/me/follows/${anime.id}`, { token: u1.token });
  assert.deepEqual([r.status, r.json['follow'].notifyNewEpisodes, r.json['follow'].notifyNewSeasons], [200, true, true]);
  const r2 = await call('PUT', `/me/follows/${anime.id}`, { token: u1.token, body: { notifyNewSeasons: false } });
  assert.deepEqual([r2.json['follow'].notifyNewEpisodes, r2.json['follow'].notifyNewSeasons], [true, false]);
  assert.equal((await call('PUT', `/me/follows/${film.id}`, { token: u1.token })).status, 409);
  assert.equal((await call('PUT', `/me/follows/${anime.id}`, { token: u1.token, body: { notifyNewSeasons: 'oui' } })).status, 400);
  const list = (await call('GET', '/me/follows', { token: u1.token })).json;
  assert.deepEqual([list['total'], list['items'][0].content.title, list['items'][0].notifyNewSeasons], [1, 'Suivi Anime', false]);
  assert.equal((await call('DELETE', `/me/follows/${anime.id}`, { token: u1.token })).status, 204);
  assert.equal((await call('GET', '/me/follows', { token: u1.token })).json['total'], 0);
});

test('historique : reprise de lecture, terminé à 95 %, épisode, version cohérente, masquage, suppression, synchronisation désactivable', async () => {
  const film = await publishMovie('Histoire Film', '2026-02-01');
  const anime = await publishAnime('Histoire Anime');
  const put = (body: J, token = u1.token) => call('PUT', '/me/history', { token, body });

  const a = await put({ contentId: film.id, versionId: film.versionId, positionSeconds: 600, durationSeconds: 7200 });
  assert.deepEqual([a.status, a.json['stored'], a.json['history'].completed], [200, true, false]);
  const b = await put({ contentId: film.id, versionId: film.versionId, positionSeconds: 7000, durationSeconds: 7200 });
  assert.equal(b.json['history'].id, a.json['history'].id, 'même ligne mise à jour');
  assert.equal(b.json['history'].completed, true);
  assert.equal(statOf(film.id, 'plays'), 1, 'lecture comptée à la première entrée seulement');

  await put({ episodeId: anime.episodeId, versionId: anime.versionId, positionSeconds: 100, durationSeconds: 1400 });
  const list = (await call('GET', '/me/history', { token: u1.token })).json;
  assert.deepEqual(list['items'].map((i: J) => i['kind']), ['episode', 'movie'], 'le plus récent d’abord');
  assert.deepEqual([list['items'][0].episode.number, list['items'][0].episode.seasonNumber, list['items'][0].content.title], [1, 1, 'Histoire Anime']);
  assert.deepEqual([list['items'][1].positionSeconds, list['items'][1].versionId], [7000, film.versionId]);

  assert.equal((await put({ contentId: film.id, positionSeconds: 5 })).status, 200);
  assert.equal((await put({ episodeId: anime.episodeId, versionId: film.versionId, positionSeconds: 5 })).status, 400, 'version d’un autre contenu');
  assert.equal((await put({ positionSeconds: 5 })).status, 400);
  assert.equal((await put({ contentId: film.id, episodeId: anime.episodeId, positionSeconds: 5 })).status, 400);
  assert.equal((await put({ contentId: anime.id, positionSeconds: 5 })).status, 409, 'une série se lit par épisode');
  assert.equal((await put({ contentId: film.id, positionSeconds: -1 })).status, 400);
  assert.equal((await put({ contentId: film.id, positionSeconds: 5 }, u2.token)).status, 200);
  assert.equal((await call('GET', '/me/history', { token: u1.token })).json['total'], 2, 'chaque utilisateur a son historique');

  await fx.admin.setContentStatus(ACTOR, film.id, 'UNPUBLISHED', CTX);
  assert.deepEqual((await call('GET', '/me/history', { token: u1.token })).json['items'].map((i: J) => i['kind']), ['episode']);
  await fx.admin.setContentStatus(ACTOR, film.id, 'PUBLISHED', CTX);

  const id = (await call('GET', '/me/history', { token: u1.token })).json['items'][0].id;
  assert.equal((await call('DELETE', `/me/history/${id}`, { token: u2.token })).status, 404, 'pas celui d’un autre');
  assert.equal((await call('DELETE', `/me/history/${id}`, { token: u1.token })).status, 204);
  assert.equal((await call('DELETE', `/me/history/${id}`, { token: u1.token })).status, 404);

  await call('PATCH', '/me/settings', { token: u1.token, body: { historySyncEnabled: false } });
  const off = await put({ contentId: film.id, positionSeconds: 42 });
  assert.deepEqual([off.status, off.json['stored']], [200, false]);
  await call('PATCH', '/me/settings', { token: u1.token, body: { historySyncEnabled: true } });
  assert.equal((await call('DELETE', '/me/history', { token: u1.token })).status, 204);
  assert.equal((await call('GET', '/me/history', { token: u1.token })).json['items'].length, 0);
});

test('réglages et recherches récentes', async () => {
  assert.deepEqual((await call('GET', '/me/settings', { token: u2.token })).json['settings'], { locale: 'fr', notificationsEnabled: true, historySyncEnabled: true, adSoundEnabled: false });
  const p = await call('PATCH', '/me/settings', { token: u2.token, body: { adSoundEnabled: true, locale: 'pt-BR' } });
  assert.deepEqual([p.json['settings'].adSoundEnabled, p.json['settings'].locale], [true, 'pt-BR']);
  assert.equal((await call('PATCH', '/me/settings', { token: u2.token, body: {} })).status, 400);
  assert.equal((await call('PATCH', '/me/settings', { token: u2.token, body: { locale: 'FRANCAIS' } })).status, 400);
  assert.equal((await call('PATCH', '/me/settings', { token: u2.token, body: { notificationsEnabled: 'non' } })).status, 400);

  for (const q of ['dune', 'avatar', 'DUNE']) assert.equal((await call('POST', '/me/search-history', { token: u2.token, body: { query: q } })).status, 204);
  assert.deepEqual((await call('GET', '/me/search-history', { token: u2.token })).json['queries'], ['DUNE', 'avatar'], 'doublon fusionné, le plus récent d’abord');
  assert.equal((await call('POST', '/me/search-history', { token: u2.token, body: { query: 'a' } })).status, 400);
  assert.equal((await call('DELETE', '/me/search-history', { token: u2.token })).status, 204);
  assert.deepEqual((await call('GET', '/me/search-history', { token: u2.token })).json['queries'], []);
});

test('téléchargement : lien signé 15 min avec nom de fichier, compteur, état puis terminé ; refus hors publication', async () => {
  const film = await publishMovie('Telechargeable', '2026-03-01');
  const r = await call('POST', `/versions/${film.versionId}/download`, { token: u1.token, headers: { 'x-app-version': '1.4.2' } });
  assert.equal(r.status, 200);
  assert.match(r.json['url'], /^https:\/\/fake\.r2\/get\/video\/2026\/11\/.+\.mkv\?exp=900&dl=Telechargeable%20%5Bfr%5D\.mkv/);
  assert.deepEqual([r.json['filename'], r.json['expiresInSeconds'], r.json['allowLocalShare']], ['Telechargeable [fr].mkv', 900, false]);
  assert.equal(typeof r.json['sizeBytes'], 'number');
  assert.equal(statOf(film.id, 'downloads'), 1);
  assert.equal(userRepo.downloads.get(r.json['downloadId'])?.appVersion, '1.4.2');

  const st = (s: string, token = u1.token, extra: J = {}) => call('POST', `/downloads/${r.json['downloadId']}/status`, { token, body: { status: s, ...extra } });
  const done = await st('COMPLETED');
  assert.deepEqual([done.status, done.json['download'].status], [200, 'COMPLETED']);
  assert.notEqual(done.json['download'].completedAt, null);
  assert.equal((await st('COMPLETED')).status, 200, 'idempotent');
  assert.equal((await st('FAILED')).status, 409);
  assert.equal((await st('COMPLETED', u2.token)).status, 404, 'pas celui d’un autre');
  assert.equal((await st('TERMINE')).status, 400);

  const brouillon = await publishMovie('Version Brouillon', null, { version: false });
  const { version } = await fx.admin.addMovieVersion(ACTOR, brouillon.id, { mediaFileId: await fx.readyMedia('VIDEO', 'mkv'), audioLanguages: ['fr'] }, CTX);
  assert.equal((await call('POST', `/versions/${version.id}/download`, { token: u1.token })).status, 404, 'version non publiée');
  assert.equal((await call('POST', `/versions/${UUID0}/download`, { token: u1.token })).status, 404);

  const anime = await publishAnime('Anime Dl');
  const ep = await call('POST', `/versions/${anime.versionId}/download`, { token: u1.token });
  assert.equal(ep.json['filename'], 'Anime Dl S01E01 [fr].mkv');
  await fx.admin.setSeasonStatus(ACTOR, anime.seasonId, 'UNPUBLISHED', CTX);
  assert.equal((await call('POST', `/versions/${anime.versionId}/download`, { token: u1.token })).status, 404, 'saison dépubliée');
  await fx.admin.setSeasonStatus(ACTOR, anime.seasonId, 'PUBLISHED', CTX);
  await fx.repo.updateContent(film.id, { status: 'WITHDRAWN' });
  const gone = await call('POST', `/versions/${film.versionId}/download`, { token: u1.token });
  assert.deepEqual([gone.status, gone.json['error'].message], [410, 'Ce contenu a été retiré de l’application.']);
  await fx.repo.updateContent(film.id, { status: 'PUBLISHED' });
});

test('téléchargement : limite par utilisateur (5 par heure dans ce test)', async () => {
  const film = await publishMovie('Limite Dl', null);
  for (let i = 0; i < 5; i++) assert.equal((await call('POST', `/versions/${film.versionId}/download`, { token: u3.token })).status, 200);
  const blocked = await call('POST', `/versions/${film.versionId}/download`, { token: u3.token });
  assert.equal(blocked.status, 429);
  assert.equal((await call('POST', `/versions/${film.versionId}/download`, { token: u2.token })).status, 200, 'les autres utilisateurs ne sont pas touchés');
});

test('accueil : nouveautés par date de sortie officielle, saisons de l’année, à venir ; public', async () => {
  const sorti = await publishMovie('Accueil Sorti', '2026-09-01');
  const futur = await publishMovie('Accueil Futur', '2027-03-01', { version: false });
  const sansDate = await publishMovie('Accueil Sans Date', null);
  const anime = await publishAnime('Accueil Anime');
  const home = await call('GET', '/home');
  assert.equal(home.status, 200);
  const titles = (k: string): string[] => home.json[k].map((i: J) => i['title']);
  assert.ok(titles('newReleases').includes('Accueil Sorti'));
  assert.ok(!titles('newReleases').includes('Accueil Futur'), 'une sortie future n’est pas une nouveauté');
  assert.ok(!titles('newReleases').includes('Accueil Sans Date'));
  assert.ok(titles('upcoming').includes('Accueil Futur'));
  assert.ok(!titles('upcoming').includes('Accueil Sorti'));
  assert.ok(home.json['newSeasons'].some((s: J) => s['content'].title === 'Accueil Anime' && s['season'].number === 1 && s['season'].releaseDate === '2026-06-01'));
  const dates = home.json['newReleases'].map((i: J) => i['releaseDate']);
  assert.deepEqual(dates, [...dates].sort().reverse(), 'plus récent d’abord');
  const up = await call('GET', '/upcoming?limit=5');
  assert.deepEqual(up.json['items'].map((i: J) => i['title']), ['Accueil Futur']);
  assert.equal((await call('GET', '/upcoming?limit=100')).status, 400);
  void sansDate; void sorti; void futur; void anime;
});

test('tendances : usage récent pondéré, réglable, sans bonus de nouveauté', async () => {
  const a = await publishMovie('Tendance A', '2026-05-01');
  const b = await publishMovie('Tendance B', '2026-05-02');
  const neuf = await publishMovie('Tendance Neuf Sans Activite', '2026-11-04');
  await call('POST', `/versions/${a.versionId}/download`, { token: u2.token }); // téléchargement = 5
  await call('PUT', `/me/favorites/${b.id}`, { token: u2.token }); // favori = 3
  await call('GET', `/contents/${b.slug}`); // consultation = 1
  await new Promise((r) => setTimeout(r, 30)); // la consultation est comptée sans attendre
  let trending = ((await call('GET', '/home')).json['trending'] as J[]).map((i) => i['title']);
  assert.ok(trending.indexOf('Tendance A') !== -1 && trending.indexOf('Tendance A') < trending.indexOf('Tendance B'), `A (5) avant B (4) : ${trending.join(', ')}`);
  assert.ok(!trending.includes('Tendance Neuf Sans Activite'));

  userRepo.appSettings.set('trending', { views: 0, downloads: 0, favorites: 10, plays: 0, windowDays: 7 });
  trending = ((await call('GET', '/home')).json['trending'] as J[]).map((i) => i['title']);
  assert.ok(trending.includes('Tendance B') && !trending.includes('Tendance A'), 'poids modifiés : seul B a des favoris');
  userRepo.appSettings.set('trending', { views: -5, downloads: 'beaucoup', windowDays: 9999 });
  assert.ok(((await call('GET', '/home')).json['trending'] as J[]).length > 0, 'réglage invalide : valeurs par défaut');
  void neuf;
});
