/**
 * Chargement et validation des variables d'environnement.
 *
 * Règles :
 *  - une fonction par service : le bot n'exige ni DATABASE_URL ni secrets R2
 *    (le bot passe par l'API, il n'a jamais accès à la base) ;
 *  - toutes les erreurs sont collectées puis levées d'un coup ;
 *  - les messages d'erreur ne contiennent JAMAIS la valeur d'une variable.
 */

export type EnvSource = Record<string, string | undefined>;

export class EnvError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Configuration invalide :\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'EnvError';
    this.issues = issues;
  }
}

class Reader {
  readonly issues: string[] = [];
  private readonly source: EnvSource;

  constructor(source: EnvSource) {
    this.source = source;
  }

  private raw(name: string): string | undefined {
    const v = this.source[name];
    return v === undefined || v.trim() === '' ? undefined : v.trim();
  }

  str(name: string, opts: { default?: string } = {}): string {
    const v = this.raw(name) ?? opts.default;
    if (v === undefined) {
      this.issues.push(`${name} : variable obligatoire manquante`);
      return '';
    }
    return v;
  }

  /** Secret : longueur minimale imposée. */
  secret(name: string, minLength = 32): string {
    const v = this.raw(name);
    if (v === undefined) {
      this.issues.push(`${name} : variable obligatoire manquante`);
      return '';
    }
    if (v.length < minLength) {
      this.issues.push(`${name} : trop court (minimum ${minLength} caractères)`);
    }
    return v;
  }

  int(name: string, opts: { default?: number; min?: number; max?: number } = {}): number {
    const v = this.raw(name);
    if (v === undefined) {
      if (opts.default !== undefined) return opts.default;
      this.issues.push(`${name} : variable obligatoire manquante`);
      return 0;
    }
    if (!/^-?\d+$/.test(v)) {
      this.issues.push(`${name} : entier attendu`);
      return 0;
    }
    const n = Number(v);
    if (opts.min !== undefined && n < opts.min) this.issues.push(`${name} : doit être ≥ ${opts.min}`);
    if (opts.max !== undefined && n > opts.max) this.issues.push(`${name} : doit être ≤ ${opts.max}`);
    return n;
  }

  url(name: string, opts: { protocols: readonly string[]; default?: string }): string {
    const v = this.raw(name) ?? opts.default;
    if (v === undefined) {
      this.issues.push(`${name} : variable obligatoire manquante`);
      return '';
    }
    try {
      const u = new URL(v);
      if (!opts.protocols.includes(u.protocol)) {
        this.issues.push(`${name} : protocole non autorisé (attendu : ${opts.protocols.join(', ')})`);
      }
    } catch {
      this.issues.push(`${name} : URL invalide`);
    }
    return v;
  }

  oneOf<T extends string>(name: string, values: readonly T[], def: T): T {
    const v = this.raw(name);
    if (v === undefined) return def;
    if (!(values as readonly string[]).includes(v)) {
      this.issues.push(`${name} : valeur non autorisée (attendu : ${values.join(', ')})`);
      return def;
    }
    return v as T;
  }

  bool(name: string, def: boolean): boolean {
    const v = this.raw(name);
    if (v === undefined) return def;
    if (v === 'true' || v === '1') return true;
    if (v === 'false' || v === '0') return false;
    this.issues.push(`${name} : booléen attendu (true/false)`);
    return def;
  }

  /** Origines CORS : http(s)://hôte[:port], sans chemin ni slash final. */
  origins(name: string): string[] {
    const v = this.raw(name);
    if (v === undefined) return [];
    const out: string[] = [];
    for (const part of v.split(',').map((p) => p.trim()).filter(Boolean)) {
      let ok = false;
      try {
        const u = new URL(part);
        ok = (u.protocol === 'http:' || u.protocol === 'https:') && u.origin === part;
      } catch {
        ok = false;
      }
      if (!ok) {
        this.issues.push(`${name} : origines http(s) sans chemin attendues (ex. https://admin.exemple.com)`);
        return [];
      }
      out.push(part);
    }
    return out;
  }

