import { Router } from 'express';
import { authenticate, requireRole } from '../../core/auth/auth.middleware';
import { db } from '../../config/db';
import { success, paginated } from '../../shared/response';
import { parsePagination } from '../../shared/pagination';
import { NotFoundError } from '../../shared/errors';
import { z } from 'zod';

const router = Router();
router.use(authenticate);

router.get('/', requireRole('SUPER_ADMIN', 'ADMIN'), async (req, res, next) => {
  try {
    const p = parsePagination(req);
    const where: any = { user: { role: 'TEACHER' } };
    if (p.search) where.user.fullName = { contains: p.search };
    const [data, total] = await Promise.all([
      db.teacher.findMany({
        where, skip: p.skip, take: p.pageSize,
        orderBy: { createdAt: 'desc' },
        include: { user: { select: { id: true, fullName: true, email: true, phone: true, status: true } } },
      }),
      db.teacher.count({ where }),
    ]);
    paginated(res, data, { page: p.page, pageSize: p.pageSize, total, totalPages: Math.ceil(total / p.pageSize) });
  } catch (e) { next(e); }
});

router.patch('/my-signature', requireRole('TEACHER'), async (req, res, next) => {
  try {
    const { url } = z.object({ url: z.string().min(1) }).parse(req.body);
    const teacher = await db.teacher.findUnique({ where: { userId: req.user!.id } });
    if (!teacher) throw new NotFoundError('Teacher profile');
    const updated = await db.teacher.update({ where: { id: teacher.id }, data: { signatureUrl: url } });
    success(res, updated);
  } catch (e) { next(e); }
});

router.get('/my-students', requireRole('TEACHER'), async (req, res, next) => {
  try {
    const teacher = await db.teacher.findUnique({ where: { userId: req.user!.id } });
    if (!teacher) { success(res, []); return; }
    const current = await db.term.findFirst({ where: { isCurrent: true } });
    const assignments = await db.teacherClassSubject.findMany({
      where: { teacherId: teacher.id, ...(current ? { termId: current.id } : {}) },
      select: { classId: true },
    });
    const classIds = Array.from(new Set(assignments.map((a) => a.classId)));
    const students = await db.student.findMany({
      where: { classId: { in: classIds }, status: 'active' },
      include: { class: { select: { name: true } } },
      orderBy: [{ class: { name: 'asc' } }, { fullName: 'asc' }],
    });
    success(res, students);
  } catch (e) { next(e); }
});

export default router;