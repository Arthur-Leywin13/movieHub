import type { Keyboard, TelegramPort, TgUpdate } from './types.ts';
import { createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export class TelegramError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.name = 'TelegramError';
    this.code = code;
  }
}

const MAX_TEXT = 4000;
const markup = (kb?: Keyboard) =>
  kb && kb.length ? { reply_markup: { inline_keyboard: kb.map((row) => row.map((b) => ({ text: b.text, callback_data: b.data }))) } } : {};

/** Client Bot API sur fetch. Le jeton figure dans l'URL : il n'apparaît jamais dans les erreurs levées. */
export class TelegramClient implements TelegramPort {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly fileServerBaseUrl: string;
  private readonly fileServerWorkDir: string;

  constructor(opts: { token: string; baseUrl: string; fileServerBaseUrl?: string; fileServerWorkDir?: string; fetch?: typeof fetch }) {
    this.token = opts.token;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.fetchFn = opts.fetch ?? fetch;
    this.fileServerBaseUrl = (opts.fileServerBaseUrl ?? '').replace(/\/+$/, '');
    this.fileServerWorkDir = (opts.fileServerWorkDir ?? '/tmp/telegram-bot-api').replace(/\/+$/, '');
  }

  private async call<T>(method: string, payload: Record<string, unknown>, timeoutMs = 30_000): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseUrl}/bot${this.token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new TelegramError(0, 'Telegram injoignable');
    }
    const json = (await res.json().catch(() => null)) as { ok?: boolean; result?: T; description?: string; error_code?: number } | null;
    if (!json || !json.ok) throw new TelegramError(json?.error_code ?? res.status, json?.description ?? 'Réponse Telegram invalide');
    return json.result as T;
  }

  /** Le sondage (getUpdates) échoue si un webhook est actif : on le retire au démarrage. */
  async deleteWebhook(): Promise<void> {
    await this.call('deleteWebhook', { drop_pending_updates: false });
  }

  getUpdates(offset: number, timeoutSeconds: number): Promise<TgUpdate[]> {
    return this.call<TgUpdate[]>('getUpdates', { offset, timeout: timeoutSeconds, allowed_updates: ['message', 'callback_query'] }, (timeoutSeconds + 15) * 1000);
  }

  async sendMessage(chatId: number, text: string, keyboard?: Keyboard): Promise<{ messageId: number }> {
    const r = await this.call<{ message_id: number }>('sendMessage', { chat_id: chatId, text: text.slice(0, MAX_TEXT), ...markup(keyboard) });
    return { messageId: r.message_id };
  }

  async editMessage(chatId: number, messageId: number, text: string, keyboard?: Keyboard): Promise<void> {
    try {
      await this.call('editMessageText', { chat_id: chatId, message_id: messageId, text: text.slice(0, MAX_TEXT), ...markup(keyboard) });
    } catch (err) {
      if (err instanceof TelegramError && /not modified/i.test(err.message)) return;
      throw err;
    }
  }

  async answerCallback(callbackId: string, text?: string): Promise<void> {
    await this.call('answerCallbackQuery', { callback_query_id: callbackId, ...(text ? { text: text.slice(0, 190) } : {}) }).catch(() => undefined);
  }

  async getFile(fileId: string): Promise<{ filePath: string; size: number | null }> {
    const r = await this.call<{ file_path?: string; file_size?: number }>('getFile', { file_id: fileId }, 15 * 60_000);
    if (!r.file_path) throw new TelegramError(400, 'Fichier indisponible');
    return { filePath: r.file_path, size: r.file_size ?? null };
  }

  async downloadFile(filePath: string): Promise<Buffer> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseUrl}/file/bot${this.token}/${filePath}`, { signal: AbortSignal.timeout(5 * 60_000) });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new TelegramError(0, `Téléchargement Telegram impossible: ${detail.slice(0, 180)}`);
    }
    if (!res.ok) throw new TelegramError(res.status, `Téléchargement Telegram refusé (HTTP ${res.status})`);
    return Buffer.from(await res.arrayBuffer());
  }

  /** Copie en streaming depuis le serveur Bot API local, sans charger le fichier entier en RAM. */
  async downloadFileToPath(filePath: string, destination: string): Promise<number> {
    const path = filePath.replace(/^\/+/, '');
    let downloadUrl: string;
    if (this.fileServerBaseUrl) {
      const prefix = this.fileServerWorkDir + '/';
      const relative = filePath.startsWith(prefix) ? filePath.slice(prefix.length) : path;
      if (!relative || relative.split('/').some((part) => part === '..')) throw new TelegramError(400, 'Chemin de fichier local invalide');
      downloadUrl = this.fileServerBaseUrl + '/' + relative.split('/').map(encodeURIComponent).join('/');
    } else {
      downloadUrl = this.baseUrl + '/file/bot' + this.token + '/' + path;
    }
    let res: Response;
    try {
      res = await this.fetchFn(downloadUrl, { signal: AbortSignal.timeout(30 * 60_000) });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new TelegramError(0, `Téléchargement Telegram impossible: ${detail.slice(0, 180)}`);
    }
    if (!res.ok || !res.body) throw new TelegramError(res.status, `Téléchargement Telegram refusé (HTTP ${res.status})`);
    try {
      await pipeline(Readable.fromWeb(res.body as any), createWriteStream(destination));
      return (await stat(destination)).size;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new TelegramError(0, `Écriture du fichier Telegram impossible: ${detail.slice(0, 180)}`);
    }
  }

}
