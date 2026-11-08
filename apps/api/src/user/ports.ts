export interface Settings {
  locale: string;
  notificationsEnabled: boolean;
  historySyncEnabled: boolean;
  adSoundEnabled: boolean;
}
export const DEFAULT_SETTINGS: Settings = { locale: 'fr', notificationsEnabled: true, historySyncEnabled: true, adSoundEnabled: false };

export interface FollowRecord {
  contentId: string;
  notifyNewEpisodes: boolean;
  notifyNewSeasons: boolean;
  createdAt: Date;
}

export interface HistoryRecord {
  id: string;
  userId: string;
  contentId: string | null;
  episodeId: string | null;
  videoAssetId: string | null;
  positionSeconds: number;
  durationSeconds: number | null;
  completed: boolean;
  lastWatchedAt: Date;
  createdAt: Date;
}

export type DownloadStatusName = 'STARTED' | 'COMPLETED' | 'FAILED' | 'CANCELED';
export interface DownloadRecord {
  id: string;
  userId: string | null;
  videoAssetId: string;
  status: DownloadStatusName;
  sizeBytes: number | null;
  appVersion: string | null;
  failureReason: string | null;
  startedAt: Date;
  completedAt: Date | null;
}

export type StatField = 'views' | 'downloads' | 'favorites' | 'plays';
export interface StatRow {
  contentId: string;
  views: number;
  downloads: number;
  favorites: number;
  plays: number;
}

export interface UserPaging {
  page: number;
  limit: number;
}

/** Données propres à l'utilisateur (favoris, suivis, historique, téléchargements) et compteurs d'usage. */
export interface UserDataRepo {
  /** Renvoie vrai si le favori vient d'être créé (faux s'il existait déjà). */
  addFavorite(userId: string, contentId: string): Promise<boolean>;
  removeFavorite(userId: string, contentId: string): Promise<void>;
  /** Seulement les contenus actuellement publiés, du plus récent au plus ancien. */
  listFavorites(userId: string, p: UserPaging): Promise<{ contentIds: string[]; total: number }>;
  upsertFollow(userId: string, contentId: string, flags: { notifyNewEpisodes?: boolean; notifyNewSeasons?: boolean }): Promise<FollowRecord>;
  removeFollow(userId: string, contentId: string): Promise<void>;
  listFollows(userId: string, p: UserPaging): Promise<{ items: FollowRecord[]; total: number }>;
  upsertHistory(h: {
    userId: string; contentId: string | null; episodeId: string | null; videoAssetId: string | null;
    positionSeconds: number; durationSeconds: number | null; completed: boolean; at: Date;
  }): Promise<{ record: HistoryRecord; created: boolean }>;
  listHistory(userId: string, p: UserPaging): Promise<{ items: HistoryRecord[]; total: number }>;
  deleteHistory(userId: string, id: string): Promise<boolean>;
  clearHistory(userId: string): Promise<void>;
  addSearch(userId: string, query: string): Promise<void>;
  listSearches(userId: string, limit: number): Promise<string[]>;
  clearSearches(userId: string): Promise<void>;
  createDownload(d: { userId: string; videoAssetId: string; sizeBytes: number | null; appVersion: string | null }): Promise<DownloadRecord>;
  getDownload(id: string): Promise<DownloadRecord | null>;
  finishDownload(id: string, status: Exclude<DownloadStatusName, 'STARTED'>, failureReason: string | null, at: Date): Promise<DownloadRecord>;
  /** Incrémente le compteur du jour (AAAA-MM-JJ). */
  bumpStat(contentId: string, day: string, field: StatField): Promise<void>;
  /** Totaux par contenu depuis ce jour (inclus). */
  statsSince(day: string): Promise<StatRow[]>;
  getSettings(userId: string): Promise<Settings | null>;
  updateSettings(userId: string, patch: Partial<Settings>): Promise<Settings>;
  getAppSetting(key: string): Promise<unknown | null>;
}
