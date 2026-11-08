import { ApiClient, ApiError } from '../api-client.ts';
import { Bot } from '../bot.ts';
import { FileResolver } from '../files.ts';
import { MemorySessionStore, type SessionStore } from '../session.ts';
import { Uploader } from '../uploader.ts';
import { ADMIN_ID, BOT_TOKEN, type ApiHarness } from './harness.ts';
import { Driver, FakeTelegram } from './fake-telegram.ts';

/** ApiClient dont l'envoi des morceaux peut échouer ou être bloqué à volonté. */
export class ControlledApi extends ApiClient {
  failPuts = 0;
  /** Si défini : au-delà de ce nombre d'envois, tous les envois échouent (coupure en cours de route). */
  okPuts: number | null = null;
  puts = 0;
  gate: Promise<void> | null = null;
  onGate: (() => void) | null = null;
  override async putPart(url: string, data: Buffer, signal?: AbortSignal): Promise<string> {
    this.puts++;
    if (this.okPuts !== null && this.puts > this.okPuts) throw new ApiError(0, 'UPLOAD_UNREACHABLE', 'coupure simulée');
    if (this.failPuts > 0) {
      this.failPuts--;
      throw new ApiError(0, 'UPLOAD_UNREACHABLE', 'coupure simulée');
    }
    if (this.gate) {
      this.onGate?.();
      await this.gate;
    }
    return super.putPart(url, data, signal);
  }
}

export async function makeBot(h: ApiHarness, opts: { sessions?: SessionStore; tg?: FakeTelegram; allowed?: number[] } = {}) {
  const tg = opts.tg ?? new FakeTelegram();
  if (!opts.tg) await tg.init();
  const api = new ControlledApi({ baseUrl: h.baseUrl, serviceToken: BOT_TOKEN });
  const bot = new Bot({
    tg, api, sessions: opts.sessions ?? new MemorySessionStore(), maxFileBytes: 2000 * 1024 * 1024, progressIntervalMs: 0,
    allowedIds: new Set(opts.allowed ?? [ADMIN_ID]),
    files: new FileResolver({ tg, tmpDir: tg.dir, maxBytes: 2000 * 1024 * 1024 }),
    uploader: new Uploader(api, { sleep: async () => undefined }),
  });
  return { bot, tg, api, admin: new Driver(bot, tg, ADMIN_ID) };
}
