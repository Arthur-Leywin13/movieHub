import type { ActorResolver } from '../auth/actor.ts';
import type { Router } from '../http/router.ts';
import type { Handler, HttpRequest } from '../http/types.ts';
import { ValidationError } from '@movieshub/shared';
import { asObject, int, intQuery, oneOf, optBool, optInt, optStr, str, uuidParam } from '../http/validation.ts';
import type { Settings } from './ports.ts';
import type { UserDataService } from './service.ts';

const optUuid = (b: Record<string, unknown>, field: string): string | undefined =>
  b[field] === undefined ? undefined : uuidParam(typeof b[field] === 'string' ? (b[field] as string) : undefined, field);

/** Routes « utilisateur connecté » : favoris, suivi, historique, réglages, recherches récentes, téléchargements. */
export function registerUserRoutes(router: Router, deps: { users: UserDataService; actors: ActorResolver }): void {
  const { users, actors } = deps;
  const on = (method: string, path: string, h: Handler): void => void router.add(method, path, h);
  const me = async (req: HttpRequest): Promise<string> => (await actors.user(req)).userId;
  const paging = (req: HttpRequest) => ({ page: intQuery(req.query, 'page', 1, 1, 10_000), limit: intQuery(req.query, 'limit', 20, 1, 50) });
  const id = (req: HttpRequest): string => uuidParam(req.params['id']);

  // ---- favoris ----
  on('GET', '/me/favorites', async (req) => ({ status: 200, body: await users.favorites(await me(req), paging(req)) }));
  on('PUT', '/me/favorites/:id', async (req) => {
    await users.addFavorite(await me(req), id(req));
    return { status: 204 };
  });
  on('DELETE', '/me/favorites/:id', async (req) => {
    await users.removeFavorite(await me(req), id(req));
    return { status: 204 };
  });

  // ---- suivi des séries et animés (notifications par série) ----
  on('GET', '/me/follows', async (req) => ({ status: 200, body: await users.follows(await me(req), paging(req)) }));
  on('PUT', '/me/follows/:id', async (req) => {
    const userId = await me(req);
    const b = req.body === undefined ? {} : asObject(req.body);
    const flags = {
      ...(optBool(b, 'notifyNewEpisodes') !== undefined ? { notifyNewEpisodes: optBool(b, 'notifyNewEpisodes') as boolean } : {}),
      ...(optBool(b, 'notifyNewSeasons') !== undefined ? { notifyNewSeasons: optBool(b, 'notifyNewSeasons') as boolean } : {}),
    };
    return { status: 200, body: { follow: await users.follow(userId, id(req), flags) } };
  });
  on('DELETE', '/me/follows/:id', async (req) => {
    await users.unfollow(await me(req), id(req));
    return { status: 204 };
  });

  // ---- historique de visionnage ----
  on('GET', '/me/history', async (req) => ({ status: 200, body: await users.history(await me(req), paging(req)) }));
  on('PUT', '/me/history', async (req) => {
    const userId = await me(req);
    const b = asObject(req.body);
    const contentId = optUuid(b, 'contentId');
    const episodeId = optUuid(b, 'episodeId');
    const versionId = optUuid(b, 'versionId');
    const durationSeconds = optInt(b, 'durationSeconds', { min: 1, max: 604_800 });
    const completed = optBool(b, 'completed');
    const out = await users.recordHistory(userId, {
      ...(contentId ? { contentId } : {}), ...(episodeId ? { episodeId } : {}), ...(versionId ? { versionId } : {}),
      positionSeconds: int(b, 'positionSeconds', { min: 0, max: 604_800 }),
      ...(durationSeconds !== undefined ? { durationSeconds } : {}), ...(completed !== undefined ? { completed } : {}),
    });
    return { status: 200, body: out };
  });
  on('DELETE', '/me/history/:id', async (req) => {
    await users.deleteHistory(await me(req), id(req));
    return { status: 204 };
  });
  on('DELETE', '/me/history', async (req) => {
    await users.clearHistory(await me(req));
    return { status: 204 };
  });

  // ---- réglages ----
  on('GET', '/me/settings', async (req) => ({ status: 200, body: { settings: await users.settings(await me(req)) } }));
  on('PATCH', '/me/settings', async (req) => {
    const userId = await me(req);
    const b = asObject(req.body);
    const patch: Partial<Settings> = {};
    if (b['locale'] !== undefined) {
      const l = str(b, 'locale', { max: 10 });
      if (!/^[a-z]{2}(-[A-Z]{2})?$/.test(l)) throw new ValidationError('Langue invalide (ex. fr, en, pt-BR)', { field: 'locale' });
      patch.locale = l;
    }
    for (const k of ['notificationsEnabled', 'historySyncEnabled', 'adSoundEnabled'] as const) {
      const v = optBool(b, k);
      if (v !== undefined) patch[k] = v;
    }
    if (Object.keys(patch).length === 0) throw new ValidationError('Aucun réglage à modifier');
    return { status: 200, body: { settings: await users.updateSettings(userId, patch) } };
  });

  // ---- recherches récentes ----
  on('GET', '/me/search-history', async (req) => ({ status: 200, body: { queries: await users.searches(await me(req)) } }));
  on('POST', '/me/search-history', async (req) => {
    await users.addSearch(await me(req), str(asObject(req.body), 'query', { max: 100 }));
    return { status: 204 };
  });
  on('DELETE', '/me/search-history', async (req) => {
    await users.clearSearches(await me(req));
    return { status: 204 };
  });

  // ---- téléchargements ----
  on('POST', '/versions/:id/download', async (req) => ({
    status: 200,
    body: await users.startDownload(await me(req), id(req), { appVersion: req.headers['x-app-version'] ?? null }),
  }));
  on('POST', '/downloads/:id/status', async (req) => {
    const userId = await me(req);
    const b = asObject(req.body);
    const d = await users.finishDownload(userId, id(req), oneOf(b, 'status', ['COMPLETED', 'FAILED', 'CANCELED'] as const), optStr(b, 'failureReason', { max: 200 }) ?? null);
    return { status: 200, body: { download: { id: d.id, status: d.status, completedAt: d.completedAt } } };
  });
}
