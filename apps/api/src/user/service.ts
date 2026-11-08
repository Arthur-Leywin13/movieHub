import { AppError, ConflictError, NotFoundError, ValidationError } from '@movieshub/shared';
import type { CatalogRepo, VersionChain } from '../catalog/ports.ts';
import { WITHDRAWN_MESSAGE, type CatalogReadService, type UrlSigner } from '../catalog/read-service.ts';
import { isoDay } from '../catalog/trending.ts';
import { SlidingWindowLimiter } from '../security/rate-limit.ts';
import type { DownloadRecord, Settings, StatField, UserDataRepo, UserPaging } from './ports.ts';

export interface HistoryInput {
  contentId?: string;
  episodeId?: string;
  versionId?: string;
  positionSeconds: number;
  durationSeconds?: number;
  completed?: boolean;
}

/** Seuil à partir duquel une lecture est considérée comme terminée. */
export const COMPLETED_RATIO = 0.95;

const safeName = (s: string): string => s.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);

export class UserDataService {
  private readonly repo: UserDataRepo;
  private readonly catalog: CatalogRepo;
  private readonly read: CatalogReadService;
  private readonly signer: UrlSigner;
  private readonly ttl: number;
  private readonly now: () => Date;
  private readonly downloadLimiter: SlidingWindowLimiter;

  constructor(deps: { repo: UserDataRepo; catalog: CatalogRepo; read: CatalogReadService; signer: UrlSigner; downloadTtlSeconds?: number; downloadsPerHour?: number; now?: () => Date }) {
    this.repo = deps.repo;
    this.catalog = deps.catalog;
    this.read = deps.read;
    this.signer = deps.signer;
    this.ttl = deps.downloadTtlSeconds ?? 900;
    this.now = deps.now ?? (() => new Date());
    this.downloadLimiter = new SlidingWindowLimiter({ max: deps.downloadsPerHour ?? 60, windowMs: 3_600_000, now: () => this.now().getTime() });
  }

  private bump(contentId: string, field: StatField): Promise<void> {
    return this.repo.bumpStat(contentId, isoDay(this.now()), field).catch(() => undefined);
  }

  /** Consultation d'une fiche (compteur de tendances) ; n'échoue jamais. */
  recordView(contentId: string): Promise<void> {
    return this.bump(contentId, 'views');
  }

  // ---------- favoris ----------
  async addFavorite(userId: string, contentId: string): Promise<void> {
    const c = await this.read.assertVisible(contentId);
    if (await this.repo.addFavorite(userId, c.id)) await this.bump(c.id, 'favorites');
  }
  removeFavorite(userId: string, contentId: string): Promise<void> {
    return this.repo.removeFavorite(userId, contentId);
  }
  async favorites(userId: string, p: UserPaging) {
    const { contentIds, total } = await this.repo.listFavorites(userId, p);
    return { items: await this.read.cardsByIds(contentIds), total, page: p.page, limit: p.limit };
  }

  // ---------- suivi des séries et animés ----------
  async follow(userId: string, contentId: string, flags: { notifyNewEpisodes?: boolean; notifyNewSeasons?: boolean }) {
    const c = await this.read.assertVisible(contentId);
    if (c.type === 'MOVIE') throw new ConflictError('Seules les séries et les animés peuvent être suivis');
    const f = await this.repo.upsertFollow(userId, c.id, flags);
    return { contentId: f.contentId, notifyNewEpisodes: f.notifyNewEpisodes, notifyNewSeasons: f.notifyNewSeasons, createdAt: f.createdAt };
  }
  unfollow(userId: string, contentId: string): Promise<void> {
    return this.repo.removeFollow(userId, contentId);
  }
  async follows(userId: string, p: UserPaging) {
    const { items, total } = await this.repo.listFollows(userId, p);
    const cards = new Map((await this.read.cardsByIds(items.map((i) => i.contentId))).map((c) => [c.id, c]));
    return {
      items: items.flatMap((f) => (cards.has(f.contentId) ? [{ content: cards.get(f.contentId), notifyNewEpisodes: f.notifyNewEpisodes, notifyNewSeasons: f.notifyNewSeasons, followedAt: f.createdAt }] : [])),
      total, page: p.page, limit: p.limit,
    };
  }

