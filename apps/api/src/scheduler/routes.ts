import type { Router } from '../http/router.ts';
import type { Handler } from '../http/types.ts';
import { asObject, intQuery, nullableStr, oneOf, optBool, str, uuidParam } from '../http/validation.ts';
import { ActorResolver, CATALOG_ROLES, requireRole } from '../auth/actor.ts';
import type { ScheduledPublicationService } from './service.ts';

const TARGET_TYPES = ['CONTENT', 'SEASON', 'EPISODE', 'VIDEO_ASSET', 'POSTER', 'TRAILER'] as const;
const ACTIONS = ['PUBLISH', 'UNPUBLISH', 'ARCHIVE'] as const;

export function registerScheduledPublicationRoutes(
  router: Router,
  deps: { service: ScheduledPublicationService; actors: ActorResolver },
): void {
  const { service, actors } = deps;
  const on = (method: string, path: string, handler: Handler): void => void router.add(method, path, handler);
  const admin = async (req: Parameters<Handler>[0]) => {
    const actor = await actors.admin(req);
    requireRole(actor, CATALOG_ROLES);
    return actor;
  };
  const ctx = (req: Parameters<Handler>[0]) => ({ ip: req.ip, requestId: req.requestId });

  on('GET', '/admin/scheduled-publications', async (req) => {
    await admin(req);
    return {
      status: 200,
      body: await service.list(
        intQuery(req.query, 'page', 1, 1, 10_000),
        intQuery(req.query, 'limit', 20, 1, 100),
      ),
    };
  });

  on('POST', '/admin/scheduled-publications', async (req) => {
    const actor = await admin(req);
    const b = asObject(req.body);
    const job = await service.schedule(actor, {
      targetType: oneOf(b, 'targetType', TARGET_TYPES),
      targetId: uuidParam(typeof b['targetId'] === 'string' ? b['targetId'] : undefined, 'targetId'),
      action: oneOf(b, 'action', ACTIONS),
      scheduledFor: str(b, 'scheduledFor', { max: 40 }),
      ...(b['adminNote'] !== undefined ? { adminNote: nullableStr(b, 'adminNote', { max: 1000 }) ?? null } : {}),
      ...(optBool(b, 'notifyFollowers') !== undefined ? { notifyFollowers: optBool(b, 'notifyFollowers') as boolean } : {}),
    }, ctx(req));
    return { status: 201, body: { scheduledPublication: job } };
  });

  on('DELETE', '/admin/scheduled-publications/:id', async (req) => {
    const actor = await admin(req);
    return { status: 200, body: await service.cancel(actor, uuidParam(req.params['id']), ctx(req)) };
  });
}
