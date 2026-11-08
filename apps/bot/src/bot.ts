import type { ApiClient, J } from './api-client.ts';
import { userMessage } from './errors.ts';
import { allFlows } from './flows/index.ts';
import type { FileRef, FileResolver } from './files.ts';
import { runPipeline } from './pipelines.ts';
import { newSession, type Session, type SessionStore } from './session.ts';
import { HELP, STATUS_LABEL, TYPE_LABEL, cardText, fmtBytes } from './texts.ts';
import type { InlineButton, Keyboard, TelegramPort, TgCallbackQuery, TgMessage, TgUpdate } from './telegram/types.ts';
import { UploadAborted, type Uploader } from './uploader.ts';
import { WizardEngine, type Input, type Outcome, type StepEnv } from './wizard.ts';

export interface BotDeps {
  tg: TelegramPort;
  api: ApiClient;
  sessions: SessionStore;
  files: FileResolver;
  uploader: Uploader;
  /** Identifiants Telegram NUMÉRIQUES autorisés (jamais le @username). L'API revérifie en base. */
  allowedIds: ReadonlySet<number>;
  maxFileBytes: number;
  progressIntervalMs?: number;
  log?: (message: string, meta?: Record<string, unknown>) => void;
}

const ACTION_FLOW: Record<string, string> = {
  desc: 'edit:desc', lang: 'edit:lang', poster: 'edit:poster', trailer: 'edit:trailer', version: 'edit:version',
  epversion: 'edit:epversion', season: 'edit:season', episodes: 'edit:episodes', status: 'edit:status',
};

function fileOf(m: TgMessage): FileRef | null {
  if (m.photo?.length) {
    const p = [...m.photo].sort((a, b) => b.width * b.height - a.width * a.height)[0];
    if (p) return { fileId: p.file_id, name: 'affiche.jpg', size: p.file_size ?? null, mime: 'image/jpeg', media: 'photo' };
  }
  if (m.video) return { fileId: m.video.file_id, name: m.video.file_name ?? 'video.mp4', size: m.video.file_size ?? null, mime: m.video.mime_type ?? null, media: 'video' };
  if (m.document) return { fileId: m.document.file_id, name: m.document.file_name ?? 'fichier', size: m.document.file_size ?? null, mime: m.document.mime_type ?? null, media: 'document' };
  return null;
}

export class Bot {
  private readonly d: BotDeps;
  private readonly engine = new WizardEngine(allFlows());
  private readonly queues = new Map<number, Promise<void>>();
  private readonly jobs = new Map<number, { abort: AbortController; promise: Promise<void> }>();
  private languages: { code: string; name: string }[] | null = null;

  constructor(deps: BotDeps) {
    this.d = deps;
  }

  /** Les mises à jour d'un même administrateur sont traitées dans l'ordre ; des administrateurs différents en parallèle. */
  handleUpdate(update: TgUpdate): Promise<void> {
    const uid = update.message?.from?.id ?? update.callback_query?.from.id;
    if (uid === undefined) return Promise.resolve();
    const next = (this.queues.get(uid) ?? Promise.resolve()).then(() => this.process(update, uid)).catch((e: unknown) => this.d.log?.('Erreur de traitement', { error: e instanceof Error ? e.name : 'inconnue' }));
    this.queues.set(uid, next);
    return next;
  }

  /** Attend les files d'attente et les traitements en cours (tests, arrêt propre). */
  async drain(): Promise<void> {
    for (let i = 0; i < 50; i++) {
      const pending = [...this.queues.values(), ...[...this.jobs.values()].map((j) => j.promise)];
      if (pending.length === 0) return;
      await Promise.all(pending);
      for (const [uid, q] of this.queues) if (await isSettled(q)) this.queues.delete(uid);
      if (this.jobs.size === 0 && [...this.queues.values()].length === 0) return;
    }
  }

  /** Interrompt les traitements : leur état est conservé, /resume les reprendra. */
  async shutdown(): Promise<void> {
    for (const j of this.jobs.values()) j.abort.abort();
    await Promise.race([this.drain(), new Promise((r) => setTimeout(r, 15_000))]);
  }

