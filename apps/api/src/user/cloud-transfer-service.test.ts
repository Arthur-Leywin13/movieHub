import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NotFoundError, ValidationError } from '@movieshub/shared';
import { CloudTransferService } from './cloud-transfer-service.ts';

class FakeStorage {
  keys = new Set<string>();
  putCalls: Array<{ key: string; ttl: number }> = [];
  getCalls: Array<{ key: string; ttl: number; name?: string }> = [];
  size = 1234;

  presignPut(key: string, ttl: number) {
    this.putCalls.push({ key, ttl });
    return `https://storage.test/upload/${encodeURIComponent(key)}?ttl=${ttl}`;
  }
  presignGet(key: string, ttl: number, opts: { downloadName?: string } = {}) {
    this.getCalls.push({ key, ttl, name: opts.downloadName });
    return `https://storage.test/download/${encodeURIComponent(key)}?ttl=${ttl}`;
  }
  async headObject(key: string) {
    return this.keys.has(key) ? { sizeBytes: this.size, etag: 'etag', contentType: 'application/octet-stream' } : null;
  }
  async deleteObject(key: string) { this.keys.delete(key); }
}

test('cloud transfer : upload et lien de partage sont confinés à l’utilisateur', async () => {
  const storage = new FakeStorage();
  const service = new CloudTransferService({ storage, uploadTtlSeconds: 7200, downloadTtlSeconds: 1800 });
  const init = await service.init('user-123', { filename: 'sample movie.mp4', sizeBytes: 1234 });
  assert.equal(init.uploadMethod, 'PUT');
  assert.equal(init.expiresInSeconds, 7200);
  assert.ok(storage.putCalls[0]?.key.startsWith('transfers/user-123/'));
  const key = storage.putCalls[0]?.key as string;
  storage.keys.add(key);
  const complete = await service.complete('user-123', init.transferId, { filename: 'sample movie.mp4', sizeBytes: 1234 });
  assert.equal(complete.status, 'READY');
  assert.equal(complete.expiresInSeconds, 1800);
  assert.equal(storage.getCalls[0]?.name, 'sample movie.mp4');
  await assert.rejects(service.share('another-user', init.transferId, 'sample.mp4'), NotFoundError);
});

test('cloud transfer : refuse une taille non annoncée ou supérieure à la limite de test', async () => {
  const storage = new FakeStorage();
  const service = new CloudTransferService({ storage, uploadTtlSeconds: 7200 });
  await assert.rejects(service.init('user-123', { filename: 'x.mp4', sizeBytes: 0 }), ValidationError);
  await assert.rejects(service.init('user-123', { filename: 'x.mp4', sizeBytes: 51 * 1024 * 1024 }), ValidationError);
});

test('cloud transfer : vérifie la taille du fichier avant de partager', async () => {
  const storage = new FakeStorage();
  const service = new CloudTransferService({ storage, uploadTtlSeconds: 7200 });
  const init = await service.init('user-123', { filename: 'sample.mp4', sizeBytes: 100 });
  storage.keys.add(storage.putCalls[0]?.key as string);
  storage.size = 99;
  await assert.rejects(service.complete('user-123', init.transferId, { filename: 'sample.mp4', sizeBytes: 100 }), ValidationError);
});
