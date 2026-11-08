import { ConflictError, NotFoundError, ValidationError, buildContentSlug } from '@movieshub/shared';
import type { AdminActor } from '../auth/actor.ts';
import type { AuditRepo, MediaFileRecord, MediaFileRepo } from '../ports.ts';
import type {
  CatalogRepo, ContentRecord, ContentUpdate, EpisodeRecord, PosterRecord, SeasonRecord, TrailerRecord, VersionRecord,
} from './ports.ts';
import {
  CONTENT_TYPES, assertDate, assertHttpsUrl, assertTransition, dedupeTexts, genreSlug, normalizeCodes, subtitleFormatFromKey,
  summarizeContentChanges, type ChangeLine, type ContentChanges, type ContentTypeName, type PublicationStatusName, type SubtitleFormatName,
} from './rules.ts';

export interface Ctx {
  ip: string;
  requestId: string;
}

export interface CreateContentInput {
  type: ContentTypeName;
  title: string;
  description?: string | null;
  year?: number | null;
  releaseDate?: string | null;
  altTitles?: string[];
  genres?: string[];
  audioLanguages?: string[];
  subtitleLanguages?: string[];
}

export interface CreateVersionInput {
  mediaFileId: string;
  label?: string | null;
  width?: number | null;
  height?: number | null;
  durationSeconds?: number | null;
  allowLocalShare?: boolean;
  audioLanguages: string[];
  embeddedSubtitles?: { language: string; format: SubtitleFormatName; streamIndex: number }[];
}

const MAX_GENRES = 10;
const MAX_ALT_TITLES = 20;

export class CatalogAdminService {
  private readonly repo: CatalogRepo;
  private readonly media: MediaFileRepo;
  private readonly audit: AuditRepo;
  private readonly now: () => Date;

  constructor(deps: { repo: CatalogRepo; media: MediaFileRepo; audit: AuditRepo; now?: () => Date }) {
    this.repo = deps.repo;
    this.media = deps.media;
    this.audit = deps.audit;
    this.now = deps.now ?? (() => new Date());
  }

  private async log(a: AdminActor, c: Ctx, action: string, entityType: string, entityId: string, oldValues: unknown, newValues: unknown): Promise<void> {
    await this.audit.log({
      source: a.via === 'bot' ? 'TELEGRAM_BOT' : 'DASHBOARD', adminId: a.adminId, action, entityType, entityId,
      oldValues, newValues, result: 'SUCCESS', ipAddress: c.ip, requestId: c.requestId,
    });
  }

  // ---------- accès ----------
  private async content(id: string): Promise<ContentRecord> {
    const c = await this.repo.getContent(id);
    if (!c) throw new NotFoundError('Contenu introuvable');
    return c;
  }
  private async season(id: string): Promise<SeasonRecord> {
    const s = await this.repo.getSeason(id);
    if (!s) throw new NotFoundError('Saison introuvable');
    return s;
  }
  private async episode(id: string): Promise<EpisodeRecord> {
    const e = await this.repo.getEpisode(id);
    if (!e) throw new NotFoundError('Épisode introuvable');
    return e;
  }
  private async version(id: string): Promise<VersionRecord> {
    const v = await this.repo.getVersion(id);
    if (!v) throw new NotFoundError('Version introuvable');
    return v;
  }

  /** Fichier R2 prêt, du bon type, et jamais déjà utilisé ailleurs dans le catalogue. */
  private async freeMedia(id: string, kinds: readonly MediaFileRecord['kind'][], field: string): Promise<MediaFileRecord> {
    const m = await this.media.findById(id);
    if (!m || m.status === 'DELETED') throw new NotFoundError('Fichier introuvable');
    if (m.status !== 'READY') throw new ConflictError('Le fichier n’est pas prêt : terminez d’abord son envoi', { field });
    if (!kinds.includes(m.kind)) throw new ValidationError(`Type de fichier incorrect (attendu : ${kinds.join(' ou ')})`, { field });
    if (await this.repo.isMediaUsed(id)) throw new ConflictError('Ce fichier est déjà utilisé dans le catalogue', { field });
    return m;
  }

