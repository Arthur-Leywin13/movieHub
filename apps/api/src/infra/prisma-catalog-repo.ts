/**
 * Implémentation Prisma de CatalogRepo.
 * NON EXÉCUTÉ dans l'environnement de création (pas de base ni de client généré) : validé par le
 * typecheck de la CI (après `prisma generate`) et par le premier lancement réel.
 * Écarts connus avec l'implémentation mémoire des tests : la recherche administrateur (`q`) est ici
 * sensible aux accents (la recherche SQL avec unaccent/pg_trgm viendra avec la phase « recherche »)
 * et le tri par titre suit l'ordre de tri de la base.
 */
import { Prisma, type PrismaClient } from '@prisma/client';
import { ConflictError, NotFoundError } from '@movieshub/shared';
import type {
  CatalogRepo, ContentFilter, ContentListItem, ContentRecord, ContentUpdate, EpisodeRecord, EpisodeUpdate, GenreRef,
  NewContent, NewEpisode, NewPoster, NewSeason, NewSubtitleTrack, NewTrailer, NewVersion, Page, Paging, PosterRecord,
  SeasonRecord, SeasonUpdate, TrailerRecord, VersionChain, VersionRecord,
} from '../catalog/ports.ts';
import type { PublicationStatusName } from '../catalog/rules.ts';
import { MIN_SIMILARITY, normalizeText, tsPrefixQuery } from '../catalog/search.ts';

const contentInclude = {
  altTitles: true,
  genres: { include: { genre: true } },
  audioLanguages: { include: { language: true } },
  subtitleLanguages: { include: { language: true } },
} satisfies Prisma.ContentInclude;
type ContentRow = Prisma.ContentGetPayload<{ include: typeof contentInclude }>;

const listInclude = {
  ...contentInclude,
  primaryPoster: { select: { mediaFile: { select: { objectKey: true } } } },
} satisfies Prisma.ContentInclude;
type ListRow = Prisma.ContentGetPayload<{ include: typeof listInclude }>;
const toItem = (r: ListRow): ContentListItem => ({ ...toContent(r), posterKey: r.primaryPoster?.mediaFile.objectKey ?? null });

const versionInclude = {
  audioTracks: { include: { language: true } },
  subtitleTracks: { include: { language: true } },
  mediaFile: { select: { sizeBytes: true } },
} satisfies Prisma.VideoAssetInclude;
type VersionRow = Prisma.VideoAssetGetPayload<{ include: typeof versionInclude }>;

const day = (d: Date | null): string | null => (d ? d.toISOString().slice(0, 10) : null);
const toDate = (s: string): Date => new Date(`${s}T00:00:00Z`);

const toContent = (c: ContentRow): ContentRecord => ({
  id: c.id, type: c.type, slug: c.slug, title: c.title, description: c.description, year: c.year, releaseDate: day(c.releaseDate),
  status: c.status, publishedAt: c.publishedAt, primaryPosterId: c.primaryPosterId, primaryTrailerId: c.primaryTrailerId,
  altTitles: c.altTitles.map((a) => a.title),
  genres: c.genres.map((g) => ({ slug: g.genre.slug, name: g.genre.name })),
  audioLanguages: c.audioLanguages.map((l) => l.language.code),
  subtitleLanguages: c.subtitleLanguages.map((l) => l.language.code),
  createdAt: c.createdAt,
});

const toVersion = (v: VersionRow): VersionRecord => ({
  id: v.id, contentId: v.contentId, episodeId: v.episodeId, mediaFileId: v.mediaFileId, label: v.label, status: v.status,
  width: v.width, height: v.height, durationSeconds: v.durationSeconds, allowLocalShare: v.allowLocalShare,
  sizeBytes: v.mediaFile.sizeBytes === null ? null : Number(v.mediaFile.sizeBytes),
  audioTracks: [...v.audioTracks].sort((a, b) => a.streamIndex - b.streamIndex).map((t) => ({
    languageCode: t.language.code, streamIndex: t.streamIndex, isDefault: t.isDefault, origin: t.origin,
  })),
  subtitleTracks: v.subtitleTracks.map((s) => ({
    id: s.id, languageCode: s.language.code, source: s.source, format: s.format, streamIndex: s.streamIndex,
    mediaFileId: s.mediaFileId, isDefault: s.isDefault, isForced: s.isForced,
  })),
  publishedAt: v.publishedAt, createdAt: v.createdAt,
});

