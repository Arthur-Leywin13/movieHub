import type { Handler } from './types.ts';

interface Route {
  method: string;
  segments: string[];
  handler: Handler;
}

export type RouteMatch =
  | { kind: 'found'; handler: Handler; params: Record<string, string> }
  | { kind: 'method_not_allowed'; allowed: string[] }
  | { kind: 'not_found' };

const split = (path: string): string[] => path.split('/').filter((s) => s.length > 0);

/** Routeur minimal : segments littéraux et paramètres « :nom ». */
export class Router {
  private readonly routes: Route[] = [];

  add(method: string, pattern: string, handler: Handler): this {
    this.routes.push({ method: method.toUpperCase(), segments: split(pattern), handler });
    return this;
  }

  match(method: string, path: string): RouteMatch {
    const parts = split(path);
    const allowed = new Set<string>();
    for (const route of this.routes) {
      if (route.segments.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < parts.length; i++) {
        const seg = route.segments[i] as string;
        const part = parts[i] as string;
        if (seg.startsWith(':')) {
          try {
            params[seg.slice(1)] = decodeURIComponent(part);
          } catch {
            ok = false;
            break;
          }
        } else if (seg !== part) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      if (route.method === method.toUpperCase()) return { kind: 'found', handler: route.handler, params };
      allowed.add(route.method);
    }
    return allowed.size > 0 ? { kind: 'method_not_allowed', allowed: [...allowed] } : { kind: 'not_found' };
  }
}
