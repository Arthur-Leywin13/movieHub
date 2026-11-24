import { isAbsolute } from 'node:path';
import { mkdir, rm, writeFile } from 'node:fs/promises';
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
 * - Bot API local : getFile renvoie un chemin absolu sur le serveur Telegram ; copie HTTP en streaming vers le bot.
 * - Serveur officiel : chemin relatif, fichier téléchargé en mémoire puis copié en temporaire.
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
      // Le chemin absolu est sur l'hôte du Bot API, pas dans ce service Railway.
      await mkdir(this.tmpDir, { recursive: true });
      const path = join(this.tmpDir, `${randomUUID()}.bin`);
      let size: number;
      try {
        if (this.tg.downloadFileToPath) {
          size = await this.tg.downloadFileToPath(info.filePath, path);
        } else {
          const data = await this.tg.downloadFile(info.filePath);
          size = data.length;
          await writeFile(path, data);
        }
      } catch {
        throw new FileError('Téléchargement depuis le serveur Bot API local impossible');
      }
      if (size > this.maxBytes) {
        await rm(path, { force: true });
        throw new FileError('Fichier trop volumineux');
      }
      return { path, size, name: ref.name, temporary: true };
    }
    const data = await this.tg.downloadFile(info.filePath);
    if (data.length > this.maxBytes) throw new FileError('Fichier trop volumineux');
    await mkdir(this.tmpDir, { recursive: true });
    const path = join(this.tmpDir, `${randomUUID()}.bin`);
    await writeFile(path, data);
    return { path, size: data.length, name: ref.name, temporary: true };
  }
}
