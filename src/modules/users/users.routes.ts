import { Router } from 'express';
import { authenticate, requireRole } from '../../core/auth/auth.middleware';
import { db } from '../../config/db';
import { success, paginated } from '../../shared/response';
import { parsePagination } from '../../shared/pagination';
import { NotFoundError, ValidationError } from '../../shared/errors';
import { logAudit } from '../../core/audit/audit.service';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import * as notify from '../../core/notify/notify.service';

const router = Router();
router.use(authenticate);

router.get('/', requireRole('SUPER_ADMIN'), async (req, res, next) => {
  try {
    const p = parsePagination(req);
    const q = z.object({ role: z.string().optional(), status: z.string().optional() }).parse(req.query);
    const where: any = { deletedAt: null };
    if (p.search) {
      where.OR = [
        { fullName: { contains: p.search } },
        { email: { contains: p.search } },
        { username: { contains: p.search } },
      ];
    }
    if (q.role) where.role = q.role;
    if (q.status) where.status = q.status;
    const [items, total] = await Promise.all([
      db.user.findMany({
        where, skip: p.skip, take: p.pageSize, orderBy: { createdAt: 'desc' },
        select: { id: true, fullName: true, email: true, username: true, phone: true, role: true, status: true, mustChangePassword: true, lastLoginAt: true, createdAt: true },
      }),
      db.user.count({ where }),
    ]);
    paginated(res, items, { page: p.page, pageSize: p.pageSize, total, totalPages: Math.ceil(total / p.pageSize) });
  } catch (e) { next(e); }
});

// ---------- Self-service profile (all roles) ----------
router.patch('/me/profile', authenticate, async (req, res, next) => {
  try {
    const q = z.object({
      fullName: z.string().min(2).optional(),
      phone: z.string().min(7).nullable().optional(),
      profilePictureUrl: z.string().nullable().optional(),
    }).parse(req.body);
    const before = await db.user.findUnique({ where: { id: req.user!.id } });
    if (!before) throw new NotFoundError('User', req.user!.id);
    const updated = await db.user.update({ where: { id: before.id }, data: q });
    await logAudit({
      userId: req.user!.id, userRole: req.user!.role,
      action: 'user.profile_updated', entityType: 'User', entityId: before.id,
      beforeValues: { fullName: before.fullName, phone: before.phone, profilePictureUrl: before.profilePictureUrl },
      afterValues: q,
    });
    success(res, {
      id: updated.id, email: updated.email, username: updated.username,
      fullName: updated.fullName, role: updated.role,
      mustChangePassword: updated.mustChangePassword,
      profilePictureUrl: updated.profilePictureUrl, phone: updated.phone,
    });
  } catch (e) { next(e); }
});



router.patch('/:id/role', requireRole('SUPER_ADMIN'), async (req, res, next) => {
  try {
    const { role } = z.object({ role: z.enum(['SUPER_ADMIN', 'ADMIN', 'TEACHER', 'PARENT']) }).parse(req.body);
    const target = await db.user.findUnique({ where: { id: req.params.id } });
    if (!target) throw new NotFoundError('User', req.params.id);
    if (target.id === req.user!.id) throw new ValidationError('You cannot change your own role.');
    if (target.role === 'SUPER_ADMIN' && role !== 'SUPER_ADMIN') {
      const count = await db.user.count({ where: { role: 'SUPER_ADMIN', status: 'ACTIVE' } });
      if (count <= 1) throw new ValidationError('Cannot demote the last active Super Admin.');
    }
    const updated = await db.user.update({ where: { id: target.id }, data: { role } });
    if (role === 'PARENT') {
      const profile = await db.parent.findUnique({ where: { userId: target.id } });
      if (!profile) {
        await db.parent.create({ data: { userId: target.id, parentCode: `PAR-${randomUUID().slice(0, 8).toUpperCase()}` } });
      }
    }
    if (role === 'TEACHER') {
      const profile = await db.teacher.findUnique({ where: { userId: target.id } });
      if (!profile) {
        await db.teacher.create({ data: { userId: target.id, teacherCode: `TCH-${randomUUID().slice(0, 8).toUpperCase()}` } });
      }
    }
    await logAudit({ userId: req.user!.id, userRole: req.user!.role, action: 'user.role_changed', entityType: 'User', entityId: target.id, beforeValues: { role: target.role }, afterValues: { role } });
    success(res, updated);
  } catch (e) { next(e); }
});

