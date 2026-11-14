import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient, ScheduledAction, ScheduledTargetType } from '@movieshub/database';
import { ConflictError, NotFoundError, ValidationError } from '@movieshub/shared';
import type { AdminActor } from '../auth/actor.ts';

type TargetType = 'CONTENT' | 'SEASON' | 'EPISODE' | 'VIDEO_ASSET' | 'POSTER' | 'TRAILER';
type Action = 'PUBLISH' | 'UNPUBLISH' | 'ARCHIVE';

interface ScheduleInput {
  targetType: TargetType;
  targetId: string;
  action: Action;
  scheduledFor: string;
  adminNote?: string | null;
  notifyFollowers?: boolean;
}

interface RequestContext {
  ip: string;
  requestId: string;
}

interface ClaimedJob {
  id: string;
  targetType: TargetType;
  targetId: string;
  action: Action;
  attempts: number;
  maxAttempts: number;
  lockedBy: string;
  notifyFollowers: boolean;
}

const MAX_NOTE_LENGTH = 1000;
const STALE_LOCK_MS = 2 * 60 * 1000;

/**
 * Service des publications programmées.
 *
 * Le worker utilise FOR UPDATE SKIP LOCKED : plusieurs instances de l'API
 * peuvent traiter la file sans exécuter simultanément le même élément.
 * Chaque modification du catalogue et le passage du job à DONE sont atomiques.
 */
export class ScheduledPublicationService {
  private readonly prisma: PrismaClient;
  private readonly workerId: string;
  private readonly now: () => Date;

  constructor(deps: { prisma: PrismaClient; workerId?: string; now?: () => Date }) {
    this.prisma = deps.prisma;
    this.workerId = deps.workerId ?? randomUUID();
    this.now = deps.now ?? (() => new Date());
  }

  private async assertTarget(targetType: TargetType, targetId: string, action: Action): Promise<void> {
    if ((targetType === 'POSTER' || targetType === 'TRAILER') && action !== 'ARCHIVE') {
      throw new ValidationError('Une affiche ou une bande-annonce peut uniquement être archivée par programmation');
    }

    const target = await (async () => {
      switch (targetType) {
        case 'CONTENT': return this.prisma.content.findUnique({ where: { id: targetId }, select: { id: true, status: true } });
        case 'SEASON': return this.prisma.season.findUnique({ where: { id: targetId }, select: { id: true, status: true } });
        case 'EPISODE': return this.prisma.episode.findUnique({ where: { id: targetId }, select: { id: true, status: true } });
        case 'VIDEO_ASSET': return this.prisma.videoAsset.findUnique({ where: { id: targetId }, select: { id: true, status: true } });
        case 'POSTER': return this.prisma.poster.findUnique({ where: { id: targetId }, select: { id: true, archivedAt: true } });
        case 'TRAILER': return this.prisma.trailer.findUnique({ where: { id: targetId }, select: { id: true, archivedAt: true } });
      }
    })();

    if (!target) throw new NotFoundError('Élément à programmer introuvable');
    if ('status' in target && target.status === 'WITHDRAWN') {
      throw new ConflictError('Un contenu retiré ne peut pas être programmé');
    }
    if ('archivedAt' in target && target.archivedAt) {
      throw new ConflictError('Ce média est déjà archivé');
    }
  }

  async schedule(actor: AdminActor, input: ScheduleInput, ctx: RequestContext) {
    const scheduledFor = new Date(input.scheduledFor);
    if (!Number.isFinite(scheduledFor.getTime())) throw new ValidationError('Date de programmation invalide', { field: 'scheduledFor' });
    if (scheduledFor.getTime() <= this.now().getTime()) throw new ValidationError('La date de programmation doit être dans le futur', { field: 'scheduledFor' });
    if (input.notifyFollowers && (input.action !== 'PUBLISH' || !['EPISODE', 'SEASON', 'VIDEO_ASSET'].includes(input.targetType))) {
      throw new ValidationError('Les notifications sont disponibles uniquement lors de la publication d’un épisode, d’une saison ou d’une version vidéo', { field: 'notifyFollowers' });
    }
    const adminNote = input.adminNote?.trim() || null;
    if (adminNote && adminNote.length > MAX_NOTE_LENGTH) throw new ValidationError(`La note ne peut pas dépasser ${MAX_NOTE_LENGTH} caractères`);
    await this.assertTarget(input.targetType, input.targetId, input.action);

    return this.prisma.$transaction(async (tx) => {
      const job = await tx.scheduledPublication.create({
        data: {
          targetType: input.targetType as ScheduledTargetType,
          targetId: input.targetId,
          action: input.action as ScheduledAction,
          scheduledFor,
          dedupeKey: randomUUID(),
          adminNote,
          notifyFollowers: input.notifyFollowers ?? false,
          createdByAdminId: actor.adminId,
        },
      });
      await tx.auditLog.create({
        data: {
          source: actor.via === 'bot' ? 'TELEGRAM_BOT' : 'DASHBOARD',
          adminId: actor.adminId,
          action: 'publication.schedule',
          entityType: 'ScheduledPublication',
          entityId: job.id,
          newValues: { targetType: input.targetType, targetId: input.targetId, action: input.action, scheduledFor: scheduledFor.toISOString() },
          ipAddress: ctx.ip,
          requestId: ctx.requestId,
        },
      });
      return job;
    });
  }

