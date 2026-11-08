/**
 * JWT HS256 minimal (module crypto intégré). Sécurités : algorithme imposé (« none » et autres
 * refusés), comparaison de signature en temps constant, expiration obligatoire, émetteur vérifié.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { UnauthorizedError } from '@movieshub/shared';

export interface JwtPayload {
  sub: string;
  sid: string;
  iss: string;
  iat: number;
  exp: number;
}

const HEADER = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');

const sign = (data: string, secret: string): Buffer => createHmac('sha256', secret).update(data).digest();

export function signJwt(
  claims: { sub: string; sid: string },
  secret: string,
  opts: { expiresInSeconds: number; issuer: string; now?: Date },
): string {
  const iat = Math.floor((opts.now ?? new Date()).getTime() / 1000);
  const payload: JwtPayload = { ...claims, iss: opts.issuer, iat, exp: iat + opts.expiresInSeconds };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const data = `${HEADER}.${body}`;
  return `${data}.${sign(data, secret).toString('base64url')}`;
}

export function verifyJwt(token: string, secret: string, opts: { issuer: string; now?: Date }): JwtPayload {
  const invalid = (): never => {
    throw new UnauthorizedError('Jeton invalide ou expiré');
  };
  const parts = token.split('.');
  if (parts.length !== 3) return invalid();
  const [h, b, s] = parts as [string, string, string];

  // L'en-tête doit être exactement celui que nous émettons : aucun autre algorithme n'est accepté.
  if (h !== HEADER) return invalid();

  const expected = sign(`${h}.${b}`, secret);
  const given = Buffer.from(s, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return invalid();

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(b, 'base64url').toString('utf8'));
  } catch {
    return invalid();
  }
  if (typeof payload !== 'object' || payload === null) return invalid();
  const p = payload as Record<string, unknown>;
  if (
    typeof p['sub'] !== 'string' ||
    typeof p['sid'] !== 'string' ||
    typeof p['iss'] !== 'string' ||
    typeof p['iat'] !== 'number' ||
    typeof p['exp'] !== 'number'
  ) {
    return invalid();
  }
  if (p['iss'] !== opts.issuer) return invalid();
  const nowSeconds = Math.floor((opts.now ?? new Date()).getTime() / 1000);
  if (p['exp'] <= nowSeconds) return invalid();
  return p as unknown as JwtPayload;
}
