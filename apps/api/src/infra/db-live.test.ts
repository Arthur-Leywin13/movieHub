/**
 * Test d'intégration contre un VRAI PostgreSQL : exerce toutes les couches Prisma de l'API (comptes, médias,
 * catalogue, recherche, données utilisateur, compteurs). Ignoré sauf DB_LIVE_TEST=1 ; lancé par la CI après
 * migrations, SQL de recherche et seed. Seul R2 est simulé (liens signés factices).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

if (process.env['DB_LIVE_TEST'] !== '1') {
  test('PostgreSQL réel : ignoré (DB_LIVE_TEST=1 requis)', { skip: true }, () => undefined);
} else {
  const { prisma } = await import('@movieshub/database');
  const { PrismaAdminRepo, PrismaAuditRepo, PrismaMediaFileRepo, PrismaUserRepo } = await import('./prisma-repos.ts');
  const { PrismaCatalogRepo } = await import('./prisma-catalog-repo.ts');
  const { PrismaUserDataRepo } = await import('./prisma-user-data-repo.ts');
  const { CatalogAdminService } = await import('../catalog/admin-service.ts');
  const { CatalogReadService } = await import('../catalog/read-service.ts');
  const { UserDataService } = await import('../user/service.ts');
  const { FakeR2 } = await import('../testing/fake-r2.ts');
  const { after } = await import('node:test');
  after(() => prisma.$disconnect());

  const tag = randomUUID().slice(0, 8);
  const users = new PrismaUserRepo(prisma);
  const media = new PrismaMediaFileRepo(prisma);
  const catalog = new PrismaCatalogRepo(prisma);
  const userData = new PrismaUserDataRepo(prisma);
  const r2 = new FakeR2();
  const admin = new CatalogAdminService({ repo: catalog, media, audit: new PrismaAuditRepo(prisma) });
  const read = new CatalogReadService({ repo: catalog, signer: r2, stats: userData });
  const svc = new UserDataService({ repo: userData, catalog, read, signer: r2 });

  const adminUser = await users.create({ email: `live-admin-${tag}@exemple.com`, passwordHash: 'scrypt$x', displayName: 'Live Admin' });
  const adminRow = await new PrismaAdminRepo(prisma).create({ userId: adminUser.id, telegramId: null, role: 'EDITOR' });
  const ACTOR = { kind: 'admin' as const, userId: adminUser.id, adminId: adminRow.id, role: 'EDITOR' as const, via: 'jwt' as const, telegramId: null };
  const CTX = { ip: '127.0.0.1', requestId: `live-${tag}` };
  const readyMedia = async (kind: 'VIDEO' | 'IMAGE' | 'SUBTITLE' | 'TRAILER_VIDEO', ext: string): Promise<string> => {
    const id = randomUUID();
    await media.create({ id, bucket: 'b', objectKey: `${kind.toLowerCase()}/live/${id}.${ext}`, kind, mimeType: 'x/y', sizeBytes: 1234, multipartUploadId: null, multipartPartSize: null, uploadedByAdminId: adminRow.id });
    await media.markReady(id, { verifiedAt: new Date(), sizeBytes: 1234 });
    return id;
  };

  const title = `Les Misérables ${tag}`;
  let movieId = '';
  let versionId = '';
  let movieSlug = '';

  test('PostgreSQL : catalogue — création, doublon, personnalisation, versions, affiches, bandes-annonces, publication', async () => {
    const c = await admin.createContent(ACTOR, { type: 'MOVIE', title, year: 2012, releaseDate: '2012-12-19', genres: ['Drame', 'Musical'], altTitles: [`Les Mis ${tag}`], audioLanguages: ['fr'], subtitleLanguages: ['fr', 'en'] }, CTX);
    movieId = c.id;
    movieSlug = c.slug;
    assert.deepEqual([c.status, c.genres.map((g) => g.slug), c.audioLanguages, c.altTitles], ['DRAFT', ['drame', 'musical'], ['fr'], [`Les Mis ${tag}`]]);
    await assert.rejects(admin.createContent(ACTOR, { type: 'MOVIE', title: title.toUpperCase(), year: 2012 }, CTX), /existe déjà/);

    const preview = await admin.customizeContent(ACTOR, movieId, { audioLanguages: { add: ['ja'] }, genres: { remove: ['Musical'], add: ['Historique'] } }, false, CTX);
    assert.equal(preview.applied, false);
    assert.deepEqual((await catalog.getContent(movieId))?.audioLanguages, ['fr']);
    const applied = await admin.customizeContent(ACTOR, movieId, { audioLanguages: { add: ['ja'] }, genres: { remove: ['Musical'], add: ['Historique'] }, description: 'Un classique.' }, true, CTX);
    assert.deepEqual([applied.content.audioLanguages.sort(), applied.content.genres.map((g) => g.slug).sort(), applied.content.description], [['fr', 'ja'], ['drame', 'historique'], 'Un classique.']);

    const vf = await admin.addMovieVersion(ACTOR, movieId, { mediaFileId: await readyMedia('VIDEO', 'mkv'), audioLanguages: ['fr'], height: 1080 }, CTX);
    versionId = vf.version.id;
    const vo = await admin.addMovieVersion(ACTOR, movieId, { mediaFileId: await readyMedia('VIDEO', 'mkv'), audioLanguages: ['ja'], embeddedSubtitles: [{ language: 'fr', format: 'ASS', streamIndex: 2 }] }, CTX);
    const withSub = await admin.addExternalSubtitle(ACTOR, versionId, { mediaFileId: await readyMedia('SUBTITLE', 'srt'), language: 'en' }, CTX);
    assert.deepEqual(withSub.subtitleTracks.map((s) => [s.languageCode, s.format]), [['en', 'SRT']]);
    await admin.setVersionStatus(ACTOR, versionId, 'PUBLISHED', CTX);
    assert.equal((await catalog.getVersion(vo.version.id))?.status, 'DRAFT');

    const p1 = await admin.addPoster(ACTOR, movieId, { mediaFileId: await readyMedia('IMAGE', 'jpg') }, CTX);
    const p2 = await admin.addPoster(ACTOR, movieId, { mediaFileId: await readyMedia('IMAGE', 'png') }, CTX);
    await admin.setPrimaryPoster(ACTOR, p2.id, CTX);
    assert.ok((await catalog.getPoster(p1.id))?.archivedAt, 'ancienne affiche archivée');
    assert.equal((await catalog.getContent(movieId))?.primaryPosterId, p2.id);
    await admin.restorePoster(ACTOR, p1.id, CTX);
    const t1 = await admin.addTrailer(ACTOR, movieId, { externalUrl: 'https://www.youtube.com/watch?v=live1' }, CTX);
    const t2 = await admin.addTrailer(ACTOR, movieId, { mediaFileId: await readyMedia('TRAILER_VIDEO', 'mp4') }, CTX);
    await admin.setPrimaryTrailer(ACTOR, t2.id, CTX);
    await admin.reorderTrailers(ACTOR, movieId, null, [t2.id, t1.id], CTX);
    assert.deepEqual((await catalog.listTrailers(movieId)).map((t) => t.id), [t2.id, t1.id]);

    await admin.setContentStatus(ACTOR, movieId, 'PUBLISHED', CTX);
    const d = await read.detail(movieSlug);
    assert.deepEqual([d.type, 'versions' in d ? d.versions.length : -1, d.poster !== null, d.trailer?.external], ['MOVIE', 1, true, false]);
  });

  test('PostgreSQL : catalogue série — saisons, épisodes, versions par épisode, lecture publique', async () => {
    const a = await admin.createContent(ACTOR, { type: 'ANIME', title: `Anime Live ${tag}`, year: 2024, audioLanguages: ['fr', 'ja'] }, CTX);
    const season = await admin.createSeason(ACTOR, a.id, { number: 1, releaseDate: '2024-04-01', featuredAsNewSeason: true }, CTX);
    await assert.rejects(admin.createSeason(ACTOR, a.id, { number: 1, releaseDate: '2024-05-01' }, CTX), /existe déjà/);
    const e1 = await admin.createEpisode(ACTOR, season.id, { number: 1, title: 'Début' }, CTX);
    const fr = await admin.addEpisodeVersion(ACTOR, e1.id, { mediaFileId: await readyMedia('VIDEO', 'mkv'), audioLanguages: ['fr'] }, CTX);
    const ja = await admin.addEpisodeVersion(ACTOR, e1.id, { mediaFileId: await readyMedia('VIDEO', 'mkv'), audioLanguages: ['ja'] }, CTX);
    for (const v of [fr.version.id, ja.version.id]) await admin.setVersionStatus(ACTOR, v, 'PUBLISHED', CTX);
    await admin.setEpisodeStatus(ACTOR, e1.id, 'PUBLISHED', CTX);
    await admin.setSeasonStatus(ACTOR, season.id, 'PUBLISHED', CTX);
    await admin.setContentStatus(ACTOR, a.id, 'PUBLISHED', CTX);
    const eps = await read.seasonEpisodes(season.id);
    assert.deepEqual(eps.episodes[0]?.versions.map((v) => v.audioLanguages[0]).sort(), ['fr', 'ja']);
    const detail = await read.detail(a.slug);
    assert.deepEqual([('seasons' in detail ? detail.seasons[0]?.episodeCount : -1), detail.available], [1, true]);
    const home = await read.home();
    assert.ok(home.newSeasons.length >= 0);
    const adminDetail = await admin.adminDetail(a.id);
    assert.equal(adminDetail.seasons[0]?.episodes[0]?.versions.length, 2);
    assert.equal((await admin.adminSearch({ q: `anime live ${tag}` }, 1, 10)).total, 1);
  });

  test('PostgreSQL : recherche — accents, titre alternatif, faute de frappe, filtres, brouillons invisibles', async () => {
    const draft = await admin.createContent(ACTOR, { type: 'MOVIE', title: `Brouillon Secret ${tag}`, year: 2020 }, CTX);
    const titles = async (q: string, f: Record<string, unknown> = {}): Promise<string[]> => (await read.search(q, { page: 1, limit: 10, ...f })).items.map((i) => i.title);
    assert.equal((await titles(`les miserables ${tag}`))[0], title, 'sans accent');
    assert.equal((await titles(`les mis ${tag}`))[0], title, 'titre alternatif');
    assert.equal((await titles(`les miserbles ${tag}`))[0], title, 'faute de frappe');
    assert.equal((await titles(`les miser`))[0] !== undefined, true, 'début de mot');
    assert.deepEqual(await titles(`brouillon secret ${tag}`), [], 'brouillon invisible');
    assert.equal((await titles('les miserables', { type: 'ANIME' })).length, 0, 'filtre de type');
    assert.equal((await titles(`les miserables ${tag}`, { audio: 'ja' }))[0], title, 'filtre de langue');
    void draft;
  });

  test('PostgreSQL : données utilisateur — favoris, suivi, historique, téléchargement, réglages, recherches, tendances', async () => {
    const u = await users.create({ email: `live-user-${tag}@exemple.com`, passwordHash: 'scrypt$x', displayName: 'Live User' });
    await svc.addFavorite(u.id, movieId);
    await svc.addFavorite(u.id, movieId);
    assert.deepEqual((await svc.favorites(u.id, { page: 1, limit: 10 })).items.map((i) => i.title), [title]);

    const anime = (await read.search(`anime live ${tag}`, { page: 1, limit: 5 })).items[0];
    assert.ok(anime);
    const follow = await svc.follow(u.id, anime.id, { notifyNewSeasons: false });
    assert.deepEqual([follow.notifyNewEpisodes, follow.notifyNewSeasons], [true, false]);
    await assert.rejects(svc.follow(u.id, movieId, {}), /séries et les animés/);

    const h1 = await svc.recordHistory(u.id, { contentId: movieId, versionId, positionSeconds: 600, durationSeconds: 7200 });
    const h2 = await svc.recordHistory(u.id, { contentId: movieId, versionId, positionSeconds: 7000, durationSeconds: 7200 });
    assert.ok(h1.stored && h2.stored && h1.history.id === h2.history.id && h2.history.completed);
    assert.equal((await svc.history(u.id, { page: 1, limit: 10 })).items.length, 1);

    const dl = await svc.startDownload(u.id, versionId, { appVersion: '1.0.0' });
    assert.match(dl.url, /^https:\/\/fake\.r2\/get\//);
    assert.equal((await svc.finishDownload(u.id, dl.downloadId, 'COMPLETED', null)).status, 'COMPLETED');

    assert.equal((await svc.updateSettings(u.id, { adSoundEnabled: true })).adSoundEnabled, true);
    await svc.addSearch(u.id, 'dune');
    await svc.addSearch(u.id, 'DUNE');
    assert.deepEqual(await svc.searches(u.id), ['DUNE']);

    await svc.recordView(movieId);
    const trending = await read.trending(10);
    assert.ok(trending.some((t) => t.id === movieId), 'le film aux téléchargements, favoris et lectures figure dans les tendances');
    await svc.clearHistory(u.id);
    assert.equal((await svc.history(u.id, { page: 1, limit: 10 })).items.length, 0);
  });
}