  private async assertLanguages(codes: string[], field: string): Promise<void> {
    const known = new Set(await this.repo.existingLanguageCodes(codes));
    const unknown = codes.filter((c) => !known.has(c));
    if (unknown.length) throw new ValidationError(`Langue(s) inconnue(s) : ${unknown.join(', ')}`, { field, unknown });
  }

  // ---------- contenus ----------
  /** Slug stable (titre + année) ; une collision avec le même type est un doublon. */
  private async uniqueSlug(type: ContentTypeName, title: string, year: number | null): Promise<string> {
    const base = buildContentSlug(title, year);
    const clash = await this.repo.getContentBySlug(base);
    if (!clash) return base;
    if (clash.type === type) {
      throw new ConflictError('Ce contenu existe déjà', { existing: { id: clash.id, title: clash.title, year: clash.year, status: clash.status } });
    }
    const typed = `${base}-${type.toLowerCase()}`;
    if (await this.repo.getContentBySlug(typed)) throw new ConflictError('Ce contenu existe déjà', { existing: { slug: typed } });
    return typed;
  }

  async createContent(actor: AdminActor, input: CreateContentInput, ctx: Ctx): Promise<ContentRecord> {
    if (!CONTENT_TYPES.includes(input.type)) throw new ValidationError('Type invalide', { field: 'type' });
    const year = input.year ?? null;
    if (year !== null && (year < 1888 || year > 2100)) throw new ValidationError('Année invalide', { field: 'year' });
    if (input.releaseDate) assertDate(input.releaseDate, 'releaseDate');
    const genres = dedupeTexts(input.genres ?? []).map((name) => ({ name, slug: genreSlug(name) }));
    if (genres.some((g) => !g.slug)) throw new ValidationError('Nom de genre invalide', { field: 'genres' });
    if (genres.length > MAX_GENRES) throw new ValidationError(`Maximum ${MAX_GENRES} genres`, { field: 'genres' });
    const altTitles = dedupeTexts(input.altTitles ?? []).filter((t) => t.toLowerCase() !== input.title.trim().toLowerCase());
    if (altTitles.length > MAX_ALT_TITLES) throw new ValidationError(`Maximum ${MAX_ALT_TITLES} titres alternatifs`, { field: 'altTitles' });
    const audio = normalizeCodes(input.audioLanguages ?? [], 'audioLanguages');
    const subs = normalizeCodes(input.subtitleLanguages ?? [], 'subtitleLanguages');
    await this.assertLanguages([...new Set([...audio, ...subs])], 'languages');

    const slug = await this.uniqueSlug(input.type, input.title.trim(), year);
    const created = await this.repo.createContent({
      type: input.type, slug, title: input.title.trim(), description: input.description?.trim() || null, year,
      releaseDate: input.releaseDate ?? null, altTitles, genres, audioLanguages: audio, subtitleLanguages: subs,
    });
    await this.log(actor, ctx, 'content.create', 'Content', created.id, null, { type: created.type, slug: created.slug, title: created.title });
    return created;
  }

