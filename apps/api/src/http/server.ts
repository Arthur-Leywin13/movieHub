/**
 * Adaptateur HTTP sur le module intégré node:http. Volontairement mince : toute la logique métier
 * vit dans des services indépendants du transport, donc remplaçable par Fastify sans les toucher.
 */
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { AppError, NotFoundError, ValidationError, toErrorBody } from '@movieshub/shared';
import type { Router } from './router.ts';
import { silentLogger, type Logger } from './types.ts';

export interface ServerOptions {
  router: Router;
  logger?: Logger;
  maxBodyBytes?: number;
  /** Lit l'IP du client dans X-Forwarded-For (uniquement derrière un proxy de confiance). */
  trustProxy?: boolean;
  corsOrigins?: readonly string[];
}

const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

async function readJson(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const declared = Number(first(req.headers['content-length']) ?? '0');
  if (declared > maxBytes) throw new AppError('VALIDATION_ERROR', 413, 'Corps de requête trop volumineux');
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > maxBytes) throw new AppError('VALIDATION_ERROR', 413, 'Corps de requête trop volumineux');
    chunks.push(buf);
  }
  if (total === 0) return undefined;
  const type = first(req.headers['content-type']) ?? '';
  if (!type.toLowerCase().includes('application/json')) {
    throw new AppError('VALIDATION_ERROR', 415, 'Content-Type application/json requis');
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ValidationError('JSON invalide');
  }
}

export function createHttpServer(opts: ServerOptions): Server {
  const logger = opts.logger ?? silentLogger;
  const maxBody = opts.maxBodyBytes ?? 1_048_576;
  const cors = new Set(opts.corsOrigins ?? []);

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const started = Date.now();
    const requestId = randomUUID();
    const method = (req.method ?? 'GET').toUpperCase();
    const origin = first(req.headers['origin']);
    const headers: Record<string, string> = {
      'content-type': 'application/json; charset=utf-8',
      'x-request-id': requestId,
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
    };
    if (origin && cors.has(origin)) {
      headers['access-control-allow-origin'] = origin;
      headers['vary'] = 'Origin';
    }

    let status = 500;
    let payload: unknown;
    try {
      if (method === 'OPTIONS') {
        if (origin && cors.has(origin)) {
          headers['access-control-allow-methods'] = 'GET,POST,PUT,PATCH,DELETE,OPTIONS';
          headers['access-control-allow-headers'] = 'authorization,content-type,x-telegram-user-id';
          headers['access-control-max-age'] = '600';
        }
        status = 204;
      } else {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const match = opts.router.match(method, url.pathname);
        if (match.kind === 'not_found') throw new NotFoundError('Route introuvable');
        if (match.kind === 'method_not_allowed') {
          headers['allow'] = match.allowed.join(', ');
          throw new AppError('VALIDATION_ERROR', 405, 'Méthode non autorisée');
        }
        const body = BODY_METHODS.has(method) ? await readJson(req, maxBody) : undefined;
        const ip = opts.trustProxy
          ? (first(req.headers['x-forwarded-for'])?.split(',')[0]?.trim() ?? req.socket.remoteAddress ?? 'unknown')
          : (req.socket.remoteAddress ?? 'unknown');
        const flat: Record<string, string | undefined> = {};
        for (const [k, v] of Object.entries(req.headers)) flat[k] = first(v);
        const out = await match.handler({
          method,
          path: url.pathname,
          query: url.searchParams,
          headers: flat,
          body,
          params: match.params,
          ip,
          requestId,
        });
        status = out.status;
        payload = out.body;
        Object.assign(headers, out.headers ?? {});
      }
    } catch (err) {
      const mapped = toErrorBody(err, requestId);
      status = mapped.status;
      payload = mapped.body;
      if (status >= 500) {
        logger.error('Erreur serveur', {
          requestId,
          method,
          path: req.url?.split('?')[0],
          error: err instanceof Error ? err.name : 'inconnue',
        });
      }
    }

    const text = status === 204 || payload === undefined ? '' : JSON.stringify(payload);
    if (status === 413) headers['connection'] = 'close';
    res.writeHead(status, text ? { ...headers, 'content-length': String(Buffer.byteLength(text)) } : headers);
    res.end(text);
    logger.info('requête', { requestId, method, path: req.url?.split('?')[0], status, ms: Date.now() - started });
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      logger.error('Erreur fatale du gestionnaire', { error: err instanceof Error ? err.name : 'inconnue' });
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end('{"error":{"code":"INTERNAL_ERROR","message":"Erreur interne"}}');
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  return server;
}
