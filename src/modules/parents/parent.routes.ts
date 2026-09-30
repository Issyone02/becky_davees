import { Router } from 'express';
import { authenticate, requireRole } from '../../core/auth/auth.middleware';
import { db } from '../../config/db';
import { success, paginated } from '../../shared/response';
import { parsePagination } from '../../shared/pagination';

const router = Router();
router.use(authenticate);
router.use(requireRole('SUPER_ADMIN', 'ADMIN'));

router.get('/', async (req, res, next) => {
  try {
    const p = parsePagination(req);
    const where: any = { user: { role: 'PARENT' } };
    if (p.search) where.user.fullName = { contains: p.search };
    const [data, total] = await Promise.all([
      db.parent.findMany({
        where, skip: p.skip, take: p.pageSize,
        orderBy: { createdAt: 'desc' },
        include: {
          user: { select: { id: true, fullName: true, email: true, phone: true, status: true } },
          students: { include: { student: { select: { id: true, studentId: true, fullName: true, classId: true } } } },
        },
      }),
      db.parent.count({ where }),
    ]);
    paginated(res, data, { page: p.page, pageSize: p.pageSize, total, totalPages: Math.ceil(total / p.pageSize) });
  } catch (e) { next(e); }
});

export default router;