  async cancel(actor: AdminActor, id: string, ctx: RequestContext) {
    const job = await this.prisma.scheduledPublication.findUnique({ where: { id } });
    if (!job) throw new NotFoundError('Programmation introuvable');
    if (job.status !== 'PENDING') throw new ConflictError('Seule une programmation en attente peut être annulée');

    return this.prisma.$transaction(async (tx) => {
      const result = await tx.scheduledPublication.updateMany({
        where: { id, status: 'PENDING' },
        data: { status: 'CANCELED' },
      });
      if (result.count !== 1) throw new ConflictError('La programmation a déjà été prise en charge');
      await tx.auditLog.create({
        data: {
          source: actor.via === 'bot' ? 'TELEGRAM_BOT' : 'DASHBOARD',
          adminId: actor.adminId,
          action: 'publication.cancel',
          entityType: 'ScheduledPublication',
          entityId: id,
          oldValues: { status: job.status },
          newValues: { status: 'CANCELED' },
          ipAddress: ctx.ip,
          requestId: ctx.requestId,
        },
      });
      return { id, status: 'CANCELED' as const };
    });
  }

  async list(page = 1, limit = 20) {
    const [items, total] = await this.prisma.$transaction([
      this.prisma.scheduledPublication.findMany({
        orderBy: [{ scheduledFor: 'asc' }, { createdAt: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.scheduledPublication.count(),
    ]);
    return { items, total, page, limit };
  }

  /** Traite un lot d'échéances. Appelable périodiquement depuis chaque instance API. */
  async runOnce(batchSize = 10): Promise<{ claimed: number; completed: number; failed: number }> {
    const now = this.now();
    await this.prisma.scheduledPublication.updateMany({
      where: { status: 'PROCESSING', lockedAt: { lt: new Date(now.getTime() - STALE_LOCK_MS) } },
      data: { status: 'PENDING', lockedAt: null, lockedBy: null },
    });

    const jobs = await this.prisma.$transaction(async (tx) => {
      const due = await tx.$queryRaw<Array<{ id: string; targetType: TargetType; targetId: string; action: Action; attempts: number; maxAttempts: number; notifyFollowers: boolean }>>`
        SELECT "id", "targetType", "targetId", "action", "attempts", "maxAttempts", "notifyFollowers"
        FROM "ScheduledPublication"
        WHERE "status" = 'PENDING'::"ScheduledStatus" AND "scheduledFor" <= ${now}
        ORDER BY "scheduledFor" ASC
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED
      `;
      const claimed: ClaimedJob[] = [];
      for (const item of due) {
        const updated = await tx.scheduledPublication.update({
          where: { id: item.id },
          data: { status: 'PROCESSING', lockedAt: now, lockedBy: this.workerId, attempts: { increment: 1 } },
        });
        claimed.push({ ...item, attempts: updated.attempts, lockedBy: this.workerId });
      }
      return claimed;
    });

    let completed = 0;
    let failed = 0;
    for (const job of jobs) {
      try {
        await this.execute(job);
        completed++;
      } catch (error) {
        failed++;
        await this.recordFailure(job, error);
      }
    }
    return { claimed: jobs.length, completed, failed };
  }

  private async execute(job: ClaimedJob): Promise<void> {
    const now = this.now();
    await this.prisma.$transaction(async (tx) => {
      const status = job.action === 'PUBLISH' ? 'PUBLISHED' : job.action === 'UNPUBLISH' ? 'UNPUBLISHED' : 'ARCHIVED';
      let changed = 0;
      switch (job.targetType) {
        case 'CONTENT':
          changed = (await tx.content.updateMany({ where: { id: job.targetId, status: { not: 'WITHDRAWN' } }, data: { status, publishedAt: status === 'PUBLISHED' ? now : null } })).count;
          break;
        case 'SEASON':
          changed = (await tx.season.updateMany({ where: { id: job.targetId }, data: { status, publishedAt: status === 'PUBLISHED' ? now : null } })).count;
          break;
        case 'EPISODE':
          changed = (await tx.episode.updateMany({ where: { id: job.targetId }, data: { status, publishedAt: status === 'PUBLISHED' ? now : null } })).count;
          break;
        case 'VIDEO_ASSET':
          changed = (await tx.videoAsset.updateMany({ where: { id: job.targetId }, data: { status, publishedAt: status === 'PUBLISHED' ? now : null } })).count;
          break;
        case 'POSTER':
          if (job.action !== 'ARCHIVE') throw new ValidationError('Action non autorisée pour une affiche');
          changed = (await tx.poster.updateMany({ where: { id: job.targetId, archivedAt: null }, data: { archivedAt: now } })).count;
          break;
        case 'TRAILER':
          if (job.action !== 'ARCHIVE') throw new ValidationError('Action non autorisée pour une bande-annonce');
          changed = (await tx.trailer.updateMany({ where: { id: job.targetId, archivedAt: null }, data: { archivedAt: now } })).count;
          break;
      }
      if (changed !== 1) throw new ConflictError('La cible a disparu ou ne peut plus recevoir cette programmation');

      if (job.notifyFollowers && job.action === 'PUBLISH') {
        await this.createFollowerNotification(tx, job, now);
      }

      await tx.scheduledPublication.update({
        where: { id: job.id },
        data: { status: 'DONE', executedAt: now, lockedAt: null, lockedBy: null, lastError: null },
      });
      await tx.auditLog.create({
        data: {
          source: 'SYSTEM',
          action: `publication.${job.action.toLowerCase()}`,
          entityType: job.targetType,
          entityId: job.targetId,
          newValues: { status, scheduledPublicationId: job.id },
        },
      });
    });
  }

  /** Crée une notification intégrée dans la même transaction que la publication. */
  private async createFollowerNotification(tx: Prisma.TransactionClient, job: ClaimedJob, now: Date): Promise<void> {
    let contentId: string | null = null;
    let type: 'NEW_EPISODE' | 'NEW_SEASON' | 'NEW_LANGUAGE_VERSION';
    let title: string;
    let body: string;
    let followFilter: Record<string, unknown> = {};

    if (job.targetType === 'EPISODE') {
      const episode = await tx.episode.findUnique({
        where: { id: job.targetId },
        select: { number: true, season: { select: { number: true, content: { select: { id: true, title: true } } } } },
      });
      if (!episode) throw new NotFoundError('Épisode introuvable pour la notification');
      contentId = episode.season.content.id;
      type = 'NEW_EPISODE';
      title = 'Nouvel épisode disponible';
      body = episode.season.content.title + ' — saison ' + episode.season.number + ', épisode ' + episode.number;
      followFilter = { notifyNewEpisodes: true };
    } else if (job.targetType === 'SEASON') {
      const season = await tx.season.findUnique({
        where: { id: job.targetId },
        select: { number: true, content: { select: { id: true, title: true } } },
      });
      if (!season) throw new NotFoundError('Saison introuvable pour la notification');
      contentId = season.content.id;
      type = 'NEW_SEASON';
      title = 'Nouvelle saison disponible';
      body = season.content.title + ' — saison ' + season.number;
      followFilter = { notifyNewSeasons: true };
    } else if (job.targetType === 'VIDEO_ASSET') {
      const version = await tx.videoAsset.findUnique({
        where: { id: job.targetId },
        select: {
          content: { select: { id: true, title: true } },
          episode: { select: { season: { select: { content: { select: { id: true, title: true } } } } } },
        },
      });
      const content = version?.content ?? version?.episode?.season.content ?? null;
      if (!content) throw new NotFoundError('Contenu introuvable pour la notification de version');
      contentId = content.id;
      type = 'NEW_LANGUAGE_VERSION';
      title = 'Nouvelle version disponible';
      body = 'Une nouvelle version de ' + content.title + ' est disponible.';
      followFilter = { OR: [{ notifyNewEpisodes: true }, { notifyNewSeasons: true }] };
    } else {
      return;
    }

    const notification = await tx.notification.create({
      data: { type, status: 'SENDING', audience: 'FOLLOWERS', contentId, title, body, dedupeKey: 'scheduled-publication:' + job.id + ':followers' },
    });
    const follows = await tx.follow.findMany({
      where: { contentId, ...followFilter, user: { status: 'ACTIVE', notificationsEnabled: true } },
      select: { userId: true },
    });
    const userIds = [...new Set(follows.map((follow) => follow.userId))];
    const disabled = userIds.length ? await tx.notificationPreference.findMany({
      where: { userId: { in: userIds }, type, enabled: false }, select: { userId: true },
    }) : [];
    const disabledIds = new Set(disabled.map((row) => row.userId));
    const recipients = userIds.filter((id) => !disabledIds.has(id));
    if (recipients.length) {
      await tx.notificationDelivery.createMany({
        data: recipients.map((userId) => ({ notificationId: notification.id, userId, channel: 'IN_APP', status: 'SENT', sentAt: now })),
        skipDuplicates: true,
      });
    }
    await tx.notification.update({ where: { id: notification.id }, data: { status: 'SENT', sentAt: now } });
  }
  private async recordFailure(job: ClaimedJob, error: unknown): Promise<void> {
    const message = (error instanceof Error ? error.message : 'Erreur inconnue').slice(0, 1000);
    const retry = job.attempts < job.maxAttempts;
    await this.prisma.scheduledPublication.updateMany({
      where: { id: job.id, status: 'PROCESSING', lockedBy: this.workerId },
      data: {
        status: retry ? 'PENDING' : 'FAILED',
        lastError: message,
        lockedAt: null,
        lockedBy: null,
      },
    });
  }
}
