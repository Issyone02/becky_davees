import { db } from '../../config/db';
import { NotFoundError, ValidationError, ConflictError } from '../../shared/errors';
import { hashPassword, validatePasswordStrength } from '../../core/auth/password';
import { logAudit } from '../../core/audit/audit.service';
import { parsePagination } from '../../shared/pagination';
import { Request } from 'express';

export async function listUsers(req: Request) {
  const { skip, page, pageSize, search, sortBy, sortOrder } = parsePagination(req);
  const where: any = { deletedAt: null };
  if (search) {
    where.OR = [
      { fullName: { contains: search } },
      { email: { contains: search } },
    ];
  }
  const [data, total] = await Promise.all([
    db.user.findMany({
      where, skip, take: pageSize,
      orderBy: sortBy ? { [sortBy]: sortOrder } : { createdAt: 'desc' },
      select: {
        id: true, email: true, username: true, fullName: true, role: true,
        status: true, createdAt: true, lastLoginAt: true,
      },
    }),
    db.user.count({ where }),
  ]);
  return { data, meta: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } };
}

export async function createUser(input: {
  email: string; fullName: string; role: 'ADMIN' | 'TEACHER' | 'PARENT';
  password: string; phone?: string; username?: string;
}, createdBy: string) {
  const strength = validatePasswordStrength(input.password);
  if (!strength.valid) throw new ValidationError('Invalid password', strength.issues);

  const existing = await db.user.findFirst({
    where: { OR: [{ email: input.email }, input.phone ? { phone: input.phone } : {}] },
  });
  if (existing) throw new ConflictError('Email or phone already in use');

  const passwordHash = await hashPassword(input.password);
  const user = await db.user.create({
    data: {
      email: input.email, fullName: input.fullName, role: input.role,
      passwordHash, phone: input.phone, username: input.username,
      status: 'ACTIVE', mustChangePassword: true, emailVerifiedAt: new Date(),
    },
  });

  if (input.role === 'TEACHER') {
    await db.teacher.create({ data: { userId: user.id, teacherCode: `TCH-${Date.now()}` } });
  } else if (input.role === 'PARENT') {
    await db.parent.create({ data: { userId: user.id, parentCode: `PAR-${Date.now()}` } });
  }

  await logAudit({
    userId: createdBy, userRole: 'ADMIN', action: 'user.created',
    entityType: 'User', entityId: user.id,
    afterValues: { email: user.email, role: user.role },
  });

  return user;
}

export async function getUser(id: string) {
  const user = await db.user.findUnique({ where: { id, deletedAt: null } });
  if (!user) throw new NotFoundError('User', id);
  return user;
}

export async function updateUser(id: string, data: Partial<{ fullName: string; phone: string; status: string }>, updatedBy: string) {
  const before = await getUser(id);
  const user = await db.user.update({ where: { id }, data });
  await logAudit({
    userId: updatedBy, userRole: 'ADMIN', action: 'user.updated',
    entityType: 'User', entityId: id,
    beforeValues: { fullName: before.fullName, status: before.status },
    afterValues: { fullName: user.fullName, status: user.status },
  });
  return user;
}