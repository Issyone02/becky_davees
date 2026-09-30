import { Router } from 'express';
import { authenticate, requireRole } from '../../core/auth/auth.middleware';
import { db } from '../../config/db';
import { paginated } from '../../shared/response';
import { parsePagination } from '../../shared/pagination';

const router = Router();
router.use(authenticate);
router.use(requireRole('SUPER_ADMIN', 'ADMIN'));

router.get('/', async (req, res, next) => {
  try {
    const p = parsePagination(req);
    const where: any = {};
    if (p.search) {
      where.OR = [
        { action: { contains: p.search } },
        { entityType: { contains: p.search } },
        { entityId: { contains: p.search } },
        { user: { fullName: { contains: p.search } } },
      ];
    }
    const [items, total] = await Promise.all([
      db.auditLog.findMany({
        where, skip: p.skip, take: p.pageSize, orderBy: { createdAt: 'desc' },
        include: { user: { select: { fullName: true, role: true } } },
      }),
      db.auditLog.count({ where }),
    ]);
    paginated(res, items, { page: p.page, pageSize: p.pageSize, total, totalPages: Math.ceil(total / p.pageSize) });
  } catch (e) { next(e); }
});

export default router;