import { ActorResolver, requireRole } from '../auth/actor.ts';
import type { Router } from '../http/router.ts';
import type { Handler } from '../http/types.ts';
import { intQuery } from '../http/validation.ts';
import type { AuditLogService } from './service.ts';

export function registerAuditLogRoutes(
  router: Router,
  deps: { service: AuditLogService; actors: ActorResolver },
): void {
  const on = (method: string, path: string, handler: Handler): void => void router.add(method, path, handler);
  on('GET', '/admin/audit-logs', async (req) => {
    const actor = await deps.actors.admin(req);
    requireRole(actor, ['SUPER_ADMIN', 'ADMIN']);
    const page = intQuery(req.query, 'page', 1, 1, 100_000);
    const limit = intQuery(req.query, 'limit', 30, 1, 100);
    return { status: 200, body: await deps.service.list(actor, page, limit) };
  });
}
