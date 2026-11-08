import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConflictError, NotFoundError, ValidationError } from '@movieshub/shared';
import { ACTOR, CTX, catalogFixture } from '../testing/catalog-fixture.ts';

const movie = { type: 'MOVIE' as const, title: 'Les Misérables', year: 2012, genres: ['Drame', 'Musical'], audioLanguages: ['fr'], subtitleLanguages: ['fr', 'en'] };

test('création : slug titre+année, genres normalisés, titres alternatifs dédoublonnés, statut DRAFT, audit', async () => {
  const { admin, audit } = catalogFixture();
  const c = await admin.createContent(ACTOR, { ...movie, altTitles: ['Les Mis', 'LES MIS', 'les misérables'], description: '  Un classique  ' }, CTX);
  assert.equal(c.slug, 'les-miserables-2012');
  assert.equal(c.status, 'DRAFT');
  assert.equal(c.description, 'Un classique');
  assert.deepEqual(c.altTitles, ['Les Mis']);
  assert.deepEqual(c.genres.map((g) => g.slug), ['drame', 'musical']);
  assert.deepEqual(c.audioLanguages, ['fr']);
  assert.equal(audit.entries.at(-1)?.action, 'content.create');
});

test('doublons : même titre/année/type refusé (casse et accents ignorés) ; autre type accepté avec slug distinct', async () => {
  const { admin } = catalogFixture();
  const first = await admin.createContent(ACTOR, movie, CTX);
  await assert.rejects(admin.createContent(ACTOR, { ...movie, title: 'LES MISERABLES' }, CTX), (err: unknown) => {
    assert.ok(err instanceof ConflictError);
    assert.equal((err.details as { existing: { id: string } }).existing.id, first.id);
    return true;
  });
  const series = await admin.createContent(ACTOR, { ...movie, type: 'SERIES' }, CTX);
  assert.equal(series.slug, 'les-miserables-2012-series');
  await assert.rejects(admin.createContent(ACTOR, { ...movie, type: 'SERIES' }, CTX), ConflictError);
});

test('création : langue inconnue, année, date et genre invalides refusés', async () => {
  const { admin } = catalogFixture();
  await assert.rejects(admin.createContent(ACTOR, { ...movie, audioLanguages: ['xx'] }, CTX), /inconnue/);
  await assert.rejects(admin.createContent(ACTOR, { ...movie, year: 1500 }, CTX), ValidationError);
  await assert.rejects(admin.createContent(ACTOR, { ...movie, releaseDate: '2012-02-30' }, CTX), ValidationError);
  await assert.rejects(admin.createContent(ACTOR, { ...movie, genres: ['!!!'] }, CTX), ValidationError);
  await assert.rejects(admin.createContent(ACTOR, { ...movie, genres: Array.from({ length: 11 }, (_, i) => `Genre ${i}`) }, CTX), /Maximum 10 genres/);
});

test('personnaliser : sans confirmation = résumé seul (rien n’est modifié) ; avec confirmation = appliqué + audit', async () => {
  const { admin, audit } = catalogFixture();
  const c = await admin.createContent(ACTOR, movie, CTX);
  const changes = { description: 'Nouvelle description', audioLanguages: { add: ['ja'] }, genres: { add: ['Historique'], remove: ['Musical'] } };

  const preview = await admin.customizeContent(ACTOR, c.id, changes, false, CTX);
  assert.equal(preview.applied, false);
  assert.deepEqual(preview.summary.map((l) => l.field), ['description', 'genres', 'audioLanguages']);
  const unchanged = await admin.adminDetail(c.id);
  assert.equal(unchanged.content.description, null);
  assert.deepEqual(unchanged.content.audioLanguages, ['fr']);

  const done = await admin.customizeContent(ACTOR, c.id, changes, true, CTX);
  assert.equal(done.applied, true);
  assert.equal(done.content.description, 'Nouvelle description');
  assert.deepEqual(done.content.audioLanguages, ['fr', 'ja']);
  assert.deepEqual(done.content.genres.map((g) => g.slug), ['drame', 'historique']);
  assert.equal(audit.entries.at(-1)?.action, 'content.update');
});

