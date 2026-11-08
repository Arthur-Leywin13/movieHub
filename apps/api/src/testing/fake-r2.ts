import type { R2Part } from '../storage/r2-client.ts';
import type { R2Port } from '../admin/upload-service.ts';

/** Faux R2 en mémoire, réservé aux tests. */
export class FakeR2 implements R2Port {
  readonly uploads = new Map<string, { key: string; parts: Map<number, R2Part> }>();
  readonly objects = new Map<string, { sizeBytes: number }>();
  readonly aborted: string[] = [];
  headOverride: number | null = null;
  private counter = 0;

  presignGet(key: string, expiresSeconds: number, opts: { downloadName?: string } = {}): string {
    return `https://fake.r2/get/${key}?exp=${expiresSeconds}${opts.downloadName ? `&dl=${encodeURIComponent(opts.downloadName)}` : ''}&sig=abc`;
  }
  presignPut(key: string, expiresSeconds: number): string {
    return `https://fake.r2/put/${key}?exp=${expiresSeconds}&sig=abc`;
  }
  presignUploadPart(key: string, uploadId: string, partNumber: number, expiresSeconds: number): string {
    return `https://fake.r2/part/${key}?uploadId=${uploadId}&partNumber=${partNumber}&exp=${expiresSeconds}&sig=abc`;
  }
  async createMultipartUpload(key: string): Promise<string> {
    const id = `up-${++this.counter}`;
    this.uploads.set(id, { key, parts: new Map() });
    return id;
  }
  /** Aide de test : simule l'envoi d'un morceau par le client. */
  putPart(uploadId: string, partNumber: number, sizeBytes: number): void {
    this.uploads.get(uploadId)?.parts.set(partNumber, { partNumber, etag: `"etag-${partNumber}"`, sizeBytes });
  }
  async listParts(_key: string, uploadId: string): Promise<R2Part[]> {
    return [...(this.uploads.get(uploadId)?.parts.values() ?? [])];
  }
  async completeMultipartUpload(key: string, uploadId: string, parts: readonly R2Part[]): Promise<void> {
    const total = parts.reduce((n, p) => n + p.sizeBytes, 0);
    this.objects.set(key, { sizeBytes: total });
    this.uploads.delete(uploadId);
  }
  async abortMultipartUpload(_key: string, uploadId: string): Promise<void> {
    this.aborted.push(uploadId);
    this.uploads.delete(uploadId);
  }
  async headObject(key: string) {
    const o = this.objects.get(key);
    if (!o) return null;
    return { sizeBytes: this.headOverride ?? o.sizeBytes, etag: '"x"', contentType: null };
  }
}
