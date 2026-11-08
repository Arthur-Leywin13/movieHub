import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConflictError, NotFoundError, ValidationError } from '@movieshub/shared';
import type { AdminActor } from '../auth/actor.ts';
import { FakeR2 } from '../testing/fake-r2.ts';
import { MemoryAuditRepo, MemoryMediaRepo } from '../testing/memory-repos.ts';
import { choosePartSize, expectedPartSize, partCount } from '../storage/keys.ts';
import { UploadService } from './upload-service.ts';

const MiB = 1024 * 1024;
const ACTOR: AdminActor = { kind: 'admin', userId: 'u1', adminId: 'adm1', role: 'EDITOR', via: 'bot', telegramId: 1n };
const CTX = { ip: '1.1.1.1', requestId: 'req1' };

function setup() {
  const r2 = new FakeR2();
  const media = new MemoryMediaRepo();
  const audit = new MemoryAuditRepo();
  const svc = new UploadService({ r2, media, audit, bucket: 'movieshub', now: () => new Date('2026-11-01T12:00:00Z') });
  return { r2, media, audit, svc };
}

test('morceaux : 16 Mio min., au plus 9000, dernier morceau plus petit', () => {
  assert.equal(choosePartSize(2000 * MiB), 16 * MiB);
  assert.equal(partCount(2000 * MiB, 16 * MiB), 125);
  assert.equal(partCount(100 * MiB, 16 * MiB), 7);
  assert.equal(expectedPartSize(100 * MiB, 16 * MiB, 1), 16 * MiB);
  assert.equal(expectedPartSize(100 * MiB, 16 * MiB, 7), 4 * MiB);
  assert.equal(expectedPartSize(10, 16 * MiB, 1), 10);
  assert.ok(partCount(2000 * MiB, choosePartSize(2000 * MiB)) <= 10_000);
  const huge = 100 * 1024 * MiB;
  assert.ok(partCount(huge, choosePartSize(huge)) <= 9000);
});

test('init vidéo 100 Mio : 7 liens, clé serveur (jamais le nom du client), audit sans URL', async () => {
  const { svc, media, audit } = setup();
  const out = await svc.init(ACTOR, { kind: 'VIDEO', filename: '../../etc/passwd Film.MKV', sizeBytes: 100 * MiB }, CTX);
  assert.equal(out.multipart, true);
  assert.equal(out.partCount, 7);
  assert.equal(out.partSize, 16 * MiB);
  assert.equal(out.parts?.length, 7);
  assert.match(out.parts?.[0]?.url ?? '', /partNumber=1&exp=21600/);
  const rec = media.files.get(out.mediaFileId);
  assert.match(rec?.objectKey ?? '', /^video\/2026\/11\/[0-9a-f-]{36}\.mkv$/);
  assert.equal(rec?.mimeType, 'video/x-matroska');
  assert.equal(rec?.status, 'PENDING');
  assert.equal(rec?.uploadedByAdminId, 'adm1');
  assert.equal(audit.entries.length, 1);
  assert.equal(audit.entries[0]?.source, 'TELEGRAM_BOT');
  assert.ok(!JSON.stringify(audit.entries).includes('https://'));
});

test('init : extension, taille et type refusés', async () => {
  const { svc } = setup();
  const bad = [
    { kind: 'VIDEO' as const, filename: 'virus.exe', sizeBytes: 10 },
    { kind: 'VIDEO' as const, filename: 'sans-extension', sizeBytes: 10 },
    { kind: 'VIDEO' as const, filename: 'film.mkv', sizeBytes: 2000 * MiB + 1 },
    { kind: 'VIDEO' as const, filename: 'film.mkv', sizeBytes: 0 },
    { kind: 'IMAGE' as const, filename: 'a.png', sizeBytes: 26 * MiB },
    { kind: 'IMAGE' as const, filename: 'a.svg', sizeBytes: 10 },
    { kind: 'SUBTITLE' as const, filename: 'a.mkv', sizeBytes: 10 },
  ];
  for (const b of bad) await assert.rejects(svc.init(ACTOR, b, CTX), ValidationError, JSON.stringify(b));
  const max = await svc.init(ACTOR, { kind: 'VIDEO', filename: 'film.mp4', sizeBytes: 2000 * MiB }, CTX);
  assert.equal(max.partCount, 125);
});

test('reprise : status liste les morceaux reçus et redonne des liens pour les manquants', async () => {
  const { svc, r2 } = setup();
  const init = await svc.init(ACTOR, { kind: 'VIDEO', filename: 'f.mp4', sizeBytes: 100 * MiB }, CTX);
  const uploadId = [...r2.uploads.keys()][0] as string;
  for (const n of [1, 2, 3]) r2.putPart(uploadId, n, 16 * MiB);
  r2.putPart(uploadId, 4, 5 * MiB); // morceau tronqué : doit être refait
  const st = await svc.status(ACTOR, init.mediaFileId);
  assert.deepEqual(st.uploadedParts, [1, 2, 3]);
  assert.deepEqual(st.missingParts?.map((p) => p.partNumber), [4, 5, 6, 7]);
});