  /**
   * « Personnaliser un contenu » : sans `confirm`, renvoie seulement le résumé des changements ;
   * avec `confirm`, les applique. Aucune saison, épisode ni fichier n'est jamais touché ici.
   */
  async customizeContent(actor: AdminActor, id: string, changes: ContentChanges, confirm: boolean, ctx: Ctx): Promise<{ applied: boolean; summary: ChangeLine[]; content: ContentRecord }> {
    const before = await this.content(id);
    if (before.status === 'WITHDRAWN') throw new ConflictError('Contenu retiré : modification impossible');
    if (changes.releaseDate) assertDate(changes.releaseDate, 'releaseDate');
    if (changes.year !== undefined && changes.year !== null && (changes.year < 1888 || changes.year > 2100)) throw new ValidationError('Année invalide', { field: 'year' });

    const norm: ContentChanges = { ...changes };
    if (changes.altTitles) norm.altTitles = { add: dedupeTexts(changes.altTitles.add ?? []), remove: dedupeTexts(changes.altTitles.remove ?? []) };
    if (changes.genres) norm.genres = { add: dedupeTexts(changes.genres.add ?? []), remove: dedupeTexts(changes.genres.remove ?? []) };
    if (changes.audioLanguages) norm.audioLanguages = { add: normalizeCodes(changes.audioLanguages.add ?? [], 'audioLanguages'), remove: normalizeCodes(changes.audioLanguages.remove ?? [], 'audioLanguages') };
    if (changes.subtitleLanguages) norm.subtitleLanguages = { add: normalizeCodes(changes.subtitleLanguages.add ?? [], 'subtitleLanguages'), remove: normalizeCodes(changes.subtitleLanguages.remove ?? [], 'subtitleLanguages') };
    await this.assertLanguages([...(norm.audioLanguages?.add ?? []), ...(norm.subtitleLanguages?.add ?? [])], 'languages');

    const summary = summarizeContentChanges(before, norm);
    if (!confirm || summary.length === 0) return { applied: false, summary, content: before };

    const nextGenres = (before.genres.length - (norm.genres?.remove ?? []).length) + (norm.genres?.add ?? []).length;
    if (nextGenres > MAX_GENRES) throw new ValidationError(`Maximum ${MAX_GENRES} genres`, { field: 'genres' });

    const update: ContentUpdate = {
      ...(norm.title !== undefined ? { title: norm.title.trim() } : {}),
      ...(norm.description !== undefined ? { description: norm.description?.trim() || null } : {}),
      ...(norm.year !== undefined ? { year: norm.year } : {}),
      ...(norm.releaseDate !== undefined ? { releaseDate: norm.releaseDate } : {}),
      ...(norm.altTitles ? { addAltTitles: norm.altTitles.add, removeAltTitles: norm.altTitles.remove } : {}),
      ...(norm.genres ? { addGenres: (norm.genres.add ?? []).map((name) => ({ name, slug: genreSlug(name) })), removeGenreSlugs: (norm.genres.remove ?? []).map(genreSlug) } : {}),
      ...(norm.audioLanguages ? { addAudio: norm.audioLanguages.add, removeAudio: norm.audioLanguages.remove } : {}),
      ...(norm.subtitleLanguages ? { addSubs: norm.subtitleLanguages.add, removeSubs: norm.subtitleLanguages.remove } : {}),
    };
    const content = await this.repo.updateContent(id, update);
    await this.log(actor, ctx, 'content.update', 'Content', id, Object.fromEntries(summary.map((l) => [l.field, l.from])), Object.fromEntries(summary.map((l) => [l.field, l.to])));
    return { applied: true, summary, content };
  }

  async setContentStatus(actor: AdminActor, id: string, status: PublicationStatusName, ctx: Ctx): Promise<ContentRecord> {
    const c = await this.content(id);
    assertTransition(c.status, status);
    const updated = await this.repo.updateContent(id, { status, ...(status === 'PUBLISHED' ? { publishedAt: this.now() } : {}) });
    await this.log(actor, ctx, 'content.status', 'Content', id, { status: c.status }, { status });
    return updated;
  }

  // ---------- saisons et épisodes ----------
  async createSeason(actor: AdminActor, contentId: string, input: { number: number; title?: string | null; description?: string | null; releaseDate: string; featuredAsNewSeason?: boolean }, ctx: Ctx): Promise<SeasonRecord> {
    const c = await this.content(contentId);
    if (c.type === 'MOVIE') throw new ConflictError('Un film n’a pas de saisons');
    if (c.status === 'WITHDRAWN') throw new ConflictError('Contenu retiré');
    assertDate(input.releaseDate, 'releaseDate');
    const s = await this.repo.createSeason({
      contentId, number: input.number, title: input.title?.trim() || null, description: input.description?.trim() || null,
      releaseDate: input.releaseDate, featuredAsNewSeason: input.featuredAsNewSeason ?? false,
    });
    await this.log(actor, ctx, 'season.create', 'Season', s.id, null, { contentId, number: s.number, releaseDate: s.releaseDate });
    return s;
  }

