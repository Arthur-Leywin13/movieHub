/** Implémentation en mémoire de CatalogRepo, réservée aux tests. */
import { randomUUID } from 'node:crypto';
import { ConflictError, NotFoundError, slugify } from '@movieshub/shared';
import { scoreMatch } from '../catalog/search.ts';
import type {
  CatalogRepo, VersionChain, ContentFilter, ContentListItem, ContentRecord, ContentUpdate, EpisodeRecord, EpisodeUpdate, GenreRef,
  NewContent, NewEpisode, NewPoster, NewSeason, NewSubtitleTrack, NewTrailer, NewVersion, Page, Paging,
  PosterRecord, SeasonRecord, SeasonUpdate, TrailerRecord, VersionRecord,
} from '../catalog/ports.ts';
import type { PublicationStatusName } from '../catalog/rules.ts';
import type { MemoryMediaRepo } from './memory-repos.ts';

const must = <T>(v: T | undefined | null, what: string): T => {
  if (v === undefined || v === null) throw new NotFoundError(`${what} introuvable`);
  return v;
};
const norm = (s: string): string => slugify(s, 200);

export class MemoryCatalogRepo implements CatalogRepo {
  readonly contents = new Map<string, ContentRecord>();
  readonly seasons = new Map<string, SeasonRecord>();
  readonly episodes = new Map<string, EpisodeRecord>();
  readonly versions = new Map<string, VersionRecord>();
  readonly posters = new Map<string, PosterRecord>();
  readonly trailers = new Map<string, TrailerRecord>();
  readonly languages = new Map<string, { code: string; name: string; nativeName: string | null }>();
  private readonly media: MemoryMediaRepo;

  constructor(media: MemoryMediaRepo) {
    this.media = media;
    for (const [code, name] of [['fr', 'French'], ['en', 'English'], ['ja', 'Japanese'], ['es', 'Spanish'], ['pt', 'Portuguese']] as const) {
      this.languages.set(code, { code, name, nativeName: null });
    }
  }

  private key(f: { mediaFileId: string | null }): string | null {
    return f.mediaFileId ? (this.media.files.get(f.mediaFileId)?.objectKey ?? null) : null;
  }

  // ---- contenus ----
  async getContent(id: string) { return this.contents.get(id) ?? null; }
  async getContentBySlug(slug: string) { return [...this.contents.values()].find((c) => c.slug === slug) ?? null; }

  async createContent(c: NewContent): Promise<ContentRecord> {
    if ([...this.contents.values()].some((x) => x.slug === c.slug)) throw new ConflictError('Slug déjà utilisé');
    const rec: ContentRecord = {
      id: randomUUID(), ...c, status: 'DRAFT', publishedAt: null, primaryPosterId: null, primaryTrailerId: null, createdAt: new Date(),
      altTitles: [...c.altTitles], genres: [...c.genres], audioLanguages: [...c.audioLanguages], subtitleLanguages: [...c.subtitleLanguages],
    };
    this.contents.set(rec.id, rec);
    return rec;
  }

  async updateContent(id: string, u: ContentUpdate): Promise<ContentRecord> {
    const c = must(this.contents.get(id), 'Contenu');
    if (u.title !== undefined) c.title = u.title;
    if (u.description !== undefined) c.description = u.description;
    if (u.year !== undefined) c.year = u.year;
    if (u.releaseDate !== undefined) c.releaseDate = u.releaseDate;
    if (u.status !== undefined) c.status = u.status;
    if (u.publishedAt !== undefined) c.publishedAt = u.publishedAt;
    const rm = new Set((u.removeAltTitles ?? []).map((t) => t.toLowerCase()));
    c.altTitles = c.altTitles.filter((t) => !rm.has(t.toLowerCase()));
    for (const t of u.addAltTitles ?? []) if (!c.altTitles.some((x) => x.toLowerCase() === t.toLowerCase())) c.altTitles.push(t);
    const rg = new Set(u.removeGenreSlugs ?? []);
    c.genres = c.genres.filter((g) => !rg.has(g.slug));
    for (const g of u.addGenres ?? []) if (!c.genres.some((x) => x.slug === g.slug)) c.genres.push(g);
    c.audioLanguages = [...new Set([...c.audioLanguages.filter((l) => !(u.removeAudio ?? []).includes(l)), ...(u.addAudio ?? [])])];
    c.subtitleLanguages = [...new Set([...c.subtitleLanguages.filter((l) => !(u.removeSubs ?? []).includes(l)), ...(u.addSubs ?? [])])];
    return c;
  }

