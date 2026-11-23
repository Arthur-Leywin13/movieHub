import type { PrismaClient } from '@prisma/client';
import type { AdminActor } from '../auth/actor.ts';

export interface AuditLogPage {
  items: Array<{
    id: string;
    occurredAt: Date;
    source: string;
    admin: { displayName: string; email: string } | null;
    action: string;
    entityType: string;
    entityId: string | null;
    result: string;
    errorMessage: string | null;
    ipAddress: string | null;
    requestId: string | null;
  }>;
  total: number;
  page: number;
  limit: number;
}

/** Consultation en lecture seule des actions sensibles. Les valeurs JSON brutes ne sont pas exposées. */
export class AuditLogService {
  private readonly prisma: PrismaClient;

  constructor(deps: { prisma: PrismaClient }) {
    this.prisma = deps.prisma;
  }

  async list(_actor: AdminActor, page: number, limit: number): Promise<AuditLogPage> {
    const where = {};
    const [total, rows] = await Promise.all([
      this.prisma.auditLog.count({ where }),
      this.prisma.auditLog.findMany({
        where,
        include: {
          admin: {
            include: {
              user: { select: { displayName: true, email: true } },
            },
          },
        },
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    return {
      items: rows.map((row) => ({
        id: row.id.toString(),
        occurredAt: row.occurredAt,
        source: row.source,
        admin: row.admin ? {
          displayName: row.admin.user.displayName,
          email: row.admin.user.email,
        } : null,
        action: row.action,
        entityType: row.entityType,
        entityId: row.entityId,
        result: row.result,
        errorMessage: row.errorMessage,
        ipAddress: row.ipAddress,
        requestId: row.requestId,
      })),
      total,
      page,
      limit,
    };
  }
}
