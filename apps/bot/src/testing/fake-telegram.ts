import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Bot } from '../bot.ts';
import type { Keyboard, TelegramPort, TgMessage } from '../telegram/types.ts';

interface Shown {
  chatId: number;
  messageId: number;
  text: string;
  keyboard: Keyboard;
  touched: number;
}

/** Faux Telegram : enregistre les messages (modifications comprises) et sert des fichiers locaux. */
export class FakeTelegram implements TelegramPort {
  readonly messages = new Map<number, Shown>();
  readonly files = new Map<string, { path: string; size: number }>();
  private tick = 0;
  private nextId = 1;
  dir = '';

  async init(): Promise<void> {
    this.dir = await mkdtemp(join(tmpdir(), 'movieshub-fake-tg-'));
  }
  async cleanup(): Promise<void> {
    await rm(this.dir, { recursive: true, force: true });
  }
  async sendMessage(chatId: number, text: string, keyboard: Keyboard = []) {
    const messageId = this.nextId++;
    this.messages.set(messageId, { chatId, messageId, text, keyboard, touched: ++this.tick });
    return { messageId };
  }
  async editMessage(chatId: number, messageId: number, text: string, keyboard: Keyboard = []) {
    this.messages.set(messageId, { chatId, messageId, text, keyboard, touched: ++this.tick });
  }
  async answerCallback() {}
  async getFile(fileId: string) {
    const f = this.files.get(fileId);
    if (!f) throw new Error('fichier inconnu');
    return { filePath: f.path, size: f.size };
  }
  async downloadFile(): Promise<Buffer> {
    throw new Error('non utilisé');
  }
  /** Enregistre un fichier local (octets aléatoires) et renvoie son file_id Telegram. */
  async registerFile(size: number): Promise<string> {
    const id = `f-${randomUUID()}`;
    const path = join(this.dir, `${id}.bin`);
    await writeFile(path, randomBytes(size));
    this.files.set(id, { path, size });
    return id;
  }
  /** Messages du plus récent au plus ancien (selon la dernière modification). */
  recent(): Shown[] {
    return [...this.messages.values()].sort((a, b) => b.touched - a.touched);
  }
  lastText(): string {
    return this.recent()[0]?.text ?? '';
  }
}

/** Pilote un administrateur : envoie des messages/fichiers, appuie sur les boutons réellement affichés. */
export class Driver {
  readonly bot: Bot;
  readonly tg: FakeTelegram;
  readonly uid: number;
  private updateId = 1;
  private messageId = 5000;
  constructor(bot: Bot, tg: FakeTelegram, uid: number) {
    this.bot = bot;
    this.tg = tg;
    this.uid = uid;
  }
  private msg(extra: Partial<TgMessage>): TgMessage {
    return { message_id: ++this.messageId, from: { id: this.uid }, chat: { id: this.uid }, ...extra };
  }
  async say(text: string): Promise<void> {
    await this.bot.handleUpdate({ update_id: ++this.updateId, message: this.msg({ text }) });
  }
  async file(kind: 'photo' | 'video' | 'document', name: string, size: number, mime?: string): Promise<void> {
    const file_id = await this.tg.registerFile(size);
    const message =
      kind === 'photo' ? this.msg({ photo: [{ file_id, width: 800, height: 1200, file_size: size }] })
      : kind === 'video' ? this.msg({ video: { file_id, file_name: name, file_size: size, ...(mime ? { mime_type: mime } : {}) } })
      : this.msg({ document: { file_id, file_name: name, file_size: size, ...(mime ? { mime_type: mime } : {}) } });
    await this.bot.handleUpdate({ update_id: ++this.updateId, message });
  }
  /** Appuie sur un bouton affiché (par données exactes ou par fragment de libellé). Échoue s'il n'existe pas. */
  async press(dataOrLabel: string): Promise<void> {
    for (const m of this.tg.recent()) {
      const b = m.keyboard.flat().find((x) => x.data === dataOrLabel) ?? m.keyboard.flat().find((x) => x.text.includes(dataOrLabel));
      if (b) {
        await this.bot.handleUpdate({
          update_id: ++this.updateId,
          callback_query: { id: `cb-${this.updateId}`, from: { id: this.uid }, data: b.data, message: { message_id: m.messageId, chat: { id: m.chatId } } },
        });
        return;
      }
    }
    throw new Error(`Bouton introuvable : ${dataOrLabel}\nDernier message : ${this.tg.lastText()}`);
  }
  async settle(): Promise<void> {
    await this.bot.drain();
  }
  hasButton(dataOrLabel: string): boolean {
    return this.tg.recent().some((m) => m.keyboard.flat().some((x) => x.data === dataOrLabel || x.text.includes(dataOrLabel)));
  }
  text(): string {
    return this.tg.lastText();
  }
}
