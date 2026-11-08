import { ValidationError } from '@movieshub/shared';

const fail = (field: string, message: string): never => {
  throw new ValidationError(message, { field });
};

export function asObject(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ValidationError('Un objet JSON est attendu');
  }
  return body as Record<string, unknown>;
}

export function str(
  obj: Record<string, unknown>,
  field: string,
  opts: { min?: number; max?: number } = {},
): string {
  const v = obj[field];
  if (typeof v !== 'string') return fail(field, `Le champ « ${field} » doit être un texte`);
  const t = v.trim();
  if (t.length < (opts.min ?? 1)) return fail(field, `Le champ « ${field} » est trop court`);
  if (t.length > (opts.max ?? 500)) return fail(field, `Le champ « ${field} » est trop long`);
  return t;
}

export function optStr(
  obj: Record<string, unknown>,
  field: string,
  opts: { min?: number; max?: number } = {},
): string | undefined {
  if (obj[field] === undefined || obj[field] === null) return undefined;
  return str(obj, field, opts);
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** E-mail normalisé en minuscules. */
export function email(obj: Record<string, unknown>, field = 'email'): string {
  const v = str(obj, field, { max: 254 }).toLowerCase();
  if (!EMAIL.test(v)) return fail(field, 'Adresse e-mail invalide');
  return v;
}

export function int(obj: Record<string, unknown>, field: string, opts: { min: number; max: number }): number {
  const v = obj[field];
  if (typeof v !== 'number' || !Number.isInteger(v)) return fail(field, `Le champ « ${field} » doit être un entier`);
  if (v < opts.min || v > opts.max) return fail(field, `Le champ « ${field} » doit être entre ${opts.min} et ${opts.max}`);
  return v;
}

export function oneOf<T extends string>(obj: Record<string, unknown>, field: string, values: readonly T[]): T {
  const v = obj[field];
  if (typeof v !== 'string' || !(values as readonly string[]).includes(v)) {
    return fail(field, `Le champ « ${field} » doit valoir : ${values.join(', ')}`);
  }
  return v as T;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function uuidParam(value: string | undefined, field = 'id'): string {
  if (!value || !UUID.test(value)) return fail(field, `Identifiant « ${field} » invalide`);
  return value.toLowerCase();
}

export const has = (obj: Record<string, unknown>, field: string): boolean => Object.prototype.hasOwnProperty.call(obj, field);

export function optInt(obj: Record<string, unknown>, field: string, opts: { min: number; max: number }): number | undefined {
  return obj[field] === undefined ? undefined : int(obj, field, opts);
}

export function optBool(obj: Record<string, unknown>, field: string): boolean | undefined {
  const v = obj[field];
  if (v === undefined) return undefined;
  if (typeof v !== 'boolean') return fail(field, `Le champ « ${field} » doit être vrai ou faux`);
  return v;
}

/** Champ texte qui peut valoir null pour l'effacer ; undefined s'il est absent. */
export function nullableStr(obj: Record<string, unknown>, field: string, opts: { min?: number; max?: number } = {}): string | null | undefined {
  if (!has(obj, field)) return undefined;
  return obj[field] === null ? null : str(obj, field, opts);
}

export function nullableInt(obj: Record<string, unknown>, field: string, opts: { min: number; max: number }): number | null | undefined {
  if (!has(obj, field)) return undefined;
  return obj[field] === null ? null : int(obj, field, opts);
}

export function strArray(obj: Record<string, unknown>, field: string, opts: { max?: number; itemMax?: number } = {}): string[] | undefined {
  const v = obj[field];
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) return fail(field, `Le champ « ${field} » doit être une liste de textes`);
  if (v.length > (opts.max ?? 50)) return fail(field, `Trop d'éléments dans « ${field} »`);
  if ((v as string[]).some((x) => x.length > (opts.itemMax ?? 200))) return fail(field, `Élément trop long dans « ${field} »`);
  return v as string[];
}

/** { add?: string[], remove?: string[] } */
export function setChange(obj: Record<string, unknown>, field: string): { add?: string[]; remove?: string[] } | undefined {
  if (obj[field] === undefined) return undefined;
  const o = asObject(obj[field]);
  const add = strArray(o, 'add');
  const remove = strArray(o, 'remove');
  return { ...(add ? { add } : {}), ...(remove ? { remove } : {}) };
}

export function intQuery(q: URLSearchParams, name: string, def: number, min: number, max: number): number {
  const raw = q.get(name);
  if (raw === null || raw === '') return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) return fail(name, `Paramètre « ${name} » invalide (${min} à ${max})`);
  return n;
}
