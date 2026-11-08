import { ValidationError } from '@movieshub/shared';

export const UPLOAD_KINDS = ['VIDEO', 'TRAILER_VIDEO', 'IMAGE', 'SUBTITLE'] as const;
export type UploadKind = (typeof UPLOAD_KINDS)[number];

const MiB = 1024 * 1024;
const VIDEO_MIMES: Record<string, string> = {
  mp4: 'video/mp4',
  mkv: 'video/x-matroska',
  webm: 'video/webm',
  mov: 'video/quicktime',
  avi: 'video/x-msvideo',
};

export interface UploadRule {
  prefix: string;
  /** extension autorisée -> type MIME (déduit de l'extension, jamais fourni par le client). */
  mimes: Record<string, string>;
  maxBytes: number;
  multipart: boolean;
}

/** 2000 Mo : maximum d'un fichier Telegram, aligné avec la limite du bot. */
export const MAX_VIDEO_BYTES = 2000 * MiB;

export const UPLOAD_RULES: Record<UploadKind, UploadRule> = {
  VIDEO: { prefix: 'video', mimes: VIDEO_MIMES, maxBytes: MAX_VIDEO_BYTES, multipart: true },
  TRAILER_VIDEO: { prefix: 'trailer', mimes: VIDEO_MIMES, maxBytes: MAX_VIDEO_BYTES, multipart: true },
  IMAGE: {
    prefix: 'image',
    mimes: { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' },
    maxBytes: 25 * MiB,
    multipart: false,
  },
  SUBTITLE: {
    prefix: 'subtitle',
    mimes: { srt: 'application/x-subrip', vtt: 'text/vtt', ass: 'text/x-ssa', ssa: 'text/x-ssa' },
    maxBytes: 5 * MiB,
    multipart: false,
  },
};

export function resolveUpload(kind: UploadKind, filename: string, sizeBytes: number) {
  const rule = UPLOAD_RULES[kind];
  const ext = /\.([A-Za-z0-9]{1,5})$/.exec(filename.trim())?.[1]?.toLowerCase();
  const mime = ext ? rule.mimes[ext] : undefined;
  if (!ext || !mime) {
    throw new ValidationError(`Extension non autorisée pour ${kind} (autorisées : ${Object.keys(rule.mimes).join(', ')})`, {
      field: 'filename',
    });
  }
  if (!Number.isInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > rule.maxBytes) {
    throw new ValidationError(`Taille invalide : 1 à ${rule.maxBytes} octets pour ${kind}`, { field: 'sizeBytes' });
  }
  return { rule, ext, mime };
}

/**
 * Clé d'objet R2 : seul l'identifiant généré par le serveur et une extension de la liste blanche
 * entrent dans la clé. Le nom de fichier du client n'y figure jamais (pas de traversée de chemin).
 */
export function buildObjectKey(kind: UploadKind, id: string, ext: string, now: Date): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${UPLOAD_RULES[kind].prefix}/${y}/${m}/${id}.${ext}`;
}

export const MIN_PART_SIZE = 5 * MiB;
export const MAX_PARTS = 10_000;

/** Morceaux de taille uniforme (exigence R2), 16 Mio minimum, jamais plus de 9000 morceaux. */
export function choosePartSize(totalBytes: number): number {
  return Math.max(16 * MiB, Math.ceil(totalBytes / 9000));
}

export const partCount = (totalBytes: number, partSize: number): number => Math.ceil(totalBytes / partSize);

export function expectedPartSize(totalBytes: number, partSize: number, partNumber: number): number {
  const count = partCount(totalBytes, partSize);
  return partNumber < count ? partSize : totalBytes - partSize * (count - 1);
}
