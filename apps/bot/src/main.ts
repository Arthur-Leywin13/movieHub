/**
 * Point d'entrée du bot : sondage long (getUpdates) sur le serveur Bot API.
 * NON EXÉCUTÉ dans l'environnement de création (pas de jeton Telegram, pas de serveur local).
 */
import { EnvError, loadBotEnv } from '@movieshub/config';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApiClient } from './api-client.ts';
import { Bot } from './bot.ts';
import { FileResolver } from './files.ts';
import { FileSessionStore } from './session.ts';
import { TelegramClient } from './telegram/client.ts';
import { Uploader } from './uploader.ts';

const log = (message: string, meta?: Record<string, unknown>): void => console.log(JSON.stringify({ level: 'info', message, ...meta }));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  let env;
  try {
    env = loadBotEnv();
  } catch (err) {
    if (err instanceof EnvError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  const allowedIds = new Set<number>();
  for (const id of env.adminTelegramIds) {
    if (id > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Identifiant Telegram hors limites');
    allowedIds.add(Number(id));
  }

  const tg = new TelegramClient({ token: env.telegramBotToken, baseUrl: env.telegramApiBaseUrl });
  const api = new ApiClient({ baseUrl: env.apiBaseUrl, serviceToken: env.botServiceToken });
  const bot = new Bot({
    tg, api, allowedIds, maxFileBytes: env.maxFileBytes, log,
    sessions: new FileSessionStore(join(env.stateDir, 'sessions')),
    files: new FileResolver({ tg, tmpDir: join(tmpdir(), 'movieshub-bot'), maxBytes: env.maxFileBytes }),
    uploader: new Uploader(api),
  });

  // Position de lecture mémorisée : évite de rejouer des messages déjà traités après un redémarrage.
  const offsetFile = join(env.stateDir, 'offset.json');
  await mkdir(env.stateDir, { recursive: true });
  let offset = Number(JSON.parse(await readFile(offsetFile, 'utf8').catch(() => '{"offset":0}')).offset) || 0;
  const saveOffset = async (): Promise<void> => {
    await writeFile(`${offsetFile}.tmp`, JSON.stringify({ offset }));
    await rename(`${offsetFile}.tmp`, offsetFile);
  };

  let stopping = false;
  const stop = (signal: string): void => {
    log('Arrêt demandé', { signal });
    stopping = true;
    void bot.shutdown().finally(() => process.exit(0));
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));

  await tg.deleteWebhook().catch(() => log('deleteWebhook ignoré'));
  log('Bot démarré', { admins: allowedIds.size, serveur: new URL(env.telegramApiBaseUrl).hostname });
  while (!stopping) {
    try {
      const updates = await tg.getUpdates(offset, 30);
      for (const u of updates) {
        offset = u.update_id + 1;
        void bot.handleUpdate(u);
      }
      if (updates.length) await saveOffset();
    } catch (err) {
      log('Erreur de sondage', { error: err instanceof Error ? err.message : 'inconnue' });
      await sleep(3000);
    }
  }
}

void main();