  async updateSeason(actor: AdminActor, id: string, patch: { title?: string | null; description?: string | null; releaseDate?: string; featuredAsNewSeason?: boolean }, ctx: Ctx): Promise<SeasonRecord> {
    const before = await this.season(id);
    if (patch.releaseDate) assertDate(patch.releaseDate, 'releaseDate');
    const s = await this.repo.updateSeason(id, patch);
    await this.log(actor, ctx, 'season.update', 'Season', id, { releaseDate: before.releaseDate, featuredAsNewSeason: before.featuredAsNewSeason, title: before.title }, patch);
    return s;
  }

  async setSeasonStatus(actor: AdminActor, id: string, status: PublicationStatusName, ctx: Ctx): Promise<SeasonRecord> {
    const s = await this.season(id);
    assertTransition(s.status, status);
    const out = await this.repo.updateSeason(id, { status, ...(status === 'PUBLISHED' ? { publishedAt: this.now() } : {}) });
    await this.log(actor, ctx, 'season.status', 'Season', id, { status: s.status }, { status });
    return out;
  }

  async createEpisode(actor: AdminActor, seasonId: string, input: { number: number; title?: string | null; description?: string | null; durationSeconds?: number | null; releaseNote?: string | null }, ctx: Ctx): Promise<EpisodeRecord> {
    await this.season(seasonId);
    const e = await this.repo.createEpisode({
      seasonId, number: input.number, title: input.title?.trim() || null, description: input.description?.trim() || null,
      durationSeconds: input.durationSeconds ?? null, releaseNote: input.releaseNote?.trim() || null,
    });
    await this.log(actor, ctx, 'episode.create', 'Episode', e.id, null, { seasonId, number: e.number });
    return e;
  }

  async updateEpisode(actor: AdminActor, id: string, patch: { title?: string | null; description?: string | null; durationSeconds?: number | null; releaseNote?: string | null }, ctx: Ctx): Promise<EpisodeRecord> {
    const before = await this.episode(id);
    const e = await this.repo.updateEpisode(id, patch);
    await this.log(actor, ctx, 'episode.update', 'Episode', id, { title: before.title, releaseNote: before.releaseNote }, patch);
    return e;
  }

  async setEpisodeStatus(actor: AdminActor, id: string, status: PublicationStatusName, ctx: Ctx): Promise<EpisodeRecord> {
    const e = await this.episode(id);
    assertTransition(e.status, status);
    const out = await this.repo.updateEpisode(id, { status, ...(status === 'PUBLISHED' ? { publishedAt: this.now() } : {}) });
    await this.log(actor, ctx, 'episode.status', 'Episode', id, { status: e.status }, { status });
    return out;
  }

  // ---------- versions vidéo (une langue = une version, jamais de remplacement) ----------
  private async buildVersion(input: CreateVersionInput, target: { contentId: string | null; episodeId: string | null }): Promise<{ version: VersionRecord; warnings: string[]; audio: string[]; subs: string[] }> {
    await this.freeMedia(input.mediaFileId, ['VIDEO'], 'mediaFileId');
    const audio = normalizeCodes(input.audioLanguages, 'audioLanguages');
    if (audio.length === 0) throw new ValidationError('Au moins une piste audio est requise', { field: 'audioLanguages' });
    const embedded = (input.embeddedSubtitles ?? []).map((s) => ({ languageCode: normalizeCodes([s.language], 'embeddedSubtitles')[0] as string, format: s.format, streamIndex: s.streamIndex }));
    const subs = [...new Set(embedded.map((s) => s.languageCode))];
    await this.assertLanguages([...new Set([...audio, ...subs])], 'languages');
    const version = await this.repo.createVersion({
      ...target, mediaFileId: input.mediaFileId, label: input.label?.trim() || null, width: input.width ?? null, height: input.height ?? null,
      durationSeconds: input.durationSeconds ?? null, allowLocalShare: input.allowLocalShare ?? false, audioLanguages: audio, embeddedSubtitles: embedded,
    });
    return { version, warnings: [], audio, subs };
  }

