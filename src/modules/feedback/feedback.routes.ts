import { Router } from 'express';
import { authenticate, requireRole } from '../../core/auth/auth.middleware';
import * as svc from './feedback.service';
import { success, paginated } from '../../shared/response';
import { parsePagination } from '../../shared/pagination';
import { z } from 'zod';

const router = Router();
router.use(authenticate);
const adminOnly = requireRole('SUPER_ADMIN', 'ADMIN');
const submitterOnly = requireRole('TEACHER', 'PARENT');

router.get('/mine', submitterOnly, async (req, res, next) => {
  try { success(res, await svc.listMine(req.user!.id)); } catch (e) { next(e); }
});

router.post('/', submitterOnly, async (req, res, next) => {
  try {
    const q = z.object({
      category: z.string().min(2), priority: z.string().min(2),
      subject: z.string().min(3), message: z.string().min(10),
      attachmentUrl: z.string().nullish(),
    }).parse(req.body);
    success(res, await svc.createFeedback({ id: req.user!.id, role: req.user!.role }, q), 201);
  } catch (e) { next(e); }
});

router.get('/', adminOnly, async (req, res, next) => {
  try {
    const p = parsePagination(req);
    const q = z.object({ status: z.string().optional(), category: z.string().optional(), priority: z.string().optional() }).parse(req.query);
    const { items, total } = await svc.listForAdmin({ ...q, search: p.search, skip: p.skip, take: p.pageSize });
    paginated(res, items, { page: p.page, pageSize: p.pageSize, total, totalPages: Math.ceil(total / p.pageSize) });
  } catch (e) { next(e); }
});

router.get('/:id', async (req, res, next) => {
  try { success(res, await svc.getOne({ id: req.user!.id, role: req.user!.role }, req.params.id)); } catch (e) { next(e); }
});

router.post('/:id/replies', async (req, res, next) => {
  try {
    const q = z.object({ message: z.string().min(2) }).parse(req.body);
    success(res, await svc.reply({ id: req.user!.id, role: req.user!.role }, req.params.id, q.message), 201);
  } catch (e) { next(e); }
});

router.patch('/:id/status', adminOnly, async (req, res, next) => {
  try {
    const q = z.object({ status: z.string() }).parse(req.body);
    success(res, await svc.setStatus({ id: req.user!.id, role: req.user!.role }, req.params.id, q.status));
  } catch (e) { next(e); }
});

export default router;