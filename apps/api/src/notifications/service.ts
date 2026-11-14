import { ConflictError, NotFoundError, ValidationError } from '@movieshub/shared';
import { Prisma, type PrismaClient, type NotificationType } from '@prisma/client';
import type { AdminActor } from '../auth/actor.ts';

const TYPES = [
  'NEW_EPISODE', 'NEW_SEASON', 'NEW_LANGUAGE_VERSION', 'ANNOUNCEMENT',
  'MAINTENANCE', 'CATALOG_CHANGE', 'CONTENT_WITHDRAWAL', 'ACCOUNT', 'OPERATION_CONFIRMATION',
] as const;
type TypeName = (typeof TYPES)[number];
type Audience = 'ALL' | 'FOLLOWERS' | 'USER' | 'SEGMENT';

export interface CreateNotificationInput {
  type: TypeName;
  audience: Audience;
  title: string;
  body: string;
  contentId?: string;
  targetUserId?: string;
  data?: Record<string, unknown>;
  dedupeKey?: string;
}

export class NotificationService {
  private readonly prisma: PrismaClient;
  constructor(deps: { prisma: PrismaClient }) {
    this.prisma = deps.prisma;
  }

  async createCampaign(actor: AdminActor, input: CreateNotificationInput, ctx: { ip: string; requestId: string }) {
    if (input.audience === 'SEGMENT') {
      throw new ValidationError('Le ciblage SEGMENT sera activé avec le module de segmentation');
    }
    if (input.audience === 'USER' && !input.targetUserId) {
      throw new ValidationError('targetUserId est obligatoire pour une notification USER', { field: 'targetUserId' });
    }
    if (input.audience !== 'USER' && input.targetUserId) {
      throw new ValidationError('targetUserId est réservé à audience USER', { field: 'targetUserId' });
    }
    if (input.audience === 'FOLLOWERS' && !input.contentId) {
      throw new ValidationError('contentId est obligatoire pour cibler les abonnés', { field: 'contentId' });
    }
    if (input.type === 'NEW_EPISODE' || input.type === 'NEW_SEASON' || input.type === 'NEW_LANGUAGE_VERSION') {
      if (!input.contentId) throw new ValidationError('contentId est obligatoire pour cette notification', { field: 'contentId' });
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        if (input.contentId) {
          const content = await tx.content.findUnique({ where: { id: input.contentId }, select: { id: true } });
          if (!content) throw new NotFoundError('Contenu introuvable');
        }
        const notification = await tx.notification.create({
          data: {
            type: input.type as NotificationType,
            status: 'SENDING',
            audience: input.audience,
            targetUserId: input.targetUserId ?? null,
            contentId: input.contentId ?? null,
            title: input.title.trim(),
            body: input.body.trim(),
            data: input.data ? (input.data as Prisma.InputJsonValue) : undefined,
            dedupeKey: input.dedupeKey ?? null,
            createdByAdminId: actor.adminId,
          },
        });

        let recipientIds: string[];
        if (input.audience === 'USER') {
          const user = await tx.user.findFirst({
            where: { id: input.targetUserId, status: 'ACTIVE', notificationsEnabled: true },
            select: { id: true },
          });
          recipientIds = user ? [user.id] : [];
        } else if (input.audience === 'FOLLOWERS') {
          const followFilter = input.type === 'NEW_EPISODE'
            ? { notifyNewEpisodes: true }
            : input.type === 'NEW_SEASON'
              ? { notifyNewSeasons: true }
              : {};
          const follows = await tx.follow.findMany({
            where: { contentId: input.contentId, ...followFilter, user: { status: 'ACTIVE', notificationsEnabled: true } },
            select: { userId: true },
          });
          recipientIds = follows.map((f) => f.userId);
        } else {
          const users = await tx.user.findMany({
            where: { status: 'ACTIVE', notificationsEnabled: true },
            select: { id: true },
          });
          recipientIds = users.map((u) => u.id);
        }

        const disabled = await tx.notificationPreference.findMany({
          where: { type: input.type, enabled: false, userId: { in: recipientIds } },
          select: { userId: true },
        });
        const disabledIds = new Set(disabled.map((p) => p.userId));
        const eligible = [...new Set(recipientIds)].filter((id) => !disabledIds.has(id));

        if (eligible.length) {
          await tx.notificationDelivery.createMany({
            data: eligible.map((userId) => ({
              notificationId: notification.id,
              userId,
              channel: 'IN_APP',
              status: 'SENT',
              sentAt: new Date(),
            })),
            skipDuplicates: true,
          });
        }
        const sent = await tx.notification.update({
          where: { id: notification.id },
          data: { status: 'SENT', sentAt: new Date() },
        });
        await tx.auditLog.create({
          data: {
            source: actor.via === 'bot' ? 'TELEGRAM_BOT' : 'DASHBOARD',
            adminId: actor.adminId,
            action: 'notification.send',
            entityType: 'Notification',
            entityId: notification.id,
            newValues: {
              type: input.type, audience: input.audience, recipientCount: eligible.length,
              ...(input.contentId ? { contentId: input.contentId } : {}),
            },
            ipAddress: ctx.ip,
            requestId: ctx.requestId,
          },
        });
        return { notification: sent, recipientCount: eligible.length, channel: 'IN_APP' as const };
      });
    } catch (error) {
      if (input.dedupeKey && error && typeof error === 'object' && 'code' in error && error.code === 'P2002') {
        throw new ConflictError('Cette notification a déjà été envoyée (dedupeKey)');
      }
      throw error;
    }
  }

  async listForUser(userId: string, page: number, limit: number, unreadOnly = false) {
    const where = { userId, channel: 'IN_APP' as const, ...(unreadOnly ? { readAt: null } : {}) };
    const [total, unread, rows] = await this.prisma.$transaction([
      this.prisma.notificationDelivery.count({ where }),
      this.prisma.notificationDelivery.count({ where: { userId, channel: 'IN_APP', readAt: null } }),
      this.prisma.notificationDelivery.findMany({
        where,
        include: { notification: { select: { id: true, type: true, title: true, body: true, data: true, contentId: true, createdAt: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);
    return {
      items: rows.map((row) => ({
        id: row.id, readAt: row.readAt, createdAt: row.createdAt,
        notification: row.notification,
      })),
      total, unread, page, limit,
    };
  }

  async markRead(userId: string, deliveryId: string) {
    const result = await this.prisma.notificationDelivery.updateMany({
      where: { id: deliveryId, userId, channel: 'IN_APP', readAt: null },
      data: { readAt: new Date() },
    });
    if (result.count === 0) {
      const existing = await this.prisma.notificationDelivery.findFirst({
        where: { id: deliveryId, userId, channel: 'IN_APP' },
        select: { id: true },
      });
      if (!existing) throw new NotFoundError('Notification introuvable');
    }
    return { id: deliveryId, read: true };
  }

  async markAllRead(userId: string) {
    const result = await this.prisma.notificationDelivery.updateMany({
      where: { userId, channel: 'IN_APP', readAt: null },
      data: { readAt: new Date() },
    });
    return { updated: result.count };
  }

  async preferences(userId: string) {
    const rows = await this.prisma.notificationPreference.findMany({ where: { userId } });
    const saved = new Map(rows.map((row) => [row.type, row.enabled]));
    return TYPES.map((type) => ({ type, enabled: saved.get(type) ?? true }));
  }

  async updatePreference(userId: string, type: TypeName, enabled: boolean) {
    return this.prisma.notificationPreference.upsert({
      where: { userId_type: { userId, type } },
      create: { userId, type, enabled },
      update: { enabled },
    });
  }
}