  /** Avertit (sans bloquer) si la version apporte des langues non annoncées au niveau du contenu. */
  private announceWarnings(content: ContentRecord, audio: string[], subs: string[]): string[] {
    const w: string[] = [];
    const a = audio.filter((l) => !content.audioLanguages.includes(l));
    const s = subs.filter((l) => !content.subtitleLanguages.includes(l));
    if (a.length) w.push(`Langues audio non annoncées dans la fiche : ${a.join(', ')}`);
    if (s.length) w.push(`Sous-titres non annoncés dans la fiche : ${s.join(', ')}`);
    return w;
  }

  async addMovieVersion(actor: AdminActor, contentId: string, input: CreateVersionInput, ctx: Ctx): Promise<{ version: VersionRecord; warnings: string[] }> {
    const c = await this.content(contentId);
    if (c.type !== 'MOVIE') throw new ConflictError('Les versions des séries et animés se rattachent aux épisodes');
    if (c.status === 'WITHDRAWN') throw new ConflictError('Contenu retiré');
    const { version, audio, subs } = await this.buildVersion(input, { contentId, episodeId: null });
    await this.log(actor, ctx, 'version.create', 'VideoAsset', version.id, null, { contentId, audio, label: version.label });
    return { version, warnings: this.announceWarnings(c, audio, subs) };
  }

  async addEpisodeVersion(actor: AdminActor, episodeId: string, input: CreateVersionInput, ctx: Ctx): Promise<{ version: VersionRecord; warnings: string[] }> {
    const e = await this.episode(episodeId);
    const season = await this.season(e.seasonId);
    const c = await this.content(season.contentId);
    if (c.status === 'WITHDRAWN') throw new ConflictError('Contenu retiré');
    const { version, audio, subs } = await this.buildVersion(input, { contentId: null, episodeId });
    await this.log(actor, ctx, 'version.create', 'VideoAsset', version.id, null, { episodeId, audio, label: version.label });
    return { version, warnings: this.announceWarnings(c, audio, subs) };
  }

  async addExternalSubtitle(actor: AdminActor, versionId: string, input: { mediaFileId: string; language: string; isDefault?: boolean; isForced?: boolean }, ctx: Ctx): Promise<VersionRecord> {
    await this.version(versionId);
    const media = await this.freeMedia(input.mediaFileId, ['SUBTITLE'], 'mediaFileId');
    const [code] = normalizeCodes([input.language], 'language');
    await this.assertLanguages([code as string], 'language');
    const v = await this.repo.addSubtitleTrack(versionId, {
      languageCode: code as string, source: 'EXTERNAL', format: subtitleFormatFromKey(media.objectKey), streamIndex: null,
      mediaFileId: media.id, isDefault: input.isDefault ?? false, isForced: input.isForced ?? false,
    });
    await this.log(actor, ctx, 'subtitle.add', 'VideoAsset', versionId, null, { language: code, mediaFileId: media.id });
    return v;
  }

  async setVersionStatus(actor: AdminActor, id: string, status: PublicationStatusName, ctx: Ctx): Promise<VersionRecord> {
    const v = await this.version(id);
    assertTransition(v.status, status);
    const out = await this.repo.updateVersionStatus(id, status, status === 'PUBLISHED' ? this.now() : null);
    await this.log(actor, ctx, 'version.status', 'VideoAsset', id, { status: v.status }, { status });
    return out;
  }

