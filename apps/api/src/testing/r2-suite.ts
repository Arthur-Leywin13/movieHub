/**
 * Suite de tests d'intégration du stockage, exécutée :
 *  - contre le VRAI Cloudflare R2 (r2-live.test.ts, via la CI et les secrets GitHub) ;
 *  - contre un serveur S3 local (r2-http.test.ts) pour valider le test lui-même avant de le lancer.
 * Tout ce qui est créé est supprimé à la fin, même si un test échoue.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { ValidationError } from '@movieshub/shared';
import { UploadService } from '../admin/upload-service.ts';
import type { AdminActor } from '../auth/actor.ts';
import { StorageError, type R2Client } from '../storage/r2-client.ts';
import { MemoryAuditRepo, MemoryMediaRepo } from './memory-repos.ts';

const MiB = 1024 * 1024;
const sha = (b: Buffer | Uint8Array): string => createHash('sha256').update(b).digest('hex');
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const ACTOR: AdminActor = { kind: 'admin', userId: 'u', adminId: 'adm', role: 'EDITOR', via: 'bot', telegramId: 1n };
const CTX = { ip: '127.0.0.1', requestId: 'live' };

export interface SuiteEnv {
  r2: R2Client;
  /** Même point d'accès, mais avec une clé secrète donnée (pour tester le refus d'une mauvaise clé). */
  withSecret: (secret: string) => R2Client;
  bucket: string;
  /** URL de l'objet SANS signature (doit être refusée). */
  unsignedUrl: (key: string) => string;
}

