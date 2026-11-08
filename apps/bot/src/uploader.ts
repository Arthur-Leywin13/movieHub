import { open, unlink } from 'node:fs/promises';
import { ApiClient, ApiError, type J } from './api-client.ts';
import type { LocalFile } from './files.ts';

export type UploadKind = 'VIDEO' | 'TRAILER_VIDEO' | 'IMAGE' | 'SUBTITLE';

export class UploadAborted extends Error {
  constructor() {
    super('Envoi interrompu');
    this.name = 'UploadAborted';
  }
}

export class UploadFailed extends Error {
  readonly mediaFileId: string | null;
  constructor(message: string, mediaFileId: string | null) {
    super(message);
    this.name = 'UploadFailed';
    this.mediaFileId = mediaFileId;
  }
}

export interface UploadOptions {
  /** Reprend un envoi déjà initialisé (après une coupure ou un redémarrage). */
  resume?: string | null;
  /** Appelé dès que l'envoi existe côté serveur : permet de mémoriser l'identifiant pour reprendre. */
  onStarted?: (mediaFileId: string) => Promise<void> | void;
  onProgress?: (doneBytes: number, totalBytes: number) => void;
  signal?: AbortSignal;
}

interface PartLink { partNumber: number; url: string }

async function readSlice(path: string, offset: number, length: number): Promise<Buffer> {
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, offset);
    if (bytesRead !== length) throw new UploadFailed('Lecture du fichier incomplète', null);
    return buf;
  } finally {
    await fh.close();
  }
}

/** Envoie un fichier vers R2 via l'API : liens signés, morceaux, reprise, nouvelles tentatives. */
export class Uploader {
  private readonly api: ApiClient;
  private readonly retries: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(api: ApiClient, opts: { retries?: number; sleep?: (ms: number) => Promise<void> } = {}) {
    this.api = api;
    this.retries = opts.retries ?? 3;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private async putWithRetry(url: string, data: Buffer, signal: AbortSignal | undefined, mediaFileId: string): Promise<void> {
    let last: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      if (signal?.aborted) throw new UploadAborted();
      try {
        await this.api.putPart(url, data);
        return;
      } catch (err) {
        last = err;
        // Un refus définitif du stockage (lien expiré, signature) ne s'arrange pas en réessayant.
        if (err instanceof ApiError && err.status >= 400 && err.status < 500) break;
        if (attempt < this.retries) await this.sleep(1000 * 2 ** attempt);
      }
    }
    throw new UploadFailed(last instanceof Error ? last.message : 'Envoi échoué', mediaFileId);
  }

  /** Renvoie l'identifiant du fichier R2 une fois l'envoi vérifié (READY). */
  async upload(uid: number, kind: UploadKind, file: LocalFile, opts: UploadOptions = {}): Promise<string> {
    let id: string | null = opts.resume ?? null;
    let info: J | null = null;

    if (id) {
      const st = await this.api.call(uid, 'GET', `/admin/uploads/${id}`);
      if (st['status'] === 'READY') return id;
      if (st['status'] === 'PENDING') info = st;
      else id = null; // échoué ou annulé : on repart de zéro
    }
    if (!info) {
      info = await this.api.call<J>(uid, 'POST', '/admin/uploads', { kind, filename: file.name, sizeBytes: file.size });
      id = String(info['mediaFileId']);
      await opts.onStarted?.(id);
    }

    const multipart = Boolean(info['multipart']);
    const partSize = Number(info['partSize'] ?? 0);
    let todo = ((info['parts'] ?? info['missingParts'] ?? []) as PartLink[]);
    let singleUrl = String(info['url'] ?? '');
    const mediaId = id as string;

    let sent = multipart ? file.size - todo.reduce((n, p) => n + Math.min(partSize, file.size - (p.partNumber - 1) * partSize), 0) : 0;
    opts.onProgress?.(sent, file.size);

    for (let round = 0; round < 3; round++) {
      if (multipart) {
        for (const p of todo) {
          if (opts.signal?.aborted) throw new UploadAborted();
          const offset = (p.partNumber - 1) * partSize;
          const length = Math.min(partSize, file.size - offset);
          await this.putWithRetry(p.url, await readSlice(file.path, offset, length), opts.signal, mediaId);
          sent += length;
          opts.onProgress?.(sent, file.size);
        }
      } else {
        if (opts.signal?.aborted) throw new UploadAborted();
        await this.putWithRetry(singleUrl, await readSlice(file.path, 0, file.size), opts.signal, mediaId);
        opts.onProgress?.(file.size, file.size);
      }
      if (opts.signal?.aborted) throw new UploadAborted();
      try {
        await this.api.call(uid, 'POST', `/admin/uploads/${mediaId}/complete`);
        return mediaId;
      } catch (err) {
        // Des morceaux manquent ou sont tronqués : on redemande des liens pour ceux-là et on recommence.
        const missing = err instanceof ApiError && err.status === 400 ? (err.details as J | undefined)?.['missingParts'] : undefined;
        if (!Array.isArray(missing) || round === 2) throw err;
        const st = await this.api.call(uid, 'GET', `/admin/uploads/${mediaId}`);
        todo = (st['missingParts'] ?? []) as PartLink[];
        singleUrl = String(st['url'] ?? singleUrl);
      }
    }
    throw new UploadFailed('Envoi incomplet après plusieurs tentatives', mediaId);
  }

  /** Abandon : annule côté serveur (silencieux si déjà terminé ou inconnu). */
  async abandon(uid: number, mediaFileId: string): Promise<void> {
    await this.api.call(uid, 'POST', `/admin/uploads/${mediaFileId}/abort`).catch(() => undefined);
  }
}

export async function removeTemp(file: LocalFile): Promise<void> {
  if (file.temporary) await unlink(file.path).catch(() => undefined);
}
