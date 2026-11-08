import type { FileRef } from './files.ts';
import type { Data } from './session.ts';
import type { InlineButton } from './telegram/types.ts';
import type { Prompt, StepCtx, StepDef, StepResult } from './wizard.ts';

export const CANCEL: InlineButton = { text: '❌ Annuler', data: 'x:cancel' };
const SKIP: InlineButton = { text: '⏭ Passer', data: 'skip' };

export type Text = string | ((d: Data) => string);
const txt = (t: Text, d: Data): string => (typeof t === 'function' ? t(d) : t);
const done = (value?: unknown): StepResult => ({ status: 'done', value });
const invalid = (error: string): StepResult => ({ status: 'invalid', error });

interface Base {
  id: string;
  when?: (d: Data) => boolean;
  next?: (value: any, d: Data) => string[];
}

const rows = (buttons: InlineButton[], columns: number): InlineButton[][] => {
  const out: InlineButton[][] = [];
  for (let i = 0; i < buttons.length; i += columns) out.push(buttons.slice(i, i + columns));
  return out;
};

export function textStep(o: Base & { prompt: Text; optional?: boolean; min?: number; max?: number; apply: (d: Data, v: string | undefined) => void }): StepDef {
  return {
    id: o.id, ...(o.when ? { when: o.when } : {}), ...(o.next ? { next: o.next } : {}), apply: o.apply,
    ask: ({ data }) => ({ text: txt(o.prompt, data) + (o.optional ? '\n(facultatif)' : ''), keyboard: [...(o.optional ? [[SKIP]] : []), [CANCEL]] }),
    handle: (input) => {
      if (input.kind === 'callback' && input.data === 'skip' && o.optional) return done(undefined);
      if (input.kind !== 'text') return invalid('Envoyez un texte.');
      const v = input.text.trim();
      if (v.length < (o.min ?? 1)) return invalid('Texte trop court.');
      if (v.length > (o.max ?? 200)) return invalid(`Texte trop long (max ${o.max ?? 200} caractères).`);
      return done(v);
    },
  };
}

export function numberStep(o: Base & { prompt: Text; min: number; max: number; suggest?: (d: Data) => number | null; validate?: (n: number, d: Data) => string | null; apply: (d: Data, v: number) => void }): StepDef {
  return {
    id: o.id, ...(o.when ? { when: o.when } : {}), ...(o.next ? { next: o.next } : {}), apply: o.apply,
    ask: ({ data }) => {
      const s = o.suggest?.(data) ?? null;
      return { text: txt(o.prompt, data), keyboard: [...(s !== null ? [[{ text: `${s}`, data: `n:${s}` }]] : []), [CANCEL]] };
    },
    handle: (input, { data }) => {
      const raw = input.kind === 'callback' && input.data.startsWith('n:') ? input.data.slice(2) : input.kind === 'text' ? input.text.trim() : null;
      if (raw === null) return invalid('Envoyez un nombre.');
      if (!/^\d{1,5}$/.test(raw)) return invalid('Envoyez un nombre entier.');
      const n = Number(raw);
      if (n < o.min || n > o.max) return invalid(`Le nombre doit être entre ${o.min} et ${o.max}.`);
      const problem = o.validate?.(n, data) ?? null;
      return problem ? invalid(problem) : done(n);
    },
  };
}

export function dateStep(o: Base & { prompt: Text; optional?: boolean; apply: (d: Data, v: string | undefined) => void }): StepDef {
  return {
    id: o.id, ...(o.when ? { when: o.when } : {}), ...(o.next ? { next: o.next } : {}), apply: o.apply,
    ask: ({ data }) => ({ text: `${txt(o.prompt, data)}\nFormat AAAA-MM-JJ (ex. 2024-02-28)${o.optional ? '\n(facultatif)' : ''}`, keyboard: [...(o.optional ? [[SKIP]] : []), [CANCEL]] }),
    handle: (input) => {
      if (input.kind === 'callback' && input.data === 'skip' && o.optional) return done(undefined);
      if (input.kind !== 'text') return invalid('Envoyez une date.');
      const v = input.text.trim();
      const d = new Date(`${v}T00:00:00Z`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) return invalid('Date invalide (format AAAA-MM-JJ).');
      return done(v);
    },
  };
}