  private matches(c: ContentRecord, f: ContentFilter): boolean {
    if (f.onlyPublished && c.status !== 'PUBLISHED') return false;
    if (f.status && c.status !== f.status) return false;
    if (f.type && c.type !== f.type) return false;
    if (f.year !== undefined && c.year !== f.year) return false;
    if (f.genreSlug && !c.genres.some((g) => g.slug === f.genreSlug)) return false;
    if (f.audio && !c.audioLanguages.includes(f.audio)) return false;
    if (f.subtitle && !c.subtitleLanguages.includes(f.subtitle)) return false;
    if (f.releasedOnOrBefore && !(c.releaseDate !== null && c.releaseDate <= f.releasedOnOrBefore)) return false;
    if (f.releasingAfter && !(c.releaseDate !== null && c.releaseDate > f.releasingAfter)) return false;
    if (f.q) {
      const q = norm(f.q);
      if (![c.title, ...c.altTitles].some((t) => norm(t).includes(q))) return false;
    }
    return true;
  }

  private item(c: ContentRecord): ContentListItem {
    return { ...c, posterKey: c.primaryPosterId ? (this.posters.get(c.primaryPosterId)?.objectKey ?? null) : null };
  }

  async listContents(f: ContentFilter, p: Paging, sort: 'new' | 'title' | 'soonest'): Promise<Page<ContentListItem>> {
    let list = [...this.contents.values()].filter((c) => this.matches(c, f));
    list =
      sort === 'title'
        ? list.sort((a, b) => norm(a.title).localeCompare(norm(b.title)))
        : sort === 'soonest'
          ? list.sort((a, b) => (a.releaseDate ?? '9').localeCompare(b.releaseDate ?? '9'))
          : list.sort((a, b) => (b.releaseDate ?? '').localeCompare(a.releaseDate ?? '') || b.createdAt.getTime() - a.createdAt.getTime());
    return { items: list.slice((p.page - 1) * p.limit, p.page * p.limit).map((c) => this.item(c)), total: list.length, page: p.page, limit: p.limit };
  }

