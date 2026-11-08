import { Router } from './http/router.ts';
import type { Handler, HttpRequest } from './http/types.ts';
import { asObject, email, int, oneOf, optStr, str, uuidParam } from './http/validation.ts';
import { UploadService } from './admin/upload-service.ts';
import { ActorResolver, CATALOG_ROLES, requireRole } from './auth/actor.ts';
import type { AuthService, ClientContext } from './auth/auth-service.ts';
import { UPLOAD_KINDS } from './storage/keys.ts';
import type { CatalogAdminService } from './catalog/admin-service.ts';
import type { CatalogReadService } from './catalog/read-service.ts';
import { registerCatalogRoutes } from './catalog/routes.ts';
import type { UserDataService } from './user/service.ts';
import { registerUserRoutes } from './user/routes.ts';

export interface AppDeps {
  auth: AuthService;
  actors: ActorResolver;
  uploads: UploadService;
  catalogAdmin: CatalogAdminService;
  catalogRead: CatalogReadService;
  /** Favoris, suivi, historique, téléchargements : routes « /me » et téléchargements, absentes si non fourni. */
  userData?: UserDataService;
  /** Vérifie la base de données (route /health/ready). */
  checkReady?: () => Promise<boolean>;
}

const PLATFORMS = ['ANDROID', 'WEB'] as const;

function clientContext(req: HttpRequest, body: Record<string, unknown> = {}): ClientContext {
  return {
    ip: req.ip,
    userAgent: req.headers['user-agent']?.slice(0, 300) ?? null,
    deviceName: optStr(body, 'deviceName', { max: 100 }) ?? null,
    platform: body['platform'] === undefined ? null : oneOf(body, 'platform', PLATFORMS),
  };
}

export function buildApp(deps: AppDeps): Router {
  const router = new Router();
  const on = (method: string, path: string, handler: Handler): void => void router.add(method, path, handler);

  on('GET', '/health', () => ({ status: 200, body: { status: 'ok' } }));
  on('GET', '/health/ready', async () => {
    const ready = deps.checkReady ? await deps.checkReady().catch(() => false) : true;
    return ready ? { status: 200, body: { status: 'ready' } } : { status: 503, body: { status: 'unavailable' } };
  });

  // ---- Authentification ----
  on('POST', '/auth/register', async (req) => {
    const b = asObject(req.body);
    const result = await deps.auth.register(
      { email: email(b), password: str(b, 'password', { min: 1, max: 1000 }), displayName: str(b, 'displayName', { min: 2, max: 50 }) },
      clientContext(req, b),
    );
    return { status: 201, body: result };
  });

  on('POST', '/auth/login', async (req) => {
    const b = asObject(req.body);
    const result = await deps.auth.login({ email: email(b), password: str(b, 'password', { min: 1, max: 1000 }) }, clientContext(req, b));
    return { status: 200, body: result };
  });

  on('POST', '/auth/refresh', async (req) => {
    const b = asObject(req.body);
    return { status: 200, body: await deps.auth.refresh(str(b, 'refreshToken', { max: 500 })) };
  });

  on('POST', '/auth/logout', async (req) => {
    await deps.auth.logout(str(asObject(req.body), 'refreshToken', { max: 500 }));
    return { status: 204 };
  });

  on('POST', '/auth/logout-all', async (req) => {
    const actor = await deps.actors.user(req);
    await deps.auth.logoutAll(actor.userId);
    return { status: 204 };
  });

  on('GET', '/me', async (req) => {
    const actor = await deps.actors.user(req);
    return { status: 200, body: { user: await deps.auth.me(actor.userId) } };
  });

  // ---- Administration : envois de fichiers vers R2 ----
  on('POST', '/admin/uploads', async (req) => {
    const actor = await deps.actors.admin(req);
    requireRole(actor, CATALOG_ROLES);
    const b = asObject(req.body);
    const out = await deps.uploads.init(
      actor,
      { kind: oneOf(b, 'kind', UPLOAD_KINDS), filename: str(b, 'filename', { max: 255 }), sizeBytes: int(b, 'sizeBytes', { min: 1, max: 2_097_152_000 }) },
      { ip: req.ip, requestId: req.requestId },
    );
    return { status: 201, body: out };
  });

  on('GET', '/admin/uploads/:id', async (req) => {
    const actor = await deps.actors.admin(req);
    requireRole(actor, CATALOG_ROLES);
    return { status: 200, body: await deps.uploads.status(actor, uuidParam(req.params['id'])) };
  });

  on('POST', '/admin/uploads/:id/complete', async (req) => {
    const actor = await deps.actors.admin(req);
    requireRole(actor, CATALOG_ROLES);
    return { status: 200, body: await deps.uploads.complete(actor, uuidParam(req.params['id']), { ip: req.ip, requestId: req.requestId }) };
  });

  on('POST', '/admin/uploads/:id/abort', async (req) => {
    const actor = await deps.actors.admin(req);
    requireRole(actor, CATALOG_ROLES);
    await deps.uploads.abort(actor, uuidParam(req.params['id']), { ip: req.ip, requestId: req.requestId });
    return { status: 204 };
  });

  const userData = deps.userData;
  registerCatalogRoutes(router, {
    admin: deps.catalogAdmin, read: deps.catalogRead, actors: deps.actors,
    ...(userData ? { onView: (id: string) => void userData.recordView(id) } : {}),
  });
  if (userData) registerUserRoutes(router, { users: userData, actors: deps.actors });

  return router;
}