test('personnaliser : changement vide ou sans effet → rien appliqué même avec confirmation', async () => {
  const { admin, audit } = catalogFixture();
  const c = await admin.createContent(ACTOR, movie, CTX);
  const before = audit.entries.length;
  const out = await admin.customizeContent(ACTOR, c.id, { title: c.title, audioLanguages: { add: ['fr'] } }, true, CTX);
  assert.deepEqual([out.applied, out.summary.length], [false, 0]);
  assert.equal(audit.entries.length, before);
});

test('personnaliser : ne supprime jamais saisons, épisodes, versions ni affiches', async () => {
  const { admin, readyMedia } = catalogFixture();
  const c = await admin.createContent(ACTOR, { type: 'SERIES', title: 'Serie Test', year: 2024, audioLanguages: ['fr'] }, CTX);
  const season = await admin.createSeason(ACTOR, c.id, { number: 1, releaseDate: '2024-01-10' }, CTX);
  const ep = await admin.createEpisode(ACTOR, season.id, { number: 1 }, CTX);
  await admin.addEpisodeVersion(ACTOR, ep.id, { mediaFileId: await readyMedia('VIDEO', 'mkv'), audioLanguages: ['fr'] }, CTX);
  await admin.addPoster(ACTOR, c.id, { mediaFileId: await readyMedia('IMAGE', 'png') }, CTX);

  await admin.customizeContent(ACTOR, c.id, { title: 'Serie Test Renommée', audioLanguages: { remove: ['fr'], add: ['ja'] }, genres: { add: ['Action'] } }, true, CTX);
  const d = await admin.adminDetail(c.id);
  assert.equal(d.seasons.length, 1);
  assert.equal(d.seasons[0]?.episodes.length, 1);
  assert.equal(d.seasons[0]?.episodes[0]?.versions.length, 1);
  assert.equal(d.posters.length, 1);
});

test('statuts : publication, transitions interdites, contenu retiré non modifiable', async () => {
  const { admin, repo } = catalogFixture();
  const c = await admin.createContent(ACTOR, movie, CTX);
  const pub = await admin.setContentStatus(ACTOR, c.id, 'PUBLISHED', CTX);
  assert.equal(pub.status, 'PUBLISHED');
  assert.equal(pub.publishedAt?.toISOString(), '2026-11-01T12:00:00.000Z');
  await assert.rejects(admin.setContentStatus(ACTOR, c.id, 'DRAFT', CTX), ConflictError);
  await admin.setContentStatus(ACTOR, c.id, 'UNPUBLISHED', CTX);
  await admin.setContentStatus(ACTOR, c.id, 'ARCHIVED', CTX);
  await admin.setContentStatus(ACTOR, c.id, 'DRAFT', CTX);
  await repo.updateContent(c.id, { status: 'WITHDRAWN' });
  await assert.rejects(admin.customizeContent(ACTOR, c.id, { title: 'X' }, true, CTX), /retiré/);
  await assert.rejects(admin.setContentStatus(ACTOR, c.id, 'PUBLISHED', CTX), ConflictError);
  await assert.rejects(admin.setContentStatus(ACTOR, '0a1b2c3d-0000-4000-8000-000000000001', 'PUBLISHED', CTX), NotFoundError);
});

