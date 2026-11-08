import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FileRef } from './files.ts';
import { FileSessionStore, newSession } from './session.ts';
import { normalizeFile } from './steps.ts';
import { startApiHarness } from './testing/harness.ts';
import { makeBot } from './testing/make-bot.ts';
import { UploadFailed } from './uploader.ts';

const MiB = 1024 * 1024;
const ref = (o: Partial<FileRef>): FileRef => ({ fileId: 'x', name: 'f', size: 1000, mime: null, media: 'document', ...o });
const MAX = 2000 * MiB;

test('fichiers : photo → jpg, extension déduite du type MIME, mauvais type refusé', () => {
  const photo = normalizeFile(ref({ media: 'photo', name: 'affiche.jpg' }), 'image', MAX);
  assert.deepEqual(photo.ok && photo.file.name, 'affiche.jpg');
  const png = normalizeFile(ref({ name: 'Affiche.PNG' }), 'image', MAX);
  assert.deepEqual(png.ok && png.file.name, 'Affiche.png');
  const mime = normalizeFile(ref({ name: 'image', mime: 'image/webp' }), 'image', MAX);
  assert.deepEqual(mime.ok && mime.file.name, 'image.webp');
  const vid = normalizeFile(ref({ media: 'video', name: 'video.mp4' }), 'video', MAX);
  assert.equal(vid.ok, true);
  assert.equal(normalizeFile(ref({ media: 'photo' }), 'video', MAX).ok, false);
  assert.equal(normalizeFile(ref({ name: 'film.exe' }), 'video', MAX).ok, false);
  assert.equal(normalizeFile(ref({ media: 'video', name: 'x.mp4' }), 'subtitle', MAX).ok, false);
  assert.equal(normalizeFile(ref({ name: 'fr.srt' }), 'subtitle', MAX).ok, true);
  assert.equal(normalizeFile(ref({ name: 'notes.txt' }), 'subtitle', MAX).ok, false);
});

test('fichiers : tailles limites (image 25 Mo, sous-titres 5 Mo, vidéo selon la limite du bot)', () => {
  assert.equal(normalizeFile(ref({ name: 'a.png', size: 26 * MiB }), 'image', MAX).ok, false);
  assert.equal(normalizeFile(ref({ name: 'a.png', size: 24 * MiB }), 'image', MAX).ok, true);
  assert.equal(normalizeFile(ref({ name: 'a.srt', size: 6 * MiB }), 'subtitle', MAX).ok, false);
  assert.equal(normalizeFile(ref({ name: 'f.mkv', size: 2001 * MiB }), 'video', MAX).ok, false);
  assert.equal(normalizeFile(ref({ name: 'f.mkv', size: 2000 * MiB }), 'video', MAX).ok, true);
  assert.equal(normalizeFile(ref({ name: 'f.mkv', size: 300 * MiB }), 'video', 100 * MiB).ok, false);
});

test('sessions : écriture atomique, relecture, suppression, identifiant invalide refusé', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'movieshub-sessions-'));
  after(() => rm(dir, { recursive: true, force: true }));
  const store = new FileSessionStore(dir);
  const s = newSession(42, 42);
  s.flow = 'add:MOVIE';
  s.phase = 'wizard';
  s.stack = ['title', 'year'];
  s.data = { title: 'Test' };
  await store.set(s);
  assert.deepEqual((await store.get(42))?.stack, ['title', 'year']);
  assert.deepEqual((await readdir(dir)).filter((f) => f.endsWith('.tmp')), []);
  assert.equal(((await readFile(join(dir, '42.json'), 'utf8')).includes('Test')), true);
  await store.delete(42);
  assert.equal(await store.get(42), null);
  await assert.rejects(store.set({ ...s, userId: -1 }), /invalide/);
  await assert.rejects(store.get(Number('../etc')), /invalide/);
  await writeFile(join(dir, '7.json'), 'pas du json');
  assert.equal(await store.get(7), null);
});

const h = await startApiHarness();
after(() => h.close());

test('envoi : fichier de 40 Mo en 3 morceaux, progression croissante, fichier prêt côté stockage', async () => {
  const { api, tg, bot } = await makeBot(h);
  void bot;
  after(() => tg.cleanup());
  const { Uploader } = await import('./uploader.ts');
  const up = new Uploader(api, { sleep: async () => undefined });
  const id = await tg.registerFile(40 * MiB);
  const file = { path: tg.files.get(id)!.path, size: 40 * MiB, name: 'gros.mkv', temporary: false };
  const seen: number[] = [];
  const mediaId = await up.upload(777, 'VIDEO', file, { onProgress: (d) => seen.push(d) });
  assert.deepEqual(seen, [0, 16 * MiB, 32 * MiB, 40 * MiB]);
  assert.equal(h.media.files.get(mediaId)?.status, 'READY');
  assert.equal([...h.mock.objects.values()].some((o) => o.body.length === 40 * MiB), true);
  assert.equal(api.puts, 3);
});

test('envoi : coupure au 2e morceau puis reprise — seuls les morceaux manquants sont renvoyés, un seul envoi côté serveur', async () => {
  const { api, tg } = await makeBot(h);
  after(() => tg.cleanup());
  const { Uploader } = await import('./uploader.ts');
  const up = new Uploader(api, { sleep: async () => undefined });
  const fid = await tg.registerFile(40 * MiB);
  const file = { path: tg.files.get(fid)!.path, size: 40 * MiB, name: 'coupe.mkv', temporary: false };
  const before = [...h.media.files.values()].filter((f) => f.kind === 'VIDEO').length;

  api.okPuts = 1;
  let started = null as string | null;
  const err = await up.upload(777, 'VIDEO', file, { onStarted: (id) => void (started = id) }).catch((e: unknown) => e);
  assert.ok(err instanceof UploadFailed);
  assert.equal(err.mediaFileId, started);
  assert.equal(h.media.files.get(started as string)?.status, 'PENDING');

  api.okPuts = null;
  const putsBefore = api.puts;
  const mediaId = await up.upload(777, 'VIDEO', file, { resume: started });
  assert.equal(mediaId, started);
  assert.equal(api.puts - putsBefore, 2, 'les morceaux 2 et 3 seulement');
  assert.equal(h.media.files.get(mediaId)?.status, 'READY');
  assert.equal([...h.media.files.values()].filter((f) => f.kind === 'VIDEO').length, before + 1);
  assert.equal(await up.upload(777, 'VIDEO', file, { resume: mediaId }), mediaId, 'reprise d’un envoi déjà terminé : rien à refaire');
});

test('envoi : abandon annule l’envoi côté serveur', async () => {
  const { api, tg } = await makeBot(h);
  after(() => tg.cleanup());
  const { Uploader } = await import('./uploader.ts');
  const up = new Uploader(api, { sleep: async () => undefined });
  const fid = await tg.registerFile(20 * MiB);
  const file = { path: tg.files.get(fid)!.path, size: 20 * MiB, name: 'abandon.mkv', temporary: false };
  api.okPuts = 0;
  let id = null as string | null;
  await up.upload(777, 'VIDEO', file, { onStarted: (m) => void (id = m) }).catch(() => undefined);
  await up.abandon(777, id as string);
  assert.equal(h.media.files.get(id as string)?.status, 'FAILED');
});
