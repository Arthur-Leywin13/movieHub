import { isAbsolute } from 'node:path';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { TelegramPort } from './telegram/types.ts';

export interface FileRef {
  fileId: string;
  name: string;
  size: number | null;
  mime: string | null;
  media: 'photo' | 'video' | 'document';
}

export interface LocalFile {
  path: string;
  size: number;
  name: string;
  /** Vrai si le fichier est une copie temporaire à supprimer après usage. */
  temporary: boolean;
}

export class FileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FileError';
  }
}

/**
 * Rend un fichier Telegram lisible sur disque.
 * - Serveur Bot API local : getFile renvoie un chemin absolu, lu directement (le bot doit partager le volume).
 * - Serveur officiel : chemin relatif, fichier téléchargé en mémoire (20 Mo max) puis copié en temporaire.
 */
export class FileResolver {
  private readonly tg: TelegramPort;
  private readonly tmpDir: string;
  private readonly maxBytes: number;

  constructor(opts: { tg: TelegramPort; tmpDir: string; maxBytes: number }) {
    this.tg = opts.tg;
    this.tmpDir = opts.tmpDir;
    this.maxBytes = opts.maxBytes;
  }

  async resolve(ref: FileRef): Promise<LocalFile> {
    const info = await this.tg.getFile(ref.fileId);
    if (isAbsolute(info.filePath)) {
      let size: number;
      try {
        size = (await stat(info.filePath)).size;
      } catch {
        throw new FileError('Fichier introuvable sur le disque : le bot doit partager le volume du serveur Bot API local');
      }
      if (size > this.maxBytes) throw new FileError('Fichier trop volumineux');
      return { path: info.filePath, size, name: ref.name, temporary: false };
    }
    const data = await this.tg.downloadFile(info.filePath);
    if (data.length > this.maxBytes) throw new FileError('Fichier trop volumineux');
    await mkdir(this.tmpDir, { recursive: true });
    const path = join(this.tmpDir, `${randomUUID()}.bin`);
    await writeFile(path, data);
    return { path, size: data.length, name: ref.name, temporary: true };
  }
}