  async searchContents(q: string, f: ContentFilter, p: Paging): Promise<Page<ContentListItem>> {
    const scored = [...this.contents.values()]
      .filter((c) => this.matches(c, { ...f, onlyPublished: true }))
      .map((c) => ({ c, score: scoreMatch(q, [c.title, ...c.altTitles], c.description) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || (b.c.releaseDate ?? '').localeCompare(a.c.releaseDate ?? ''));
    return { items: scored.slice((p.page - 1) * p.limit, p.page * p.limit).map((x) => this.item(x.c)), total: scored.length, page: p.page, limit: p.limit };
  }

  async listContentsByIds(ids: string[]): Promise<ContentListItem[]> {
    return ids.flatMap((id) => {
      const c = this.contents.get(id);
      return c ? [this.item(c)] : [];
    });
  }

  async listNewSeasons(o: { from: string; to: string; limit: number }) {
    return [...this.seasons.values()]
      .filter((s) => s.status === 'PUBLISHED' && s.featuredAsNewSeason && s.releaseDate >= o.from && s.releaseDate <= o.to)
      .filter((s) => this.contents.get(s.contentId)?.status === 'PUBLISHED')
      .sort((a, b) => b.releaseDate.localeCompare(a.releaseDate))
      .slice(0, o.limit)
      .map((season) => ({ season, content: this.item(this.contents.get(season.contentId) as ContentRecord) }));
  }

  async getVersionChain(versionId: string): Promise<VersionChain | null> {
    const version = this.versions.get(versionId);
    if (!version) return null;
    const episode = version.episodeId ? (this.episodes.get(version.episodeId) ?? null) : null;
    const season = episode ? (this.seasons.get(episode.seasonId) ?? null) : null;
    const content = this.contents.get(version.contentId ?? season?.contentId ?? '');
    if (!content) return null;
    return { version, objectKey: this.media.files.get(version.mediaFileId)?.objectKey ?? '', content, season, episode };
  }

  async existingLanguageCodes(codes: string[]) { return codes.filter((c) => this.languages.has(c)); }
  async listGenres(): Promise<GenreRef[]> {
    const m = new Map<string, GenreRef>();
    for (const c of this.contents.values()) for (const g of c.genres) m.set(g.slug, g);
    return [...m.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
  async listLanguages() { return [...this.languages.values()]; }

  // ---- saisons ----
  async createSeason(s: NewSeason): Promise<SeasonRecord> {
    if ([...this.seasons.values()].some((x) => x.contentId === s.contentId && x.number === s.number)) throw new ConflictError(`La saison ${s.number} existe déjà`);
    const rec: SeasonRecord = { id: randomUUID(), ...s, status: 'DRAFT', primaryTrailerId: null, publishedAt: null };
    this.seasons.set(rec.id, rec);
    return rec;
  }
  async getSeason(id: string) { return this.seasons.get(id) ?? null; }
  async listSeasons(contentId: string) { return [...this.seasons.values()].filter((s) => s.contentId === contentId).sort((a, b) => a.number - b.number); }
  async updateSeason(id: string, u: SeasonUpdate) { return Object.assign(must(this.seasons.get(id), 'Saison'), stripUndefined(u)); }

  // ---- épisodes ----
  async createEpisode(e: NewEpisode): Promise<EpisodeRecord> {
    if ([...this.episodes.values()].some((x) => x.seasonId === e.seasonId && x.number === e.number)) throw new ConflictError(`L'épisode ${e.number} existe déjà`);
    const rec: EpisodeRecord = { id: randomUUID(), ...e, status: 'DRAFT', publishedAt: null };
    this.episodes.set(rec.id, rec);
    return rec;
  }
  async getEpisode(id: string) { return this.episodes.get(id) ?? null; }
  async listEpisodes(seasonId: string) { return [...this.episodes.values()].filter((e) => e.seasonId === seasonId).sort((a, b) => a.number - b.number); }
  async updateEpisode(id: string, u: EpisodeUpdate) { return Object.assign(must(this.episodes.get(id), 'Épisode'), stripUndefined(u)); }

  // ---- versions ----
  async createVersion(v: NewVersion): Promise<VersionRecord> {
    if ([...this.versions.values()].some((x) => x.mediaFileId === v.mediaFileId)) throw new ConflictError('Ce fichier est déjà une version');
    const rec: VersionRecord = {
      id: randomUUID(), contentId: v.contentId, episodeId: v.episodeId, mediaFileId: v.mediaFileId, label: v.label, status: 'DRAFT',
      width: v.width, height: v.height, durationSeconds: v.durationSeconds, allowLocalShare: v.allowLocalShare,
      sizeBytes: this.media.files.get(v.mediaFileId)?.sizeBytes ?? null,
      audioTracks: v.audioLanguages.map((languageCode, i) => ({ languageCode, streamIndex: i, isDefault: i === 0, origin: 'DECLARED' as const })),
      subtitleTracks: v.embeddedSubtitles.map((s) => ({
        id: randomUUID(), languageCode: s.languageCode, source: 'EMBEDDED' as const, format: s.format, streamIndex: s.streamIndex,
        mediaFileId: null, isDefault: false, isForced: false,
      })),
      publishedAt: null, createdAt: new Date(),
    };
    this.versions.set(rec.id, rec);
    return rec;
  }
  async getVersion(id: string) { return this.versions.get(id) ?? null; }
  async listVersionsForContent(contentId: string) { return [...this.versions.values()].filter((v) => v.contentId === contentId); }
  async listVersionsForEpisode(episodeId: string) { return [...this.versions.values()].filter((v) => v.episodeId === episodeId); }
  async updateVersionStatus(id: string, status: PublicationStatusName, publishedAt: Date | null) {
    const v = must(this.versions.get(id), 'Version');
    v.status = status;
    if (publishedAt) v.publishedAt = publishedAt;
    return v;
  }
  async addSubtitleTrack(versionId: string, t: NewSubtitleTrack): Promise<VersionRecord> {
    const v = must(this.versions.get(versionId), 'Version');
    v.subtitleTracks.push({ id: randomUUID(), ...t });
    return v;
  }
  async isMediaUsed(mediaFileId: string): Promise<boolean> {
    return (
      [...this.versions.values()].some((v) => v.mediaFileId === mediaFileId || v.subtitleTracks.some((s) => s.mediaFileId === mediaFileId)) ||
      [...this.posters.values()].some((p) => p.mediaFileId === mediaFileId) ||
      [...this.trailers.values()].some((t) => t.mediaFileId === mediaFileId)
    );
  }

  // ---- affiches ----
  async addPoster(p: NewPoster): Promise<PosterRecord> {
    const rec: PosterRecord = { id: randomUUID(), ...p, objectKey: this.key(p) ?? '', sortOrder: 0, archivedAt: null };
    this.posters.set(rec.id, rec);
    return rec;
  }
  async getPoster(id: string) { return this.posters.get(id) ?? null; }
  async listPosters(contentId: string) { return [...this.posters.values()].filter((p) => p.contentId === contentId); }
  async setPrimaryPoster(contentId: string, posterId: string, at: Date): Promise<void> {
    const c = must(this.contents.get(contentId), 'Contenu');
    const next = must(this.posters.get(posterId), 'Affiche');
    const old = c.primaryPosterId ? this.posters.get(c.primaryPosterId) : undefined;
    if (old && old.id !== next.id) old.archivedAt = at;
    next.archivedAt = null;
    c.primaryPosterId = next.id;
  }
  async archivePoster(id: string, at: Date) { must(this.posters.get(id), 'Affiche').archivedAt = at; }
  async restorePoster(id: string) { must(this.posters.get(id), 'Affiche').archivedAt = null; }

  // ---- bandes-annonces ----
  async addTrailer(t: NewTrailer): Promise<TrailerRecord> {
    const sibs = [...this.trailers.values()].filter((x) => x.contentId === t.contentId && x.seasonId === t.seasonId);
    const rec: TrailerRecord = { id: randomUUID(), ...t, objectKey: this.key(t), sortOrder: sibs.length, archivedAt: null };
    this.trailers.set(rec.id, rec);
    return rec;
  }
  async getTrailer(id: string) { return this.trailers.get(id) ?? null; }
  async listTrailers(contentId: string) { return [...this.trailers.values()].filter((t) => t.contentId === contentId).sort((a, b) => a.sortOrder - b.sortOrder); }
  async setPrimaryTrailer(trailerId: string): Promise<void> {
    const t = must(this.trailers.get(trailerId), 'Bande-annonce');
    if (t.seasonId) must(this.seasons.get(t.seasonId), 'Saison').primaryTrailerId = t.id;
    else must(this.contents.get(t.contentId), 'Contenu').primaryTrailerId = t.id;
  }
  async archiveTrailer(id: string, at: Date) { must(this.trailers.get(id), 'Bande-annonce').archivedAt = at; }
  async restoreTrailer(id: string) { must(this.trailers.get(id), 'Bande-annonce').archivedAt = null; }
  async reorderTrailers(contentId: string, seasonId: string | null, orderedIds: string[]): Promise<void> {
    orderedIds.forEach((id, i) => {
      const t = must(this.trailers.get(id), 'Bande-annonce');
      if (t.contentId === contentId && t.seasonId === seasonId) t.sortOrder = i;
    });
  }
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
