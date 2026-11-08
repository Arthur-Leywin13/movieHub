import { ApiError } from './api-client.ts';
import { FileError } from './files.ts';
import { TelegramError } from './telegram/client.ts';
import { UploadAborted, UploadFailed } from './uploader.ts';

/** Erreur dont le message peut être montré tel quel à l'administrateur. */
export class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserError';
  }
}

/** Message affichable pour n'importe quelle erreur ; jamais de détail technique ni de secret. */
export function userMessage(err: unknown): string {
  if (err instanceof UserError || err instanceof FileError) return err.message;
  if (err instanceof UploadAborted) return 'Interrompu.';
  if (err instanceof UploadFailed) return `Envoi vers le stockage échoué (${err.message}).`;
  if (err instanceof ApiError) {
    if (err.status === 401 || err.status === 403) return 'Accès refusé par l’API : ce compte Telegram n’est pas administrateur (ou n’a pas les droits).';
    if (err.status === 0) return 'L’API MoviesHub est injoignable.';
    const existing = (err.details as { existing?: { title?: string; year?: number | null } } | undefined)?.existing;
    if (err.status === 409 && existing?.title) return `${err.message} : « ${existing.title}${existing.year ? ` (${existing.year})` : ''} » existe déjà. Utilisez /search pour le personnaliser.`;
    return err.message;
  }
  if (err instanceof TelegramError) return 'Telegram a refusé la requête.';
  return 'Erreur inattendue (voir les journaux du bot).';
}