test('saisons et épisodes : règles de structure', async () => {
  const { admin } = catalogFixture();
  const film = await admin.createContent(ACTOR, movie, CTX);
  await assert.rejects(admin.createSeason(ACTOR, film.id, { number: 1, releaseDate: '2024-01-01' }, CTX), /pas de saisons/);

  const anime = await admin.createContent(ACTOR, { type: 'ANIME', title: 'Naruto', year: 2002 }, CTX);
  const s1 = await admin.createSeason(ACTOR, anime.id, { number: 1, releaseDate: '2002-10-03', featuredAsNewSeason: true }, CTX);
  assert.equal(s1.releaseDate, '2002-10-03');
  assert.equal(s1.featuredAsNewSeason, true);
  await assert.rejects(admin.createSeason(ACTOR, anime.id, { number: 1, releaseDate: '2003-01-01' }, CTX), ConflictError);
  await assert.rejects(admin.createSeason(ACTOR, anime.id, { number: 2, releaseDate: 'demain' }, CTX), ValidationError);

  const e1 = await admin.createEpisode(ACTOR, s1.id, { number: 1, title: 'Episode 1', releaseNote: 'Note' }, CTX);
  assert.equal(e1.releaseNote, 'Note');
  await assert.rejects(admin.createEpisode(ACTOR, s1.id, { number: 1 }, CTX), ConflictError);
  await assert.rejects(admin.createEpisode(ACTOR, '0a1b2c3d-0000-4000-8000-000000000001', { number: 1 }, CTX), NotFoundError);

  const s1b = await admin.updateSeason(ACTOR, s1.id, { featuredAsNewSeason: false, title: 'Saison 1' }, CTX);
  assert.deepEqual([s1b.featuredAsNewSeason, s1b.title], [false, 'Saison 1']);
  assert.equal((await admin.setSeasonStatus(ACTOR, s1.id, 'PUBLISHED', CTX)).status, 'PUBLISHED');
  assert.equal((await admin.setEpisodeStatus(ACTOR, e1.id, 'PUBLISHED', CTX)).status, 'PUBLISHED');
});

test('versions de film : une langue = une version, l’existante n’est jamais remplacée', async () => {
  const { admin, readyMedia, repo } = catalogFixture();
  const c = await admin.createContent(ACTOR, { ...movie, audioLanguages: ['fr'] }, CTX);
  const fr = await admin.addMovieVersion(ACTOR, c.id, { mediaFileId: await readyMedia('VIDEO', 'mp4'), audioLanguages: ['fr'], label: 'VF 1080p', height: 1080 }, CTX);
  assert.equal(fr.version.status, 'DRAFT');
  assert.deepEqual(fr.version.audioTracks.map((t) => [t.languageCode, t.origin]), [['fr', 'DECLARED']]);
  assert.deepEqual(fr.warnings, []);

  const ja = await admin.addMovieVersion(ACTOR, c.id, { mediaFileId: await readyMedia('VIDEO', 'mkv'), audioLanguages: ['ja'], embeddedSubtitles: [{ language: 'fr', format: 'ASS', streamIndex: 2 }] }, CTX);
  assert.equal(ja.warnings.length, 1, 'seule la langue audio « ja » est non annoncée (le sous-titre « fr » l’est déjà)');
  assert.match(ja.warnings[0] ?? '', /audio.*ja/);
  assert.equal((await repo.listVersionsForContent(c.id)).length, 2);
  assert.ok((await repo.getVersion(fr.version.id))?.audioTracks.some((t) => t.languageCode === 'fr'));
});

test('versions : fichier non prêt, mauvais type, déjà utilisé, série (niveau contenu), pistes audio vides', async () => {
  const { admin, readyMedia } = catalogFixture();
  const film = await admin.createContent(ACTOR, movie, CTX);
  await assert.rejects(admin.addMovieVersion(ACTOR, film.id, { mediaFileId: await readyMedia('VIDEO', 'mp4', 'PENDING'), audioLanguages: ['fr'] }, CTX), ConflictError);
  await assert.rejects(admin.addMovieVersion(ACTOR, film.id, { mediaFileId: await readyMedia('IMAGE', 'png'), audioLanguages: ['fr'] }, CTX), /Type de fichier incorrect/);
  await assert.rejects(admin.addMovieVersion(ACTOR, film.id, { mediaFileId: await readyMedia('VIDEO', 'mp4'), audioLanguages: [] }, CTX), /piste audio/);
  await assert.rejects(admin.addMovieVersion(ACTOR, film.id, { mediaFileId: '0a1b2c3d-0000-4000-8000-000000000001', audioLanguages: ['fr'] }, CTX), NotFoundError);

  const media = await readyMedia('VIDEO', 'mp4');
  await admin.addMovieVersion(ACTOR, film.id, { mediaFileId: media, audioLanguages: ['fr'] }, CTX);
  await assert.rejects(admin.addMovieVersion(ACTOR, film.id, { mediaFileId: media, audioLanguages: ['fr'] }, CTX), /déjà utilisé/);

  const serie = await admin.createContent(ACTOR, { type: 'SERIES', title: 'S', year: 2020 }, CTX);
  await assert.rejects(admin.addMovieVersion(ACTOR, serie.id, { mediaFileId: await readyMedia('VIDEO', 'mp4'), audioLanguages: ['fr'] }, CTX), /épisodes/);
});

