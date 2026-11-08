import { AppError, NotFoundError } from '@movieshub/shared';
import type {
  CatalogRepo, ContentListItem, ContentRecord, Page, PosterRecord, SeasonRecord, TrailerRecord, VersionRecord,
} from './ports.ts';
import type { ContentTypeName } from './rules.ts';
import type { StatRow } from '../user/ports.ts';
import { daysAgo, isoDay, parseWeights, rankTrending } from './trending.ts';

export interface UrlSigner {
  presignGet(key: string, expiresSeconds: number, opts?: { downloadName?: string }): string;
}

/** Compteurs d'usage et réglages nécessaires aux tendances (facultatif : sans lui, pas de tendances). */
export interface StatsSource {
  statsSince(day: string): Promise<StatRow[]>;
  getAppSetting(key: string): Promise<unknown | null>;
}

export const WITHDRAWN_MESSAGE = 'Ce contenu a été retiré de l’application.';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Lecture publique : seuls les éléments PUBLISHED sont visibles, tout le reste est invisible. */
export class CatalogReadService {
  private readonly repo: CatalogRepo;
  private readonly signer: UrlSigner;
  private readonly imageTtl: number;
  private readonly stats: StatsSource | null;
  private readonly now: () => Date;

  constructor(deps: { repo: CatalogRepo; signer: UrlSigner; imageTtlSeconds?: number; stats?: StatsSource; now?: () => Date }) {
    this.repo = deps.repo;
    this.signer = deps.signer;
    this.imageTtl = deps.imageTtlSeconds ?? 3600;
    this.stats = deps.stats ?? null;
    this.now = deps.now ?? (() => new Date());
  }

  private url(key: string | null): string | null {
    return key ? this.signer.presignGet(key, this.imageTtl) : null;
  }

  private card(c: ContentListItem) {
    return {
      id: c.id, slug: c.slug, type: c.type, title: c.title, year: c.year, releaseDate: c.releaseDate,
      genres: c.genres.map((g) => g.name), audioLanguages: c.audioLanguages, subtitleLanguages: c.subtitleLanguages,
      posterUrl: this.url(c.posterKey),
    };
  }

  async list(q: { type?: ContentTypeName; genre?: string; year?: number; audio?: string; subtitle?: string; sort?: 'new' | 'title'; page: number; limit: number }) {
    const page = await this.repo.listContents(
      {
        onlyPublished: true,
        ...(q.type ? { type: q.type } : {}), ...(q.genre ? { genreSlug: q.genre } : {}), ...(q.year !== undefined ? { year: q.year } : {}),
        ...(q.audio ? { audio: q.audio } : {}), ...(q.subtitle ? { subtitle: q.subtitle } : {}),
      },
      { page: q.page, limit: q.limit },
      q.sort ?? 'new',
    );
    return { items: page.items.map((c) => this.card(c)), total: page.total, page: page.page, limit: page.limit } satisfies Page<unknown>;
  }

  private versionView(v: VersionRecord) {
    return {
      id: v.id, label: v.label, width: v.width, height: v.height, durationSeconds: v.durationSeconds, sizeBytes: v.sizeBytes,
      allowLocalShare: v.allowLocalShare,
      audioLanguages: [...v.audioTracks].sort((a, b) => a.streamIndex - b.streamIndex).map((t) => t.languageCode),
      subtitles: v.subtitleTracks.map((s) => ({ language: s.languageCode, source: s.source, format: s.format })),
    };
  }

  private trailerView(t: TrailerRecord) {
    return { id: t.id, title: t.title, external: t.externalUrl !== null, url: t.externalUrl ?? this.url(t.objectKey) };
  }

  private posterView(p: PosterRecord) {
    return { id: p.id, kind: p.kind, url: this.url(p.objectKey) };
  }

  /** Contenu visible publiquement (par identifiant ou slug) ; retiré = 410, non publié = 404. */
  async assertVisible(slugOrId: string): Promise<ContentRecord> {
    return this.visibleContent(slugOrId);
  }

  /** Cartes des contenus publiés parmi `ids`, dans l'ordre demandé. */
  async cardsByIds(ids: string[]) {
    return (await this.repo.listContentsByIds(ids)).filter((c) => c.status === 'PUBLISHED').map((c) => this.card(c));
  }

  /** Tendances : usage récent pondéré (réglage « trending »), sans bonus de nouveauté. */
  async trending(limit: number) {
    if (!this.stats) return [];
    const w = parseWeights(await this.stats.getAppSetting('trending'));
    const ranked = rankTrending(await this.stats.statsSince(daysAgo(this.now(), w.windowDays - 1)), w);
    return (await this.cardsByIds(ranked.slice(0, limit * 2).map((x) => x.contentId))).slice(0, limit);
  }

  /** À venir : contenus publiés dont la date de sortie officielle est dans le futur, les plus proches d'abord. */
  async upcoming(page: number, limit: number) {
    const res = await this.repo.listContents({ onlyPublished: true, releasingAfter: isoDay(this.now()) }, { page, limit }, 'soonest');
    return { items: res.items.map((c) => this.card(c)), total: res.total, page: res.page, limit: res.limit };
  }

  /** Accueil : nouveautés (date de sortie officielle), nouvelles saisons de l'année, tendances, à venir. */
  async home() {
    const today = isoDay(this.now());
    const [releases, seasons, upcoming, trending] = await Promise.all([
      this.repo.listContents({ onlyPublished: true, type: 'MOVIE', releasedOnOrBefore: today }, { page: 1, limit: 12 }, 'new'),
      this.repo.listNewSeasons({ from: `${today.slice(0, 4)}-01-01`, to: today, limit: 12 }),
      this.upcoming(1, 12),
      this.trending(12),
    ]);
    return {
      newReleases: releases.items.map((c) => this.card(c)),
      newSeasons: seasons.map((x) => ({ content: this.card(x.content), season: { id: x.season.id, number: x.season.number, title: x.season.title, releaseDate: x.season.releaseDate } })),
      trending,
      upcoming: upcoming.items,
    };
  }

