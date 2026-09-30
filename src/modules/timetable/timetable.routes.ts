import { Router } from 'express';
import { authenticate, requireRole } from '../../core/auth/auth.middleware';
import { db } from '../../config/db';
import * as svc from './timetable.service';
import { success } from '../../shared/response';
import { z } from 'zod';

const router = Router();
router.use(authenticate);
const staff = requireRole('SUPER_ADMIN', 'ADMIN', 'TEACHER');
const adminOnly = requireRole('SUPER_ADMIN', 'ADMIN');

const entrySchema = z.object({
  classId: z.string().min(1),
  subjectId: z.string().min(1),
  teacherId: z.string().min(1),
  dayOfWeek: z.coerce.number().int().min(1).max(5),
  startTime: z.string().regex(/^\d{2}:\d{2}$/),
  endTime: z.string().regex(/^\d{2}:\d{2}$/),
  termId: z.string().min(1),
});

router.get('/', staff, async (req, res, next) => {
  try {
    const q = z.object({
      classId: z.string().optional(), termId: z.string().optional(),
      teacherId: z.string().optional(), mine: z.string().optional(),
    }).parse(req.query);
    let teacherId = q.teacherId;
    if (req.user!.role === 'TEACHER' || q.mine === '1') {
      const t = await db.teacher.findUnique({ where: { userId: req.user!.id }, select: { id: true } });
      teacherId = t?.id ?? 'none';
    }
    success(res, await svc.listEntries({ classId: q.classId, termId: q.termId, teacherId }));
  } catch (e) { next(e); }
});

router.post('/', adminOnly, async (req, res, next) => {
  try { success(res, await svc.createEntry(entrySchema.parse(req.body), { id: req.user!.id, role: req.user!.role }), 201); } catch (e) { next(e); }
});

router.patch('/:id', adminOnly, async (req, res, next) => {
  try { success(res, await svc.updateEntry(Number(req.params.id), entrySchema.partial().parse(req.body), { id: req.user!.id, role: req.user!.role })); } catch (e) { next(e); }
});

router.delete('/:id', adminOnly, async (req, res, next) => {
  try { success(res, await svc.deleteEntry(Number(req.params.id), { id: req.user!.id, role: req.user!.role })); } catch (e) { next(e); }
});

export default router;