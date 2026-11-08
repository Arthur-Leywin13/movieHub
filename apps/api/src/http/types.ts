export interface HttpRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  /** En-têtes en minuscules (première valeur si répétés). */
  headers: Record<string, string | undefined>;
  /** Corps JSON déjà analysé (undefined si absent). */
  body: unknown;
  params: Record<string, string>;
  ip: string;
  requestId: string;
}

export interface HttpResponse {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export type Handler = (req: HttpRequest) => Promise<HttpResponse> | HttpResponse;

export interface Logger {
  info(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export const silentLogger: Logger = { info: () => undefined, error: () => undefined };

export const consoleLogger: Logger = {
  info: (message, meta) => console.log(JSON.stringify({ level: 'info', message, ...meta })),
  error: (message, meta) => console.error(JSON.stringify({ level: 'error', message, ...meta })),
};
