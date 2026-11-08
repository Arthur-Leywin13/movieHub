/**
 * Serveur S3 local minimal, réservé aux tests : il VÉRIFIE les signatures SigV4 (URL pré-signées et
 * en-têtes) et applique les règles S3 utiles (morceaux de 5 Mio minimum sauf le dernier, ETag,
 * pagination, NoSuchUpload). Il sert à valider le code de test AVANT de le lancer sur le vrai R2 ;
 * il ne prouve rien sur R2 lui-même.
 */
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { presignUrl, signRequest, type Credentials } from '../storage/sigv4.ts';

const MiB = 1024 * 1024;

interface StoredObject {
  body: Buffer;
  etag: string;
  contentType: string | null;
}

export interface MockS3 {
  host: string;
  objects: Map<string, StoredObject>;
  uploads: Map<string, { key: string; parts: Map<number, { body: Buffer; etag: string }> }>;
  close(): Promise<void>;
}

const md5 = (b: Buffer): string => `"${createHash('md5').update(b).digest('hex')}"`;
const xmlEscape = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const xmlDecode = (s: string): string => s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

function parseAmzDate(d: string): Date {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(d);
  if (!m) return new Date(NaN);
  return new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!));
}

function send(res: ServerResponse, status: number, body = '', headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/xml', ...headers });
  res.end(body);
}
const sendError = (res: ServerResponse, status: number, code: string): void =>
  send(res, status, `<Error><Code>${code}</Code><Message>${code}</Message></Error>`);

