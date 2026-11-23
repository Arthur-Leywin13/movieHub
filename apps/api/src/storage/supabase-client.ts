/**
 * Supabase Storage provider used for small transfer tests.
 * Credentials stay on the API; clients receive short-lived signed URLs only.
 *
 * Supabase Storage does not implement the S3 multipart API used by R2Client.
 * This provider intentionally supports single-object uploads; multipart methods
 * fail clearly so a test cannot silently pretend to support resumable 2 GB files.
 */
import { AppError } from '@movieshub/shared';

export interface SupabaseStorageConfig {
  projectUrl: string;
  serviceRoleKey: string;
  bucket: string;
}

export interface SupabaseStorageResponse {
  status: number;
  ok: boolean;
  text(): Promise<string>;
  headers: { get(name: string): string | null };
}

type FetchLike = (url: string, init: {
  method: string;
  headers: Record<string, string>;
  body?: string;
}) => Promise<SupabaseStorageResponse>;

export interface StoragePart {
  partNumber: number;
  etag: string;
  sizeBytes: number;
}

export class SupabaseStorageError extends AppError {
  constructor(message: string, details?: unknown) {
    super('INTERNAL_ERROR', 502, message, details);
  }
}

const encodeObjectPath = (key: string): string => key.split('/').map(encodeURIComponent).join('/');
const safeDownloadName = (name: string): string =>
  name.replace(/[^\w.\- ()]/g, '_').slice(0, 120);

export class SupabaseStorageClient {
  private readonly cfg: SupabaseStorageConfig;
  private readonly baseUrl: string;
  private readonly fetchFn: FetchLike;

  constructor(cfg: SupabaseStorageConfig, opts: { fetch?: FetchLike } = {}) {
    this.cfg = cfg;
    this.baseUrl = cfg.projectUrl.replace(/\/$/, '');
    this.fetchFn = opts.fetch ?? (fetch as unknown as FetchLike);
  }

  private objectPath(key: string): string {
    return `/storage/v1/object/${encodeURIComponent(this.cfg.bucket)}/${encodeObjectPath(key)}`;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      apikey: this.cfg.serviceRoleKey,
      authorization: `Bearer ${this.cfg.serviceRoleKey}`,
      ...extra,
    };
  }

  private async jsonRequest(path: string, body: unknown): Promise<Record<string, unknown>> {
    let response: SupabaseStorageResponse;
    try {
      response = await this.fetchFn(`${this.baseUrl}/storage/v1/${path}`, {
        method: 'POST',
        headers: this.headers({ 'content-type': 'application/json' }),
        body: JSON.stringify(body),
      });
    } catch {
      throw new SupabaseStorageError('Supabase Storage injoignable');
    }
    const text = await response.text();
    if (!response.ok) throw new SupabaseStorageError('Échec de la signature Supabase Storage', { status: response.status });
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new SupabaseStorageError('Réponse invalide de Supabase Storage');
    }
  }

  private absoluteSignedUrl(value: unknown): string {
    if (typeof value !== 'string' || !value) throw new SupabaseStorageError('Supabase n’a pas renvoyé de lien signé');
    if (/^https?:\/\//i.test(value)) return value;
    const normalized = value.startsWith('/') ? value : `/${value}`;
    return normalized.startsWith('/storage/v1/')
      ? `${this.baseUrl}${normalized}`
      : `${this.baseUrl}/storage/v1${normalized}`;
  }

  async presignGet(key: string, expiresSeconds: number, opts: { downloadName?: string } = {}): Promise<string> {
    const result = await this.jsonRequest(
      `object/sign/${encodeURIComponent(this.cfg.bucket)}/${encodeObjectPath(key)}`,
      { expiresIn: expiresSeconds },
    );
    const signedUrl = this.absoluteSignedUrl(result['signedURL'] ?? result['signedUrl'] ?? result['url']);
    if (!opts.downloadName) return signedUrl;
    const url = new URL(signedUrl);
    url.searchParams.set('download', safeDownloadName(opts.downloadName));
    return url.toString();
  }

  /** Supabase signed upload tokens have a fixed two-hour lifetime. */
  async presignPut(key: string, _expiresSeconds: number): Promise<string> {
    const result = await this.jsonRequest(
      `object/upload/sign/${encodeURIComponent(this.cfg.bucket)}/${encodeObjectPath(key)}`,
      {},
    );
    return this.absoluteSignedUrl(result['signedURL'] ?? result['signedUrl'] ?? result['url']);
  }

  async headObject(key: string): Promise<{ sizeBytes: number; etag: string | null; contentType: string | null } | null> {
    let response: SupabaseStorageResponse;
    try {
      response = await this.fetchFn(`${this.baseUrl}${this.objectPath(key)}`, {
        method: 'HEAD',
        headers: this.headers(),
      });
    } catch {
      throw new SupabaseStorageError('Supabase Storage injoignable');
    }
    if (response.status === 404) return null;
    if (!response.ok) throw new SupabaseStorageError('Échec de vérification du fichier Supabase', { status: response.status });
    return {
      sizeBytes: Number(response.headers.get('content-length') ?? '0'),
      etag: response.headers.get('etag'),
      contentType: response.headers.get('content-type'),
    };
  }

  async deleteObject(key: string): Promise<void> {
    let response: SupabaseStorageResponse;
    try {
      response = await this.fetchFn(`${this.baseUrl}${this.objectPath(key)}`, {
        method: 'DELETE',
        headers: this.headers(),
      });
    } catch {
      throw new SupabaseStorageError('Supabase Storage injoignable');
    }
    if (!response.ok && response.status !== 404) {
      throw new SupabaseStorageError('Échec de suppression du fichier Supabase', { status: response.status });
    }
  }

  private multipartUnavailable(): SupabaseStorageError {
    return new SupabaseStorageError('Supabase test provider : envoi multipart/reprise non pris en charge. Utilisez R2 pour les gros fichiers.');
  }

  createMultipartUpload(_key: string, _contentType?: string): Promise<string> { return Promise.reject(this.multipartUnavailable()); }
  presignUploadPart(_key: string, _uploadId: string, _partNumber: number, _expiresSeconds: number): string { throw this.multipartUnavailable(); }
  listParts(_key: string, _uploadId: string): Promise<StoragePart[]> { return Promise.reject(this.multipartUnavailable()); }
  completeMultipartUpload(_key: string, _uploadId: string, _parts: readonly StoragePart[]): Promise<void> { return Promise.reject(this.multipartUnavailable()); }
  abortMultipartUpload(_key: string, _uploadId: string): Promise<void> { return Promise.reject(this.multipartUnavailable());
}
