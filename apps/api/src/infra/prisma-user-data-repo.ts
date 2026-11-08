/**
 * Implémentation Prisma de UserDataRepo (favoris, suivis, historique, recherches, téléchargements, compteurs, réglages).
 * NON EXÉCUTÉ dans l'environnement de création : validé par le typecheck et le test d'intégration PostgreSQL de la CI.
 */
import { Prisma, type PrismaClient } from '@prisma/client';
import type { DownloadRecord, DownloadStatusName, FollowRecord, HistoryRecord, Settings, StatField, StatRow, UserDataRepo, UserPaging } from '../user/ports.ts';

const day = (d: string): Date => new Date(`${d}T00:00:00Z`);
const isCode = (err: unknown, code: string): boolean => err instanceof Prisma.PrismaClientKnownRequestError && err.code === code;
const skipTake = (p: UserPaging) => ({ skip: (p.page - 1) * p.limit, take: p.limit });
const settingsSelect = { locale: true, notificationsEnabled: true, historySyncEnabled: true, adSoundEnabled: true } as const;

const toHistory = (h: Prisma.WatchHistoryGetPayload<object>): HistoryRecord => ({
  id: h.id, userId: h.userId, contentId: h.contentId, episodeId: h.episodeId, videoAssetId: h.videoAssetId,
  positionSeconds: h.positionSeconds, durationSeconds: h.durationSeconds, completed: h.completed, lastWatchedAt: h.lastWatchedAt, createdAt: h.createdAt,
});
const toDownload = (d: Prisma.DownloadMetadataGetPayload<object>): DownloadRecord => ({
  id: d.id, userId: d.userId, videoAssetId: d.videoAssetId, status: d.status, sizeBytes: d.sizeBytes === null ? null : Number(d.sizeBytes),
  appVersion: d.appVersion, failureReason: d.failureReason, startedAt: d.startedAt, completedAt: d.completedAt,
});

export class PrismaUserDataRepo implements UserDataRepo {
  private readonly db: PrismaClient;
  constructor(db: PrismaClient) {
    this.db = db;
  }

  async addFavorite(userId: string, contentId: string): Promise<boolean> {
    try {
      await this.db.favorite.create({ data: { userId, contentId } });
      return true;
    } catch (err) {
      if (isCode(err, 'P2002')) return false;
      throw err;
    }
  }
  async removeFavorite(userId: string, contentId: string): Promise<void> {
    await this.db.favorite.deleteMany({ where: { userId, contentId } });
  }
  async listFavorites(userId: string, p: UserPaging) {
    const where: Prisma.FavoriteWhereInput = { userId, content: { status: 'PUBLISHED' } };
    const [total, rows] = await this.db.$transaction([
      this.db.favorite.count({ where }),
      this.db.favorite.findMany({ where, orderBy: { createdAt: 'desc' }, select: { contentId: true }, ...skipTake(p) }),
    ]);
    return { contentIds: rows.map((r) => r.contentId), total };
  }

  async upsertFollow(userId: string, contentId: string, flags: { notifyNewEpisodes?: boolean; notifyNewSeasons?: boolean }): Promise<FollowRecord> {
    const f = await this.db.follow.upsert({
      where: { userId_contentId: { userId, contentId } },
      update: { notifyNewEpisodes: flags.notifyNewEpisodes, notifyNewSeasons: flags.notifyNewSeasons },
      create: { userId, contentId, notifyNewEpisodes: flags.notifyNewEpisodes, notifyNewSeasons: flags.notifyNewSeasons },
    });
    return { contentId: f.contentId, notifyNewEpisodes: f.notifyNewEpisodes, notifyNewSeasons: f.notifyNewSeasons, createdAt: f.createdAt };
  }
  async removeFollow(userId: string, contentId: string): Promise<void> {
    await this.db.follow.deleteMany({ where: { userId, contentId } });
  }
  async listFollows(userId: string, p: UserPaging) {
    const where: Prisma.FollowWhereInput = { userId, content: { status: 'PUBLISHED' } };
    const [total, rows] = await this.db.$transaction([
      this.db.follow.count({ where }),
      this.db.follow.findMany({ where, orderBy: { createdAt: 'desc' }, ...skipTake(p) }),
    ]);
    return { items: rows.map((f) => ({ contentId: f.contentId, notifyNewEpisodes: f.notifyNewEpisodes, notifyNewSeasons: f.notifyNewSeasons, createdAt: f.createdAt })), total };
  }