  private send(chatId: number, text: string, kb?: Keyboard) {
    return this.d.tg.sendMessage(chatId, text, kb);
  }

  private async env(uid: number): Promise<StepEnv> {
    if (!this.languages) {
      const r = await this.d.api.call(uid, 'GET', '/languages');
      this.languages = (r['languages'] as J[]).map((l) => ({ code: l['code'], name: l['name'] }));
    }
    return { api: this.d.api, uid, languages: this.languages, maxFileBytes: this.d.maxFileBytes };
  }

  private async process(update: TgUpdate, uid: number): Promise<void> {
    const msg = update.message ?? update.callback_query?.message;
    if (!msg) return;
    const chatId = msg.chat.id;
    if (!this.d.allowedIds.has(uid)) {
      if (update.callback_query) await this.d.tg.answerCallback(update.callback_query.id);
      await this.send(chatId, '⛔ Accès réservé aux administrateurs.');
      return;
    }
    const session = (await this.d.sessions.get(uid)) ?? newSession(uid, chatId);
    session.chatId = chatId;
    try {
      if (update.callback_query) await this.onCallback(update.callback_query, session);
      else if (update.message) await this.onMessage(update.message, session);
    } catch (err) {
      this.d.log?.('Erreur', { uid, error: err instanceof Error ? err.name : 'inconnue' });
      await this.send(chatId, `❌ ${userMessage(err)}`);
    }
  }

  private busy(session: Session): boolean {
    return this.jobs.has(session.userId);
  }

  // ---------------- messages et commandes ----------------
  private async onMessage(m: TgMessage, session: Session): Promise<void> {
    const text = m.text?.trim();
    if (text?.startsWith('/')) return this.onCommand(text, session);
    if (this.busy(session)) return void (await this.send(session.chatId, '⏳ Un traitement est en cours. /cancel pour l’interrompre.'));
    if (session.phase === 'failed') return void (await this.send(session.chatId, 'Opération interrompue. /resume pour reprendre, /cancel pour abandonner.'));
    if (session.phase !== 'wizard') return void (await this.send(session.chatId, 'Je n’ai pas compris. /help pour la liste des commandes.'));
    const file = fileOf(m);
    const input: Input | null = file ? { kind: 'file', file } : text !== undefined ? { kind: 'text', text } : null;
    if (!input) return void (await this.send(session.chatId, 'Ce type de message n’est pas pris en charge ici.'));
    await this.step(session, input);
  }

  private async onCommand(text: string, session: Session): Promise<void> {
    const [raw = '', ...rest] = text.split(/\s+/);
    const cmd = raw.slice(1).split('@')[0]?.toLowerCase() ?? '';
    const arg = rest.join(' ').trim();
    const chatId = session.chatId;
    const startable = async (): Promise<boolean> => {
      if (this.busy(session)) {
        await this.send(chatId, '⏳ Un traitement est en cours. /cancel pour l’interrompre.');
        return false;
      }
      if (session.phase === 'failed') {
        await this.send(chatId, 'Un traitement interrompu attend : /resume pour le reprendre ou /cancel pour l’abandonner.');
        return false;
      }
      return true;
    };
    switch (cmd) {
      case 'start':
      case 'help':
        return void (await this.send(chatId, HELP));
      case 'cancel':
        return this.cancel(session);
      case 'resume':
        if (this.busy(session)) return void (await this.send(chatId, '⏳ Déjà en cours.'));
        if (session.phase !== 'failed') return void (await this.send(chatId, 'Rien à reprendre.'));
        session.phase = 'running';
        session.error = null;
        await this.d.sessions.set(session);
        return this.startJob(session);
      case 'addfilm':
      case 'addmovie':
      case 'addserie':
      case 'addseries':
      case 'addanime': {
        if (!(await startable())) return;
        const type = cmd === 'addanime' ? 'ANIME' : cmd.startsWith('addserie') ? 'SERIES' : 'MOVIE';
        return this.render(session, await this.engine.begin(session, `add:${type}`, {}, await this.env(session.userId)));
      }
      case 'search':
      case 'customize':
      case 'edit':
      case 'delete': {
        if (!(await startable())) return;
        const mode = cmd === 'delete' ? 'delete' : 'customize';
        if (arg) return this.search(session, arg, mode);
        return this.render(session, await this.engine.begin(session, 'search', { mode }, await this.env(session.userId)));
      }
      case 'stats':
        return this.stats(session);
      default:
        await this.send(chatId, 'Commande inconnue. /help pour la liste.');
    }
  }

