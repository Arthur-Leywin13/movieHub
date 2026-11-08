/**
 * Hachage des mots de passe avec scrypt (module intégré de Node : aucune dépendance native).
 * Paramètres par défaut : N=2^15, r=8, p=3 (équivalent OWASP, ~32 Mio de mémoire).
 * Format stocké : scrypt$N$r$p$sel(base64)$hash(base64) — les paramètres voyagent avec le hash,
 * ce qui permet de les durcir plus tard (needsRehash) sans casser les anciens comptes.
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { ValidationError } from '@movieshub/shared';

export interface ScryptParams {
  N: number;
  r: number;
  p: number;
}

export const DEFAULT_SCRYPT_PARAMS: ScryptParams = { N: 2 ** 15, r: 8, p: 3 };

const KEY_LENGTH = 32;
const MAX_MEMORY = 128 * 1024 * 1024;
const MAX_N = 2 ** 20;

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

function scryptAsync(password: string, salt: Buffer, keylen: number, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

const normalize = (password: string): string => password.normalize('NFKC');

export function assertPasswordPolicy(password: unknown): asserts password is string {
  if (typeof password !== 'string') throw new ValidationError('Mot de passe invalide', { field: 'password' });
  if (password.length < PASSWORD_MIN_LENGTH) {
    throw new ValidationError(`Le mot de passe doit contenir au moins ${PASSWORD_MIN_LENGTH} caractères`, { field: 'password' });
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    throw new ValidationError(`Le mot de passe ne doit pas dépasser ${PASSWORD_MAX_LENGTH} caractères`, { field: 'password' });
  }
  if (password.trim().length === 0) {
    throw new ValidationError('Le mot de passe ne peut pas être vide', { field: 'password' });
  }
}

export async function hashPassword(password: string, params: ScryptParams = DEFAULT_SCRYPT_PARAMS): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(normalize(password), salt, KEY_LENGTH, { ...params, maxmem: MAX_MEMORY });
  return ['scrypt', params.N, params.r, params.p, salt.toString('base64'), hash.toString('base64')].join('$');
}

interface Parsed {
  params: ScryptParams;
  salt: Buffer;
  hash: Buffer;
}

function parse(encoded: string): Parsed | null {
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const [N, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  const validInt = (n: number): boolean => Number.isInteger(n) && n > 0;
  if (!validInt(N) || !validInt(r) || !validInt(p) || N > MAX_N || (N & (N - 1)) !== 0) return null;
  const salt = Buffer.from(parts[4] ?? '', 'base64');
  const hash = Buffer.from(parts[5] ?? '', 'base64');
  if (salt.length < 8 || hash.length !== KEY_LENGTH) return null;
  return { params: { N, r, p }, salt, hash };
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parsed = parse(encoded);
  if (!parsed) return false;
  const candidate = await scryptAsync(normalize(password), parsed.salt, KEY_LENGTH, {
    ...parsed.params,
    maxmem: MAX_MEMORY,
  });
  return timingSafeEqual(candidate, parsed.hash);
}

/** Vrai si le hash stocké utilise des paramètres plus faibles que la cible actuelle. */
export function needsRehash(encoded: string, target: ScryptParams = DEFAULT_SCRYPT_PARAMS): boolean {
  const parsed = parse(encoded);
  if (!parsed) return true;
  const { N, r, p } = parsed.params;
  return N < target.N || r < target.r || p < target.p;
}

let dummyHash: Promise<string> | null = null;

/**
 * Vérification factice : à appeler quand l'e-mail est inconnu, pour que le temps de réponse
 * ne révèle pas l'existence du compte.
 */
export async function dummyVerify(password: string, params: ScryptParams = DEFAULT_SCRYPT_PARAMS): Promise<void> {
  dummyHash ??= hashPassword('movieshub-dummy-password', params);
  await verifyPassword(password, await dummyHash);
}