async function put(url: string, body: Buffer): Promise<string> {
  const res = await fetch(url, { method: 'PUT', body });
  if (!res.ok) throw new Error(`PUT refusé : HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  return res.headers.get('etag') ?? '';
}

async function get(url: string): Promise<{ status: number; body: Buffer; headers: Headers }> {
  const res = await fetch(url);
  return { status: res.status, body: Buffer.from(await res.arrayBuffer()), headers: res.headers };
}

export function registerR2Suite(env: SuiteEnv): void {
  const { r2 } = env;
  const prefix = `ci-live-test/${randomUUID()}`;
  const keys: string[] = [];
  const media = new MemoryMediaRepo();
  const svc = new UploadService({ r2, media, audit: new MemoryAuditRepo(), bucket: env.bucket });
  const opts = { timeout: 180_000 };

  after(async () => {
    const all = [...keys, ...[...media.files.values()].map((f) => f.objectKey)];
    let failed = 0;
    for (const k of all) await r2.deleteObject(k).catch(() => void failed++);
    console.log(`# nettoyage : ${all.length - failed}/${all.length} objets de test supprimés`);
  });

  test('R2 : envoi unique, lecture signée, taille et contenu identiques', opts, async () => {
    const key = `${prefix}/single.bin`;
    keys.push(key);
    const data = randomBytes(100 * 1024);
    await put(r2.presignPut(key, 300), data);

    const head = await r2.headObject(key);
    assert.equal(head?.sizeBytes, data.length);

    const dl = await get(r2.presignGet(key, 300));
    assert.equal(dl.status, 200);
    assert.equal(sha(dl.body), sha(data));

    const named = await get(r2.presignGet(key, 300, { downloadName: 'Mon Film (2026).mkv' }));
    assert.match(named.headers.get('content-disposition') ?? '', /attachment/);
    assert.match(named.headers.get('content-disposition') ?? '', /Mon Film \(2026\)\.mkv/);
  });

  test('R2 : lien altéré, lien expiré, URL sans signature et mauvaise clé sont refusés', opts, async () => {
    const key = `${prefix}/single.bin`;
    const url = r2.presignGet(key, 300);
    assert.equal((await get(url.slice(0, -1) + (url.endsWith('0') ? '1' : '0'))).status, 403);

    const unsigned = await get(env.unsignedUrl(key));
    assert.ok(unsigned.status >= 400 && unsigned.status < 500, `HTTP ${unsigned.status}`);

    const short = r2.presignGet(key, 1);
    await sleep(2500);
    const expired = await get(short);
    assert.ok(expired.status >= 400 && expired.status < 500, `HTTP ${expired.status}`);

    await assert.rejects(env.withSecret('mauvaise-cle-secrete').headObject(key), (err: unknown) => {
      assert.ok(err instanceof StorageError);
      assert.equal((err.details as { status: number }).status, 403);
      return true;
    });
  });

  test('R2 : objet absent → headObject renvoie null', opts, async () => {
    assert.equal(await r2.headObject(`${prefix}/n-existe-pas.bin`), null);
  });

  test('R2 : multipart (5 Mio + 1 Kio) — liste, finalisation, intégrité du contenu', opts, async () => {
    const key = `${prefix}/multipart.bin`;
    keys.push(key);
    const uploadId = await r2.createMultipartUpload(key, 'application/octet-stream');
    const p1 = randomBytes(5 * MiB);
    const p2 = randomBytes(1024);
    await put(r2.presignUploadPart(key, uploadId, 1, 600), p1);
    await put(r2.presignUploadPart(key, uploadId, 2, 600), p2);

    const parts = await r2.listParts(key, uploadId);
    assert.deepEqual(parts.map((p) => [p.partNumber, p.sizeBytes]), [[1, 5 * MiB], [2, 1024]]);

    await r2.completeMultipartUpload(key, uploadId, parts);
    assert.equal((await r2.headObject(key))?.sizeBytes, 5 * MiB + 1024);
    const dl = await get(r2.presignGet(key, 300));
    assert.equal(sha(dl.body), sha(Buffer.concat([p1, p2])));
  });

  test('R2 : multipart abandonné — annulation, puis le même envoi n’existe plus', opts, async () => {
    const key = `${prefix}/abandonne.bin`;
    keys.push(key);
    const uploadId = await r2.createMultipartUpload(key);
    await put(r2.presignUploadPart(key, uploadId, 1, 600), randomBytes(1024));
    await r2.abortMultipartUpload(key, uploadId);
    await r2.abortMultipartUpload(key, uploadId); // idempotent
    await assert.rejects(r2.listParts(key, uploadId), (err: unknown) => err instanceof StorageError);
    assert.equal(await r2.headObject(key), null);
  });

  test('UploadService : vidéo de 20 Mio (morceaux 16 + 4 Mio), reprise, finalisation, annulation', opts, async () => {
    const total = 20 * MiB;
    const data = randomBytes(total);
    const init = await svc.init(ACTOR, { kind: 'VIDEO', filename: 'live-test.mp4', sizeBytes: total }, CTX);
    assert.equal(init.partCount, 2);
    assert.equal(init.partSize, 16 * MiB);
    const link = (n: number): string => (init.parts as { partNumber: number; url: string }[])[n - 1]!.url;

    await put(link(1), data.subarray(0, 16 * MiB));
    const st = await svc.status(ACTOR, init.mediaFileId);
    assert.deepEqual(st.uploadedParts, [1]);
    assert.deepEqual(st.missingParts?.map((p) => p.partNumber), [2]);

    await assert.rejects(svc.complete(ACTOR, init.mediaFileId, CTX), ValidationError);
    assert.equal(media.files.get(init.mediaFileId)?.status, 'PENDING');

    await put(st.missingParts![0]!.url, data.subarray(16 * MiB));
    const done = await svc.complete(ACTOR, init.mediaFileId, CTX);
    assert.deepEqual(done, { mediaFileId: init.mediaFileId, status: 'READY', sizeBytes: total });

    const key = media.files.get(init.mediaFileId)!.objectKey;
    assert.equal(sha((await get(r2.presignGet(key, 300))).body), sha(data));

    const init2 = await svc.init(ACTOR, { kind: 'VIDEO', filename: 'annule.mkv', sizeBytes: total }, CTX);
    await put((init2.parts as { url: string }[])[0]!.url, data.subarray(0, 16 * MiB));
    await svc.abort(ACTOR, init2.mediaFileId, CTX);
    assert.equal(media.files.get(init2.mediaFileId)?.status, 'FAILED');
  });

  test('UploadService : image (envoi unique) puis finalisation', opts, async () => {
    const data = randomBytes(2048);
    const init = await svc.init(ACTOR, { kind: 'IMAGE', filename: 'affiche.png', sizeBytes: data.length }, CTX);
    await assert.rejects(svc.complete(ACTOR, init.mediaFileId, CTX), /non reçu/);
    await put(init.url as string, data);
    assert.equal((await svc.complete(ACTOR, init.mediaFileId, CTX)).status, 'READY');
  });
}