  // ---------------- boutons ----------------
  private async onCallback(cq: TgCallbackQuery, session: Session): Promise<void> {
    await this.d.tg.answerCallback(cq.id);
    const data = cq.data ?? '';
    if (data === 'x:cancel') return this.cancel(session);
    if (this.busy(session)) return void (await this.send(session.chatId, '⏳ Un traitement est en cours. /cancel pour l’interrompre.'));
    if (data.startsWith('sel:') || data.startsWith('del:')) {
      if (session.phase === 'failed') return void (await this.send(session.chatId, 'Un traitement interrompu attend : /resume ou /cancel.'));
      return this.openContent(session, data.slice(4), data.startsWith('del:'));
    }
    if (data.startsWith('act:')) {
      const [, action = '', id = ''] = data.split(':');
      return this.startAction(session, action, id);
    }
    if (data.startsWith('mp:')) {
      const [, op = '', id = ''] = data.split(':');
      return this.mediaAction(session, op, id);
    }
    if (session.phase === 'wizard') await this.step(session, { kind: 'callback', data }, cq.message?.message_id);
  }

  private async step(session: Session, input: Input, editMessageId?: number): Promise<void> {
    const out = await this.engine.handle(session, input, await this.env(session.userId));
    await this.render(session, out, editMessageId);
  }

  private async render(session: Session, out: Outcome, editMessageId?: number): Promise<void> {
    if (out.kind === 'prompt') {
      await this.d.sessions.set(session);
      if (out.edit && editMessageId !== undefined) await this.d.tg.editMessage(session.chatId, editMessageId, out.prompt.text, out.prompt.keyboard);
      else await this.send(session.chatId, out.prompt.text, out.prompt.keyboard);
      return;
    }
    if (session.flow === 'search') {
      const { q, mode } = session.data as { q: string; mode: 'customize' | 'delete' };
      await this.d.sessions.delete(session.userId);
      return this.search(session, q, mode);
    }
    session.phase = 'running';
    session.error = null;
    await this.d.sessions.set(session);
    this.startJob(session);
  }

  // ---------------- recherche, fiche, actions ----------------
  private async search(session: Session, q: string, mode: 'customize' | 'delete'): Promise<void> {
    await this.d.sessions.delete(session.userId);
    const r = await this.d.api.call(session.userId, 'GET', `/admin/contents?q=${encodeURIComponent(q)}&limit=8`);
    const items = r['items'] as J[];
    if (!items.length) return void (await this.send(session.chatId, `Aucun résultat pour « ${q} ».`));
    const kb: Keyboard = items.map((c) => [{ text: `${c['title']}${c['year'] ? ` (${c['year']})` : ''} — ${TYPE_LABEL[c['type']] ?? c['type']} [${STATUS_LABEL[c['status']] ?? c['status']}]`, data: `${mode === 'delete' ? 'del' : 'sel'}:${c['id']}` }]);
    await this.send(session.chatId, `Résultats pour « ${q} » (${r['total']}) :`, kb);
  }

  private async openContent(session: Session, contentId: string, directDelete: boolean): Promise<void> {
    if (directDelete) return this.startAction(session, 'status', contentId);
    const detail = await this.d.api.call(session.userId, 'GET', `/admin/contents/${contentId}`);
    const movie = detail['content']['type'] === 'MOVIE';
    const b = (text: string, a: string): InlineButton => ({ text, data: `act:${a}:${contentId}` });
    const kb: Keyboard = [
      [b('📝 Description', 'desc'), b('🌐 Langues', 'lang')],
      [b('🖼 Affiche', 'poster'), b('🎞 Bande-annonce', 'trailer')],
      movie ? [b('📼 Ajouter une version', 'version')] : [b('➕ Saison', 'season'), b('📼 Version d’épisode', 'epversion')],
      ...(movie ? [] : [[b('➕ Épisodes', 'episodes')]]),
      [b('📌 Statut', 'status'), b('🗂 Médias', 'media')],
    ];
    await this.send(session.chatId, cardText(detail), kb);
  }