  // ---------- historique de visionnage ----------
  async recordHistory(userId: string, input: HistoryInput) {
    if ((input.contentId === undefined) === (input.episodeId === undefined)) throw new ValidationError('Indiquez soit contentId (film), soit episodeId (épisode)');
    const settings = await this.settings(userId);
    if (!settings.historySyncEnabled) return { stored: false as const };

    let contentId: string;
    let episodeId: string | null = null;
    if (input.episodeId) {
      const ep = await this.catalog.getEpisode(input.episodeId);
      const season = ep ? await this.catalog.getSeason(ep.seasonId) : null;
      if (!ep || !season || ep.status !== 'PUBLISHED' || season.status !== 'PUBLISHED') throw new NotFoundError('Épisode introuvable');
      contentId = (await this.read.assertVisible(season.contentId)).id;
      episodeId = ep.id;
    } else {
      const c = await this.read.assertVisible(input.contentId as string);
      if (c.type !== 'MOVIE') throw new ConflictError('Pour une série ou un animé, indiquez l’épisode (episodeId)');
      contentId = c.id;
    }
    if (input.versionId) {
      const v = await this.catalog.getVersion(input.versionId);
      if (!v || (episodeId ? v.episodeId !== episodeId : v.contentId !== contentId)) throw new ValidationError('Cette version ne correspond pas au contenu lu', { field: 'versionId' });
    }
    const duration = input.durationSeconds ?? null;
    const completed = input.completed ?? (duration !== null && input.positionSeconds >= duration * COMPLETED_RATIO);
    const { record, created } = await this.repo.upsertHistory({
      userId, contentId: episodeId ? null : contentId, episodeId, videoAssetId: input.versionId ?? null,
      positionSeconds: input.positionSeconds, durationSeconds: duration, completed, at: this.now(),
    });
    if (created) await this.bump(contentId, 'plays');
    return { stored: true as const, history: record };
  }

  async history(userId: string, p: UserPaging) {
    const { items, total } = await this.repo.listHistory(userId, p);
    const episodes = new Map<string, { id: string; number: number; title: string | null; seasonId: string; seasonNumber: number; contentId: string }>();
    for (const h of items) {
      if (!h.episodeId) continue;
      const ep = await this.catalog.getEpisode(h.episodeId);
      const season = ep ? await this.catalog.getSeason(ep.seasonId) : null;
      if (ep && season && ep.status === 'PUBLISHED' && season.status === 'PUBLISHED') {
        episodes.set(h.episodeId, { id: ep.id, number: ep.number, title: ep.title, seasonId: season.id, seasonNumber: season.number, contentId: season.contentId });
      }
    }
    const ids = items.map((h) => h.contentId ?? episodes.get(h.episodeId ?? '')?.contentId).filter((x): x is string => Boolean(x));
    const cards = new Map((await this.read.cardsByIds(ids)).map((c) => [c.id, c]));
    return {
      items: items.flatMap((h) => {
        const ep = h.episodeId ? episodes.get(h.episodeId) : undefined;
        const content = cards.get(h.contentId ?? ep?.contentId ?? '');
        if (!content || (h.episodeId && !ep)) return []; // contenu dépublié, retiré ou archivé : masqué
        return [{
          id: h.id, kind: h.episodeId ? ('episode' as const) : ('movie' as const), content,
          ...(ep ? { episode: { id: ep.id, number: ep.number, title: ep.title, seasonId: ep.seasonId, seasonNumber: ep.seasonNumber } } : {}),
          versionId: h.videoAssetId, positionSeconds: h.positionSeconds, durationSeconds: h.durationSeconds, completed: h.completed, lastWatchedAt: h.lastWatchedAt,
        }];
      }),
      total, page: p.page, limit: p.limit,
    };
  }

