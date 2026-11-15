import { ConflictError, NotFoundError, ValidationError } from '@movieshub/shared';
import type { PrismaClient } from '@movieshub/database';
import type { AdminActor } from '../auth/actor.ts';

interface ScheduleWithdrawalInput { contentId: string; noticeStartsAt: string; effectiveAt: string; message?: string | null; }
interface RequestContext { ip: string; requestId: string; }

/** Retraits annoncés : notification à noticeStartsAt, retrait effectif à effectiveAt. */
export class ContentWithdrawalService {
  private readonly prisma: PrismaClient;
  private readonly now: () => Date;
  constructor(deps: { prisma: PrismaClient; now?: () => Date }) { this.prisma = deps.prisma; this.now = deps.now ?? (() => new Date()); }

  async schedule(actor: AdminActor, input: ScheduleWithdrawalInput, ctx: RequestContext) {
    const noticeStartsAt = new Date(input.noticeStartsAt);
    const effectiveAt = new Date(input.effectiveAt);
    const now = this.now();
    if (!Number.isFinite(noticeStartsAt.getTime()) || !Number.isFinite(effectiveAt.getTime())) throw new ValidationError('Dates de retrait invalides');
    if (noticeStartsAt.getTime() < now.getTime()) throw new ValidationError('La date de début d’annonce ne peut pas être passée', { field: 'noticeStartsAt' });
    if (effectiveAt.getTime() <= now.getTime() || effectiveAt.getTime() <= noticeStartsAt.getTime()) throw new ValidationError('Le retrait effectif doit être après le début de l’annonce et dans le futur', { field: 'effectiveAt' });
    const message = input.message?.trim() || null;
    if (message && message.length > 2000) throw new ValidationError('Le message ne peut pas dépasser 2 000 caractères', { field: 'message' });
    return this.prisma.$transaction(async (tx) => {
      const lockedContent = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "Content" WHERE "id" = ${input.contentId}::uuid FOR UPDATE`;
      if (lockedContent.length === 0) throw new NotFoundError('Contenu introuvable');
      const content = await tx.content.findUnique({ where: { id: input.contentId }, select: { id: true, title: true, status: true } });
      if (!content) throw new NotFoundError('Contenu introuvable');
      if (content.status === 'WITHDRAWN' || content.status === 'ARCHIVED') throw new ConflictError('Ce contenu est déjà retiré ou archivé');
      const active = await tx.contentWithdrawal.findFirst({ where: { contentId: input.contentId, executedAt: null, canceledAt: null }, select: { id: true } });
      if (active) throw new ConflictError('Un retrait est déjà programmé pour ce contenu');
      const withdrawal = await tx.contentWithdrawal.create({ data: { contentId: input.contentId, noticeStartsAt, effectiveAt, message, createdByAdminId: actor.adminId } });
      await tx.auditLog.create({
        data: { source: actor.via === 'bot' ? 'TELEGRAM_BOT' : 'DASHBOARD', adminId: actor.adminId, action: 'content.withdrawal.schedule', entityType: 'ContentWithdrawal', entityId: withdrawal.id, newValues: { contentId: input.contentId, noticeStartsAt: noticeStartsAt.toISOString(), effectiveAt: effectiveAt.toISOString() }, ipAddress: ctx.ip, requestId: ctx.requestId },
      });
      return withdrawal;
    });
  }

  async cancel(actor: AdminActor, id: string, ctx: RequestContext) {
    return this.prisma.$transaction(async (tx) => {
      const withdrawal = await tx.contentWithdrawal.findUnique({ where: { id } });
      if (!withdrawal) throw new NotFoundError('Retrait programmé introuvable');
      if (withdrawal.executedAt || withdrawal.canceledAt) throw new ConflictError('Ce retrait est déjà exécuté ou annulé');
      const updated = await tx.contentWithdrawal.updateMany({ where: { id, executedAt: null, canceledAt: null }, data: { canceledAt: this.now() } });
      if (updated.count !== 1) throw new ConflictError('Le retrait a déjà été pris en charge');
      await tx.auditLog.create({ data: { source: actor.via === 'bot' ? 'TELEGRAM_BOT' : 'DASHBOARD', adminId: actor.adminId, action: 'content.withdrawal.cancel', entityType: 'ContentWithdrawal', entityId: id, newValues: { canceledAt: this.now().toISOString() }, ipAddress: ctx.ip, requestId: ctx.requestId } });
      return { id, canceled: true };
    });
  }

  async list(page = 1, limit = 20) {
    const where = {};
    const [items, total] = await this.prisma.$transaction([
      this.prisma.contentWithdrawal.findMany({ where, include: { content: { select: { id: true, title: true, slug: true, status: true } } }, orderBy: [{ effectiveAt: 'asc' }, { createdAt: 'desc' }], skip: (page - 1) * limit, take: limit }),
      this.prisma.contentWithdrawal.count({ where }),
    ]);
    return { items, total, page, limit };
  }

  /** Cycle idempotent : dédoublonnage de l’annonce via Notification.dedupeKey. */
  async runOnce(batchSize = 25): Promise<{ notices: number; withdrawn: number; failed: number }> {
    const now = this.now();
    const due = await this.prisma.contentWithdrawal.findMany({
      where: { canceledAt: null, executedAt: null, OR: [{ noticeStartsAt: { lte: now } }, { effectiveAt: { lte: now } }] },
      orderBy: [{ effectiveAt: 'asc' }, { noticeStartsAt: 'asc' }], take: batchSize,
      include: { content: { select: { id: true, title: true, status: true } } },
    });
    let notices = 0; let withdrawn = 0; let failed = 0;
    for (const item of due) {
      try {
        const result = await this.prisma.$transaction(async (tx) => {
          const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "ContentWithdrawal" WHERE "id" = ${item.id}::uuid AND "canceledAt" IS NULL AND "executedAt" IS NULL FOR UPDATE SKIP LOCKED`;
          if (locked.length === 0) return { notice: false, withdrawn: false };
          const current = await tx.contentWithdrawal.findUnique({ where: { id: item.id }, include: { content: { select: { id: true, title: true, status: true } } } });
          if (!current || current.canceledAt || current.executedAt) return { notice: false, withdrawn: false };
          let notice = false;
          if (current.noticeStartsAt <= now) {
            const key = 'content-withdrawal:' + current.id + ':notice';
            const existing = await tx.notification.findUnique({ where: { dedupeKey: key }, select: { id: true } });
            if (!existing) {
              const notification = await tx.notification.create({ data: { type: 'CONTENT_WITHDRAWAL', status: 'SENDING', audience: 'FOLLOWERS', contentId: current.contentId, title: 'Retrait annoncé', body: current.message || '« ' + current.content.title + ' » sera bientôt retiré du catalogue.', dedupeKey: key } });
              const follows = await tx.follow.findMany({ where: { contentId: current.contentId, user: { status: 'ACTIVE', notificationsEnabled: true } }, select: { userId: true } });
              const ids = [...new Set(follows.map((f) => f.userId))];
              const disabled = ids.length ? await tx.notificationPreference.findMany({ where: { userId: { in: ids }, type: 'CONTENT_WITHDRAWAL', enabled: false }, select: { userId: true } }) : [];
              const disabledIds = new Set(disabled.map((p) => p.userId));
              const recipients = ids.filter((id) => !disabledIds.has(id));
              if (recipients.length) await tx.notificationDelivery.createMany({ data: recipients.map((userId) => ({ notificationId: notification.id, userId, channel: 'IN_APP', status: 'SENT', sentAt: now })), skipDuplicates: true });
              await tx.notification.update({ where: { id: notification.id }, data: { status: 'SENT', sentAt: now } });
              notice = true;
            }
          }
          let didWithdraw = false;
          if (current.effectiveAt <= now) {
            const changed = await tx.content.updateMany({ where: { id: current.contentId, status: { not: 'WITHDRAWN' } }, data: { status: 'WITHDRAWN' } });
            if (changed.count === 0 && current.content.status !== 'WITHDRAWN') throw new ConflictError('Le contenu ne peut pas être retiré');
            await tx.contentWithdrawal.update({ where: { id: current.id }, data: { executedAt: now } });
            await tx.auditLog.create({ data: { source: 'SYSTEM', action: 'content.withdrawal.execute', entityType: 'Content', entityId: current.contentId, newValues: { withdrawalId: current.id, status: 'WITHDRAWN' } } });
            didWithdraw = true;
          }
          return { notice, withdrawn: didWithdraw };
        });
        if (result.notice) notices++; if (result.withdrawn) withdrawn++;
      } catch {
        // Le prochain cycle retentera ; aucune ligne n'est marquée comme exécutée avant la transaction.
        failed++;
      }
    }
    return { notices, withdrawn, failed };
  }
}