import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** Refresh token opaque : 48 octets aléatoires (384 bits). */
export function generateRefreshToken(): string {
  return randomBytes(48).toString('base64url');
}

/** HMAC-SHA256 avec un secret serveur : une fuite de la base seule ne permet pas de forger un token. */
export function hashRefreshToken(token: string, pepper: string): string {
  return createHmac('sha256', pepper).update(token).digest('hex');
}

/** Comparaison en temps constant de deux chaînes de longueurs quelconques. */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}