  async deleteHistory(userId: string, id: string): Promise<void> {
    if (!(await this.repo.deleteHistory(userId, id))) throw new NotFoundError('Élément introuvable');
  }
  clearHistory(userId: string): Promise<void> {
    return this.repo.clearHistory(userId);
  }

  // ---------- recherches récentes ----------
  async addSearch(userId: string, query: string): Promise<void> {
    const q = query.trim();
    if (q.length < 2 || q.length > 100) throw new ValidationError('La recherche doit contenir de 2 à 100 caractères', { field: 'query' });
    await this.repo.addSearch(userId, q);
  }
  searches(userId: string): Promise<string[]> {
    return this.repo.listSearches(userId, 20);
  }
  clearSearches(userId: string): Promise<void> {
    return this.repo.clearSearches(userId);
  }

  // ---------- réglages ----------
  async settings(userId: string): Promise<Settings> {
    const s = await this.repo.getSettings(userId);
    if (!s) throw new NotFoundError('Utilisateur introuvable');
    return s;
  }
  updateSettings(userId: string, patch: Partial<Settings>): Promise<Settings> {
    return this.repo.updateSettings(userId, patch);
  }

  // ---------- téléchargements ----------
  private async visibleChain(versionId: string): Promise<VersionChain> {
    const ch = await this.catalog.getVersionChain(versionId);
    if (!ch || ch.version.status !== 'PUBLISHED') throw new NotFoundError('Version introuvable');
    if (ch.content.status === 'WITHDRAWN') throw new AppError('NOT_FOUND', 410, WITHDRAWN_MESSAGE);
    if (ch.content.status !== 'PUBLISHED') throw new NotFoundError('Version introuvable');
    if (ch.episode && (ch.episode.status !== 'PUBLISHED' || ch.season?.status !== 'PUBLISHED')) throw new NotFoundError('Version introuvable');
    return ch;
  }

  /** Lien de téléchargement temporaire (R2 signé). Le fichier téléchargé reste ensuite sur l'appareil. */
  async startDownload(userId: string, versionId: string, opts: { appVersion?: string | null } = {}) {
    const ch = await this.visibleChain(versionId);
    this.downloadLimiter.assert(userId);
    const langs = [...ch.version.audioTracks].sort((a, b) => a.streamIndex - b.streamIndex).map((t) => t.languageCode).join('+');
    const ext = /\.([a-z0-9]{1,5})$/i.exec(ch.objectKey)?.[1] ?? 'mkv';
    const episode = ch.episode && ch.season ? ` S${String(ch.season.number).padStart(2, '0')}E${String(ch.episode.number).padStart(2, '0')}` : '';
    const filename = `${safeName(ch.content.title)}${episode}${langs ? ` [${langs}]` : ''}.${ext}`;
    const rec = await this.repo.createDownload({ userId, videoAssetId: versionId, sizeBytes: ch.version.sizeBytes, appVersion: opts.appVersion?.slice(0, 40) ?? null });
    await this.bump(ch.content.id, 'downloads');
    return {
      downloadId: rec.id, url: this.signer.presignGet(ch.objectKey, this.ttl, { downloadName: filename }), expiresInSeconds: this.ttl,
      sizeBytes: ch.version.sizeBytes, filename, allowLocalShare: ch.version.allowLocalShare,
    };
  }

  async finishDownload(userId: string, downloadId: string, status: 'COMPLETED' | 'FAILED' | 'CANCELED', reason: string | null): Promise<DownloadRecord> {
    const d = await this.repo.getDownload(downloadId);
    if (!d || d.userId !== userId) throw new NotFoundError('Téléchargement introuvable');
    if (d.status === status) return d;
    if (d.status !== 'STARTED') throw new ConflictError(`Téléchargement déjà terminé (${d.status})`);
    return this.repo.finishDownload(downloadId, status, reason?.slice(0, 200) ?? null, this.now());
  }
}