test('épisodes multilingues : un seul épisode, une version par langue, ajout progressif', async () => {
  const { admin, readyMedia, repo } = catalogFixture();
  const c = await admin.createContent(ACTOR, { type: 'ANIME', title: 'Anime X', year: 2023, audioLanguages: ['fr', 'ja'] }, CTX);
  const s = await admin.createSeason(ACTOR, c.id, { number: 1, releaseDate: '2023-04-01' }, CTX);
  const e1 = await admin.createEpisode(ACTOR, s.id, { number: 1 }, CTX);
  const e2 = await admin.createEpisode(ACTOR, s.id, { number: 2 }, CTX);
  const e3 = await admin.createEpisode(ACTOR, s.id, { number: 3 }, CTX);
  for (const [ep, lang] of [[e1, 'fr'], [e2, 'fr'], [e3, 'fr'], [e1, 'ja'], [e3, 'ja']] as const) {
    await admin.addEpisodeVersion(ACTOR, ep.id, { mediaFileId: await readyMedia('VIDEO', 'mkv'), audioLanguages: [lang] }, CTX);
  }
  assert.equal((await repo.listEpisodes(s.id)).length, 3);
  const langs = async (id: string) => (await repo.listVersionsForEpisode(id)).flatMap((v) => v.audioTracks.map((t) => t.languageCode)).sort();
  assert.deepEqual([await langs(e1.id), await langs(e2.id), await langs(e3.id)], [['fr', 'ja'], ['fr'], ['fr', 'ja']]);
});

test('sous-titres externes : format déduit du fichier, fichier réutilisé refusé, version publiée par statut', async () => {
  const { admin, readyMedia } = catalogFixture();
  const c = await admin.createContent(ACTOR, movie, CTX);
  const { version } = await admin.addMovieVersion(ACTOR, c.id, { mediaFileId: await readyMedia('VIDEO', 'mp4'), audioLanguages: ['fr'] }, CTX);
  const sub = await readyMedia('SUBTITLE', 'vtt');
  const v = await admin.addExternalSubtitle(ACTOR, version.id, { mediaFileId: sub, language: 'EN', isDefault: true }, CTX);
  assert.deepEqual(v.subtitleTracks.map((s) => [s.languageCode, s.source, s.format, s.isDefault]), [['en', 'EXTERNAL', 'WEBVTT', true]]);
  await assert.rejects(admin.addExternalSubtitle(ACTOR, version.id, { mediaFileId: sub, language: 'en' }, CTX), /déjà utilisé/);
  await assert.rejects(admin.addExternalSubtitle(ACTOR, version.id, { mediaFileId: await readyMedia('VIDEO', 'mp4'), language: 'en' }, CTX), /Type de fichier incorrect/);
  const pub = await admin.setVersionStatus(ACTOR, version.id, 'PUBLISHED', CTX);
  assert.deepEqual([pub.status, pub.publishedAt !== null], ['PUBLISHED', true]);
});