export function listStep(o: Base & { prompt: Text; optional?: boolean; max: number; itemMax?: number; apply: (d: Data, v: string[]) => void }): StepDef {
  return {
    id: o.id, ...(o.when ? { when: o.when } : {}), ...(o.next ? { next: o.next } : {}), apply: (d, v) => o.apply(d, (v as string[] | undefined) ?? []),
    ask: ({ data }) => ({ text: `${txt(o.prompt, data)}\nSéparez par des virgules.${o.optional ? '\n(facultatif)' : ''}`, keyboard: [...(o.optional ? [[SKIP]] : []), [CANCEL]] }),
    handle: (input) => {
      if (input.kind === 'callback' && input.data === 'skip' && o.optional) return done([]);
      if (input.kind !== 'text') return invalid('Envoyez un texte.');
      const items = [...new Set(input.text.split(/[,;\n]/).map((s) => s.trim()).filter(Boolean))];
      if (items.length === 0) return invalid('Indiquez au moins un élément.');
      if (items.length > o.max) return invalid(`Maximum ${o.max} éléments.`);
      if (items.some((s) => s.length > (o.itemMax ?? 100))) return invalid('Un élément est trop long.');
      return done(items);
    },
  };
}

export interface Option {
  label: string;
  value: string;
}

export function choiceStep(o: Base & { prompt: Text; options: (ctx: StepCtx) => Option[] | Promise<Option[]>; columns?: number; cancel?: boolean; apply: (d: Data, v: string) => void }): StepDef {
  return {
    id: o.id, ...(o.when ? { when: o.when } : {}), ...(o.next ? { next: o.next } : {}), apply: o.apply,
    prepare: async (ctx) => {
      ctx.tmp['options'] = await o.options(ctx);
    },
    ask: ({ data, tmp }) => ({
      text: txt(o.prompt, data),
      keyboard: [...rows((tmp['options'] as Option[]).map((x) => ({ text: x.label, data: `c:${x.value}` })), o.columns ?? 1), ...(o.cancel === false ? [] : [[CANCEL]])],
    }),
    handle: (input, { tmp }) => {
      if (input.kind !== 'callback' || !input.data.startsWith('c:')) return invalid('Choisissez une option avec les boutons.');
      const v = input.data.slice(2);
      return (tmp['options'] as Option[]).some((x) => x.value === v) ? done(v) : invalid('Option inconnue.');
    },
  };
}

export function multiStep(o: Base & { prompt: Text; options: (ctx: StepCtx) => Option[]; min?: number; apply: (d: Data, v: string[]) => void }): StepDef {
  return {
    id: o.id, ...(o.when ? { when: o.when } : {}), ...(o.next ? { next: o.next } : {}), apply: o.apply,
    prepare: async (ctx) => {
      ctx.tmp['options'] = o.options(ctx);
      ctx.tmp['sel'] ??= [];
    },
    ask: ({ data, tmp }): Prompt => {
      const sel = new Set(tmp['sel'] as string[]);
      const buttons = (tmp['options'] as Option[]).map((x) => ({ text: `${sel.has(x.value) ? '☑' : '☐'} ${x.label}`, data: `m:${x.value}` }));
      return { text: `${txt(o.prompt, data)}\nCochez puis validez.`, keyboard: [...rows(buttons, 2), [{ text: '✅ Valider', data: 'ok' }], [CANCEL]] };
    },
    handle: (input, { tmp }) => {
      if (input.kind !== 'callback') return invalid('Utilisez les boutons.');
      const sel = (tmp['sel'] as string[] | undefined) ?? [];
      if (input.data.startsWith('m:')) {
        const v = input.data.slice(2);
        if (!(tmp['options'] as Option[]).some((x) => x.value === v)) return invalid('Option inconnue.');
        tmp['sel'] = sel.includes(v) ? sel.filter((x) => x !== v) : [...sel, v];
        return { status: 'stay' };
      }
      if (input.data === 'ok') return sel.length < (o.min ?? 0) ? invalid(`Choisissez au moins ${o.min} élément.`) : done(sel);
      return invalid('Utilisez les boutons.');
    },
  };
}

