/**
 * Client Cloudflare R2 (API compatible S3), sans SDK. Les clés d'accès ne quittent jamais ce module :
 * les clients reçoivent uniquement des URL pré-signées à durée limitée.
 */
import { AppError } from '@movieshub/shared';
import { EMPTY_PAYLOAD_HASH, presignUrl, rfc3986, sha256Hex, signRequest, encodePath, canonicalQuery } from './sigv4.ts';

export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

export interface FetchResponseLike {
  status: number;
  ok: boolean;
  text(): Promise<string>;
  headers: { get(name: string): string | null };
}
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<FetchResponseLike>;

export interface R2Part {
  partNumber: number;
  etag: string;
  sizeBytes: number;
}

export class StorageError extends AppError {
  constructor(message: string, details?: unknown) {
    super('INTERNAL_ERROR', 502, message, details);
  }
}

const decodeXml = (s: string): string =>
  s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const escapeXml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const xmlTag = (xml: string, name: string): string | null => {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
  return m ? decodeXml(m[1] as string) : null;
};
const xmlBlocks = (xml: string, name: string): string[] =>
  [...xml.matchAll(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'g'))].map((m) => m[1] as string);

export class R2Client {
  private readonly cfg: R2Config;
  private readonly host: string;
  private readonly scheme: 'http' | 'https';
  private readonly fetchFn: FetchLike;
  private readonly now: () => Date;
  private readonly region = 'auto';

  constructor(
    cfg: R2Config,
    opts: { fetch?: FetchLike; now?: () => Date; endpoint?: { host: string; scheme: 'http' | 'https' } } = {},
  ) {
    this.cfg = cfg;
    // Par défaut : le point d'accès S3 de R2. `endpoint` sert aux tests locaux (serveur S3 simulé).
    this.host = opts.endpoint?.host ?? `${cfg.accountId}.r2.cloudflarestorage.com`;
    this.scheme = opts.endpoint?.scheme ?? 'https';
    this.fetchFn = opts.fetch ?? (fetch as unknown as FetchLike);
    this.now = opts.now ?? (() => new Date());
  }

  private path(key: string): string {
    return `/${this.cfg.bucket}/${key}`;
  }

  private creds() {
    return { accessKeyId: this.cfg.accessKeyId, secretAccessKey: this.cfg.secretAccessKey };
  }

  private presign(method: string, key: string, expiresSeconds: number, query: Record<string, string> = {}): string {
    return presignUrl({
      method,
      host: this.host,
      path: this.path(key),
      query,
      region: this.region,
      expiresSeconds,
      credentials: this.creds(),
      now: this.now(),
      scheme: this.scheme,
    });
  }

  /** Lien de téléchargement temporaire. */
  presignGet(key: string, expiresSeconds: number, opts: { downloadName?: string } = {}): string {
    const query: Record<string, string> = {};
    if (opts.downloadName) {
      const safe = opts.downloadName.replace(/[^\w.\- ()]/g, '_').slice(0, 120);
      query['response-content-disposition'] = `attachment; filename="${safe}"`;
    }
    return this.presign('GET', key, expiresSeconds, query);
  }

  /** Lien d'envoi unique (images, sous-titres). */
  presignPut(key: string, expiresSeconds: number): string {
    return this.presign('PUT', key, expiresSeconds);
  }

  presignUploadPart(key: string, uploadId: string, partNumber: number, expiresSeconds: number): string {
    return this.presign('PUT', key, expiresSeconds, { partNumber: String(partNumber), uploadId });
  }

