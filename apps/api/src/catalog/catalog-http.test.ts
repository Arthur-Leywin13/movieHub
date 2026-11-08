import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { UploadService } from '../admin/upload-service.ts';
import { buildApp } from '../app.ts';
import { ActorResolver } from '../auth/actor.ts';
import { AuthService } from '../auth/auth-service.ts';
import { createHttpServer } from '../http/server.ts';
import { catalogFixture } from '../testing/catalog-fixture.ts';
import { MemoryAdminRepo, MemorySessionRepo, MemoryUserRepo } from '../testing/memory-repos.ts';

const BOT = 'b'.repeat(40);
const fx = catalogFixture();
const users = new MemoryUserRepo();
const admins = new MemoryAdminRepo();
const auth = new AuthService({ users, sessions: new MemorySessionRepo() }, { accessSecret: 'a'.repeat(40), refreshPepper: 'p'.repeat(40), passwordParams: { N: 2 ** 10, r: 8, p: 1 } });
const actors = new ActorResolver({ auth, admins, botServiceToken: BOT });
const uploads = new UploadService({ r2: fx.r2, media: fx.media, audit: fx.audit, bucket: 'b' });
const server = createHttpServer({ router: buildApp({ auth, actors, uploads, catalogAdmin: fx.admin, catalogRead: fx.read }) });
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

async function login(email: string): Promise<{ token: string; userId: string }> {
  const r = await auth.register({ email, password: 'Motdepasse-Solide1', displayName: 'Test' }, { ip: `ip-${email}`, userAgent: null });
  return { token: r.accessToken, userId: r.user.id };
}

const editor = await login('editor@exemple.com');
admins.admins.push({ id: 'adm-e', userId: editor.userId, telegramId: 4242n, role: 'EDITOR', isActive: true });
const plain = await login('simple@exemple.com');
const moderator = await login('modo@exemple.com');
admins.admins.push({ id: 'adm-m', userId: moderator.userId, telegramId: null, role: 'MODERATOR', isActive: true });
const T = editor.token;
let movieId = '';
let movieSlug = '';

test('accès : lecture publique sans connexion ; administration refusée sans droits', async () => {
  assert.equal((await call('GET', '/contents')).status, 200);
  assert.equal((await call('GET', '/genres')).status, 200);
  assert.equal((await call('GET', '/languages')).json['languages'].length, 5);
  const body = { type: 'MOVIE', title: 'X' };
  assert.equal((await call('POST', '/admin/contents', { body })).status, 401);
  assert.equal((await call('POST', '/admin/contents', { body, token: plain.token })).status, 403);
  assert.equal((await call('POST', '/admin/contents', { body, token: moderator.token })).status, 403);
  assert.equal((await call('GET', '/admin/contents', { token: moderator.token })).status, 403);
});

test('film : création, doublon (409 avec l’existant), personnalisation avec résumé puis confirmation', async () => {
  const created = await call('POST', '/admin/contents', { token: T, body: { type: 'MOVIE', title: 'Dune : Deuxième partie', year: 2024, releaseDate: '2024-02-28', genres: ['Science-fiction', 'Aventure'], audioLanguages: ['fr'], subtitleLanguages: ['fr', 'en'], altTitles: ['Dune: Part Two'] } });
  assert.equal(created.status, 201);
  movieId = created.json['content'].id;
  movieSlug = created.json['content'].slug;
  assert.equal(movieSlug, 'dune-deuxieme-partie-2024');

  const dup = await call('POST', '/admin/contents', { token: T, body: { type: 'MOVIE', title: 'DUNE deuxième partie', year: 2024 } });
  assert.equal(dup.status, 409);
  assert.equal(dup.json['error'].details.existing.id, movieId);

  const preview = await call('PATCH', `/admin/contents/${movieId}`, { token: T, body: { description: 'Paul Atréides s’unit aux Fremen.', audioLanguages: { add: ['ja'] } } });
  assert.deepEqual([preview.status, preview.json['applied']], [200, false]);
  assert.deepEqual(preview.json['summary'].map((l: J) => l['field']), ['description', 'audioLanguages']);
  assert.equal((await call('GET', `/admin/contents/${movieId}`, { token: T })).json['content'].description, null);

  const applied = await call('PATCH', `/admin/contents/${movieId}`, { token: T, body: { description: 'Paul Atréides s’unit aux Fremen.', audioLanguages: { add: ['ja'] }, confirm: true } });
  assert.deepEqual([applied.status, applied.json['applied']], [200, true]);
  assert.deepEqual(applied.json['content'].audioLanguages, ['fr', 'ja']);
});

