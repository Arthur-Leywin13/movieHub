import type { StatRow } from '../user/ports.ts';

export interface TrendingWeights {
  views: number;
  downloads: number;
  favorites: number;
  plays: number;
  windowDays: number;
}

export const DEFAULT_TRENDING: TrendingWeights = { views: 1, downloads: 5, favorites: 3, plays: 2, windowDays: 7 };

/** Pondérations lues dans le réglage « trending » (modifiable depuis le dashboard) ; valeur invalide = défaut. */
export function parseWeights(raw: unknown): TrendingWeights {
  const o = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const num = (k: 'views' | 'downloads' | 'favorites' | 'plays'): number => (typeof o[k] === 'number' && Number.isFinite(o[k]) && (o[k] as number) >= 0 && (o[k] as number) <= 1000 ? (o[k] as number) : DEFAULT_TRENDING[k]);
  const w = o['windowDays'];
  return {
    views: num('views'), downloads: num('downloads'), favorites: num('favorites'), plays: num('plays'),
    windowDays: typeof w === 'number' && Number.isInteger(w) && w >= 1 && w <= 60 ? w : DEFAULT_TRENDING.windowDays,
  };
}

/**
 * Classement par usage récent (consultations, téléchargements, favoris, lectures sur la fenêtre).
 * Aucun bonus de nouveauté : un contenu qui vient d'être ajouté sans activité n'apparaît pas.
 */
export function rankTrending(rows: StatRow[], w: TrendingWeights): { contentId: string; score: number }[] {
  return rows
    .map((r) => ({ contentId: r.contentId, score: r.views * w.views + r.downloads * w.downloads + r.favorites * w.favorites + r.plays * w.plays }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.contentId.localeCompare(b.contentId));
}

export const isoDay = (d: Date): string => d.toISOString().slice(0, 10);
export const daysAgo = (d: Date, n: number): string => isoDay(new Date(d.getTime() - n * 86_400_000));
