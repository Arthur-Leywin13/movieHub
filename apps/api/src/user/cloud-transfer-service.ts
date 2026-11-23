import { randomUUID } from 'node:crypto';
import { NotFoundError, ValidationError } from '@movieshub/shared';

const MiB = 1024 * 1024;
export const MAX_CLOUD_TRANSFER_BYTES = 50 * MiB;
export const CLOUD_TRANSFER_DOWNLOAD_TTL_SECONDS = 60 * 60;

export interface CloudTransferStorage {
  presignPut(key: string, expiresSeconds: number): string | Promise<string>;
  presignGet(key: string, expiresSeconds: number, opts?: { downloadName?: string }): string | Promise<string>;
  headObject(key: string): Promise<{ sizeBytes: number; etag: string | null; contentType: string | null } | null>;
  deleteObject(key: string): Promise<void>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const safeName = (name: string): string => name
  .replace(/[\\/:*?"<>|]+/g, '_')
  .replace(/[\\r\\n\\0]/g, '_')
  .trim()
  .slice(0, 120) || 'moviehub-transfer.bin';

export class CloudTransferService {
  private readonly storage: CloudTransferStorage;
  private readonly uploadTtl: number;
  private readonly downloadTtl: number;

  constructor(deps: { storage: CloudTransferStorage; uploadTtlSeconds: number; downloadTtlSeconds?: number }) {
    this.storage = deps.storage;
    this.uploadTtl = deps.uploadTtlSeconds;
    this.downloadTtl = deps.downloadTtlSeconds ?? CLOUD_TRANSFER_DOWNLOAD_TTL_SECONDS;
  }

  private key(userId: string, transferId: string): string {
    if (!UUID.test(transferId)) throw new ValidationError('Identifiant de transfert invalide', { field: 'id' });
    return `transfers/${userId}/${transferId}/payload`;
  }

  async init(userId: string, input: { filename: string; sizeBytes: number }) {
    if (!Number.isInteger(input.sizeBytes) || input.sizeBytes < 1 || input.sizeBytes > MAX_CLOUD_TRANSFER_BYTES) {
      throw new ValidationError(`La taille doit être entre 1 octet et ${MAX_CLOUD_TRANSFER_BYTES} octets pour ce test`, { field: 'sizeBytes' });
    }
    const filename = safeName(input.filename);
    const transferId = randomUUID();
    const objectKey = this.key(userId, transferId);
    const uploadUrl = await this.storage.presignPut(objectKey, this.uploadTtl);
    return { transferId, filename, sizeBytes: input.sizeBytes, uploadUrl, uploadMethod: 'PUT' as const, expiresInSeconds: this.uploadTtl };
  }

  async complete(userId: string, transferId: string, input: { filename: string; sizeBytes: number }) {
    if (!Number.isInteger(input.sizeBytes) || input.sizeBytes < 1 || input.sizeBytes > MAX_CLOUD_TRANSFER_BYTES) {
      throw new ValidationError('Taille de transfert invalide', { field: 'sizeBytes' });
    }
    const filename = safeName(input.filename);
    const objectKey = this.key(userId, transferId);
    const head = await this.storage.headObject(objectKey);
    if (!head) throw new NotFoundError('Fichier de transfert non reçu');
    if (head.sizeBytes !== input.sizeBytes) {
      throw new ValidationError('La taille reçue ne correspond pas à la taille annoncée', {
        expected: input.sizeBytes, received: head.sizeBytes,
      });
    }
    const downloadUrl = await this.storage.presignGet(objectKey, this.downloadTtl, { downloadName: filename });
    return { transferId, status: 'READY' as const, sizeBytes: head.sizeBytes, filename, downloadUrl, expiresInSeconds: this.downloadTtl };
  }

  async share(userId: string, transferId: string, filename: string) {
    const objectKey = this.key(userId, transferId);
    if (!(await this.storage.headObject(objectKey))) throw new NotFoundError('Fichier de transfert introuvable');
    return {
      transferId,
      downloadUrl: await this.storage.presignGet(objectKey, this.downloadTtl, { downloadName: safeName(filename) }),
      expiresInSeconds: this.downloadTtl,
    };
  }

  async remove(userId: string, transferId: string): Promise<void> {
    await this.storage.deleteObject(this.key(userId, transferId));
  }
}
