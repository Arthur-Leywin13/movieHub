import { ForbiddenError } from '@movieshub/shared';
import type { ActorResolver } from '../auth/actor.ts';
import type { Router } from '../http/router.ts';
import type { Handler, HttpRequest } from '../http/types.ts';
import { intQuery, oneOf, optStr, uuidParam } from '../http/validation.ts';
import type { AdminManagementService } from './management-service.ts';

const MANAGEABLE_ROLES = ['ADMIN', 'EDITOR', 'MODERATOR'] as const;
const requireSuperAdmin = (role: string): void => {
  if (role !== 'SUPER_ADMIN') throw new ForbiddenError('Réservé au super-administrateur');
};

export function registerAdminManagementRoutes(router: Router, deps: { service: AdminManagementService; actors: ActorResolver }): void {
  const on = (method: string, path: string, handler: Handler): void => void router.add(method, path, handler);
  const admin = async (req: HttpRequest) => {
    const actor = await deps.actors.admin(req);
    requireSuperAdmin(actor.role);
    return actor;
  };
  const context = (req: HttpRequest) => ({ ip: req.ip, requestId: req.requestId });

  on('GET', '/admin/users', async (req) => {
    await admin(req);
    return { status: 200, body: await deps.service.listUsers(
      intQuery(req.query, 'page', 1, 1, 10_000),
      intQuery(req.query, 'limit', 25, 1, 100),
      optStr(Object.fromEntries(req.query.entries()), 'q', { max: 100 }),
    ) };
  });
  on('PATCH', '/admin/users/:id/status', async (req) => {
    const actor = await admin(req);
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body as Record<string, unknown> : {};
    return { status: 200, body: await deps.service.setUserStatus(actor, uuidParam(req.params['id']), oneOf(body, 'status', ['ACTIVE', 'SUSPENDED'] as const), context(req)) };
  });
  on('PUT', '/admin/users/:id/admin-role', async (req) => {
    const actor = await admin(req);
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body as Record<string, unknown> : {};
    return { status: 200, body: await deps.service.setAdminRole(actor, uuidParam(req.params['id']), oneOf(body, 'role', MANAGEABLE_ROLES), context(req)) };
  });
  on('DELETE', '/admin/users/:id/admin-role', async (req) => {
    const actor = await admin(req);
    return { status: 200, body: await deps.service.removeAdmin(actor, uuidParam(req.params['id']), context(req)) };
  });
}