test('affiches : la 1re devient principale ; changer de principale archive l’ancienne sans rien supprimer ; restauration', async () => {
  const { admin, readyMedia, repo } = catalogFixture();
  const c = await admin.createContent(ACTOR, movie, CTX);
  const p1 = await admin.addPoster(ACTOR, c.id, { mediaFileId: await readyMedia('IMAGE', 'jpg') }, CTX);
  assert.equal((await repo.getContent(c.id))?.primaryPosterId, p1.id);
  const p2 = await admin.addPoster(ACTOR, c.id, { mediaFileId: await readyMedia('IMAGE', 'png') }, CTX);
  const promo = await admin.addPoster(ACTOR, c.id, { mediaFileId: await readyMedia('IMAGE', 'webp'), kind: 'PROMOTIONAL' }, CTX);
  assert.equal((await repo.getContent(c.id))?.primaryPosterId, p1.id);

  await admin.setPrimaryPoster(ACTOR, p2.id, CTX);
  const list = await repo.listPosters(c.id);
  assert.equal(list.length, 3);
  assert.equal((await repo.getContent(c.id))?.primaryPosterId, p2.id);
  assert.ok((await repo.getPoster(p1.id))?.archivedAt, 'l’ancienne principale est archivée');
  assert.equal((await repo.getPoster(promo.id))?.archivedAt, null, 'les autres images ne sont pas touchées');

  await assert.rejects(admin.setPrimaryPoster(ACTOR, promo.id, CTX), ValidationError);
  await assert.rejects(admin.archivePoster(ACTOR, p2.id, CTX), /principale/);
  await admin.restorePoster(ACTOR, p1.id, CTX);
  assert.equal((await repo.getPoster(p1.id))?.archivedAt, null);
  await admin.setPrimaryPoster(ACTOR, p1.id, CTX);
  assert.ok((await repo.getPoster(p2.id))?.archivedAt);
  await admin.archivePoster(ACTOR, promo.id, CTX);
  assert.ok((await repo.getPoster(promo.id))?.archivedAt);
});

test('affiches : fichier de mauvais type ou déjà utilisé refusé ; promo ne peut pas être principale', async () => {
  const { admin, readyMedia } = catalogFixture();
  const c = await admin.createContent(ACTOR, movie, CTX);
  await assert.rejects(admin.addPoster(ACTOR, c.id, { mediaFileId: await readyMedia('VIDEO', 'mp4') }, CTX), /Type de fichier incorrect/);
  const img = await readyMedia('IMAGE', 'png');
  await admin.addPoster(ACTOR, c.id, { mediaFileId: img }, CTX);
  await assert.rejects(admin.addPoster(ACTOR, c.id, { mediaFileId: img }, CTX), /déjà utilisé/);
  await assert.rejects(admin.addPoster(ACTOR, c.id, { mediaFileId: await readyMedia('IMAGE', 'png'), kind: 'PROMOTIONAL', makePrimary: true }, CTX), ValidationError);
});

