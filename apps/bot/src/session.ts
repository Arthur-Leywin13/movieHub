import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export type Data = Record<string, any>;

export interface Session {
  userId: number;
  chatId: number;
  /** Identifiant du parcours en cours (ex. « add:MOVIE »), nul au repos. */
  flow: string | null;
  phase: 'idle' | 'wizard' | 'running' | 'failed';
  /** Étapes restantes (identifiants), la première est l'étape courante. */
  stack: string[];
  data: Data;
  /** État temporaire de l'étape courante (ex. sélection multiple). */
  tmp: Data;
  /** Avancement du traitement (reprise après coupure). */
  progress: Data;
  error: string | null;
  updatedAt: string;
}

export const newSession = (userId: number, chatId: number): Session => ({
  userId, chatId, flow: null, phase: 'idle', stack: [], data: {}, tmp: {}, progress: {}, error: null, updatedAt: new Date().toISOString(),
});

export interface SessionStore {
  get(userId: number): Promise<Session | null>;
  set(session: Session): Promise<void>;
  delete(userId: number): Promise<void>;
}

export class MemorySessionStore implements SessionStore {
  private readonly map = new Map<number, string>();
  async get(userId: number) {
    const raw = this.map.get(userId);
    return raw ? (JSON.parse(raw) as Session) : null;
  }
  async set(s: Session) {
    this.map.set(s.userId, JSON.stringify({ ...s, updatedAt: new Date().toISOString() }));
  }
  async delete(userId: number) {
    this.map.delete(userId);
  }
}

/** Un fichier JSON par administrateur, écrit de façon atomique : une conversation survit à un redémarrage. */
export class FileSessionStore implements SessionStore {
  private readonly dir: string;
  constructor(dir: string) {
    this.dir = dir;
  }
  private file(userId: number): string {
    if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error('Identifiant utilisateur invalide');
    return join(this.dir, `${userId}.json`);
  }
  async get(userId: number): Promise<Session | null> {
    const file = this.file(userId);
    try {
      return JSON.parse(await readFile(file, 'utf8')) as Session;
    } catch {
      return null;
    }
  }
  async set(s: Session): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const f = this.file(s.userId);
    const tmp = `${f}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify({ ...s, updatedAt: new Date().toISOString() }), { mode: 0o600 });
    await rename(tmp, f);
  }
  async delete(userId: number): Promise<void> {
    await rm(this.file(userId), { force: true });
  }
}