  /** Liste d'identifiants Telegram numériques séparés par des virgules (jamais des @username). */
  telegramIds(name: string): bigint[] {
    const v = this.raw(name);
    if (v === undefined) {
      this.issues.push(`${name} : au moins un identifiant Telegram administrateur est requis`);
      return [];
    }
    const out: bigint[] = [];
    for (const part of v.split(',').map((p) => p.trim()).filter(Boolean)) {
      if (!/^\d{1,20}$/.test(part)) {
        this.issues.push(`${name} : identifiants numériques attendus (pas de @username)`);
        return [];
      }
      out.push(BigInt(part));
    }
    if (out.length === 0) this.issues.push(`${name} : liste vide`);
    return out;
  }

  done(): void {
    if (this.issues.length > 0) throw new EnvError(this.issues);
  }
}

const NODE_ENVS = ['development', 'test', 'production'] as const;
export type NodeEnv = (typeof NODE_ENVS)[number];

export interface ApiEnv {
  nodeEnv: NodeEnv;
  port: number;
  publicUrl: string;
  /** Derrière un proxy/reverse proxy de confiance : lit l'IP dans X-Forwarded-For. */
  trustProxy: boolean;
  /** Origines autorisées à appeler l'API depuis un navigateur (dashboard, site web). */
  corsOrigins: string[];
  databaseUrl: string;
  /** Premier administrateur, créé au démarrage s'il n'existe encore aucun administrateur. */
  bootstrapAdmin: { email: string; password: string; telegramId: bigint } | null;
  jwtAccessSecret: string;
  jwtRefreshSecret: string;
  botServiceToken: string;
  r2: {
    accountId: string;
    accessKeyId: string;
    secretAccessKey: string;
    bucket: string;
    signedUrlTtlSeconds: number;
  };
}

export interface BotEnv {
  nodeEnv: NodeEnv;
  telegramBotToken: string;
  /** Serveur Bot API : officiel (https://api.telegram.org) ou local (fichiers jusqu'à 2 Go). */
  telegramApiBaseUrl: string;
  /** Taille maximale d'un fichier accepté par le bot, en octets. */
  maxFileBytes: number;
  apiBaseUrl: string;
  botServiceToken: string;
  adminTelegramIds: bigint[];
  /** Dossier où le bot garde les conversations en cours (reprise après redémarrage). */
  stateDir: string;
}

/** Limite Telegram pour un fichier envoyé au bot via un serveur Bot API local (2000 Mo). */
export const TELEGRAM_LOCAL_MAX_FILE_BYTES = 2000 * 1024 * 1024;
/** Limite de téléchargement d'un fichier reçu par un bot avec le serveur Bot API officiel (20 Mo). */
export const TELEGRAM_OFFICIAL_MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;
const OFFICIAL_BOT_API_HOST = 'api.telegram.org';