router.patch('/:id/status', requireRole('SUPER_ADMIN'), async (req, res, next) => {
  try {
    const { status } = z.object({ status: z.enum(['ACTIVE', 'PENDING', 'SUSPENDED', 'DEACTIVATED']) }).parse(req.body);
    const target = await db.user.findUnique({ where: { id: req.params.id } });
    if (!target) throw new NotFoundError('User', req.params.id);
    if (target.id === req.user!.id) throw new ValidationError('You cannot change your own status.');
    if (target.role === 'SUPER_ADMIN' && status !== 'ACTIVE') {
      const count = await db.user.count({ where: { role: 'SUPER_ADMIN', status: 'ACTIVE' } });
      if (count <= 1) throw new ValidationError('Cannot suspend the last active Super Admin.');
    }
    const updated = await db.user.update({ where: { id: target.id }, data: { status } });
    if (status === 'SUSPENDED' || status === 'DEACTIVATED') {
      await db.refreshToken.deleteMany({ where: { userId: target.id } });
    }
    await logAudit({ userId: req.user!.id, userRole: req.user!.role, action: 'user.status_changed', entityType: 'User', entityId: target.id, beforeValues: { status: target.status }, afterValues: { status } });
    success(res, updated);
  } catch (e) { next(e); }
});

router.post('/:id/reset-password', requireRole('SUPER_ADMIN'), async (req, res, next) => {
  try {
    const target = await db.user.findUnique({ where: { id: req.params.id } });
    if (!target) throw new NotFoundError('User', req.params.id);
    if (target.role === 'SUPER_ADMIN') throw new ValidationError('The Super Admin password cannot be changed in-app.');
    const temp = `Temp${Math.random().toString(36).slice(2, 8)}!${Math.floor(100 + Math.random() * 900)}`;
    const hash = await bcrypt.hash(temp, 10);
    await db.user.update({
      where: { id: target.id },
      data: { passwordHash: hash, mustChangePassword: true, passwordChangedAt: new Date() },
    });
    await db.userPasswordHistory.create({ data: { userId: target.id, passwordHash: hash } });
    void notify.emailPasswordReset(target.id, temp);
    await logAudit({ userId: req.user!.id, userRole: req.user!.role, action: 'user.password_reset_by_admin', entityType: 'User', entityId: target.id, afterValues: { mustChangePassword: true } });
    success(res, { temporaryPassword: temp });
  } catch (e) { next(e); }
});


// ---------- Teacher/Parent Lifecycle Management ----------
router.patch('/:id/account-status', requireRole('SUPER_ADMIN', 'ADMIN'), async (req, res, next) => {
  try {
    const { status } = z.object({ status: z.enum(['ACTIVE', 'DEACTIVATED', 'SUSPENDED']) }).parse(req.body);
    const target = await db.user.findUnique({ where: { id: req.params.id } });
    if (!target) throw new NotFoundError('User', req.params.id);
    if (target.id === req.user!.id) throw new ValidationError('You cannot change your own account status.');
    if (target.role !== 'TEACHER' && target.role !== 'PARENT') {
      throw new ValidationError('This endpoint manages teacher and parent accounts only.');
    }
    const updated = await db.user.update({ where: { id: target.id }, data: { status } });
    if (status !== 'ACTIVE') await db.refreshToken.deleteMany({ where: { userId: target.id } });
    await logAudit({ userId: req.user!.id, userRole: req.user!.role, action: 'user.account_status_changed', entityType: 'User', entityId: target.id, beforeValues: { status: target.status }, afterValues: { status } });
    success(res, updated);
  } catch (e) { next(e); }
});

router.delete('/:id/account', requireRole('SUPER_ADMIN', 'ADMIN'), async (req, res, next) => {
  try {
    const target = await db.user.findUnique({ where: { id: req.params.id } });
    if (!target) throw new NotFoundError('User', req.params.id);
    if (target.id === req.user!.id) throw new ValidationError('You cannot delete your own account.');
    if (target.role !== 'TEACHER' && target.role !== 'PARENT') {
      throw new ValidationError('Only teacher and parent accounts can be deleted from here.');
    }
    if (target.deletedAt) throw new ValidationError('This account is already deleted.');
    const updated = await db.user.update({
      where: { id: target.id },
      data: { deletedAt: new Date(), status: 'DEACTIVATED' },
    });
    await db.refreshToken.deleteMany({ where: { userId: target.id } });
    await logAudit({ userId: req.user!.id, userRole: req.user!.role, action: 'user.deleted', entityType: 'User', entityId: target.id, beforeValues: { status: target.status, role: target.role }, afterValues: { deletedAt: String(updated.deletedAt) } });
    success(res, updated);
  } catch (e) { next(e); }
});

export default router;