  // ---------- affiches (jamais supprimées : archivées, restaurables) ----------
  async addPoster(actor: AdminActor, contentId: string, input: { mediaFileId: string; kind?: 'POSTER' | 'PROMOTIONAL'; makePrimary?: boolean }, ctx: Ctx): Promise<PosterRecord> {
    const c = await this.content(contentId);
    await this.freeMedia(input.mediaFileId, ['IMAGE'], 'mediaFileId');
    const kind = input.kind ?? 'POSTER';
    const poster = await this.repo.addPoster({ contentId, mediaFileId: input.mediaFileId, kind });
    const makePrimary = input.makePrimary === true || (kind === 'POSTER' && c.primaryPosterId === null);
    if (makePrimary) {
      if (kind !== 'POSTER') throw new ValidationError('Seule une affiche (pas une image promotionnelle) peut être principale', { field: 'kind' });
      await this.repo.setPrimaryPoster(contentId, poster.id, this.now());
    }
    await this.log(actor, ctx, 'poster.add', 'Poster', poster.id, null, { contentId, kind, primary: makePrimary });
    return (await this.repo.getPoster(poster.id)) as PosterRecord;
  }

  async setPrimaryPoster(actor: AdminActor, posterId: string, ctx: Ctx): Promise<PosterRecord> {
    const p = await this.repo.getPoster(posterId);
    if (!p) throw new NotFoundError('Affiche introuvable');
    if (p.kind !== 'POSTER') throw new ValidationError('Seule une affiche peut être principale');
    const c = await this.content(p.contentId);
    await this.repo.setPrimaryPoster(p.contentId, p.id, this.now());
    await this.log(actor, ctx, 'poster.primary', 'Poster', p.id, { previousPrimary: c.primaryPosterId }, { primary: p.id });
    return (await this.repo.getPoster(p.id)) as PosterRecord;
  }

  async archivePoster(actor: AdminActor, posterId: string, ctx: Ctx): Promise<void> {
    const p = await this.repo.getPoster(posterId);
    if (!p) throw new NotFoundError('Affiche introuvable');
    const c = await this.content(p.contentId);
    if (c.primaryPosterId === p.id) throw new ConflictError('C’est l’affiche principale : choisissez d’abord une autre affiche principale');
    await this.repo.archivePoster(p.id, this.now());
    await this.log(actor, ctx, 'poster.archive', 'Poster', p.id, null, {});
  }

  async restorePoster(actor: AdminActor, posterId: string, ctx: Ctx): Promise<void> {
    const p = await this.repo.getPoster(posterId);
    if (!p) throw new NotFoundError('Affiche introuvable');
    await this.repo.restorePoster(p.id);
    await this.log(actor, ctx, 'poster.restore', 'Poster', p.id, null, {});
  }

  // ---------- bandes-annonces ----------
  async addTrailer(actor: AdminActor, contentId: string, input: { seasonId?: string | null; title?: string | null; mediaFileId?: string | null; externalUrl?: string | null; makePrimary?: boolean }, ctx: Ctx): Promise<TrailerRecord> {
    const c = await this.content(contentId);
    if (!input.mediaFileId === !input.externalUrl) throw new ValidationError('Indiquez soit un fichier (mediaFileId), soit un lien (externalUrl)');
    if (input.seasonId) {
      const s = await this.season(input.seasonId);
      if (s.contentId !== contentId) throw new ValidationError('Cette saison n’appartient pas à ce contenu', { field: 'seasonId' });
    }
    if (input.mediaFileId) await this.freeMedia(input.mediaFileId, ['TRAILER_VIDEO'], 'mediaFileId');
    if (input.externalUrl) assertHttpsUrl(input.externalUrl, 'externalUrl');
    const t = await this.repo.addTrailer({ contentId, seasonId: input.seasonId ?? null, title: input.title?.trim() || null, mediaFileId: input.mediaFileId ?? null, externalUrl: input.externalUrl ?? null });
    const hasPrimary = t.seasonId ? (await this.season(t.seasonId)).primaryTrailerId !== null : c.primaryTrailerId !== null;
    if (input.makePrimary === true || !hasPrimary) await this.repo.setPrimaryTrailer(t.id);
    await this.log(actor, ctx, 'trailer.add', 'Trailer', t.id, null, { contentId, seasonId: t.seasonId });
    return (await this.repo.getTrailer(t.id)) as TrailerRecord;
  }

