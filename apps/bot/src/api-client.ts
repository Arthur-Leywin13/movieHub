/** Client de l'API MoviesHub. Le bot n'a jamais accès à la base ni à R2 : tout passe ici. */
export type J = Record<string, any>;

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: any;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class ApiClient {
  private readonly baseUrl: string;
  private readonly serviceToken: string;
  private readonly fetchFn: typeof fetch;

  constructor(opts: { baseUrl: string; serviceToken: string; fetch?: typeof fetch }) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.serviceToken = opts.serviceToken;
    this.fetchFn = opts.fetch ?? fetch;
  }

  /** Appel authentifié « Bot <jeton de service> » au nom de l'administrateur Telegram `uid` (id numérique). */
  async call<T = J>(uid: number, method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bot ${this.serviceToken}`,
          'x-telegram-user-id': String(uid),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(60_000),
      });
    } catch {
      throw new ApiError(0, 'UNREACHABLE', 'API MoviesHub injoignable');
    }
    const text = await res.text();
    const json = text ? (JSON.parse(text) as J) : {};
    if (!res.ok) {
      const e = (json['error'] ?? {}) as J;
      throw new ApiError(res.status, String(e['code'] ?? 'ERROR'), String(e['message'] ?? `Erreur HTTP ${res.status}`), e['details']);
    }
    return json as T;
  }

  /** Envoi direct d'un morceau vers une URL pré-signée R2 ; renvoie l'ETag. */
  async putPart(url: string, data: Buffer, signal?: AbortSignal): Promise<string> {
    let res: Response;
    try {
      res = await this.fetchFn(url, { method: 'PUT', body: data, signal: signal ?? AbortSignal.timeout(15 * 60_000) });
    } catch {
      throw new ApiError(0, 'UPLOAD_UNREACHABLE', 'Envoi vers le stockage impossible');
    }
    if (!res.ok) throw new ApiError(res.status, 'UPLOAD_REJECTED', `Stockage : envoi refusé (HTTP ${res.status})`);
    return res.headers.get('etag') ?? '';
  }
}
