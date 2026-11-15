import { ActorResolver, CATALOG_ROLES, requireRole } from '../auth/actor.ts';
import type { Router } from '../http/router.ts';
import type { Handler } from '../http/types.ts';
import { asObject, intQuery, optStr, str, uuidParam } from '../http/validation.ts';
import type { ContentWithdrawalService } from './service.ts';

export function registerContentWithdrawalRoutes(router: Router, deps: { service: ContentWithdrawalService; actors: ActorResolver }): void {
  const { service, actors } = deps;
  const on = (method: string, path: string, handler: Handler): void => void router.add(method, path, handler);
  const admin = async (req: Parameters<Handler>[0]) => { const actor = await actors.admin(req); requireRole(actor, CATALOG_ROLES); return actor; };
  const ctx = (req: Parameters<Handler>[0]) => ({ ip: req.ip, requestId: req.requestId });

  on('GET', '/admin/content-withdrawals', async (req) => {
    await admin(req);
    return { status: 200, body: await service.list(intQuery(req.query, 'page', 1, 1, 10_000), intQuery(req.query, 'limit', 20, 1, 100)) };
  });
  on('POST', '/admin/content-withdrawals', async (req) => {
    const actor = await admin(req); const b = asObject(req.body);
    const message = optStr(b, 'message', { max: 2000 });
    const withdrawal = await service.schedule(actor, {
      contentId: uuidParam(typeof b['contentId'] === 'string' ? b['contentId'] : undefined, 'contentId'),
      noticeStartsAt: str(b, 'noticeStartsAt', { max: 40 }),
      effectiveAt: str(b, 'effectiveAt', { max: 40 }),
      ...(message ? { message } : {}),
    }, ctx(req));
    return { status: 201, body: { withdrawal } };
  });
  on('DELETE', '/admin/content-withdrawals/:id', async (req) => {
    const actor = await admin(req);
    return { status: 200, body: await service.cancel(actor, uuidParam(req.params['id']), ctx(req)) };
  });
}