  private async startAction(session: Session, action: string, contentId: string): Promise<void> {
    if (session.phase === 'failed') return void (await this.send(session.chatId, 'Un traitement interrompu attend : /resume ou /cancel.'));
    const detail = await this.d.api.call(session.userId, 'GET', `/admin/contents/${contentId}`);
    const c = detail['content'] as J;
    if (action === 'media') return this.showMedia(session, detail);
    const flow = ACTION_FLOW[action];
    if (!flow) return void (await this.send(session.chatId, 'Action inconnue.'));
    const seasons = (detail['seasons'] as J[]).map((s) => s['season']['number'] as number);
    const args = {
      contentId, type: c['type'], title: c['title'], status: c['status'],
      audioLanguages: c['audioLanguages'], subtitleLanguages: c['subtitleLanguages'], nextSeason: seasons.length ? Math.max(...seasons) + 1 : 1,
    };
    await this.render(session, await this.engine.begin(session, flow, args, await this.env(session.userId)));
  }

  private async showMedia(session: Session, detail: J): Promise<void> {
    const c = detail['content'] as J;
    const kb: Keyboard = [];
    const lines = ['🗂 Médias'];
    for (const [i, p] of (detail['posters'] as J[]).entries()) {
      const primary = p['id'] === c['primaryPosterId'];
      const archived = Boolean(p['archivedAt']);
      lines.push(`🖼 Affiche ${i + 1}${p['kind'] === 'PROMOTIONAL' ? ' (promo)' : ''}${primary ? ' ⭐ principale' : ''}${archived ? ' 🗄 archivée' : ''}`);
      const row: InlineButton[] = [];
      if (archived) row.push({ text: `♻️ Restaurer ${i + 1}`, data: `mp:pr:${p['id']}` });
      if (!primary && p['kind'] === 'POSTER') row.push({ text: `⭐ Principale ${i + 1}`, data: `mp:pp:${p['id']}` });
      if (!primary && !archived) row.push({ text: `🗄 Archiver ${i + 1}`, data: `mp:pa:${p['id']}` });
      if (row.length) kb.push(row);
    }
    for (const [i, t] of (detail['trailers'] as J[]).entries()) {
      const primary = t['id'] === c['primaryTrailerId'] || (detail['seasons'] as J[]).some((s) => s['season']['primaryTrailerId'] === t['id']);
      const archived = Boolean(t['archivedAt']);
      lines.push(`🎞 Bande-annonce ${i + 1}${t['seasonId'] ? ' (saison)' : ''}${primary ? ' ⭐ principale' : ''}${archived ? ' 🗄 archivée' : ''}`);
      const row: InlineButton[] = [];
      if (archived) row.push({ text: `♻️ Restaurer ${i + 1}`, data: `mp:tr:${t['id']}` });
      else {
        if (!primary) row.push({ text: `⭐ Principale ${i + 1}`, data: `mp:tp:${t['id']}` }, { text: `🗄 Archiver ${i + 1}`, data: `mp:ta:${t['id']}` });
      }
      if (row.length) kb.push(row);
    }
    if (lines.length === 1) lines.push('Aucun média.');
    await this.send(session.chatId, lines.join('\n'), kb);
  }

  private async mediaAction(session: Session, op: string, id: string): Promise<void> {
    const route: Record<string, [string, string]> = {
      pp: ['posters', 'primary'], pa: ['posters', 'archive'], pr: ['posters', 'restore'],
      tp: ['trailers', 'primary'], ta: ['trailers', 'archive'], tr: ['trailers', 'restore'],
    };
    const r = route[op];
    if (!r) return;
    await this.d.api.call(session.userId, 'POST', `/admin/${r[0]}/${id}/${r[1]}`);
    await this.send(session.chatId, op === 'pp' ? '✅ Nouvelle affiche principale (l’ancienne est archivée, restaurable).' : '✅ Fait.');
  }