const toSeason = (s: Prisma.SeasonGetPayload<object>): SeasonRecord => ({
  id: s.id, contentId: s.contentId, number: s.number, title: s.title, description: s.description, releaseDate: day(s.releaseDate) as string,
  status: s.status, featuredAsNewSeason: s.featuredAsNewSeason, primaryTrailerId: s.primaryTrailerId, publishedAt: s.publishedAt,
});

const toEpisode = (e: Prisma.EpisodeGetPayload<object>): EpisodeRecord => ({
  id: e.id, seasonId: e.seasonId, number: e.number, title: e.title, description: e.description, durationSeconds: e.durationSeconds,
  releaseNote: e.releaseNote, status: e.status, publishedAt: e.publishedAt,
});

type PosterRow = Prisma.PosterGetPayload<{ include: { mediaFile: { select: { objectKey: true } } } }>;
const posterInclude = { mediaFile: { select: { objectKey: true } } } as const;
const toPoster = (p: PosterRow): PosterRecord => ({
  id: p.id, contentId: p.contentId, mediaFileId: p.mediaFileId, objectKey: p.mediaFile.objectKey, kind: p.kind, sortOrder: p.sortOrder, archivedAt: p.archivedAt,
});

type TrailerRow = Prisma.TrailerGetPayload<{ include: { mediaFile: { select: { objectKey: true } } } }>;
const trailerInclude = { mediaFile: { select: { objectKey: true } } } as const;
const toTrailer = (t: TrailerRow): TrailerRecord => ({
  id: t.id, contentId: t.contentId, seasonId: t.seasonId, title: t.title, mediaFileId: t.mediaFileId,
  objectKey: t.mediaFile?.objectKey ?? null, externalUrl: t.externalUrl, sortOrder: t.sortOrder, archivedAt: t.archivedAt,
});

const isCode = (err: unknown, code: string): boolean => err instanceof Prisma.PrismaClientKnownRequestError && err.code === code;

export class PrismaCatalogRepo implements CatalogRepo {
  private readonly db: PrismaClient;
  constructor(db: PrismaClient) {
    this.db = db;
  }

