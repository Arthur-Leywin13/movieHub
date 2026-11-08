export interface TgUser { id: number; is_bot?: boolean; username?: string }
export interface TgPhotoSize { file_id: string; width: number; height: number; file_size?: number }
export interface TgDocument { file_id: string; file_name?: string; mime_type?: string; file_size?: number }
export interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: { id: number; type?: string };
  text?: string;
  caption?: string;
  photo?: TgPhotoSize[];
  document?: TgDocument;
  video?: TgDocument;
}
export interface TgCallbackQuery { id: string; from: TgUser; message?: TgMessage; data?: string }
export interface TgUpdate { update_id: number; message?: TgMessage; callback_query?: TgCallbackQuery }

export interface InlineButton { text: string; data: string }
export type Keyboard = InlineButton[][];

/** Ce dont le bot a besoin de Telegram (faux en test, client HTTP en production). */
export interface TelegramPort {
  sendMessage(chatId: number, text: string, keyboard?: Keyboard): Promise<{ messageId: number }>;
  editMessage(chatId: number, messageId: number, text: string, keyboard?: Keyboard): Promise<void>;
  answerCallback(callbackId: string, text?: string): Promise<void>;
  getFile(fileId: string): Promise<{ filePath: string; size: number | null }>;
  /** Serveur officiel uniquement (fichiers <= 20 Mo) : télécharge le fichier en mémoire. */
  downloadFile(filePath: string): Promise<Buffer>;
}