test('film : affiche, bande-annonce, version française puis version japonaise ajoutée plus tard', async () => {
  const poster = await call('POST', `/admin/contents/${movieId}/posters`, { token: T, body: { mediaFileId: await fx.readyMedia('IMAGE', 'jpg') } });
  assert.equal(poster.status, 201);
  const trailer = await call('POST', `/admin/contents/${movieId}/trailers`, { token: T, body: { externalUrl: 'https://www.youtube.com/watch?v=abc123', title: 'Officielle' } });
  assert.equal(trailer.status, 201);

  const vf = await call('POST', `/admin/contents/${movieId}/versions`, { token: T, body: { mediaFileId: await fx.readyMedia('VIDEO', 'mp4'), audioLanguages: ['fr'], label: 'VF 1080p', height: 1080, width: 1920 } });
  assert.equal(vf.status, 201);
  assert.deepEqual(vf.json['warnings'], []);
  const vfId = vf.json['version'].id as string;

  const vo = await call('POST', `/admin/contents/${movieId}/versions`, { token: T, body: { mediaFileId: await fx.readyMedia('VIDEO', 'mkv'), audioLanguages: ['ja'], label: 'VO', embeddedSubtitles: [{ language: 'fr', format: 'ASS', streamIndex: 2 }] } });
  assert.equal(vo.status, 201);
  const voId = vo.json['version'].id as string;

  const sub = await call('POST', `/admin/versions/${vfId}/subtitles`, { token: T, body: { mediaFileId: await fx.readyMedia('SUBTITLE', 'srt'), language: 'en' } });
  assert.equal(sub.status, 201);
  assert.equal(sub.json['version'].subtitleTracks[0].format, 'SRT');

  // rien n'est public tant que rien n'est publié
  assert.equal((await call('GET', `/contents/${movieSlug}`)).status, 404);
  assert.equal((await call('GET', '/contents')).json['total'], 0);

  await call('POST', `/admin/versions/${vfId}/status`, { token: T, body: { status: 'PUBLISHED' } });
  assert.equal((await call('POST', `/admin/contents/${movieId}/status`, { token: T, body: { status: 'PUBLISHED' } })).status, 200);

  const detail = await call('GET', `/contents/${movieSlug}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.json['available'], true);
  assert.equal(detail.json['versions'].length, 1, 'la version japonaise (brouillon) reste invisible');
  assert.deepEqual(detail.json['versions'][0].audioLanguages, ['fr']);
  assert.deepEqual(detail.json['versions'][0].subtitles, [{ language: 'en', source: 'EXTERNAL', format: 'SRT' }]);
  assert.match(detail.json['poster'].url, /^https:\/\/fake\.r2\/get\/image\/2026\/11\/.+\.jpg\?exp=3600/);
  assert.deepEqual([detail.json['trailer'].external, detail.json['trailer'].url], [true, 'https://www.youtube.com/watch?v=abc123']);
  assert.equal((await call('GET', `/contents/${movieId}`)).status, 200, 'accessible aussi par identifiant');
  for (const secret of ['mediaFileId', 'objectKey', 'multipart', 'passwordHash']) assert.ok(!detail.raw.includes(secret), `fuite : ${secret}`);

  // publication de la nouvelle langue : la version française n'est jamais remplacée
  await call('POST', `/admin/versions/${voId}/status`, { token: T, body: { status: 'PUBLISHED' } });
  const after = (await call('GET', `/contents/${movieSlug}`)).json['versions'] as J[];
  assert.deepEqual(after.map((v) => v['audioLanguages'][0]).sort(), ['fr', 'ja']);
});

test('film : archivage de l’affiche principale, restauration, bande-annonce secondaire', async () => {
  const p2 = (await call('POST', `/admin/contents/${movieId}/posters`, { token: T, body: { mediaFileId: await fx.readyMedia('IMAGE', 'png') } })).json['poster'];
  const before = (await call('GET', `/contents/${movieSlug}`)).json;
  assert.equal(before['images'].length, 1, 'la nouvelle affiche est visible comme image secondaire');
  assert.equal((await call('POST', `/admin/posters/${p2.id}/primary`, { token: T })).status, 200);
  const swapped = (await call('GET', `/contents/${movieSlug}`)).json;
  assert.match(swapped['poster'].url, /\.png/);
  assert.equal(swapped['images'].length, 0, 'l’ancienne principale est archivée, donc masquée');
  const admin = (await call('GET', `/admin/contents/${movieId}`, { token: T })).json;
  const archived = admin['posters'].find((p: J) => p['archivedAt'] !== null);
  assert.ok(archived, 'mais conservée côté administration');
  assert.equal((await call('POST', `/admin/posters/${archived.id}/restore`, { token: T })).status, 204);
  assert.equal((await call('GET', `/contents/${movieSlug}`)).json['images'].length, 1);

  const t2 = (await call('POST', `/admin/contents/${movieId}/trailers`, { token: T, body: { mediaFileId: await fx.readyMedia('TRAILER_VIDEO', 'mp4') } })).json['trailer'];
  const d = (await call('GET', `/contents/${movieSlug}`)).json;
  assert.equal(d['otherTrailers'].length, 1);
  assert.match(d['otherTrailers'][0].url, /^https:\/\/fake\.r2\/get\/trailer\//);
  assert.equal((await call('POST', `/admin/trailers/${t2.id}/archive`, { token: T })).status, 204);
  assert.equal((await call('GET', `/contents/${movieSlug}`)).json['otherTrailers'].length, 0);
});

test('liste publique : filtres (genre, langue, type, année), tri, pagination, jamais de brouillon', async () => {
  const mk = async (title: string, year: number, releaseDate: string, extra: J = {}) => {
    const c = (await call('POST', '/admin/contents', { token: T, body: { type: 'MOVIE', title, year, releaseDate, genres: ['Action'], audioLanguages: ['fr'], ...extra } })).json['content'];
    await call('POST', `/admin/contents/${c.id}/status`, { token: T, body: { status: 'PUBLISHED' } });
    return c.id as string;
  };
  await mk('Film A', 2023, '2023-05-01');
  await mk('Film B', 2025, '2025-01-01', { audioLanguages: ['en'] });
  await mk('Film C', 2024, '2024-03-01');
  await call('POST', '/admin/contents', { token: T, body: { type: 'MOVIE', title: 'Film Brouillon', year: 2026 } });

  const all = await call('GET', '/contents?limit=50');
  assert.equal(all.json['total'], 4);
  assert.deepEqual(all.json['items'].map((i: J) => i['title']), ['Film B', 'Film C', 'Dune : Deuxième partie', 'Film A'], 'tri par date de sortie officielle décroissante');
  assert.ok(!all.raw.includes('Brouillon'));
  assert.equal(all.json['items'][3].posterUrl, null);

  const page2 = await call('GET', '/contents?limit=2&page=2');
  assert.deepEqual(page2.json['items'].map((i: J) => i['title']), ['Dune : Deuxième partie', 'Film A']);
  assert.equal(page2.json['total'], 4);

  assert.equal((await call('GET', '/contents?audio=en')).json['total'], 1);
  assert.equal((await call('GET', '/contents?audio=EN')).json['total'], 1, 'insensible à la casse');
  assert.equal((await call('GET', '/contents?subtitle=en')).json['total'], 1);
  assert.equal((await call('GET', '/contents?genre=action')).json['total'], 3);
  assert.equal((await call('GET', '/contents?year=2024')).json['total'], 2, 'Film C et Dune');
  assert.equal((await call('GET', '/contents?type=SERIES')).json['total'], 0);
  assert.deepEqual((await call('GET', '/contents?sort=title&limit=1')).json['items'].map((i: J) => i['title']), ['Dune : Deuxième partie']);
});

test('série : saisons et épisodes publiés progressivement, seuls les éléments publiés sont visibles', async () => {
  const c = (await call('POST', '/admin/contents', { token: T, body: { type: 'ANIME', title: 'Anime Test', year: 2024, audioLanguages: ['fr', 'ja'] } })).json['content'];
  await call('POST', `/admin/contents/${c.id}/status`, { token: T, body: { status: 'PUBLISHED' } });
  const s1 = (await call('POST', `/admin/contents/${c.id}/seasons`, { token: T, body: { number: 1, releaseDate: '2024-04-01', featuredAsNewSeason: true } })).json['season'];
  const e1 = (await call('POST', `/admin/seasons/${s1.id}/episodes`, { token: T, body: { number: 1, title: 'Début', releaseNote: 'Bienvenue' } })).json['episode'];
  const e2 = (await call('POST', `/admin/seasons/${s1.id}/episodes`, { token: T, body: { number: 2 } })).json['episode'];
  const vf = (await call('POST', `/admin/episodes/${e1.id}/versions`, { token: T, body: { mediaFileId: await fx.readyMedia('VIDEO', 'mkv'), audioLanguages: ['fr'] } })).json['version'];
  const vo = (await call('POST', `/admin/episodes/${e1.id}/versions`, { token: T, body: { mediaFileId: await fx.readyMedia('VIDEO', 'mkv'), audioLanguages: ['ja'] } })).json['version'];

  assert.deepEqual((await call('GET', `/contents/${c.slug}`)).json['seasons'], [], 'saison non publiée = invisible');
  assert.equal((await call('GET', `/seasons/${s1.id}/episodes`)).status, 404);

  await call('POST', `/admin/seasons/${s1.id}/status`, { token: T, body: { status: 'PUBLISHED' } });
  let detail = (await call('GET', `/contents/${c.slug}`)).json;
  assert.equal(detail['seasons'].length, 1);
  assert.deepEqual([detail['seasons'][0].episodeCount, detail['seasons'][0].featuredAsNewSeason, detail['available']], [0, true, false]);

  await call('POST', `/admin/episodes/${e1.id}/status`, { token: T, body: { status: 'PUBLISHED' } });
  await call('POST', `/admin/versions/${vf.id}/status`, { token: T, body: { status: 'PUBLISHED' } });
  detail = (await call('GET', `/contents/${c.slug}`)).json;
  assert.deepEqual([detail['seasons'][0].episodeCount, detail['available']], [1, true]);

  const eps = (await call('GET', `/seasons/${s1.id}/episodes`)).json;
  assert.equal(eps['episodes'].length, 1, 'l’épisode 2 (brouillon) est invisible');
  assert.equal(eps['episodes'][0].releaseNote, 'Bienvenue');
  assert.deepEqual(eps['episodes'][0].versions.map((v: J) => v['audioLanguages']), [['fr']], 'la version japonaise (brouillon) est invisible');

  await call('POST', `/admin/versions/${vo.id}/status`, { token: T, body: { status: 'PUBLISHED' } });
  await call('POST', `/admin/episodes/${e2.id}/status`, { token: T, body: { status: 'PUBLISHED' } });
  const full = (await call('GET', `/seasons/${s1.id}/episodes`)).json;
  assert.deepEqual(full['episodes'].map((e: J) => e['number']), [1, 2]);
  assert.deepEqual(full['episodes'][0].versions.map((v: J) => v['audioLanguages'][0]).sort(), ['fr', 'ja']);
});

test('contenu retiré : message dédié (410) ; retiré ou non publié absent de la liste', async () => {
  const c = (await call('POST', '/admin/contents', { token: T, body: { type: 'MOVIE', title: 'A Retirer', year: 2020 } })).json['content'];
  await call('POST', `/admin/contents/${c.id}/status`, { token: T, body: { status: 'PUBLISHED' } });
  assert.equal((await call('GET', `/contents/${c.slug}`)).status, 200);
  await fx.repo.updateContent(c.id, { status: 'WITHDRAWN' });
  const gone = await call('GET', `/contents/${c.slug}`);
  assert.equal(gone.status, 410);
  assert.equal(gone.json['error'].message, 'Ce contenu a été retiré de l’application.');
  assert.ok(!(await call('GET', '/contents?limit=50')).raw.includes('A Retirer'));

  const draft = (await call('POST', '/admin/contents', { token: T, body: { type: 'MOVIE', title: 'Brouillon Secret', year: 2020 } })).json['content'];
  assert.equal((await call('GET', `/contents/${draft.slug}`)).status, 404);
  assert.equal((await call('GET', `/contents/${draft.id}`)).status, 404);
});

test('validation : types, identifiants, statuts, transitions et paramètres', async () => {
  assert.equal((await call('POST', '/admin/contents', { token: T, body: { type: 'DOCUMENTAIRE', title: 'X' } })).status, 400);
  assert.equal((await call('POST', '/admin/contents', { token: T, body: ['x'] })).status, 400);
  assert.equal((await call('POST', '/admin/contents', { token: T, body: { type: 'MOVIE' } })).status, 400);
  assert.equal((await call('GET', '/admin/contents/pas-un-uuid', { token: T })).status, 400);
  assert.equal((await call('GET', '/admin/contents/0a1b2c3d-0000-4000-8000-000000000001', { token: T })).status, 404);
  assert.equal((await call('POST', `/admin/contents/${movieId}/status`, { token: T, body: { status: 'WITHDRAWN' } })).status, 400, 'le retrait a son propre parcours');
  assert.equal((await call('POST', `/admin/contents/${movieId}/status`, { token: T, body: { status: 'SCHEDULED' } })).status, 400);
  assert.equal((await call('POST', `/admin/contents/${movieId}/status`, { token: T, body: { status: 'DRAFT' } })).status, 409, 'PUBLISHED → DRAFT interdit');
  assert.equal((await call('GET', '/contents?page=0')).status, 400);
  assert.equal((await call('GET', '/contents?limit=100')).status, 400);
  assert.equal((await call('GET', '/contents?type=XYZ')).status, 400);
  assert.equal((await call('GET', '/contents?sort=prix')).status, 400);
  assert.equal((await call('POST', `/admin/contents/${movieId}/versions`, { token: T, body: { mediaFileId: 'abc', audioLanguages: ['fr'] } })).status, 400);
  assert.equal((await call('POST', `/admin/contents/${movieId}/trailers`, { token: T, body: { externalUrl: 'http://pas-https.com/x' } })).status, 400);
});

test('bot : un administrateur Telegram peut gérer le catalogue ; un id inconnu est refusé ; audit avec la bonne source', async () => {
  const headers = { authorization: `Bot ${BOT}`, 'x-telegram-user-id': '4242' };
  const ok = await call('POST', '/admin/contents', { headers, body: { type: 'MOVIE', title: 'Ajout par le bot', year: 2026 } });
  assert.equal(ok.status, 201);
  assert.equal((await call('POST', '/admin/contents', { headers: { ...headers, 'x-telegram-user-id': '1' }, body: { type: 'MOVIE', title: 'Z', year: 2026 } })).status, 403);
  const last = fx.audit.entries.filter((e) => e.action === 'content.create').at(-1);
  assert.deepEqual([last?.source, last?.adminId], ['TELEGRAM_BOT', 'adm-e']);
});

test('recherche administrateur par HTTP : brouillons inclus, titre alternatif', async () => {
  const r = await call('GET', '/admin/contents?q=dune%20part%20two', { token: T });
  assert.equal(r.status, 200);
  assert.equal(r.json['items'][0].slug, 'dune-deuxieme-partie-2024');
  assert.equal((await call('GET', '/admin/contents?status=DRAFT&limit=50', { token: T })).json['items'].every((i: J) => i['status'] === 'DRAFT'), true);
});

test('recherche publique : accents, majuscules, titre alternatif, faute de frappe, filtres ; jamais de brouillon ni de contenu retiré', async () => {
  const titles = async (qs: string): Promise<string[]> => ((await call('GET', `/search?${qs}`)).json['items'] as J[]).map((i) => i['title']);
  assert.equal((await titles('q=dune'))[0], 'Dune : Deuxième partie');
  assert.equal((await titles('q=DEUXIEME%20PARTIE'))[0], 'Dune : Deuxième partie', 'sans accent ni casse');
  assert.equal((await titles('q=dune%20part%20two'))[0], 'Dune : Deuxième partie', 'titre alternatif');
  assert.equal((await titles('q=dune%20deuxime%20partie'))[0], 'Dune : Deuxième partie', 'faute de frappe');
  assert.equal((await titles('q=dun'))[0], 'Dune : Deuxième partie', 'début de mot');
  assert.deepEqual(await titles('q=Brouillon%20Secret'), [], 'un brouillon est invisible');
  assert.ok(!(await titles('q=retirer')).includes('A Retirer'), 'un contenu retiré est invisible');
  assert.deepEqual(await titles('q=anime%20test&type=ANIME'), ['Anime Test']);
  assert.deepEqual(await titles('q=anime%20test&type=MOVIE'), []);
  assert.equal((await titles('q=zzzzqqqq')).length, 0);
  const page = (await call('GET', '/search?q=film&limit=2&page=1')).json;
  assert.ok(page['items'].length <= 2 && page['total'] >= 3);
  assert.equal((await call('GET', '/search?q=a')).status, 400);
  assert.equal((await call('GET', '/search')).status, 400);
  assert.equal((await call('GET', '/search?q=dune&limit=100')).status, 400);
  assert.equal((await call('GET', '/search?q=dune&type=XYZ')).status, 400);
});