  async upsertHistory(h: Parameters<UserDataRepo['upsertHistory']>[0]): Promise<{ record: HistoryRecord; created: boolean }> {
    const where: Prisma.WatchHistoryWhereUniqueInput = h.contentId
      ? { userId_contentId: { userId: h.userId, contentId: h.contentId } }
      : { userId_episodeId: { userId: h.userId, episodeId: h.episodeId as string } };
    const run = async (): Promise<{ record: HistoryRecord; created: boolean }> => {
      const existing = await this.db.watchHistory.findUnique({ where });
      const data = {
        videoAssetId: h.videoAssetId, positionSeconds: h.positionSeconds, durationSeconds: h.durationSeconds ?? existing?.durationSeconds ?? null,
        completed: h.completed, lastWatchedAt: h.at,
      };
      if (existing) return { record: toHistory(await this.db.watchHistory.update({ where: { id: existing.id }, data })), created: false };
      return { record: toHistory(await this.db.watchHistory.create({ data: { userId: h.userId, contentId: h.contentId, episodeId: h.episodeId, ...data } })), created: true };
    };
    try {
      return await run();
    } catch (err) {
      if (isCode(err, 'P2002')) return run(); // deux envois simultanés : le second met à jour la ligne créée par le premier
      throw err;
    }
  }
  async listHistory(userId: string, p: UserPaging) {
    const [total, rows] = await this.db.$transaction([
      this.db.watchHistory.count({ where: { userId } }),
      this.db.watchHistory.findMany({ where: { userId }, orderBy: { lastWatchedAt: 'desc' }, ...skipTake(p) }),
    ]);
    return { items: rows.map(toHistory), total };
  }
  async deleteHistory(userId: string, id: string): Promise<boolean> {
    return (await this.db.watchHistory.deleteMany({ where: { id, userId } })).count > 0;
  }
  async clearHistory(userId: string): Promise<void> {
    await this.db.watchHistory.deleteMany({ where: { userId } });
  }

  async addSearch(userId: string, query: string): Promise<void> {
    await this.db.searchHistory.deleteMany({ where: { userId, query: { equals: query, mode: 'insensitive' } } });
    await this.db.searchHistory.create({ data: { userId, query } });
    const old = await this.db.searchHistory.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, skip: 50, select: { id: true } });
    if (old.length) await this.db.searchHistory.deleteMany({ where: { id: { in: old.map((o) => o.id) } } });
  }
  async listSearches(userId: string, limit: number): Promise<string[]> {
    return (await this.db.searchHistory.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: limit, select: { query: true } })).map((r) => r.query);
  }
  async clearSearches(userId: string): Promise<void> {
    await this.db.searchHistory.deleteMany({ where: { userId } });
  }

  async createDownload(d: { userId: string; videoAssetId: string; sizeBytes: number | null; appVersion: string | null }): Promise<DownloadRecord> {
    return toDownload(await this.db.downloadMetadata.create({ data: { userId: d.userId, videoAssetId: d.videoAssetId, sizeBytes: d.sizeBytes === null ? null : BigInt(d.sizeBytes), appVersion: d.appVersion } }));
  }
  async getDownload(id: string): Promise<DownloadRecord | null> {
    const d = await this.db.downloadMetadata.findUnique({ where: { id } });
    return d ? toDownload(d) : null;
  }
  async finishDownload(id: string, status: Exclude<DownloadStatusName, 'STARTED'>, failureReason: string | null, at: Date): Promise<DownloadRecord> {
    return toDownload(await this.db.downloadMetadata.update({ where: { id }, data: { status, failureReason, ...(status === 'COMPLETED' ? { completedAt: at } : {}) } }));
  }

  async bumpStat(contentId: string, d: string, field: StatField): Promise<void> {
    await this.db.contentStatDaily.upsert({
      where: { contentId_date: { contentId, date: day(d) } },
      create: { contentId, date: day(d), [field]: 1 } as Prisma.ContentStatDailyUncheckedCreateInput,
      update: { [field]: { increment: 1 } } as Prisma.ContentStatDailyUpdateInput,
    });
  }
  async statsSince(d: string): Promise<StatRow[]> {
    const rows = await this.db.contentStatDaily.groupBy({
      by: ['contentId'], where: { date: { gte: day(d) } }, _sum: { views: true, downloads: true, favorites: true, plays: true },
    });
    return rows.map((r) => ({ contentId: r.contentId, views: r._sum.views ?? 0, downloads: r._sum.downloads ?? 0, favorites: r._sum.favorites ?? 0, plays: r._sum.plays ?? 0 }));
  }

  async getSettings(userId: string): Promise<Settings | null> {
    return this.db.user.findUnique({ where: { id: userId }, select: settingsSelect });
  }
  async updateSettings(userId: string, patch: Partial<Settings>): Promise<Settings> {
    return this.db.user.update({ where: { id: userId }, data: patch, select: settingsSelect });
  }
  async getAppSetting(key: string): Promise<unknown | null> {
    return (await this.db.appSetting.findUnique({ where: { key } }))?.value ?? null;
  }
}