test('complete : tous les morceaux présents → READY, champs multipart effacés, audit', async () => {
  const { svc, r2, media, audit } = setup();
  const init = await svc.init(ACTOR, { kind: 'VIDEO', filename: 'f.mp4', sizeBytes: 100 * MiB }, CTX);
  const uploadId = [...r2.uploads.keys()][0] as string;
  for (let n = 1; n <= 6; n++) r2.putPart(uploadId, n, 16 * MiB);
  r2.putPart(uploadId, 7, 4 * MiB);
  const out = await svc.complete(ACTOR, init.mediaFileId, CTX);
  assert.deepEqual(out, { mediaFileId: init.mediaFileId, status: 'READY', sizeBytes: 100 * MiB });
  const rec = media.files.get(init.mediaFileId);
  assert.equal(rec?.status, 'READY');
  assert.equal(rec?.multipartUploadId, null);
  assert.equal(audit.entries.at(-1)?.action, 'media.upload.complete');
  assert.deepEqual(await svc.complete(ACTOR, init.mediaFileId, CTX), out); // idempotent
});

test('complete : morceaux manquants ou de mauvaise taille → erreur détaillée, fichier non publié', async () => {
  const { svc, r2, media } = setup();
  const init = await svc.init(ACTOR, { kind: 'VIDEO', filename: 'f.mp4', sizeBytes: 100 * MiB }, CTX);
  const uploadId = [...r2.uploads.keys()][0] as string;
  for (const n of [1, 2, 3, 4, 5]) r2.putPart(uploadId, n, 16 * MiB);
  r2.putPart(uploadId, 6, 1 * MiB);
  await assert.rejects(svc.complete(ACTOR, init.mediaFileId, CTX), (err: unknown) => {
    assert.ok(err instanceof ValidationError);
    assert.deepEqual((err.details as { missingParts: number[] }).missingParts, [6, 7]);
    return true;
  });
  assert.equal(media.files.get(init.mediaFileId)?.status, 'PENDING');
});

test('complete : taille finale différente chez R2 → FAILED + audit d’échec', async () => {
  const { svc, r2, media, audit } = setup();
  const init = await svc.init(ACTOR, { kind: 'VIDEO', filename: 'f.mp4', sizeBytes: 20 * MiB }, CTX);
  const uploadId = [...r2.uploads.keys()][0] as string;
  r2.putPart(uploadId, 1, 16 * MiB);
  r2.putPart(uploadId, 2, 4 * MiB);
  r2.headOverride = 1234;
  await assert.rejects(svc.complete(ACTOR, init.mediaFileId, CTX), /différente/);
  assert.equal(media.files.get(init.mediaFileId)?.status, 'FAILED');
  assert.equal(audit.entries.at(-1)?.result, 'FAILURE');
  await assert.rejects(svc.complete(ACTOR, init.mediaFileId, CTX), ConflictError);
});

test('image (envoi unique) : « terminer » trop tôt reste réessayable, taille fausse = échec définitif', async () => {
  const { svc, r2, media } = setup();
  const init = await svc.init(ACTOR, { kind: 'IMAGE', filename: 'affiche.PNG', sizeBytes: 1000 }, CTX);
  assert.equal(init.multipart, false);
  assert.match(init.url ?? '', /^https:\/\/fake\.r2\/put\/image\/2026\/11\/.+\.png/);
  const key = media.files.get(init.mediaFileId)?.objectKey as string;

  await assert.rejects(svc.complete(ACTOR, init.mediaFileId, CTX), /non reçu/);
  assert.equal(media.files.get(init.mediaFileId)?.status, 'PENDING');

  r2.objects.set(key, { sizeBytes: 1000 });
  assert.equal((await svc.complete(ACTOR, init.mediaFileId, CTX)).status, 'READY');

  const bad = await svc.init(ACTOR, { kind: 'IMAGE', filename: 'x.png', sizeBytes: 1000 }, CTX);
  r2.objects.set(media.files.get(bad.mediaFileId)?.objectKey as string, { sizeBytes: 999 });
  await assert.rejects(svc.complete(ACTOR, bad.mediaFileId, CTX), /différente/);
  assert.equal(media.files.get(bad.mediaFileId)?.status, 'FAILED');
});

test('abort : annule côté R2, refuse un fichier déjà prêt, introuvable → 404', async () => {
  const { svc, r2, media } = setup();
  const init = await svc.init(ACTOR, { kind: 'VIDEO', filename: 'f.mp4', sizeBytes: 20 * MiB }, CTX);
  const uploadId = [...r2.uploads.keys()][0] as string;
  await svc.abort(ACTOR, init.mediaFileId, CTX);
  assert.deepEqual(r2.aborted, [uploadId]);
  assert.equal(media.files.get(init.mediaFileId)?.status, 'FAILED');

  const ready = await svc.init(ACTOR, { kind: 'SUBTITLE', filename: 's.srt', sizeBytes: 10 }, CTX);
  r2.objects.set(media.files.get(ready.mediaFileId)?.objectKey as string, { sizeBytes: 10 });
  await svc.complete(ACTOR, ready.mediaFileId, CTX);
  await assert.rejects(svc.abort(ACTOR, ready.mediaFileId, CTX), ConflictError);
  await assert.rejects(svc.abort(ACTOR, '0a1b2c3d-0000-4000-8000-000000000001', CTX), NotFoundError);
});

test('init : si l’enregistrement en base échoue, l’envoi multipart R2 est annulé', async () => {
  const { svc, r2, media } = setup();
  media.create = async () => {
    throw new Error('base indisponible');
  };
  await assert.rejects(svc.init(ACTOR, { kind: 'VIDEO', filename: 'f.mp4', sizeBytes: 20 * MiB }, CTX), /base indisponible/);
  assert.equal(r2.aborted.length, 1);
  assert.equal(r2.uploads.size, 0);
});
