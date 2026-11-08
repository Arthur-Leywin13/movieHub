import { ConflictError, ValidationError, slugify } from '@movieshub/shared';

export const CONTENT_TYPES = ['MOVIE', 'SERIES', 'ANIME'] as const;
export type ContentTypeName = (typeof CONTENT_TYPES)[number];

export const PUBLICATION_STATUSES = ['DRAFT', 'IN_PREPARATION', 'SCHEDULED', 'PUBLISHED', 'UNPUBLISHED', 'WITHDRAWN', 'ARCHIVED'] as const;
export type PublicationStatusName = (typeof PUBLICATION_STATUSES)[number];

/** Statuts qu'un administrateur peut demander directement (SCHEDULED et WITHDRAWN ont leurs propres parcours). */
export const SETTABLE_STATUSES = ['DRAFT', 'IN_PREPARATION', 'PUBLISHED', 'UNPUBLISHED', 'ARCHIVED'] as const;

const TRANSITIONS: Record<PublicationStatusName, readonly PublicationStatusName[]> = {
  DRAFT: ['IN_PREPARATION', 'PUBLISHED', 'ARCHIVED'],
  IN_PREPARATION: ['DRAFT', 'PUBLISHED', 'ARCHIVED'],
  SCHEDULED: ['DRAFT', 'IN_PREPARATION', 'PUBLISHED', 'ARCHIVED'],
  PUBLISHED: ['UNPUBLISHED', 'ARCHIVED'],
  UNPUBLISHED: ['IN_PREPARATION', 'PUBLISHED', 'ARCHIVED'],
  ARCHIVED: ['DRAFT'],
  WITHDRAWN: [],
};

export const canTransition = (from: PublicationStatusName, to: PublicationStatusName): boolean => TRANSITIONS[from].includes(to);

export function assertTransition(from: PublicationStatusName, to: PublicationStatusName): void {
  if (!canTransition(from, to)) throw new ConflictError(`Changement de statut interdit : ${from} → ${to}`, { from, to });
}

const LANG = /^[a-z]{2,3}(-[a-z0-9]{2,8})?$/;

/** Codes de langue en minuscules, sans doublon (ex. « FR », « fr » → « fr »). */
export function normalizeCodes(values: readonly string[], field: string, max = 20): string[] {
  const out = [...new Set(values.map((v) => v.trim().toLowerCase()))];
  if (out.length > max) throw new ValidationError(`Trop de valeurs pour « ${field} » (max ${max})`, { field });
  for (const c of out) if (!LANG.test(c)) throw new ValidationError(`Code de langue invalide : « ${c} »`, { field });
  return out;
}

/** Suppression des doublons insensible à la casse, en gardant la première graphie. */
export function dedupeTexts(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values.map((x) => x.trim()).filter(Boolean)) {
    const k = v.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      out.push(v);
    }
  }
  return out;
}

export const genreSlug = (name: string): string => slugify(name, 60);

export interface SetChange {
  add?: string[];
  remove?: string[];
}

export interface ContentChanges {
  title?: string;
  description?: string | null;
  year?: number | null;
  releaseDate?: string | null;
  altTitles?: SetChange;
  genres?: SetChange;
  audioLanguages?: SetChange;
  subtitleLanguages?: SetChange;
}

export interface ChangeLine {
  field: string;
  from: unknown;
  to: unknown;
}

export interface ContentSnapshot {
  title: string;
  description: string | null;
  year: number | null;
  releaseDate: string | null;
  altTitles: string[];
  genres: { slug: string; name: string }[];
  audioLanguages: string[];
  subtitleLanguages: string[];
}

function applySet(current: string[], change: SetChange | undefined, key: (v: string) => string): string[] {
  if (!change) return current;
  const removed = new Set((change.remove ?? []).map(key));
  const kept = current.filter((v) => !removed.has(key(v)));
  const have = new Set(kept.map(key));
  for (const a of change.add ?? []) if (!have.has(key(a))) { kept.push(a); have.add(key(a)); }
  return kept;
}

/** Résumé « avant → après » des seuls champs qui changent réellement (affiché avant confirmation). */
export function summarizeContentChanges(before: ContentSnapshot, c: ContentChanges): ChangeLine[] {
  const lines: ChangeLine[] = [];
  const scalar = <K extends 'title' | 'description' | 'year' | 'releaseDate'>(field: K): void => {
    if (c[field] !== undefined && c[field] !== before[field]) lines.push({ field, from: before[field], to: c[field] });
  };
  scalar('title');
  scalar('description');
  scalar('year');
  scalar('releaseDate');

  const sets: Array<[string, string[], SetChange | undefined, (v: string) => string]> = [
    ['altTitles', before.altTitles, c.altTitles, (v) => v.toLowerCase()],
    ['genres', before.genres.map((g) => g.name), c.genres, (v) => genreSlug(v)],
    ['audioLanguages', before.audioLanguages, c.audioLanguages, (v) => v],
    ['subtitleLanguages', before.subtitleLanguages, c.subtitleLanguages, (v) => v],
  ];
  for (const [field, current, change, key] of sets) {
    const next = applySet(current, change, key);
    const a = [...current].map(key).sort().join('|');
    const b = [...next].map(key).sort().join('|');
    if (a !== b) lines.push({ field, from: [...current].sort(), to: [...next].sort() });
  }
  return lines;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
export function assertDate(value: string, field: string): void {
  const d = new Date(`${value}T00:00:00Z`);
  if (!DATE.test(value) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) {
    throw new ValidationError(`Date invalide pour « ${field} » (format AAAA-MM-JJ)`, { field });
  }
}

export function assertHttpsUrl(value: string, field: string): void {
  let ok = false;
  try {
    const u = new URL(value);
    ok = u.protocol === 'https:' && u.hostname.includes('.');
  } catch {
    ok = false;
  }
  if (!ok || value.length > 500) throw new ValidationError(`Lien https invalide pour « ${field} »`, { field });
}

export const SUBTITLE_FORMATS = ['SRT', 'WEBVTT', 'ASS', 'SSA', 'OTHER'] as const;
export type SubtitleFormatName = (typeof SUBTITLE_FORMATS)[number];

/** Format de sous-titres déduit de l'extension de la clé R2 (jamais déclaré par le client). */
export function subtitleFormatFromKey(objectKey: string): SubtitleFormatName {
  const ext = /\.([a-z0-9]+)$/i.exec(objectKey)?.[1]?.toLowerCase();
  return ext === 'srt' ? 'SRT' : ext === 'vtt' ? 'WEBVTT' : ext === 'ass' ? 'ASS' : ext === 'ssa' ? 'SSA' : 'OTHER';
}
