/**
 * Signature AWS SigV4 (compatible Cloudflare R2), sans dépendance : module crypto intégré.
 * Deux modes : URL pré-signée (accès temporaire pour un client) et en-têtes signés (appels serveur).
 */
import { createHash, createHmac } from 'node:crypto';

export const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';

export interface Credentials {
  accessKeyId: string;
  secretAccessKey: string;
}

export const sha256Hex = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');
export const EMPTY_PAYLOAD_HASH = sha256Hex('');

const hmac = (key: string | Buffer, data: string): Buffer => createHmac('sha256', key).update(data).digest();

/** Encodage RFC 3986 strict (encodeURIComponent laisse passer ! ' ( ) *). */
export function rfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** Encode chaque segment du chemin en conservant les « / ». */
export function encodePath(path: string): string {
  return path.split('/').map(rfc3986).join('/');
}

export function canonicalQuery(query: Record<string, string>): string {
  return Object.entries(query)
    .map(([k, v]) => [rfc3986(k), rfc3986(v)] as const)
    .sort(([ka, va], [kb, vb]) => (ka < kb ? -1 : ka > kb ? 1 : va < vb ? -1 : va > vb ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}

/** AAAAMMJJTHHMMSSZ */
export function amzDate(d: Date): string {
  return d.toISOString().replace(/[:-]|\.\d{3}/g, '');
}

function signingKey(secret: string, stamp: string, region: string, service: string): Buffer {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, stamp), region), service), 'aws4_request');
}

export interface PresignInput {
  method: string;
  host: string;
  /** Chemin brut (non encodé), ex. « /bucket/dossier/fichier.mkv ». */
  path: string;
  query?: Record<string, string>;
  region: string;
  service?: string;
  expiresSeconds: number;
  credentials: Credentials;
  now: Date;
  /** « https » par défaut ; « http » uniquement pour un serveur S3 local de test. */
  scheme?: 'http' | 'https';
}

export function presignUrl(i: PresignInput): string {
  const service = i.service ?? 's3';
  const date = amzDate(i.now);
  const stamp = date.slice(0, 8);
  const scope = `${stamp}/${i.region}/${service}/aws4_request`;
  const query: Record<string, string> = {
    ...(i.query ?? {}),
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${i.credentials.accessKeyId}/${scope}`,
    'X-Amz-Date': date,
    'X-Amz-Expires': String(i.expiresSeconds),
    'X-Amz-SignedHeaders': 'host',
  };
  const cq = canonicalQuery(query);
  const uri = encodePath(i.path);
  const canonicalRequest = [i.method, uri, cq, `host:${i.host}\n`, 'host', UNSIGNED_PAYLOAD].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', date, scope, sha256Hex(canonicalRequest)].join('\n');
  const signature = createHmac('sha256', signingKey(i.credentials.secretAccessKey, stamp, i.region, service))
    .update(stringToSign)
    .digest('hex');
  return `${i.scheme ?? 'https'}://${i.host}${uri}?${cq}&X-Amz-Signature=${signature}`;
}

export interface SignRequestInput {
  method: string;
  host: string;
  path: string;
  query?: Record<string, string>;
  /** En-têtes supplémentaires à signer (ex. content-type, range). */
  headers?: Record<string, string>;
  payloadHash: string;
  region: string;
  service?: string;
  credentials: Credentials;
  now: Date;
}

/** Retourne les en-têtes à envoyer (sans « host », que fetch ajoute lui-même). */
export function signRequest(i: SignRequestInput): Record<string, string> {
  const service = i.service ?? 's3';
  const date = amzDate(i.now);
  const stamp = date.slice(0, 8);
  const scope = `${stamp}/${i.region}/${service}/aws4_request`;

  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(i.headers ?? {})) headers[k.toLowerCase()] = v.trim();
  headers['host'] = i.host;
  headers['x-amz-date'] = date;
  headers['x-amz-content-sha256'] = i.payloadHash;

  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${headers[n]}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalRequest = [
    i.method,
    encodePath(i.path),
    canonicalQuery(i.query ?? {}),
    canonicalHeaders,
    signedHeaders,
    i.payloadHash,
  ].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', date, scope, sha256Hex(canonicalRequest)].join('\n');
  const signature = createHmac('sha256', signingKey(i.credentials.secretAccessKey, stamp, i.region, service))
    .update(stringToSign)
    .digest('hex');

  const out: Record<string, string> = {};
  for (const n of names) if (n !== 'host') out[n] = headers[n] as string;
  out['authorization'] =
    `AWS4-HMAC-SHA256 Credential=${i.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return out;
}
