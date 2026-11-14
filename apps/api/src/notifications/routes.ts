import { ActorResolver, CATALOG_ROLES, requireRole } from '../auth/actor.ts';
import type { Router } from '../http/router.ts';
import type { Handler, HttpRequest } from '../http/types.ts';
import { asObject, intQuery, oneOf, optStr, str, uuidParam } from '../http/validation.ts';
import type { NotificationService } from './service.ts';

const TYPES = [
  'NEW_EPISODE', 'NEW_SEASON', 'NEW_LANGUAGE_VERSION', 'ANNOUNCEMENT',
  'MAINTENANCE', 'CATALOG_CHANGE', 'CONTENT_WITHDRAWAL', 'ACCOUNT', 'OPERATION_CONFIRMATION',
] as const;
const AUDIENCES = ['ALL', 'FOLLOWERS', 'USER', 'SEGMENT'] as const;

export function registerNotificationRoutes(
  router: Router,
  deps: { service: NotificationService; actors: ActorResolver },
): void {
  const { service, actors } = deps;
  const on = (method: string, path: string, handler: Handler): void => void router.add(method, path, handler);
  const userId = async (req: HttpRequest) => (await actors.user(req)).userId;

  on('GET', '/me/notifications', async (req) => ({
    status: 200,
    body: await service.listForUser(
      await userId(req),
      intQuery(req.query, 'page', 1, 1, 10_000),
      intQuery(req.query, 'limit', 20, 1, 50),
      req.query.get('unreadOnly') === 'true',
    ),
  }));
  on('POST', '/me/notifications/read-all', async (req) => ({
    status: 200, body: await service.markAllRead(await userId(req)),
  }));
  on('POST', '/me/notifications/:id/read', async (req) => ({
    status: 200, body: await service.markRead(await userId(req), uuidParam(req.params['id'])),
  }));

  on('GET', '/me/notification-preferences', async (req) => ({
    status: 200, body: { preferences: await service.preferences(await userId(req)) },
  }));
  on('PATCH', '/me/notification-preferences/:type', async (req) => {
    const b = asObject(req.body);
    const type = oneOf({ type: req.params['type'] }, 'type', TYPES);
    if (typeof b['enabled'] !== 'boolean') throw new Error('Le champ « enabled » doit être vrai ou faux');
    return { status: 200, body: { preference: await service.updatePreference(await userId(req), type, b['enabled']) } };
  });

  on('POST', '/admin/notifications', async (req) => {
    const actor = await actors.admin(req);
    requireRole(actor, CATALOG_ROLES);
    const b = asObject(req.body);
    const data = b['data'] === undefined || b['data'] === null ? undefined : asObject(b['data']);
    return {
      status: 201,
      body: await service.createCampaign(actor, {
        type: oneOf(b, 'type', TYPES),
        audience: oneOf(b, 'audience', AUDIENCES),
        title: str(b, 'title', { min: 1, max: 160 }),
        body: str(b, 'body', { min: 1, max: 5000 }),
        ...(b['contentId'] !== undefined ? { contentId: uuidParam(typeof b['contentId'] === 'string' ? b['contentId'] : undefined, 'contentId') } : {}),
        ...(b['targetUserId'] !== undefined ? { targetUserId: uuidParam(typeof b['targetUserId'] === 'string' ? b['targetUserId'] : undefined, 'targetUserId') } : {}),
        ...(data ? { data } : {}),
        ...(optStr(b, 'dedupeKey', { max: 200 }) ? { dedupeKey: optStr(b, 'dedupeKey', { max: 200 }) as string } : {}),
      }, { ip: req.ip, requestId: req.requestId }),
    };
  });
}
