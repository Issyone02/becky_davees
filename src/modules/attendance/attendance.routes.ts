import { Router } from 'express';
import { authenticate, requireRole } from '../../core/auth/auth.middleware';
import * as svc from './attendance.service';
import { success } from '../../shared/response';
import { z } from 'zod';

const router = Router();
router.use(authenticate);

const staff = requireRole('SUPER_ADMIN', 'ADMIN', 'TEACHER');

const registerSchema = z.object({
  classId: z.string().min(1),
  sessionId: z.string().min(1),
  termId: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  entries: z.array(z.object({ studentId: z.string().min(1), status: z.enum(['present', 'absent', 'late', 'excused']) })).min(1),
  reason: z.string().min(5).optional(),
});

router.get('/my-classes', requireRole('TEACHER'), async (req, res, next) => {
  try { success(res, await svc.myTeachingClasses(req.user!.id, req.query.termId as string | undefined)); } catch (e) { next(e); }
});

router.get('/register', staff, async (req, res, next) => {
  try {
    const q = z.object({ classId: z.string(), date: z.string(), termId: z.string() }).parse(req.query);
    success(res, await svc.getRegister(q));
  } catch (e) { next(e); }
});

router.post('/register', staff, async (req, res, next) => {
  try { success(res, await svc.saveRegister(registerSchema.parse(req.body), { id: req.user!.id, role: req.user!.role })); } catch (e) { next(e); }
});

router.get('/report', staff, async (req, res, next) => {
  try {
    const q = z.object({ classId: z.string(), termId: z.string(), from: z.string().optional(), to: z.string().optional() }).parse(req.query);
    success(res, await svc.classReport(q));
  } catch (e) { next(e); }
});

export default router;