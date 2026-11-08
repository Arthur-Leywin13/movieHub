import type { Router } from '../http/router.ts';
import type { Handler } from '../http/types.ts';
import {
  asObject, has, int, intQuery, nullableInt, nullableStr, oneOf, optBool, optInt, optStr, setChange, str, strArray, uuidParam,
} from '../http/validation.ts';
import { ActorResolver, CATALOG_ROLES, requireRole } from '../auth/actor.ts';
import type { CatalogAdminService, CreateVersionInput } from './admin-service.ts';
import type { CatalogReadService } from './read-service.ts';
import { CONTENT_TYPES, PUBLICATION_STATUSES, SETTABLE_STATUSES, SUBTITLE_FORMATS, type ContentChanges } from './rules.ts';

export function registerCatalogRoutes(router: Router, deps: { admin: CatalogAdminService; read: CatalogReadService; actors: ActorResolver; onView?: (contentId: string) => void }): void {
  const { admin, read, actors } = deps;
  const on = (method: string, path: string, h: Handler): void => void router.add(method, path, h);
  const ctxOf = (req: { ip: string; requestId: string }) => ({ ip: req.ip, requestId: req.requestId });
  const editor = async (req: Parameters<Handler>[0]) => {
    const a = await actors.admin(req);
    requireRole(a, CATALOG_ROLES);
    return a;
  };
  const id = (req: Parameters<Handler>[0]): string => uuidParam(req.params['id']);

  // ================= Lecture publique =================
  on('GET', '/contents', async (req) => {
    const q = req.query;
    const type = q.get('type');
    if (type !== null && !(CONTENT_TYPES as readonly string[]).includes(type)) throw oneOf({ type }, 'type', CONTENT_TYPES);
    const sort = q.get('sort');
    if (sort !== null && sort !== 'new' && sort !== 'title') throw oneOf({ sort }, 'sort', ['new', 'title'] as const);
    const out = await read.list({
      ...(type ? { type: type as (typeof CONTENT_TYPES)[number] } : {}),
      ...(q.get('genre') ? { genre: q.get('genre') as string } : {}),
      ...(q.get('year') ? { year: intQuery(q, 'year', 0, 1888, 2100) } : {}),
      ...(q.get('audio') ? { audio: (q.get('audio') as string).toLowerCase() } : {}),
      ...(q.get('subtitle') ? { subtitle: (q.get('subtitle') as string).toLowerCase() } : {}),
      sort: (sort as 'new' | 'title' | null) ?? 'new',
      page: intQuery(q, 'page', 1, 1, 10_000),
      limit: intQuery(q, 'limit', 20, 1, 50),
    });
    return { status: 200, body: out };
  });
  on('GET', '/search', async (req) => {
    const q = (req.query.get('q') ?? '').trim();
    if (q.length < 2 || q.length > 100) throw oneOf({ q: 'x' }, 'q', ['2 à 100 caractères'] as const);
    const type = req.query.get('type');
    if (type !== null && !(CONTENT_TYPES as readonly string[]).includes(type)) throw oneOf({ type }, 'type', CONTENT_TYPES);
    const qs = req.query;
    return {
      status: 200,
      body: await read.search(q, {
        ...(type ? { type: type as (typeof CONTENT_TYPES)[number] } : {}),
        ...(qs.get('genre') ? { genre: qs.get('genre') as string } : {}),
        ...(qs.get('year') ? { year: intQuery(qs, 'year', 0, 1888, 2100) } : {}),
        ...(qs.get('audio') ? { audio: (qs.get('audio') as string).toLowerCase() } : {}),
        ...(qs.get('subtitle') ? { subtitle: (qs.get('subtitle') as string).toLowerCase() } : {}),
        page: intQuery(qs, 'page', 1, 1, 10_000),
        limit: intQuery(qs, 'limit', 20, 1, 50),
      }),
    };
  });
  on('GET', '/contents/:id', async (req) => {
    const detail = await read.detail(req.params['id'] ?? '');
    deps.onView?.(detail.id); // compteur de consultations (tendances), sans attendre ni échouer
    return { status: 200, body: detail };
  });
  on('GET', '/home', async () => ({ status: 200, body: await read.home() }));
  on('GET', '/upcoming', async (req) => ({ status: 200, body: await read.upcoming(intQuery(req.query, 'page', 1, 1, 10_000), intQuery(req.query, 'limit', 20, 1, 50)) }));
  on('GET', '/seasons/:id/episodes', async (req) => ({ status: 200, body: await read.seasonEpisodes(id(req)) }));
  on('GET', '/genres', async () => ({ status: 200, body: { genres: await read.genres() } }));
  on('GET', '/languages', async () => ({ status: 200, body: { languages: await read.languages() } }));

  // ================= Administration : contenus =================
  on('GET', '/admin/contents', async (req) => {
    await editor(req);
    const type = req.query.get('type');
    const status = req.query.get('status');
    const out = await admin.adminSearch(
      {
        ...(req.query.get('q') ? { q: req.query.get('q') as string } : {}),
        ...(type ? { type: oneOf({ type }, 'type', CONTENT_TYPES) } : {}),
        ...(status ? { status: oneOf({ status }, 'status', PUBLICATION_STATUSES) } : {}),
      },
      intQuery(req.query, 'page', 1, 1, 10_000),
      intQuery(req.query, 'limit', 20, 1, 50),
    );
    return { status: 200, body: out };
  });

  on('POST', '/admin/contents', async (req) => {
    const actor = await editor(req);
    const b = asObject(req.body);
    const created = await admin.createContent(
      actor,
      {
        type: oneOf(b, 'type', CONTENT_TYPES), title: str(b, 'title', { max: 200 }),
        ...(has(b, 'description') ? { description: nullableStr(b, 'description', { max: 5000 }) ?? null } : {}),
        ...(has(b, 'year') ? { year: nullableInt(b, 'year', { min: 1888, max: 2100 }) ?? null } : {}),
        ...(has(b, 'releaseDate') ? { releaseDate: nullableStr(b, 'releaseDate', { max: 10 }) ?? null } : {}),
        ...(strArray(b, 'altTitles', { max: 20 }) ? { altTitles: strArray(b, 'altTitles', { max: 20 }) as string[] } : {}),
        ...(strArray(b, 'genres', { max: 10 }) ? { genres: strArray(b, 'genres', { max: 10 }) as string[] } : {}),
        ...(strArray(b, 'audioLanguages', { max: 20 }) ? { audioLanguages: strArray(b, 'audioLanguages', { max: 20 }) as string[] } : {}),
        ...(strArray(b, 'subtitleLanguages', { max: 20 }) ? { subtitleLanguages: strArray(b, 'subtitleLanguages', { max: 20 }) as string[] } : {}),
      },
      ctxOf(req),
    );
    return { status: 201, body: { content: created } };
  });

  on('GET', '/admin/contents/:id', async (req) => {
    await editor(req);
    return { status: 200, body: await admin.adminDetail(id(req)) };
  });

  /** Sans `confirm: true` : résumé seulement (rien n'est modifié). Avec : application. */
  on('PATCH', '/admin/contents/:id', async (req) => {
    const actor = await editor(req);
    const b = asObject(req.body);
    const changes: ContentChanges = {
      ...(has(b, 'title') ? { title: str(b, 'title', { max: 200 }) } : {}),
      ...(has(b, 'description') ? { description: nullableStr(b, 'description', { max: 5000 }) ?? null } : {}),
      ...(has(b, 'year') ? { year: nullableInt(b, 'year', { min: 1888, max: 2100 }) ?? null } : {}),
      ...(has(b, 'releaseDate') ? { releaseDate: nullableStr(b, 'releaseDate', { max: 10 }) ?? null } : {}),
      ...(setChange(b, 'altTitles') ? { altTitles: setChange(b, 'altTitles') as NonNullable<ContentChanges['altTitles']> } : {}),
      ...(setChange(b, 'genres') ? { genres: setChange(b, 'genres') as NonNullable<ContentChanges['genres']> } : {}),
      ...(setChange(b, 'audioLanguages') ? { audioLanguages: setChange(b, 'audioLanguages') as NonNullable<ContentChanges['audioLanguages']> } : {}),
      ...(setChange(b, 'subtitleLanguages') ? { subtitleLanguages: setChange(b, 'subtitleLanguages') as NonNullable<ContentChanges['subtitleLanguages']> } : {}),
    };
    return { status: 200, body: await admin.customizeContent(actor, id(req), changes, optBool(b, 'confirm') === true, ctxOf(req)) };
  });

  on('POST', '/admin/contents/:id/status', async (req) => {
    const actor = await editor(req);
    return { status: 200, body: { content: await admin.setContentStatus(actor, id(req), oneOf(asObject(req.body), 'status', SETTABLE_STATUSES), ctxOf(req)) } };
  });

  // ================= Saisons et épisodes =================
  on('POST', '/admin/contents/:id/seasons', async (req) => {
    const actor = await editor(req);
    const b = asObject(req.body);
    const season = await admin.createSeason(
      actor, id(req),
      {
        number: int(b, 'number', { min: 0, max: 200 }), releaseDate: str(b, 'releaseDate', { max: 10 }),
        ...(has(b, 'title') ? { title: nullableStr(b, 'title', { max: 200 }) ?? null } : {}),
        ...(has(b, 'description') ? { description: nullableStr(b, 'description', { max: 5000 }) ?? null } : {}),
        ...(optBool(b, 'featuredAsNewSeason') !== undefined ? { featuredAsNewSeason: optBool(b, 'featuredAsNewSeason') as boolean } : {}),
      },
      ctxOf(req),
    );
    return { status: 201, body: { season } };
  });

  on('PATCH', '/admin/seasons/:id', async (req) => {
    const actor = await editor(req);
    const b = asObject(req.body);
    const season = await admin.updateSeason(
      actor, id(req),
      {
        ...(has(b, 'title') ? { title: nullableStr(b, 'title', { max: 200 }) ?? null } : {}),
        ...(has(b, 'description') ? { description: nullableStr(b, 'description', { max: 5000 }) ?? null } : {}),
        ...(has(b, 'releaseDate') ? { releaseDate: str(b, 'releaseDate', { max: 10 }) } : {}),
        ...(optBool(b, 'featuredAsNewSeason') !== undefined ? { featuredAsNewSeason: optBool(b, 'featuredAsNewSeason') as boolean } : {}),
      },
      ctxOf(req),
    );
    return { status: 200, body: { season } };
  });

  on('POST', '/admin/seasons/:id/status', async (req) => {
    const actor = await editor(req);
    return { status: 200, body: { season: await admin.setSeasonStatus(actor, id(req), oneOf(asObject(req.body), 'status', SETTABLE_STATUSES), ctxOf(req)) } };
  });

  on('POST', '/admin/seasons/:id/episodes', async (req) => {
    const actor = await editor(req);
    const b = asObject(req.body);
    const episode = await admin.createEpisode(
      actor, id(req),
      {
        number: int(b, 'number', { min: 1, max: 9999 }),
        ...(has(b, 'title') ? { title: nullableStr(b, 'title', { max: 200 }) ?? null } : {}),
        ...(has(b, 'description') ? { description: nullableStr(b, 'description', { max: 5000 }) ?? null } : {}),
        ...(has(b, 'durationSeconds') ? { durationSeconds: nullableInt(b, 'durationSeconds', { min: 1, max: 86_400 }) ?? null } : {}),
        ...(has(b, 'releaseNote') ? { releaseNote: nullableStr(b, 'releaseNote', { max: 2000 }) ?? null } : {}),
      },
      ctxOf(req),
    );
    return { status: 201, body: { episode } };
  });

  on('PATCH', '/admin/episodes/:id', async (req) => {
    const actor = await editor(req);
    const b = asObject(req.body);
    const episode = await admin.updateEpisode(
      actor, id(req),
      {
        ...(has(b, 'title') ? { title: nullableStr(b, 'title', { max: 200 }) ?? null } : {}),
        ...(has(b, 'description') ? { description: nullableStr(b, 'description', { max: 5000 }) ?? null } : {}),
        ...(has(b, 'durationSeconds') ? { durationSeconds: nullableInt(b, 'durationSeconds', { min: 1, max: 86_400 }) ?? null } : {}),
        ...(has(b, 'releaseNote') ? { releaseNote: nullableStr(b, 'releaseNote', { max: 2000 }) ?? null } : {}),
      },
      ctxOf(req),
    );
    return { status: 200, body: { episode } };
  });

  on('POST', '/admin/episodes/:id/status', async (req) => {
    const actor = await editor(req);
    return { status: 200, body: { episode: await admin.setEpisodeStatus(actor, id(req), oneOf(asObject(req.body), 'status', SETTABLE_STATUSES), ctxOf(req)) } };
  });

  // ================= Versions vidéo et sous-titres =================
  const versionInput = (body: unknown): CreateVersionInput => {
    const b = asObject(body);
    const embedded = b['embeddedSubtitles'];
    if (embedded !== undefined && (!Array.isArray(embedded) || embedded.length > 30)) throw oneOf({ embeddedSubtitles: 'x' }, 'embeddedSubtitles', ['liste'] as const);
    return {
      mediaFileId: uuidParam(typeof b['mediaFileId'] === 'string' ? b['mediaFileId'] : undefined, 'mediaFileId'),
      audioLanguages: strArray(b, 'audioLanguages', { max: 20 }) ?? [],
      ...(has(b, 'label') ? { label: nullableStr(b, 'label', { max: 100 }) ?? null } : {}),
      ...(optInt(b, 'width', { min: 1, max: 20_000 }) !== undefined ? { width: optInt(b, 'width', { min: 1, max: 20_000 }) as number } : {}),
      ...(optInt(b, 'height', { min: 1, max: 20_000 }) !== undefined ? { height: optInt(b, 'height', { min: 1, max: 20_000 }) as number } : {}),
      ...(optInt(b, 'durationSeconds', { min: 1, max: 86_400 }) !== undefined ? { durationSeconds: optInt(b, 'durationSeconds', { min: 1, max: 86_400 }) as number } : {}),
      ...(optBool(b, 'allowLocalShare') !== undefined ? { allowLocalShare: optBool(b, 'allowLocalShare') as boolean } : {}),
      ...(Array.isArray(embedded)
        ? {
            embeddedSubtitles: embedded.map((e) => {
              const o = asObject(e);
              return { language: str(o, 'language', { max: 12 }), format: oneOf(o, 'format', SUBTITLE_FORMATS), streamIndex: int(o, 'streamIndex', { min: 0, max: 200 }) };
            }),
          }
        : {}),
    };
  };

  on('POST', '/admin/contents/:id/versions', async (req) => {
    const actor = await editor(req);
    return { status: 201, body: await admin.addMovieVersion(actor, id(req), versionInput(req.body), ctxOf(req)) };
  });
  on('POST', '/admin/episodes/:id/versions', async (req) => {
    const actor = await editor(req);
    return { status: 201, body: await admin.addEpisodeVersion(actor, id(req), versionInput(req.body), ctxOf(req)) };
  });
  on('POST', '/admin/versions/:id/subtitles', async (req) => {
    const actor = await editor(req);
    const b = asObject(req.body);
    const version = await admin.addExternalSubtitle(
      actor, id(req),
      {
        mediaFileId: uuidParam(typeof b['mediaFileId'] === 'string' ? b['mediaFileId'] : undefined, 'mediaFileId'),
        language: str(b, 'language', { max: 12 }),
        ...(optBool(b, 'isDefault') !== undefined ? { isDefault: optBool(b, 'isDefault') as boolean } : {}),
        ...(optBool(b, 'isForced') !== undefined ? { isForced: optBool(b, 'isForced') as boolean } : {}),
      },
      ctxOf(req),
    );
    return { status: 201, body: { version } };
  });
  on('POST', '/admin/versions/:id/status', async (req) => {
    const actor = await editor(req);
    return { status: 200, body: { version: await admin.setVersionStatus(actor, id(req), oneOf(asObject(req.body), 'status', SETTABLE_STATUSES), ctxOf(req)) } };
  });

  // ================= Affiches =================
  on('POST', '/admin/contents/:id/posters', async (req) => {
    const actor = await editor(req);
    const b = asObject(req.body);
    const poster = await admin.addPoster(
      actor, id(req),
      {
        mediaFileId: uuidParam(typeof b['mediaFileId'] === 'string' ? b['mediaFileId'] : undefined, 'mediaFileId'),
        ...(b['kind'] !== undefined ? { kind: oneOf(b, 'kind', ['POSTER', 'PROMOTIONAL'] as const) } : {}),
        ...(optBool(b, 'makePrimary') !== undefined ? { makePrimary: optBool(b, 'makePrimary') as boolean } : {}),
      },
      ctxOf(req),
    );
    return { status: 201, body: { poster } };
  });
  on('POST', '/admin/posters/:id/primary', async (req) => {
    const actor = await editor(req);
    return { status: 200, body: { poster: await admin.setPrimaryPoster(actor, id(req), ctxOf(req)) } };
  });
  on('POST', '/admin/posters/:id/archive', async (req) => {
    const actor = await editor(req);
    await admin.archivePoster(actor, id(req), ctxOf(req));
    return { status: 204 };
  });
  on('POST', '/admin/posters/:id/restore', async (req) => {
    const actor = await editor(req);
    await admin.restorePoster(actor, id(req), ctxOf(req));
    return { status: 204 };
  });

  // ================= Bandes-annonces =================
  on('POST', '/admin/contents/:id/trailers', async (req) => {
    const actor = await editor(req);
    const b = asObject(req.body);
    const trailer = await admin.addTrailer(
      actor, id(req),
      {
        ...(b['seasonId'] !== undefined && b['seasonId'] !== null ? { seasonId: uuidParam(typeof b['seasonId'] === 'string' ? b['seasonId'] : undefined, 'seasonId') } : {}),
        ...(has(b, 'title') ? { title: nullableStr(b, 'title', { max: 200 }) ?? null } : {}),
        ...(b['mediaFileId'] !== undefined ? { mediaFileId: uuidParam(typeof b['mediaFileId'] === 'string' ? b['mediaFileId'] : undefined, 'mediaFileId') } : {}),
        ...(optStr(b, 'externalUrl', { max: 500 }) !== undefined ? { externalUrl: optStr(b, 'externalUrl', { max: 500 }) as string } : {}),
        ...(optBool(b, 'makePrimary') !== undefined ? { makePrimary: optBool(b, 'makePrimary') as boolean } : {}),
      },
      ctxOf(req),
    );
    return { status: 201, body: { trailer } };
  });
  on('POST', '/admin/contents/:id/trailers/reorder', async (req) => {
    const actor = await editor(req);
    const b = asObject(req.body);
    const ids = (strArray(b, 'ids', { max: 100 }) ?? []).map((x) => uuidParam(x, 'ids'));
    const seasonId = b['seasonId'] === undefined || b['seasonId'] === null ? null : uuidParam(typeof b['seasonId'] === 'string' ? b['seasonId'] : undefined, 'seasonId');
    await admin.reorderTrailers(actor, id(req), seasonId, ids, ctxOf(req));
    return { status: 204 };
  });
  for (const [action, fn] of [['primary', 'setPrimaryTrailer'], ['archive', 'archiveTrailer'], ['restore', 'restoreTrailer']] as const) {
    on('POST', `/admin/trailers/:id/${action}`, async (req) => {
      const actor = await editor(req);
      await admin[fn](actor, id(req), ctxOf(req));
      return { status: 204 };
    });
  }
}
