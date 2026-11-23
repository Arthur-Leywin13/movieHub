import { ForbiddenError, NotFoundError, ValidationError } from '@movieshub/shared';
import type { PrismaClient } from '@prisma/client';
import type { AdminActor } from '../auth/actor.ts';

const MANAGEABLE_ROLES = ['ADMIN', 'EDITOR', 'MODERATOR'] as const;
type ManagedRole = (typeof MANAGEABLE_ROLES)[number];
type UserStatus = 'ACTIVE' | 'SUSPENDED';

export class AdminManagementService {
  private readonly prisma: PrismaClient;
  constructor(deps: { prisma: PrismaClient }) { this.prisma = deps.prisma; }

  async listUsers(page: number, limit: number, query?: string) {
    const q = query?.trim();
    const where = q ? { OR: [
      { email: { contains: q, mode: 'insensitive' as const } },
      { displayName: { contains: q, mode: 'insensitive' as const } },
    ] } : {};
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.user.count({ where }),
      this.prisma.user.findMany({
        where,
        select: {
          id: true, email: true, displayName: true, locale: true, status: true,
          createdAt: true, lastLoginAt: true,
          admin: { select: { id: true, role: true, isActive: true } },
          _count: { select: { sessions: true, favorites: true, watchHistory: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);
    return { items: rows, total, page, limit };
  }

  async setUserStatus(actor: AdminActor, userId: string, status: UserStatus, ctx: { ip: string; requestId: string }) {
    if (actor.userId === userId) throw new ForbiddenError('Vous ne pouvez pas modifier votre propre compte');
    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id: userId }, include: { admin: true } });
      if (!user) throw new NotFoundError('Utilisateur introuvable');
      if (user.admin?.role === 'SUPER_ADMIN' && status !== 'ACTIVE') {
        const active = await tx.admin.count({ where: { role: 'SUPER_ADMIN', isActive: true, user: { status: 'ACTIVE' } } });
        if (active <= 1) throw new ValidationError('Impossible de suspendre le dernier super-administrateur actif');
      }
      const updated = await tx.user.update({ where: { id: userId }, data: { status } });
      if (status === 'SUSPENDED') {
        await tx.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
      }
      await tx.auditLog.create({ data: {
        source: actor.via === 'bot' ? 'TELEGRAM_BOT' : 'DASHBOARD',
        adminId: actor.adminId, action: 'user.status.update', entityType: 'User', entityId: userId,
        oldValues: { status: user.status }, newValues: { status },
        ipAddress: ctx.ip, requestId: ctx.requestId,
      } });
      return { id: updated.id, status: updated.status };
    });
  }

  async setAdminRole(actor: AdminActor, userId: string, role: ManagedRole, ctx: { ip: string; requestId: string }) {
    if (actor.userId === userId) throw new ForbiddenError('Vous ne pouvez pas modifier vos propres droits');
    if (!MANAGEABLE_ROLES.includes(role)) throw new ValidationError('Rôle administrateur invalide');
    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id: userId }, include: { admin: true } });
      if (!user || user.status !== 'ACTIVE') throw new NotFoundError('Utilisateur actif introuvable');
      if (user.admin?.role === 'SUPER_ADMIN') throw new ForbiddenError('Le rôle du super-administrateur ne peut pas être modifié ici');
      const before = user.admin ? { role: user.admin.role, isActive: user.admin.isActive } : null;
      const admin = await tx.admin.upsert({
        where: { userId },
        create: { userId, role, isActive: true },
        update: { role, isActive: true },
      });
      await tx.auditLog.create({ data: {
        source: actor.via === 'bot' ? 'TELEGRAM_BOT' : 'DASHBOARD',
        adminId: actor.adminId, action: 'admin.role.update', entityType: 'Admin', entityId: admin.id,
        oldValues: before ?? undefined, newValues: { role, isActive: true },
        ipAddress: ctx.ip, requestId: ctx.requestId,
      } });
      return { userId, role: admin.role, isActive: admin.isActive };
    });
  }

  async removeAdmin(actor: AdminActor, userId: string, ctx: { ip: string; requestId: string }) {
    if (actor.userId === userId) throw new ForbiddenError('Vous ne pouvez pas retirer vos propres droits');
    return this.prisma.$transaction(async (tx) => {
      const admin = await tx.admin.findUnique({ where: { userId } });
      if (!admin) throw new NotFoundError('Administrateur introuvable');
      if (admin.role === 'SUPER_ADMIN') throw new ForbiddenError('Un super-administrateur ne peut pas être rétrogradé ici');
      const updated = await tx.admin.update({ where: { userId }, data: { isActive: false } });
      await tx.auditLog.create({ data: {
        source: actor.via === 'bot' ? 'TELEGRAM_BOT' : 'DASHBOARD',
        adminId: actor.adminId, action: 'admin.access.revoke', entityType: 'Admin', entityId: admin.id,
        oldValues: { role: admin.role, isActive: admin.isActive }, newValues: { role: admin.role, isActive: false },
        ipAddress: ctx.ip, requestId: ctx.requestId,
      } });
      return { userId, role: updated.role, isActive: updated.isActive };
    });
  }
}