// ---------- fichiers ----------
export type FileKind = 'image' | 'video' | 'subtitle';
const MiB = 1024 * 1024;
const EXT: Record<FileKind, string[]> = { image: ['jpg', 'jpeg', 'png', 'webp'], video: ['mp4', 'mkv', 'webm', 'mov', 'avi'], subtitle: ['srt', 'vtt', 'ass', 'ssa'] };
const MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
  'video/mp4': 'mp4', 'video/x-matroska': 'mkv', 'video/webm': 'webm', 'video/quicktime': 'mov', 'video/x-msvideo': 'avi',
};
const MAX_BY_KIND: Record<FileKind, number> = { image: 25 * MiB, video: Number.MAX_SAFE_INTEGER, subtitle: 5 * MiB };
const LABEL: Record<FileKind, string> = { image: 'une image (photo ou fichier jpg/png/webp)', video: 'une vidéo (mp4, mkv, webm, mov, avi)', subtitle: 'un fichier de sous-titres (srt, vtt, ass, ssa)' };

/** Valide un fichier reçu et garantit un nom avec une extension autorisée. */
export function normalizeFile(ref: FileRef, kind: FileKind, maxBytes: number): { ok: true; file: FileRef } | { ok: false; error: string } {
  const accepted = kind === 'image' ? ['photo', 'document'] : kind === 'video' ? ['video', 'document'] : ['document'];
  if (!accepted.includes(ref.media)) return { ok: false, error: `Envoyez ${LABEL[kind]}.` };
  let ext = /\.([A-Za-z0-9]{1,5})$/.exec(ref.name)?.[1]?.toLowerCase();
  if (!ext || !EXT[kind].includes(ext)) {
    const fromMime = ref.mime ? MIME_EXT[ref.mime] : undefined;
    if (fromMime && EXT[kind].includes(fromMime)) ext = fromMime;
    else if (ref.media === 'photo') ext = 'jpg';
    else return { ok: false, error: `Format non pris en charge. Envoyez ${LABEL[kind]}.` };
  }
  const base = ref.name.replace(/\.[A-Za-z0-9]{1,5}$/, '') || (kind === 'image' ? 'image' : kind === 'video' ? 'video' : 'sous-titres');
  if (ref.size !== null && ref.size > Math.min(maxBytes, MAX_BY_KIND[kind])) {
    return { ok: false, error: `Fichier trop volumineux (max ${Math.floor(Math.min(maxBytes, MAX_BY_KIND[kind]) / MiB)} Mo).` };
  }
  return { ok: true, file: { ...ref, name: `${base}.${ext}` } };
}

export function fileStep(o: Base & { prompt: Text; kind: FileKind; optional?: boolean; allowUrl?: boolean; apply: (d: Data, v: any) => void }): StepDef {
  return {
    id: o.id, ...(o.when ? { when: o.when } : {}), ...(o.next ? { next: o.next } : {}), apply: o.apply,
    ask: ({ data }) => ({
      text: `${txt(o.prompt, data)}\nEnvoyez ${LABEL[o.kind]}${o.allowUrl ? ' ou un lien https' : ''}.${o.optional ? '\n(facultatif)' : ''}`,
      keyboard: [...(o.optional ? [[SKIP]] : []), [CANCEL]],
    }),
    handle: (input, { env }) => {
      if (input.kind === 'callback' && input.data === 'skip' && o.optional) return done(undefined);
      if (input.kind === 'text' && o.allowUrl) {
        const v = input.text.trim();
        try {
          const u = new URL(v);
          if (u.protocol === 'https:' && u.hostname.includes('.') && v.length <= 500) return done({ url: v });
        } catch {
          /* tombe sur le message d'erreur ci-dessous */
        }
        return invalid('Lien https invalide.');
      }
      if (input.kind !== 'file') return invalid(`Envoyez ${LABEL[o.kind]}${o.allowUrl ? ' ou un lien https' : ''}.`);
      const r = normalizeFile(input.file, o.kind, env.maxFileBytes);
      return r.ok ? done(r.file) : invalid(r.error);
    },
  };
}