export async function startMockS3(cfg: { bucket: string; credentials: Credentials; region?: string }): Promise<MockS3> {
  const region = cfg.region ?? 'auto';
  const objects = new Map<string, StoredObject>();
  const uploads: MockS3['uploads'] = new Map();

  const server: Server = createServer(async (req, res) => {
    try {
      const host = req.headers.host as string;
      const method = req.method as string;
      const url = new URL(req.url as string, `http://${host}`);
      const decodedPath = url.pathname.split('/').map(decodeURIComponent).join('/');
      const query: Record<string, string> = {};
      for (const [k, v] of url.searchParams) query[k] = v;

      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = Buffer.concat(chunks);

      // ---- Authentification SigV4 ----
      if (query['X-Amz-Signature']) {
        const { 'X-Amz-Signature': sig, 'X-Amz-Credential': cred, 'X-Amz-Date': date, 'X-Amz-Expires': exp, 'X-Amz-Algorithm': _a, 'X-Amz-SignedHeaders': _h, ...rest } = query;
        const when = parseAmzDate(date ?? '');
        const expected = presignUrl({
          method, host, path: decodedPath, query: rest, region, expiresSeconds: Number(exp),
          credentials: cfg.credentials, now: when, scheme: 'http',
        });
        if (!cred?.startsWith(`${cfg.credentials.accessKeyId}/`)) return sendError(res, 403, 'InvalidAccessKeyId');
        if (new URL(expected).searchParams.get('X-Amz-Signature') !== sig) return sendError(res, 403, 'SignatureDoesNotMatch');
        if (Date.now() > when.getTime() + Number(exp) * 1000) return sendError(res, 403, 'AccessDenied');
      } else if (req.headers.authorization) {
        const m = /^AWS4-HMAC-SHA256 Credential=([^,]+), SignedHeaders=([^,]+), Signature=([0-9a-f]+)$/.exec(req.headers.authorization);
        if (!m) return sendError(res, 403, 'AccessDenied');
        if (!m[1]!.startsWith(`${cfg.credentials.accessKeyId}/`)) return sendError(res, 403, 'InvalidAccessKeyId');
        const payloadHash = String(req.headers['x-amz-content-sha256']);
        if (payloadHash !== createHash('sha256').update(body).digest('hex')) return sendError(res, 400, 'XAmzContentSHA256Mismatch');
        const standard = new Set(['host', 'x-amz-date', 'x-amz-content-sha256']);
        const extra: Record<string, string> = {};
        for (const name of m[2]!.split(';')) if (!standard.has(name)) extra[name] = String(req.headers[name]);
        const expected = signRequest({
          method, host, path: decodedPath, query, headers: extra, payloadHash, region,
          credentials: cfg.credentials, now: parseAmzDate(String(req.headers['x-amz-date'])),
        });
        if (expected['authorization'] !== req.headers.authorization) return sendError(res, 403, 'SignatureDoesNotMatch');
      } else {
        return sendError(res, 403, 'AccessDenied');
      }

      // ---- Routage S3 ----
      const prefix = `/${cfg.bucket}/`;
      if (!decodedPath.startsWith(prefix)) return sendError(res, 404, 'NoSuchBucket');
      const key = decodedPath.slice(prefix.length);
      const uploadId = query['uploadId'];

      if (method === 'POST' && 'uploads' in query) {
        const id = `mock-${randomUUID()}`;
        uploads.set(id, { key, parts: new Map() });
        return send(res, 200, `<InitiateMultipartUploadResult><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`);
      }

      if (uploadId !== undefined) {
        const up = uploads.get(uploadId);
        if (!up || up.key !== key) return sendError(res, 404, 'NoSuchUpload');

        if (method === 'PUT') {
          const n = Number(query['partNumber']);
          if (!Number.isInteger(n) || n < 1 || n > 10_000) return sendError(res, 400, 'InvalidArgument');
          const etag = md5(body);
          up.parts.set(n, { body, etag });
          return send(res, 200, '', { etag });
        }
        if (method === 'GET') {
          const max = Number(query['max-parts'] ?? 1000);
          const marker = Number(query['part-number-marker'] ?? 0);
          const all = [...up.parts.entries()].sort((a, b) => a[0] - b[0]).filter(([n]) => n > marker);
          const page = all.slice(0, max);
          const truncated = all.length > page.length;
          const xml =
            `<ListPartsResult><IsTruncated>${truncated}</IsTruncated>` +
            (truncated ? `<NextPartNumberMarker>${page.at(-1)![0]}</NextPartNumberMarker>` : '') +
            page.map(([n, p]) => `<Part><PartNumber>${n}</PartNumber><ETag>${xmlEscape(p.etag)}</ETag><Size>${p.body.length}</Size></Part>`).join('') +
            '</ListPartsResult>';
          return send(res, 200, xml);
        }
        if (method === 'DELETE') {
          uploads.delete(uploadId);
          return send(res, 204);
        }
        if (method === 'POST') {
          const wanted = [...body.toString('utf8').matchAll(/<Part><PartNumber>(\d+)<\/PartNumber><ETag>(.*?)<\/ETag><\/Part>/g)].map((m) => ({
            n: Number(m[1]), etag: xmlDecode(m[2] as string),
          }));
          if (wanted.length === 0) return sendError(res, 400, 'MalformedXML');
          const buffers: Buffer[] = [];
          for (let i = 0; i < wanted.length; i++) {
            const w = wanted[i]!;
            const part = up.parts.get(w.n);
            if (!part || part.etag !== w.etag) return sendError(res, 400, 'InvalidPart');
            if (i > 0 && w.n <= wanted[i - 1]!.n) return sendError(res, 400, 'InvalidPartOrder');
            if (i < wanted.length - 1 && part.body.length < 5 * MiB) return sendError(res, 400, 'EntityTooSmall');
            buffers.push(part.body);
          }
          const full = Buffer.concat(buffers);
          objects.set(key, { body: full, etag: `"${createHash('md5').update(full).digest('hex')}-${wanted.length}"`, contentType: null });
          uploads.delete(uploadId);
          return send(res, 200, `<CompleteMultipartUploadResult><ETag>${xmlEscape(objects.get(key)!.etag)}</ETag></CompleteMultipartUploadResult>`);
        }
        return sendError(res, 405, 'MethodNotAllowed');
      }

      if (method === 'PUT') {
        const etag = md5(body);
        objects.set(key, { body, etag, contentType: (req.headers['content-type'] as string | undefined) ?? null });
        return send(res, 200, '', { etag });
      }
      const obj = objects.get(key);
      if (method === 'HEAD') {
        if (!obj) return send(res, 404);
        return send(res, 200, '', { 'content-length': String(obj.body.length), etag: obj.etag, 'content-type': obj.contentType ?? 'binary/octet-stream' });
      }
      if (method === 'GET') {
        if (!obj) return sendError(res, 404, 'NoSuchKey');
        const headers: Record<string, string> = { etag: obj.etag, 'content-type': obj.contentType ?? 'binary/octet-stream' };
        if (query['response-content-disposition']) headers['content-disposition'] = query['response-content-disposition'];
        res.writeHead(200, headers);
        return void res.end(obj.body);
      }
      if (method === 'DELETE') {
        objects.delete(key);
        return send(res, 204);
      }
      return sendError(res, 405, 'MethodNotAllowed');
    } catch {
      if (!res.headersSent) sendError(res, 500, 'InternalError');
      else res.end();
    }
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    host, objects, uploads,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
