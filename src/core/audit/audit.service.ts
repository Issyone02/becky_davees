import { db } from '../../config/db';
import { Request } from 'express';

export interface AuditInput {
  userId?: string | null;
  userRole?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  beforeValues?: Record<string, unknown> | null;
  afterValues?: Record<string, unknown> | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  req?: Request;
}

export async function logAudit(input: AuditInput): Promise<void> {
  const { userId, userRole, action, entityType, entityId, beforeValues, afterValues, req, ipAddress, userAgent } = input;

  await db.auditLog.create({
    data: {
      userId,
      userRole,
      action,
      entityType,
      entityId,
      beforeValues: beforeValues ? JSON.stringify(beforeValues) : null,
      afterValues: afterValues ? JSON.stringify(afterValues) : null,
      ipAddress: ipAddress ?? req?.ip ?? req?.socket.remoteAddress ?? null,
      userAgent: userAgent ?? (req?.headers['user-agent'] as string) ?? null,
      sessionId: (req?.headers['x-session-id'] as string) ?? null,
    },
  });
}

export function auditMiddleware(action: string, entityType: string, entityIdFn?: (req: any) => string | undefined) {
  return async (req: any, _res: any, next: any) => {
    try {
      const entityId = entityIdFn ? entityIdFn(req) : undefined;
      await logAudit({
        userId: req.user?.id,
        userRole: req.user?.role,
        action,
        entityType,
        entityId,
        req,
      });
    } catch (e) {
      console.error('Audit log failed (non-fatal):', e);
    }
    next();
  };
}