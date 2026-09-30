import { Router } from 'express';
import { authenticate, requireRole } from '../../core/auth/auth.middleware';
import * as svc from './promotions.service';
import { success } from '../../shared/response';
import { z } from 'zod';

const router = Router();
router.use(authenticate);
router.use(requireRole('SUPER_ADMIN', 'ADMIN'));

router.get('/preview', async (req, res, next) => {
  try {
    const q = z.object({ fromSessionId: z.string() }).parse(req.query);
    success(res, await svc.preview(q.fromSessionId));
  } catch (e) { next(e); }
});

router.post('/apply', async (req, res, next) => {
  try {
    const q = z.object({
      fromSessionId: z.string(),
      toSessionId: z.string().nullable(),
      entries: z.array(z.object({
        studentId: z.string(),
        decision: z.enum(['PROMOTE', 'REPEAT', 'GRADUATE', 'WITHDRAW']),
        toClassId: z.string().nullable().optional(),
      })).min(1),
    }).parse(req.body);
    success(res, await svc.apply({ id: req.user!.id, role: req.user!.role }, q));
  } catch (e) { next(e); }
});

router.get('/batches', async (_req, res, next) => {
  try { success(res, await svc.batches()); } catch (e) { next(e); }
});

router.get('/alumni', async (_req, res, next) => {
  try { success(res, await svc.alumni()); } catch (e) { next(e); }
});

router.get('/transcript', async (req, res, next) => {
  try {
    const q = z.object({ studentId: z.string() }).parse(req.query);
    success(res, await svc.transcript(q.studentId));
  } catch (e) { next(e); }
});

export default router;