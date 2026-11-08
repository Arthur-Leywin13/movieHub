import type { ContentTypeName, PublicationStatusName, SubtitleFormatName } from './rules.ts';

export interface GenreRef {
  slug: string;
  name: string;
}

export interface ContentRecord {
  id: string;
  type: ContentTypeName;
  slug: string;
  title: string;
  description: string | null;
  year: number | null;
  /** AAAA-MM-JJ */
  releaseDate: string | null;
  status: PublicationStatusName;
  publishedAt: Date | null;
  primaryPosterId: string | null;
  primaryTrailerId: string | null;
  altTitles: string[];
  genres: GenreRef[];
  audioLanguages: string[];
  subtitleLanguages: string[];
  createdAt: Date;
}

export interface NewContent {
  type: ContentTypeName;
  slug: string;
  title: string;
  description: string | null;
  year: number | null;
  releaseDate: string | null;
  altTitles: string[];
  genres: GenreRef[];
  audioLanguages: string[];
  subtitleLanguages: string[];
}

export interface ContentUpdate {
  title?: string;
  description?: string | null;
  year?: number | null;
  releaseDate?: string | null;
  status?: PublicationStatusName;
  publishedAt?: Date | null;
  addAltTitles?: string[];
  removeAltTitles?: string[];
  addGenres?: GenreRef[];
  removeGenreSlugs?: string[];
  addAudio?: string[];
  removeAudio?: string[];
  addSubs?: string[];
  removeSubs?: string[];
}

export interface ContentFilter {
  /** Vrai = vitrine publique (statut PUBLISHED uniquement). */
  onlyPublished: boolean;
  type?: ContentTypeName;
  genreSlug?: string;
  year?: number;
  audio?: string;
  subtitle?: string;
  /** Recherche administrateur par titre / titre alternatif (sans accent ni casse). */
  q?: string;
  status?: PublicationStatusName;
  /** Date de sortie <= cette date (AAAA-MM-JJ) : nouveautés. */
  releasedOnOrBefore?: string;
  /** Date de sortie > cette date : à venir. */
  releasingAfter?: string;
}

export interface Paging {
  page: number;
  limit: number;
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
}

export type ContentListItem = ContentRecord & { posterKey: string | null };

export interface SeasonRecord {
  id: string;
  contentId: string;
  number: number;
  title: string | null;
  description: string | null;
  releaseDate: string;
  status: PublicationStatusName;
  featuredAsNewSeason: boolean;
  primaryTrailerId: string | null;
  publishedAt: Date | null;
}
export interface NewSeason {
  contentId: string;
  number: number;
  title: string | null;
  description: string | null;
  releaseDate: string;
  featuredAsNewSeason: boolean;
}
export interface SeasonUpdate {
  title?: string | null;
  description?: string | null;
  releaseDate?: string;
  featuredAsNewSeason?: boolean;
  status?: PublicationStatusName;
  publishedAt?: Date | null;
}

export interface EpisodeRecord {
  id: string;
  seasonId: string;
  number: number;
  title: string | null;
  description: string | null;
  durationSeconds: number | null;
  releaseNote: string | null;
  status: PublicationStatusName;
  publishedAt: Date | null;
}
export interface NewEpisode {
  seasonId: string;
  number: number;
  title: string | null;
  description: string | null;
  durationSeconds: number | null;
  releaseNote: string | null;
}
export interface EpisodeUpdate {
  title?: string | null;
  description?: string | null;
  durationSeconds?: number | null;
  releaseNote?: string | null;
  status?: PublicationStatusName;
  publishedAt?: Date | null;
}

export interface AudioTrackRecord {
  languageCode: string;
  streamIndex: number;
  isDefault: boolean;
  origin: 'PROBED' | 'DECLARED';
}
export interface SubtitleTrackRecord {
  id: string;
  languageCode: string;
  source: 'EMBEDDED' | 'EXTERNAL';
  format: SubtitleFormatName;
  streamIndex: number | null;
  mediaFileId: string | null;
  isDefault: boolean;
  isForced: boolean;
}
export interface VersionRecord {
  id: string;
  contentId: string | null;
  episodeId: string | null;
  mediaFileId: string;
  label: string | null;
  status: PublicationStatusName;
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
  allowLocalShare: boolean;
  sizeBytes: number | null;
  audioTracks: AudioTrackRecord[];
  subtitleTracks: SubtitleTrackRecord[];
  publishedAt: Date | null;
  createdAt: Date;
}
export interface NewVersion {
  contentId: string | null;
  episodeId: string | null;
  mediaFileId: string;
  label: string | null;
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
  allowLocalShare: boolean;
  /** Langues audio déclarées (index de flux = position, à confirmer par la détection des pistes). */
  audioLanguages: string[];
  embeddedSubtitles: { languageCode: string; format: SubtitleFormatName; streamIndex: number }[];
}
export interface NewSubtitleTrack {
  languageCode: string;
  source: 'EMBEDDED' | 'EXTERNAL';
  format: SubtitleFormatName;
  streamIndex: number | null;
  mediaFileId: string | null;
  isDefault: boolean;
  isForced: boolean;
}