  /** Convertit « enregistrement introuvable » (P2025) en NotFoundError. */
  private async guard<T>(what: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (isCode(err, 'P2025')) throw new NotFoundError(`${what} introuvable`);
      throw err;
    }
  }

  private async languageIds(tx: Prisma.TransactionClient | PrismaClient, codes: string[]): Promise<Map<string, string>> {
    const rows = await tx.language.findMany({ where: { code: { in: [...new Set(codes)] } }, select: { id: true, code: true } });
    return new Map(rows.map((r) => [r.code, r.id]));
  }

  private async genreIds(tx: Prisma.TransactionClient, genres: GenreRef[]): Promise<string[]> {
    const ids: string[] = [];
    for (const g of genres) {
      const row = await tx.genre.upsert({ where: { slug: g.slug }, update: {}, create: { slug: g.slug, name: g.name }, select: { id: true } });
      ids.push(row.id);
    }
    return ids;
  }

  // ---- contenus ----
  async getContent(id: string): Promise<ContentRecord | null> {
    const c = await this.db.content.findUnique({ where: { id }, include: contentInclude });
    return c ? toContent(c) : null;
  }

  async getContentBySlug(slug: string): Promise<ContentRecord | null> {
    const c = await this.db.content.findUnique({ where: { slug }, include: contentInclude });
    return c ? toContent(c) : null;
  }

  async createContent(c: NewContent): Promise<ContentRecord> {
    try {
      const row = await this.db.$transaction(async (tx) => {
        const langs = await this.languageIds(tx, [...c.audioLanguages, ...c.subtitleLanguages]);
        const genreIds = await this.genreIds(tx, c.genres);
        return tx.content.create({
          data: {
            type: c.type, slug: c.slug, title: c.title, description: c.description, year: c.year,
            releaseDate: c.releaseDate ? toDate(c.releaseDate) : null,
            altTitles: { create: c.altTitles.map((title) => ({ title })) },
            genres: { create: genreIds.map((genreId) => ({ genreId })) },
            audioLanguages: { create: c.audioLanguages.map((code) => ({ languageId: langs.get(code) as string })) },
            subtitleLanguages: { create: c.subtitleLanguages.map((code) => ({ languageId: langs.get(code) as string })) },
          },
          include: contentInclude,
        });
      });
      return toContent(row);
    } catch (err) {
      if (isCode(err, 'P2002')) throw new ConflictError('Slug déjà utilisé');
      throw err;
    }
  }

  async updateContent(id: string, u: ContentUpdate): Promise<ContentRecord> {
    await this.guard('Contenu', () =>
      this.db.$transaction(async (tx) => {
        await tx.content.update({
          where: { id },
          data: {
            title: u.title, description: u.description, year: u.year, status: u.status, publishedAt: u.publishedAt,
            ...(u.releaseDate !== undefined ? { releaseDate: u.releaseDate === null ? null : toDate(u.releaseDate) } : {}),
          },
        });
        if (u.removeAltTitles?.length) {
          await tx.contentAltTitle.deleteMany({
            where: { contentId: id, OR: u.removeAltTitles.map((t) => ({ title: { equals: t, mode: 'insensitive' as const } })) },
          });
        }
        if (u.addAltTitles?.length) {
          await tx.contentAltTitle.createMany({ data: u.addAltTitles.map((title) => ({ contentId: id, title })), skipDuplicates: true });
        }
        if (u.removeGenreSlugs?.length) await tx.contentGenre.deleteMany({ where: { contentId: id, genre: { slug: { in: u.removeGenreSlugs } } } });
        if (u.addGenres?.length) {
          const ids = await this.genreIds(tx, u.addGenres);
          await tx.contentGenre.createMany({ data: ids.map((genreId) => ({ contentId: id, genreId })), skipDuplicates: true });
        }
        if (u.removeAudio?.length) await tx.contentAudioLanguage.deleteMany({ where: { contentId: id, language: { code: { in: u.removeAudio } } } });
        if (u.removeSubs?.length) await tx.contentSubtitleLanguage.deleteMany({ where: { contentId: id, language: { code: { in: u.removeSubs } } } });
        if (u.addAudio?.length || u.addSubs?.length) {
          const langs = await this.languageIds(tx, [...(u.addAudio ?? []), ...(u.addSubs ?? [])]);
          if (u.addAudio?.length) {
            await tx.contentAudioLanguage.createMany({ data: u.addAudio.map((c) => ({ contentId: id, languageId: langs.get(c) as string })), skipDuplicates: true });
          }
          if (u.addSubs?.length) {
            await tx.contentSubtitleLanguage.createMany({ data: u.addSubs.map((c) => ({ contentId: id, languageId: langs.get(c) as string })), skipDuplicates: true });
          }
        }
      }),
    );
    return (await this.getContent(id)) as ContentRecord;
  }

  async listContents(f: ContentFilter, p: Paging, sort: 'new' | 'title' | 'soonest'): Promise<Page<ContentListItem>> {
    const where: Prisma.ContentWhereInput = {
      ...(f.onlyPublished ? { status: 'PUBLISHED' } : {}),
      ...(f.status ? { status: f.status } : {}),
      ...(f.type ? { type: f.type } : {}),
      ...(f.year !== undefined ? { year: f.year } : {}),
      ...(f.genreSlug ? { genres: { some: { genre: { slug: f.genreSlug } } } } : {}),
      ...(f.audio ? { audioLanguages: { some: { language: { code: f.audio } } } } : {}),
      ...(f.subtitle ? { subtitleLanguages: { some: { language: { code: f.subtitle } } } } : {}),
      ...(f.q
        ? {
            OR: [
              { title: { contains: f.q, mode: 'insensitive' as const } },
              { altTitles: { some: { title: { contains: f.q, mode: 'insensitive' as const } } } },
            ],
          }
        : {}),
    };
    if (f.releasedOnOrBefore || f.releasingAfter) {
      where.releaseDate = {
        ...(f.releasedOnOrBefore ? { lte: toDate(f.releasedOnOrBefore) } : {}),
        ...(f.releasingAfter ? { gt: toDate(f.releasingAfter) } : {}),
      };
    }
    const orderBy: Prisma.ContentOrderByWithRelationInput[] =
      sort === 'title'
        ? [{ title: 'asc' }]
        : sort === 'soonest'
          ? [{ releaseDate: { sort: 'asc', nulls: 'last' } }]
          : [{ releaseDate: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }];
    const [total, rows] = await this.db.$transaction([
      this.db.content.count({ where }),
      this.db.content.findMany({ where, orderBy, skip: (p.page - 1) * p.limit, take: p.limit, include: listInclude }),
    ]);
    return { items: rows.map(toItem), total, page: p.page, limit: p.limit };
  }

  /**
   * Recherche classée : accents ignorés (unaccent), fautes de frappe (similarité pg_trgm), titres alternatifs,
   * préfixes de mots et plein texte (tsvector maintenu par trigger). Seuls les contenus PUBLISHED sont visibles.
   */
  async searchContents(q: string, f: ContentFilter, p: Paging): Promise<Page<ContentListItem>> {
    const norm = normalizeText(q);
    if (!norm) return { items: [], total: 0, page: p.page, limit: p.limit };
    const tsq = tsPrefixQuery(q);
    const conds: Prisma.Sql[] = [Prisma.sql`c."status" = 'PUBLISHED'`];
    if (f.type) conds.push(Prisma.sql`c."type"::text = ${f.type}`);
    if (f.year !== undefined) conds.push(Prisma.sql`c."year" = ${f.year}`);
    if (f.genreSlug) conds.push(Prisma.sql`EXISTS (SELECT 1 FROM "ContentGenre" cg JOIN "Genre" g ON g."id" = cg."genreId" WHERE cg."contentId" = c."id" AND g."slug" = ${f.genreSlug})`);
    if (f.audio) conds.push(Prisma.sql`EXISTS (SELECT 1 FROM "ContentAudioLanguage" x JOIN "Language" l ON l."id" = x."languageId" WHERE x."contentId" = c."id" AND l."code" = ${f.audio})`);
    if (f.subtitle) conds.push(Prisma.sql`EXISTS (SELECT 1 FROM "ContentSubtitleLanguage" x JOIN "Language" l ON l."id" = x."languageId" WHERE x."contentId" = c."id" AND l."code" = ${f.subtitle})`);
    const rows = await this.db.$queryRaw<{ id: string; total: bigint }[]>(Prisma.sql`
      WITH s AS (
        SELECT c."id", c."releaseDate", c."searchVector" AS sv,
               trim(regexp_replace(unaccent(lower(c."title")), '[^[:alnum:]]+', ' ', 'g')) AS tn
        FROM "Content" c
        WHERE ${Prisma.join(conds, ' AND ')}
      ), scored AS (
        SELECT s."id", s."releaseDate",
          GREATEST(
            CASE WHEN s.tn = ${norm} THEN 1.0 WHEN s.tn LIKE ${`${norm}%`} THEN 0.95 ELSE 0 END,
            similarity(s.tn, ${norm}),
            COALESCE((SELECT max(similarity(trim(regexp_replace(unaccent(lower(a."title")), '[^[:alnum:]]+', ' ', 'g')), ${norm}))
                      FROM "ContentAltTitle" a WHERE a."contentId" = s."id"), 0),
            CASE WHEN to_tsvector('simple', s.tn) @@ to_tsquery('simple', ${tsq}::text) THEN 0.8 ELSE 0 END,
            CASE WHEN s.sv @@ to_tsquery('simple', ${tsq}::text) THEN 0.6 ELSE 0 END
          ) AS score
        FROM s
      )
      SELECT "id", count(*) OVER () AS total
      FROM scored
      WHERE score >= ${MIN_SIMILARITY}
      ORDER BY score DESC, "releaseDate" DESC NULLS LAST
      LIMIT ${p.limit} OFFSET ${(p.page - 1) * p.limit}`);
    const items = await this.listContentsByIds(rows.map((r) => r.id));
    return { items, total: rows[0] ? Number(rows[0].total) : 0, page: p.page, limit: p.limit };
  }

  async listContentsByIds(ids: string[]): Promise<ContentListItem[]> {
    if (!ids.length) return [];
    const rows = await this.db.content.findMany({ where: { id: { in: ids } }, include: listInclude });
    const byId = new Map(rows.map((r) => [r.id, toItem(r)]));
    return ids.flatMap((id) => (byId.has(id) ? [byId.get(id) as ContentListItem] : []));
  }

  async listNewSeasons(o: { from: string; to: string; limit: number }) {
    const rows = await this.db.season.findMany({
      where: { status: 'PUBLISHED', featuredAsNewSeason: true, releaseDate: { gte: toDate(o.from), lte: toDate(o.to) }, content: { status: 'PUBLISHED' } },
      orderBy: { releaseDate: 'desc' }, take: o.limit,
      include: { content: { include: listInclude } },
    });
    return rows.map((r) => ({ season: toSeason(r), content: toItem(r.content) }));
  }

  async getVersionChain(versionId: string): Promise<VersionChain | null> {
    const v = await this.db.videoAsset.findUnique({
      where: { id: versionId },
      include: {
        ...versionInclude,
        mediaFile: { select: { sizeBytes: true, objectKey: true } },
        content: { include: contentInclude },
        episode: { include: { season: { include: { content: { include: contentInclude } } } } },
      },
    });
    if (!v) return null;
    const content = v.content ?? v.episode?.season.content;
    if (!content) return null;
    return {
      version: toVersion(v), objectKey: v.mediaFile.objectKey, content: toContent(content),
      season: v.episode ? toSeason(v.episode.season) : null, episode: v.episode ? toEpisode(v.episode) : null,
    };
  }

  async existingLanguageCodes(codes: string[]): Promise<string[]> {
    const rows = await this.db.language.findMany({ where: { code: { in: codes }, isActive: true }, select: { code: true } });
    return rows.map((r) => r.code);
  }

  async listGenres(): Promise<GenreRef[]> {
    return this.db.genre.findMany({ orderBy: { name: 'asc' }, select: { slug: true, name: true } });
  }

  async listLanguages() {
    return this.db.language.findMany({ where: { isActive: true }, orderBy: { name: 'asc' }, select: { code: true, name: true, nativeName: true } });
  }

  // ---- saisons ----
  async createSeason(s: NewSeason): Promise<SeasonRecord> {
    try {
      return toSeason(await this.db.season.create({ data: { ...s, releaseDate: toDate(s.releaseDate) } }));
    } catch (err) {
      if (isCode(err, 'P2002')) throw new ConflictError(`La saison ${s.number} existe déjà`);
      throw err;
    }
  }
  async getSeason(id: string) {
    const s = await this.db.season.findUnique({ where: { id } });
    return s ? toSeason(s) : null;
  }
  async listSeasons(contentId: string) {
    return (await this.db.season.findMany({ where: { contentId }, orderBy: { number: 'asc' } })).map(toSeason);
  }
  async updateSeason(id: string, u: SeasonUpdate): Promise<SeasonRecord> {
    return this.guard('Saison', async () =>
      toSeason(await this.db.season.update({ where: { id }, data: { ...u, releaseDate: u.releaseDate === undefined ? undefined : toDate(u.releaseDate) } })),
    );
  }

  // ---- épisodes ----
  async createEpisode(e: NewEpisode): Promise<EpisodeRecord> {
    try {
      return toEpisode(await this.db.episode.create({ data: e }));
    } catch (err) {
      if (isCode(err, 'P2002')) throw new ConflictError(`L'épisode ${e.number} existe déjà`);
      throw err;
    }
  }
  async getEpisode(id: string) {
    const e = await this.db.episode.findUnique({ where: { id } });
    return e ? toEpisode(e) : null;
  }
  async listEpisodes(seasonId: string) {
    return (await this.db.episode.findMany({ where: { seasonId }, orderBy: { number: 'asc' } })).map(toEpisode);
  }
  async updateEpisode(id: string, u: EpisodeUpdate): Promise<EpisodeRecord> {
    return this.guard('Épisode', async () => toEpisode(await this.db.episode.update({ where: { id }, data: u })));
  }

  // ---- versions ----
  async createVersion(v: NewVersion): Promise<VersionRecord> {
    const langs = await this.languageIds(this.db, [...v.audioLanguages, ...v.embeddedSubtitles.map((s) => s.languageCode)]);
    try {
      const row = await this.db.videoAsset.create({
        data: {
          contentId: v.contentId, episodeId: v.episodeId, mediaFileId: v.mediaFileId, label: v.label, width: v.width, height: v.height,
          durationSeconds: v.durationSeconds, allowLocalShare: v.allowLocalShare,
          audioTracks: {
            create: v.audioLanguages.map((code, i) => ({ languageId: langs.get(code) as string, streamIndex: i, isDefault: i === 0, origin: 'DECLARED' as const })),
          },
          subtitleTracks: {
            create: v.embeddedSubtitles.map((s) => ({
              languageId: langs.get(s.languageCode) as string, source: 'EMBEDDED' as const, format: s.format, streamIndex: s.streamIndex, origin: 'DECLARED' as const,
            })),
          },
        },
        include: versionInclude,
      });
      return toVersion(row);
    } catch (err) {
      if (isCode(err, 'P2002')) throw new ConflictError('Ce fichier est déjà une version');
      throw err;
    }
  }
  async getVersion(id: string) {
    const v = await this.db.videoAsset.findUnique({ where: { id }, include: versionInclude });
    return v ? toVersion(v) : null;
  }
  async listVersionsForContent(contentId: string) {
    return (await this.db.videoAsset.findMany({ where: { contentId }, orderBy: { createdAt: 'asc' }, include: versionInclude })).map(toVersion);
  }
  async listVersionsForEpisode(episodeId: string) {
    return (await this.db.videoAsset.findMany({ where: { episodeId }, orderBy: { createdAt: 'asc' }, include: versionInclude })).map(toVersion);
  }
  async updateVersionStatus(id: string, status: PublicationStatusName, publishedAt: Date | null): Promise<VersionRecord> {
    return this.guard('Version', async () =>
      toVersion(await this.db.videoAsset.update({ where: { id }, data: { status, ...(publishedAt ? { publishedAt } : {}) }, include: versionInclude })),
    );
  }
  async addSubtitleTrack(versionId: string, t: NewSubtitleTrack): Promise<VersionRecord> {
    const langs = await this.languageIds(this.db, [t.languageCode]);
    await this.guard('Version', () =>
      this.db.subtitleTrack.create({
        data: {
          videoAssetId: versionId, languageId: langs.get(t.languageCode) as string, source: t.source, format: t.format,
          streamIndex: t.streamIndex, mediaFileId: t.mediaFileId, isDefault: t.isDefault, isForced: t.isForced, origin: 'DECLARED',
        },
      }),
    );
    return (await this.getVersion(versionId)) as VersionRecord;
  }
  async isMediaUsed(mediaFileId: string): Promise<boolean> {
    const [v, s, p, t] = await this.db.$transaction([
      this.db.videoAsset.count({ where: { mediaFileId } }),
      this.db.subtitleTrack.count({ where: { mediaFileId } }),
      this.db.poster.count({ where: { mediaFileId } }),
      this.db.trailer.count({ where: { mediaFileId } }),
    ]);
    return v + s + p + t > 0;
  }

  // ---- affiches ----
  async addPoster(p: NewPoster): Promise<PosterRecord> {
    return toPoster(await this.db.poster.create({ data: p, include: posterInclude }));
  }
  async getPoster(id: string) {
    const p = await this.db.poster.findUnique({ where: { id }, include: posterInclude });
    return p ? toPoster(p) : null;
  }
  async listPosters(contentId: string) {
    return (await this.db.poster.findMany({ where: { contentId }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }], include: posterInclude })).map(toPoster);
  }
  async setPrimaryPoster(contentId: string, posterId: string, at: Date): Promise<void> {
    await this.guard('Affiche', () =>
      this.db.$transaction(async (tx) => {
        const c = await tx.content.findUniqueOrThrow({ where: { id: contentId }, select: { primaryPosterId: true } });
        if (c.primaryPosterId && c.primaryPosterId !== posterId) {
          await tx.poster.update({ where: { id: c.primaryPosterId }, data: { archivedAt: at } });
        }
        await tx.poster.update({ where: { id: posterId }, data: { archivedAt: null } });
        await tx.content.update({ where: { id: contentId }, data: { primaryPosterId: posterId } });
      }),
    );
  }
  async archivePoster(id: string, at: Date) {
    await this.guard('Affiche', () => this.db.poster.update({ where: { id }, data: { archivedAt: at } }));
  }
  async restorePoster(id: string) {
    await this.guard('Affiche', () => this.db.poster.update({ where: { id }, data: { archivedAt: null } }));
  }

  // ---- bandes-annonces ----
  async addTrailer(t: NewTrailer): Promise<TrailerRecord> {
    const sortOrder = await this.db.trailer.count({ where: { contentId: t.contentId, seasonId: t.seasonId } });
    return toTrailer(await this.db.trailer.create({ data: { ...t, sortOrder }, include: trailerInclude }));
  }
  async getTrailer(id: string) {
    const t = await this.db.trailer.findUnique({ where: { id }, include: trailerInclude });
    return t ? toTrailer(t) : null;
  }
  async listTrailers(contentId: string) {
    return (await this.db.trailer.findMany({ where: { contentId }, orderBy: { sortOrder: 'asc' }, include: trailerInclude })).map(toTrailer);
  }
  async setPrimaryTrailer(trailerId: string): Promise<void> {
    await this.guard('Bande-annonce', async () => {
      const t = await this.db.trailer.findUniqueOrThrow({ where: { id: trailerId }, select: { contentId: true, seasonId: true } });
      if (t.seasonId) await this.db.season.update({ where: { id: t.seasonId }, data: { primaryTrailerId: trailerId } });
      else await this.db.content.update({ where: { id: t.contentId }, data: { primaryTrailerId: trailerId } });
    });
  }
  async archiveTrailer(id: string, at: Date) {
    await this.guard('Bande-annonce', () => this.db.trailer.update({ where: { id }, data: { archivedAt: at } }));
  }
  async restoreTrailer(id: string) {
    await this.guard('Bande-annonce', () => this.db.trailer.update({ where: { id }, data: { archivedAt: null } }));
  }
  async reorderTrailers(contentId: string, seasonId: string | null, orderedIds: string[]): Promise<void> {
    await this.db.$transaction(orderedIds.map((id, i) => this.db.trailer.updateMany({ where: { id, contentId, seasonId }, data: { sortOrder: i } })));
  }
}