  private async stats(session: Session): Promise<void> {
    const count = async (qs: string): Promise<number> => Number((await this.d.api.call(session.userId, 'GET', `/admin/contents?${qs}&limit=1`))['total']);
    const [movies, series, anime, published, drafts] = await Promise.all([
      count('type=MOVIE'), count('type=SERIES'), count('type=ANIME'), count('status=PUBLISHED'), count('status=DRAFT'),
    ]);
    await this.send(session.chatId, `📊 Catalogue\nFilms : ${movies}\nSéries : ${series}\nAnimés : ${anime}\nPubliés : ${published}\nBrouillons : ${drafts}`);
  }

  // ---------------- annulation et traitements ----------------
  private async cancel(session: Session): Promise<void> {
    const job = this.jobs.get(session.userId);
    if (job) {
      job.abort.abort();
      return void (await this.send(session.chatId, '⏹ Interruption demandée. /resume pour reprendre plus tard, ou /cancel de nouveau pour abandonner.'));
    }
    if (!session.flow && session.phase === 'idle') return void (await this.send(session.chatId, 'Rien à annuler.'));
    for (const [key, mediaId] of Object.entries(session.progress)) {
      if (key.startsWith('up:') && !session.progress[`media:${key.slice(3)}`]) await this.d.uploader.abandon(session.userId, String(mediaId));
    }
    const created = session.progress['contentId'];
    await this.d.sessions.delete(session.userId);
    await this.send(session.chatId, `Opération annulée.${created ? ' Le contenu déjà créé reste en brouillon : retrouvez-le avec /search.' : ''}`);
  }

  private startJob(session: Session): void {
    const abort = new AbortController();
    const promise = this.runJob(session, abort.signal)
      .catch((e: unknown) => this.d.log?.('Erreur du traitement', { error: e instanceof Error ? e.name : 'inconnue' }))
      .finally(() => void this.jobs.delete(session.userId));
    this.jobs.set(session.userId, { abort, promise });
  }

  private async runJob(session: Session, signal: AbortSignal): Promise<void> {
    const { tg } = this.d;
    const chatId = session.chatId;
    const msg = await tg.sendMessage(chatId, '⏳ Traitement en cours…');
    const interval = this.d.progressIntervalMs ?? 4000;
    let lastEdit = 0;
    let chain: Promise<unknown> = Promise.resolve();
    const progress = (label: string, done: number, total: number): void => {
      const now = Date.now();
      if (now - lastEdit < interval && done < total) return;
      lastEdit = now;
      const pct = total ? Math.floor((done * 100) / total) : 0;
      chain = chain.then(() => tg.editMessage(chatId, msg.messageId, `⏳ Envoi de « ${label} » : ${pct} % (${fmtBytes(done)} / ${fmtBytes(total)})`)).catch(() => undefined);
    };
    try {
      const result = await runPipeline(session, {
        api: this.d.api, uploader: this.d.uploader, files: this.d.files, signal, progress,
        save: () => this.d.sessions.set(session),
      });
      await chain;
      await this.d.sessions.delete(session.userId);
      const warn = result.warnings.length && !result.message.includes('⚠️') ? `\n⚠️ ${result.warnings.join('\n⚠️ ')}` : '';
      await tg.editMessage(chatId, msg.messageId, `✅ ${result.message}${warn}`, result.contentId ? [[{ text: '📂 Ouvrir la fiche', data: `sel:${result.contentId}` }]] : undefined);
    } catch (err) {
      await chain;
      const aborted = err instanceof UploadAborted || signal.aborted;
      session.phase = 'failed';
      session.error = aborted ? 'Interrompu' : userMessage(err);
      await this.d.sessions.set(session);
      if (!aborted) this.d.log?.('Traitement échoué', { error: err instanceof Error ? err.name : 'inconnue' });
      await tg.editMessage(
        chatId, msg.messageId,
        aborted ? '⏹ Traitement interrompu. /resume pour reprendre, /cancel pour abandonner.' : `❌ ${userMessage(err)}\n/resume pour réessayer, /cancel pour abandonner.`,
      );
    }
  }
}

async function isSettled(p: Promise<unknown>): Promise<boolean> {
  const marker = Symbol();
  return (await Promise.race([p.then(() => true, () => true), Promise.resolve(marker)])) === true;
}