export function loadApiEnv(source: EnvSource = process.env): ApiEnv {
  const r = new Reader(source);
  const env: ApiEnv = {
    nodeEnv: r.oneOf('NODE_ENV', NODE_ENVS, 'development'),
    port: r.int('API_PORT', { default: 3000, min: 1, max: 65535 }),
    publicUrl: r.url('API_PUBLIC_URL', { protocols: ['http:', 'https:'], default: 'http://localhost:3000' }),
    trustProxy: r.bool('API_TRUST_PROXY', false),
    corsOrigins: r.origins('API_CORS_ORIGINS'),
    databaseUrl: r.url('DATABASE_URL', { protocols: ['postgresql:', 'postgres:'] }),
    bootstrapAdmin: null,
    jwtAccessSecret: r.secret('JWT_ACCESS_SECRET'),
    jwtRefreshSecret: r.secret('JWT_REFRESH_SECRET'),
    botServiceToken: r.secret('BOT_SERVICE_TOKEN'),
    r2: {
      accountId: r.str('R2_ACCOUNT_ID'),
      accessKeyId: r.str('R2_ACCESS_KEY_ID'),
      secretAccessKey: r.str('R2_SECRET_ACCESS_KEY'),
      bucket: r.str('R2_BUCKET'),
      signedUrlTtlSeconds: r.int('R2_SIGNED_URL_TTL_SECONDS', { default: 900, min: 60, max: 604800 }),
    },
  };
  const bEmail = source['BOOTSTRAP_ADMIN_EMAIL']?.trim();
  const bPassword = source['BOOTSTRAP_ADMIN_PASSWORD'];
  const bTelegram = source['BOOTSTRAP_ADMIN_TELEGRAM_ID']?.trim();
  if (bEmail || bPassword || bTelegram) {
    if (!bEmail || !bPassword || !bTelegram) {
      r.issues.push('BOOTSTRAP_ADMIN_EMAIL, BOOTSTRAP_ADMIN_PASSWORD et BOOTSTRAP_ADMIN_TELEGRAM_ID doivent être renseignées ensemble');
    } else {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(bEmail)) r.issues.push('BOOTSTRAP_ADMIN_EMAIL : adresse e-mail invalide');
      if (bPassword.length < 12) r.issues.push('BOOTSTRAP_ADMIN_PASSWORD : trop court (minimum 12 caractères)');
      if (!/^\d{1,20}$/.test(bTelegram)) r.issues.push('BOOTSTRAP_ADMIN_TELEGRAM_ID : identifiant numérique attendu (pas de @username)');
      else if (!r.issues.some((i) => i.startsWith('BOOTSTRAP_'))) env.bootstrapAdmin = { email: bEmail.toLowerCase(), password: bPassword, telegramId: BigInt(bTelegram) };
    }
  }
  if (env.jwtAccessSecret && env.jwtAccessSecret === env.jwtRefreshSecret) {
    r.issues.push('JWT_ACCESS_SECRET et JWT_REFRESH_SECRET doivent être différents');
  }
  r.done();
  return env;
}

function isOfficialBotApi(url: string): boolean {
  try {
    return new URL(url).hostname === OFFICIAL_BOT_API_HOST;
  } catch {
    return false;
  }
}

export function loadBotEnv(source: EnvSource = process.env): BotEnv {
  const r = new Reader(source);
  const env: BotEnv = {
    nodeEnv: r.oneOf('NODE_ENV', NODE_ENVS, 'development'),
    telegramBotToken: r.str('TELEGRAM_BOT_TOKEN'),
    telegramApiBaseUrl: r.url('TELEGRAM_API_BASE_URL', {
      protocols: ['http:', 'https:'],
      default: `https://${OFFICIAL_BOT_API_HOST}`,
    }),
    maxFileBytes: r.int('BOT_MAX_FILE_BYTES', {
      default: TELEGRAM_LOCAL_MAX_FILE_BYTES,
      min: 1,
      max: TELEGRAM_LOCAL_MAX_FILE_BYTES,
    }),
    apiBaseUrl: r.url('API_BASE_URL', { protocols: ['http:', 'https:'] }),
    botServiceToken: r.secret('BOT_SERVICE_TOKEN'),
    adminTelegramIds: r.telegramIds('TELEGRAM_ADMIN_IDS'),
    stateDir: r.str('BOT_STATE_DIR', { default: './data/bot' }),
  };
  if (isOfficialBotApi(env.telegramApiBaseUrl) && env.maxFileBytes > TELEGRAM_OFFICIAL_MAX_DOWNLOAD_BYTES) {
    r.issues.push(
      'BOT_MAX_FILE_BYTES : au-delà de 20 Mo, TELEGRAM_API_BASE_URL doit pointer vers un serveur Bot API local',
    );
  }
  r.done();
  return env;
}