  private async send(
    method: string,
    key: string,
    query: Record<string, string>,
    opts: { body?: string; headers?: Record<string, string> } = {},
  ): Promise<{ status: number; ok: boolean; text: string; headers: FetchResponseLike['headers'] }> {
    const payloadHash = opts.body === undefined ? EMPTY_PAYLOAD_HASH : sha256Hex(opts.body);
    const headers = signRequest({
      method,
      host: this.host,
      path: this.path(key),
      query,
      headers: opts.headers,
      payloadHash,
      region: this.region,
      credentials: this.creds(),
      now: this.now(),
    });
    const qs = canonicalQuery(query);
    const url = `${this.scheme}://${this.host}${encodePath(this.path(key))}${qs ? `?${qs}` : ''}`;
    let res: FetchResponseLike;
    try {
      res = await this.fetchFn(url, { method, headers, ...(opts.body === undefined ? {} : { body: opts.body }) });
    } catch {
      throw new StorageError('Stockage R2 injoignable');
    }
    const text = method === 'HEAD' ? '' : await res.text();
    return { status: res.status, ok: res.ok, text, headers: res.headers };
  }

  private fail(op: string, status: number, body: string): never {
    // Seul le code d'erreur S3 est exposé : jamais d'URL, de clé ni de contenu de requête.
    throw new StorageError(`Échec du stockage R2 (${op})`, { status, code: xmlTag(body, 'Code') });
  }

  async createMultipartUpload(key: string, contentType?: string): Promise<string> {
    const res = await this.send('POST', key, { uploads: '' }, contentType ? { headers: { 'content-type': contentType } } : {});
    if (!res.ok) this.fail('createMultipartUpload', res.status, res.text);
    const uploadId = xmlTag(res.text, 'UploadId');
    if (!uploadId) this.fail('createMultipartUpload', res.status, res.text);
    return uploadId;
  }

  async listParts(key: string, uploadId: string): Promise<R2Part[]> {
    const parts: R2Part[] = [];
    let marker: string | null = null;
    for (let page = 0; page < 20; page++) {
      const query: Record<string, string> = { uploadId, 'max-parts': '1000' };
      if (marker) query['part-number-marker'] = marker;
      const res = await this.send('GET', key, query);
      if (!res.ok) this.fail('listParts', res.status, res.text);
      for (const block of xmlBlocks(res.text, 'Part')) {
        parts.push({
          partNumber: Number(xmlTag(block, 'PartNumber')),
          etag: xmlTag(block, 'ETag') ?? '',
          sizeBytes: Number(xmlTag(block, 'Size')),
        });
      }
      if (xmlTag(res.text, 'IsTruncated') !== 'true') return parts;
      marker = xmlTag(res.text, 'NextPartNumberMarker');
      if (!marker) return parts;
    }
    throw new StorageError('Trop de pages de morceaux R2');
  }

  async completeMultipartUpload(key: string, uploadId: string, parts: readonly R2Part[]): Promise<void> {
    const ordered = [...parts].sort((a, b) => a.partNumber - b.partNumber);
    const body =
      '<CompleteMultipartUpload>' +
      ordered
        .map((p) => `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${escapeXml(p.etag)}</ETag></Part>`)
        .join('') +
      '</CompleteMultipartUpload>';
    const res = await this.send('POST', key, { uploadId }, { body, headers: { 'content-type': 'application/xml' } });
    // S3/R2 peuvent répondre 200 avec un corps <Error> : on le traite comme un échec.
    if (!res.ok || /<Error>/.test(res.text)) this.fail('completeMultipartUpload', res.status, res.text);
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    const res = await this.send('DELETE', key, { uploadId });
    // 404 NoSuchUpload : déjà terminé ou annulé, rien à faire.
    if (!res.ok && res.status !== 404) this.fail('abortMultipartUpload', res.status, res.text);
  }

  async headObject(key: string): Promise<{ sizeBytes: number; etag: string | null; contentType: string | null } | null> {
    const res = await this.send('HEAD', key, {});
    if (res.status === 404) return null;
    if (!res.ok) this.fail('headObject', res.status, '');
    return {
      sizeBytes: Number(res.headers.get('content-length') ?? '0'),
      etag: res.headers.get('etag'),
      contentType: res.headers.get('content-type'),
    };
  }

  /** Suppression définitive : à n'appeler que depuis une opération explicitement confirmée. */
  async deleteObject(key: string): Promise<void> {
    const res = await this.send('DELETE', key, {});
    if (!res.ok && res.status !== 404) this.fail('deleteObject', res.status, res.text);
  }
}

export { rfc3986 };