test('bandes-annonces : principale automatique, changement sans suppression, saison, archivage, ordre', async () => {
  const { admin, readyMedia, repo } = catalogFixture();
  const c = await admin.createContent(ACTOR, { type: 'SERIES', title: 'Série T', year: 2022 }, CTX);
  const season = await admin.createSeason(ACTOR, c.id, { number: 1, releaseDate: '2022-01-01' }, CTX);

  const t1 = await admin.addTrailer(ACTOR, c.id, { mediaFileId: await readyMedia('TRAILER_VIDEO', 'mp4'), title: 'Teaser' }, CTX);
  const t2 = await admin.addTrailer(ACTOR, c.id, { externalUrl: 'https://www.youtube.com/watch?v=abc' }, CTX);
  assert.equal((await repo.getContent(c.id))?.primaryTrailerId, t1.id);
  await admin.setPrimaryTrailer(ACTOR, t2.id, CTX);
  assert.equal((await repo.getContent(c.id))?.primaryTrailerId, t2.id);
  assert.equal((await repo.getTrailer(t1.id))?.archivedAt, null, 'l’ancienne principale reste, simplement secondaire');

  const st = await admin.addTrailer(ACTOR, c.id, { seasonId: season.id, externalUrl: 'https://vimeo.com/123456' }, CTX);
  assert.equal((await repo.getSeason(season.id))?.primaryTrailerId, st.id);
  assert.equal((await repo.getContent(c.id))?.primaryTrailerId, t2.id, 'le pointeur du contenu est inchangé');

  await assert.rejects(admin.archiveTrailer(ACTOR, t2.id, CTX), /principale/);
  await admin.archiveTrailer(ACTOR, t1.id, CTX);
  assert.ok((await repo.getTrailer(t1.id))?.archivedAt);
  await assert.rejects(admin.setPrimaryTrailer(ACTOR, t1.id, CTX), /archivée/);
  await admin.restoreTrailer(ACTOR, t1.id, CTX);
  assert.equal((await repo.getTrailer(t1.id))?.archivedAt, null);

  await admin.reorderTrailers(ACTOR, c.id, null, [t2.id, t1.id], CTX);
  assert.deepEqual((await repo.listTrailers(c.id)).filter((t) => t.seasonId === null).map((t) => t.id), [t2.id, t1.id]);
  await assert.rejects(admin.reorderTrailers(ACTOR, c.id, null, [t1.id], CTX), ValidationError);
  await assert.rejects(admin.reorderTrailers(ACTOR, c.id, null, [t1.id, t1.id], CTX), ValidationError);
});

test('bandes-annonces : validations (source unique, lien https, saison d’un autre contenu, type de fichier)', async () => {
  const { admin, readyMedia } = catalogFixture();
  const a = await admin.createContent(ACTOR, { type: 'SERIES', title: 'A', year: 2020 }, CTX);
  const b = await admin.createContent(ACTOR, { type: 'SERIES', title: 'B', year: 2020 }, CTX);
  const sb = await admin.createSeason(ACTOR, b.id, { number: 1, releaseDate: '2020-01-01' }, CTX);
  await assert.rejects(admin.addTrailer(ACTOR, a.id, {}, CTX), ValidationError);
  await assert.rejects(admin.addTrailer(ACTOR, a.id, { mediaFileId: await readyMedia('TRAILER_VIDEO', 'mp4'), externalUrl: 'https://youtu.be/x.y' }, CTX), ValidationError);
  await assert.rejects(admin.addTrailer(ACTOR, a.id, { externalUrl: 'http://pas-https.com/x' }, CTX), ValidationError);
  await assert.rejects(admin.addTrailer(ACTOR, a.id, { seasonId: sb.id, externalUrl: 'https://youtu.be/x.y' }, CTX), /n’appartient pas/);
  await assert.rejects(admin.addTrailer(ACTOR, a.id, { mediaFileId: await readyMedia('VIDEO', 'mp4') }, CTX), /Type de fichier incorrect/);
});

test('recherche administrateur : brouillons inclus, titres alternatifs, sans accent ni casse', async () => {
  const { admin } = catalogFixture();
  await admin.createContent(ACTOR, { type: 'ANIME', title: 'Shingeki no Kyojin', year: 2013, altTitles: ['Attack on Titan', 'L’Attaque des Titans'] }, CTX);
  await admin.createContent(ACTOR, { type: 'MOVIE', title: 'Interstellar', year: 2014 }, CTX);
  assert.equal((await admin.adminSearch({ q: 'attaque des titans' }, 1, 20)).total, 1);
  assert.equal((await admin.adminSearch({ q: 'ATTACK' }, 1, 20)).items[0]?.title, 'Shingeki no Kyojin');
  assert.equal((await admin.adminSearch({}, 1, 20)).total, 2);
  assert.equal((await admin.adminSearch({ type: 'MOVIE' }, 1, 20)).total, 1);
  assert.equal((await admin.adminSearch({ status: 'PUBLISHED' }, 1, 20)).total, 0);
});