  async setPrimaryTrailer(actor: AdminActor, trailerId: string, ctx: Ctx): Promise<void> {
    const t = await this.repo.getTrailer(trailerId);
    if (!t) throw new NotFoundError('Bande-annonce introuvable');
    if (t.archivedAt) throw new ConflictError('Bande-annonce archivée : restaurez-la d’abord');
    await this.repo.setPrimaryTrailer(t.id);
    await this.log(actor, ctx, 'trailer.primary', 'Trailer', t.id, null, { seasonId: t.seasonId });
  }

  async archiveTrailer(actor: AdminActor, trailerId: string, ctx: Ctx): Promise<void> {
    const t = await this.repo.getTrailer(trailerId);
    if (!t) throw new NotFoundError('Bande-annonce introuvable');
    const primaryId = t.seasonId ? (await this.season(t.seasonId)).primaryTrailerId : (await this.content(t.contentId)).primaryTrailerId;
    if (primaryId === t.id) throw new ConflictError('C’est la bande-annonce principale : choisissez d’abord une autre principale');
    await this.repo.archiveTrailer(t.id, this.now());
    await this.log(actor, ctx, 'trailer.archive', 'Trailer', t.id, null, {});
  }

  async restoreTrailer(actor: AdminActor, trailerId: string, ctx: Ctx): Promise<void> {
    if (!(await this.repo.getTrailer(trailerId))) throw new NotFoundError('Bande-annonce introuvable');
    await this.repo.restoreTrailer(trailerId);
    await this.log(actor, ctx, 'trailer.restore', 'Trailer', trailerId, null, {});
  }

  async reorderTrailers(actor: AdminActor, contentId: string, seasonId: string | null, orderedIds: string[], ctx: Ctx): Promise<void> {
    await this.content(contentId);
    const existing = (await this.repo.listTrailers(contentId)).filter((t) => t.seasonId === seasonId);
    const ids = new Set(existing.map((t) => t.id));
    if (orderedIds.length !== ids.size || new Set(orderedIds).size !== orderedIds.length || orderedIds.some((id) => !ids.has(id))) {
      throw new ValidationError('La liste doit contenir exactement les bandes-annonces de ce périmètre, une seule fois chacune', { field: 'ids' });
    }
    await this.repo.reorderTrailers(contentId, seasonId, orderedIds);
    await this.log(actor, ctx, 'trailer.reorder', 'Content', contentId, null, { seasonId, orderedIds });
  }

  // ---------- vue d'administration complète ----------
  async adminDetail(id: string) {
    const content = await this.content(id);
    const seasons = await this.repo.listSeasons(id);
    return {
      content,
      posters: await this.repo.listPosters(id),
      trailers: await this.repo.listTrailers(id),
      versions: await this.repo.listVersionsForContent(id),
      seasons: await Promise.all(
        seasons.map(async (s) => ({
          season: s,
          episodes: await Promise.all(
            (await this.repo.listEpisodes(s.id)).map(async (e) => ({ episode: e, versions: await this.repo.listVersionsForEpisode(e.id) })),
          ),
        })),
      ),
    };
  }

  async adminSearch(filter: { q?: string; type?: ContentTypeName; status?: PublicationStatusName }, page: number, limit: number) {
    return this.repo.listContents({ onlyPublished: false, ...filter }, { page, limit }, 'title');
  }
}
