import { randomUUID } from 'node:crypto';
import { NotFoundError } from '@movieshub/shared';
import { DEFAULT_SETTINGS, type DownloadRecord, type DownloadStatusName, type FollowRecord, type HistoryRecord, type Settings, type StatField, type StatRow, type UserDataRepo, type UserPaging } from '../user/ports.ts';
import type { MemoryCatalogRepo } from './memory-catalog-repo.ts';

/** Implémentation en mémoire de UserDataRepo, réservée aux tests. */
export class MemoryUserDataRepo implements UserDataRepo {
  readonly favorites: { userId: string; contentId: string; createdAt: Date }[] = [];
  readonly follows: (FollowRecord & { userId: string })[] = [];
  readonly history: HistoryRecord[] = [];
  readonly searches = new Map<string, string[]>();
  readonly downloads = new Map<string, DownloadRecord>();
  readonly stats = new Map<string, StatRow & { day: string }>();
  readonly settings = new Map<string, Settings>();
  readonly appSettings = new Map<string, unknown>();
  private readonly catalog: MemoryCatalogRepo;
  private clock = 0;

  constructor(catalog: MemoryCatalogRepo) {
    this.catalog = catalog;
  }

  private published(contentId: string): boolean {
    return this.catalog.contents.get(contentId)?.status === 'PUBLISHED';
  }
  private page<T>(list: T[], p: UserPaging): T[] {
    return list.slice((p.page - 1) * p.limit, p.page * p.limit);
  }

  async addFavorite(userId: string, contentId: string): Promise<boolean> {
    if (this.favorites.some((f) => f.userId === userId && f.contentId === contentId)) return false;
    this.favorites.push({ userId, contentId, createdAt: new Date(++this.clock) });
    return true;
  }
  async removeFavorite(userId: string, contentId: string): Promise<void> {
    const i = this.favorites.findIndex((f) => f.userId === userId && f.contentId === contentId);
    if (i >= 0) this.favorites.splice(i, 1);
  }
  async listFavorites(userId: string, p: UserPaging) {
    const all = this.favorites.filter((f) => f.userId === userId && this.published(f.contentId)).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return { contentIds: this.page(all, p).map((f) => f.contentId), total: all.length };
  }

  async upsertFollow(userId: string, contentId: string, flags: { notifyNewEpisodes?: boolean; notifyNewSeasons?: boolean }): Promise<FollowRecord> {
    let f = this.follows.find((x) => x.userId === userId && x.contentId === contentId);
    if (!f) {
      f = { userId, contentId, notifyNewEpisodes: true, notifyNewSeasons: true, createdAt: new Date(++this.clock) };
      this.follows.push(f);
    }
    if (flags.notifyNewEpisodes !== undefined) f.notifyNewEpisodes = flags.notifyNewEpisodes;
    if (flags.notifyNewSeasons !== undefined) f.notifyNewSeasons = flags.notifyNewSeasons;
    return f;
  }
  async removeFollow(userId: string, contentId: string): Promise<void> {
    const i = this.follows.findIndex((x) => x.userId === userId && x.contentId === contentId);
    if (i >= 0) this.follows.splice(i, 1);
  }
  async listFollows(userId: string, p: UserPaging) {
    const all = this.follows.filter((f) => f.userId === userId && this.published(f.contentId)).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return { items: this.page(all, p), total: all.length };
  }

  async upsertHistory(h: Parameters<UserDataRepo['upsertHistory']>[0]) {
    let rec = this.history.find((x) => x.userId === h.userId && (h.contentId ? x.contentId === h.contentId : x.episodeId === h.episodeId));
    const created = !rec;
    if (!rec) {
      rec = { id: randomUUID(), userId: h.userId, contentId: h.contentId, episodeId: h.episodeId, videoAssetId: null, positionSeconds: 0, durationSeconds: null, completed: false, lastWatchedAt: h.at, createdAt: h.at };
      this.history.push(rec);
    }
    Object.assign(rec, { videoAssetId: h.videoAssetId, positionSeconds: h.positionSeconds, durationSeconds: h.durationSeconds ?? rec.durationSeconds, completed: h.completed, lastWatchedAt: new Date(h.at.getTime() + ++this.clock) });
    return { record: rec, created };
  }
  async listHistory(userId: string, p: UserPaging) {
    const all = this.history.filter((x) => x.userId === userId).sort((a, b) => b.lastWatchedAt.getTime() - a.lastWatchedAt.getTime());
    return { items: this.page(all, p), total: all.length };
  }
  async deleteHistory(userId: string, id: string): Promise<boolean> {
    const i = this.history.findIndex((x) => x.userId === userId && x.id === id);
    if (i < 0) return false;
    this.history.splice(i, 1);
    return true;
  }
  async clearHistory(userId: string): Promise<void> {
    for (let i = this.history.length - 1; i >= 0; i--) if (this.history[i]?.userId === userId) this.history.splice(i, 1);
  }

  async addSearch(userId: string, query: string): Promise<void> {
    const list = (this.searches.get(userId) ?? []).filter((q) => q.toLowerCase() !== query.toLowerCase());
    list.unshift(query);
    this.searches.set(userId, list.slice(0, 50));
  }
  async listSearches(userId: string, limit: number) {
    return (this.searches.get(userId) ?? []).slice(0, limit);
  }
  async clearSearches(userId: string): Promise<void> {
    this.searches.delete(userId);
  }

  async createDownload(d: { userId: string; videoAssetId: string; sizeBytes: number | null; appVersion: string | null }): Promise<DownloadRecord> {
    const rec: DownloadRecord = { id: randomUUID(), ...d, status: 'STARTED', failureReason: null, startedAt: new Date(), completedAt: null };
    this.downloads.set(rec.id, rec);
    return rec;
  }
  async getDownload(id: string) {
    return this.downloads.get(id) ?? null;
  }
  async finishDownload(id: string, status: Exclude<DownloadStatusName, 'STARTED'>, failureReason: string | null, at: Date): Promise<DownloadRecord> {
    const d = this.downloads.get(id);
    if (!d) throw new NotFoundError('Téléchargement introuvable');
    Object.assign(d, { status, failureReason, completedAt: status === 'COMPLETED' ? at : d.completedAt });
    return d;
  }

  async bumpStat(contentId: string, day: string, field: StatField): Promise<void> {
    const key = `${contentId}|${day}`;
    const row = this.stats.get(key) ?? { contentId, day, views: 0, downloads: 0, favorites: 0, plays: 0 };
    row[field]++;
    this.stats.set(key, row);
  }
  async statsSince(day: string): Promise<StatRow[]> {
    const by = new Map<string, StatRow>();
    for (const r of this.stats.values()) {
      if (r.day < day) continue;
      const t = by.get(r.contentId) ?? { contentId: r.contentId, views: 0, downloads: 0, favorites: 0, plays: 0 };
      t.views += r.views; t.downloads += r.downloads; t.favorites += r.favorites; t.plays += r.plays;
      by.set(r.contentId, t);
    }
    return [...by.values()];
  }

  async getSettings(userId: string) {
    return this.settings.get(userId) ?? { ...DEFAULT_SETTINGS };
  }
  async updateSettings(userId: string, patch: Partial<Settings>): Promise<Settings> {
    const next = { ...(await this.getSettings(userId)), ...patch } as Settings;
    this.settings.set(userId, next);
    return next;
  }
  async getAppSetting(key: string) {
    return this.appSettings.get(key) ?? null;
  }
}