export interface PosterRecord {
  id: string;
  contentId: string;
  mediaFileId: string;
  objectKey: string;
  kind: 'POSTER' | 'PROMOTIONAL';
  sortOrder: number;
  archivedAt: Date | null;
}
export interface NewPoster {
  contentId: string;
  mediaFileId: string;
  kind: 'POSTER' | 'PROMOTIONAL';
}

export interface TrailerRecord {
  id: string;
  contentId: string;
  seasonId: string | null;
  title: string | null;
  mediaFileId: string | null;
  objectKey: string | null;
  externalUrl: string | null;
  sortOrder: number;
  archivedAt: Date | null;
}
export interface NewTrailer {
  contentId: string;
  seasonId: string | null;
  title: string | null;
  mediaFileId: string | null;
  externalUrl: string | null;
}

export interface CatalogRepo {
  // contenus
  getContent(id: string): Promise<ContentRecord | null>;
  getContentBySlug(slug: string): Promise<ContentRecord | null>;
  createContent(c: NewContent): Promise<ContentRecord>;
  updateContent(id: string, u: ContentUpdate): Promise<ContentRecord>;
  listContents(filter: ContentFilter, paging: Paging, sort: 'new' | 'title' | 'soonest'): Promise<Page<ContentListItem>>;
  /** Recherche classée (accents, fautes de frappe, titres alternatifs). Ne renvoie que des contenus publiés. */
  searchContents(q: string, filter: ContentFilter, paging: Paging): Promise<Page<ContentListItem>>;
  /** Fiches par identifiants, tous statuts confondus, dans l'ordre demandé (le service filtre ce qui est visible). */
  listContentsByIds(ids: string[]): Promise<ContentListItem[]>;
  /** Saisons publiées et mises en avant, sorties dans [from, to], de contenus publiés. */
  listNewSeasons(opts: { from: string; to: string; limit: number }): Promise<{ season: SeasonRecord; content: ContentListItem }[]>;
  /** Version avec sa chaîne (épisode, saison, contenu) et la clé R2 du fichier. */
  getVersionChain(versionId: string): Promise<VersionChain | null>;
  existingLanguageCodes(codes: string[]): Promise<string[]>;
  listGenres(): Promise<GenreRef[]>;
  listLanguages(): Promise<{ code: string; name: string; nativeName: string | null }[]>;
  // saisons
  createSeason(s: NewSeason): Promise<SeasonRecord>;
  getSeason(id: string): Promise<SeasonRecord | null>;
  listSeasons(contentId: string): Promise<SeasonRecord[]>;
  updateSeason(id: string, u: SeasonUpdate): Promise<SeasonRecord>;
  // épisodes
  createEpisode(e: NewEpisode): Promise<EpisodeRecord>;
  getEpisode(id: string): Promise<EpisodeRecord | null>;
  listEpisodes(seasonId: string): Promise<EpisodeRecord[]>;
  updateEpisode(id: string, u: EpisodeUpdate): Promise<EpisodeRecord>;
  // versions vidéo
  createVersion(v: NewVersion): Promise<VersionRecord>;
  getVersion(id: string): Promise<VersionRecord | null>;
  listVersionsForContent(contentId: string): Promise<VersionRecord[]>;
  listVersionsForEpisode(episodeId: string): Promise<VersionRecord[]>;
  updateVersionStatus(id: string, status: PublicationStatusName, publishedAt: Date | null): Promise<VersionRecord>;
  addSubtitleTrack(versionId: string, t: NewSubtitleTrack): Promise<VersionRecord>;
  isMediaUsed(mediaFileId: string): Promise<boolean>;
  // affiches
  addPoster(p: NewPoster): Promise<PosterRecord>;
  getPoster(id: string): Promise<PosterRecord | null>;
  listPosters(contentId: string): Promise<PosterRecord[]>;
  /** Atomique : l'ancienne affiche principale est archivée (conservée), la nouvelle devient principale. */
  setPrimaryPoster(contentId: string, posterId: string, at: Date): Promise<void>;
  archivePoster(id: string, at: Date): Promise<void>;
  restorePoster(id: string): Promise<void>;
  // bandes-annonces
  addTrailer(t: NewTrailer): Promise<TrailerRecord>;
  getTrailer(id: string): Promise<TrailerRecord | null>;
  listTrailers(contentId: string): Promise<TrailerRecord[]>;
  /** Pointe la bande-annonce principale du contenu ou de la saison ; les autres restent secondaires. */
  setPrimaryTrailer(trailerId: string): Promise<void>;
  archiveTrailer(id: string, at: Date): Promise<void>;
  restoreTrailer(id: string): Promise<void>;
  reorderTrailers(contentId: string, seasonId: string | null, orderedIds: string[]): Promise<void>;
}

export interface VersionChain {
  version: VersionRecord;
  objectKey: string;
  content: ContentRecord;
  season: SeasonRecord | null;
  episode: EpisodeRecord | null;
}