  private async visibleContent(slugOrId: string): Promise<ContentRecord> {
    const c = UUID.test(slugOrId) ? await this.repo.getContent(slugOrId.toLowerCase()) : await this.repo.getContentBySlug(slugOrId);
    if (!c) throw new NotFoundError('Contenu introuvable');
    if (c.status === 'WITHDRAWN') throw new AppError('NOT_FOUND', 410, WITHDRAWN_MESSAGE);
    if (c.status !== 'PUBLISHED') throw new NotFoundError('Contenu introuvable');
    return c;
  }

  private publishedSeasonTrailer(trailers: TrailerRecord[], s: SeasonRecord) {
    const t = trailers.find((x) => x.id === s.primaryTrailerId && !x.archivedAt);
    return t ? this.trailerView(t) : null;
  }

  async detail(slugOrId: string) {
    const c = await this.visibleContent(slugOrId);
    const posters = (await this.repo.listPosters(c.id)).filter((p) => !p.archivedAt);
    const primary = posters.find((p) => p.id === c.primaryPosterId) ?? null;
    const trailers = (await this.repo.listTrailers(c.id)).filter((t) => !t.archivedAt);
    const contentTrailers = trailers.filter((t) => t.seasonId === null);
    const mainTrailer = contentTrailers.find((t) => t.id === c.primaryTrailerId) ?? null;

    const base = {
      id: c.id, slug: c.slug, type: c.type, title: c.title, altTitles: c.altTitles, description: c.description, year: c.year,
      releaseDate: c.releaseDate, genres: c.genres.map((g) => g.name), audioLanguages: c.audioLanguages, subtitleLanguages: c.subtitleLanguages,
      poster: primary ? this.posterView(primary) : null,
      images: posters.filter((p) => p.id !== c.primaryPosterId).map((p) => this.posterView(p)),
      trailer: mainTrailer ? this.trailerView(mainTrailer) : null,
      otherTrailers: contentTrailers.filter((t) => t.id !== c.primaryTrailerId).map((t) => this.trailerView(t)),
    };

    if (c.type === 'MOVIE') {
      const versions = (await this.repo.listVersionsForContent(c.id)).filter((v) => v.status === 'PUBLISHED').map((v) => this.versionView(v));
      return { ...base, available: versions.length > 0, versions };
    }

    const seasons = (await this.repo.listSeasons(c.id)).filter((s) => s.status === 'PUBLISHED');
    let available = false;
    const seasonViews = [];
    for (const s of seasons) {
      const episodes = (await this.repo.listEpisodes(s.id)).filter((e) => e.status === 'PUBLISHED');
      for (const e of episodes) {
        if (!available && (await this.repo.listVersionsForEpisode(e.id)).some((v) => v.status === 'PUBLISHED')) available = true;
      }
      seasonViews.push({
        id: s.id, number: s.number, title: s.title, description: s.description, releaseDate: s.releaseDate,
        featuredAsNewSeason: s.featuredAsNewSeason, episodeCount: episodes.length, trailer: this.publishedSeasonTrailer(trailers, s),
      });
    }
    return { ...base, available, seasons: seasonViews };
  }

  async seasonEpisodes(seasonId: string) {
    const s = await this.repo.getSeason(seasonId);
    if (!s) throw new NotFoundError('Saison introuvable');
    const c = await this.repo.getContent(s.contentId);
    if (!c) throw new NotFoundError('Saison introuvable');
    if (c.status === 'WITHDRAWN') throw new AppError('NOT_FOUND', 410, WITHDRAWN_MESSAGE);
    if (c.status !== 'PUBLISHED' || s.status !== 'PUBLISHED') throw new NotFoundError('Saison introuvable');
    const episodes = (await this.repo.listEpisodes(s.id)).filter((e) => e.status === 'PUBLISHED');
    return {
      season: { id: s.id, contentId: c.id, number: s.number, title: s.title, releaseDate: s.releaseDate },
      episodes: await Promise.all(
        episodes.map(async (e) => ({
          id: e.id, number: e.number, title: e.title, description: e.description, durationSeconds: e.durationSeconds, releaseNote: e.releaseNote,
          versions: (await this.repo.listVersionsForEpisode(e.id)).filter((v) => v.status === 'PUBLISHED').map((v) => this.versionView(v)),
        })),
      ),
    };
  }

  /** Recherche publique : accents ignorés, fautes de frappe tolérées, titres alternatifs inclus. */
  async search(q: string, f: { type?: ContentTypeName; genre?: string; year?: number; audio?: string; subtitle?: string; page: number; limit: number }) {
    const page = await this.repo.searchContents(
      q,
      {
        onlyPublished: true,
        ...(f.type ? { type: f.type } : {}), ...(f.genre ? { genreSlug: f.genre } : {}), ...(f.year !== undefined ? { year: f.year } : {}),
        ...(f.audio ? { audio: f.audio } : {}), ...(f.subtitle ? { subtitle: f.subtitle } : {}),
      },
      { page: f.page, limit: f.limit },
    );
    return { items: page.items.map((c) => this.card(c)), total: page.total, page: page.page, limit: page.limit };
  }

  genres() { return this.repo.listGenres(); }
  languages() { return this.repo.listLanguages(); }
}
