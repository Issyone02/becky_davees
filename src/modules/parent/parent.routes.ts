import { db } from '../../config/db';
import { Router } from 'express';
import { authenticate, requireRole } from '../../core/auth/auth.middleware';
import * as svc from './parent.service';
import { success } from '../../shared/response';
import { z } from 'zod';

const router = Router();
router.use(authenticate);
router.use(requireRole('PARENT'));

router.get('/children', async (req, res, next) => {
  try { success(res, await svc.listChildren(req.user!.id)); } catch (e) { next(e); }
});

router.get('/attendance', async (req, res, next) => {
  try {
    const q = z.object({ childId: z.string(), termId: z.string().optional() }).parse(req.query);
    success(res, await svc.childAttendance(req.user!.id, q.childId, q.termId));
  } catch (e) { next(e); }
});

router.get('/results', async (req, res, next) => {
  try {
    const q = z.object({ childId: z.string(), termId: z.string().optional() }).parse(req.query);
    success(res, await svc.childResults(req.user!.id, q.childId, q.termId));
  } catch (e) { next(e); }
});

router.get('/fees', async (req, res, next) => {
  try {
    const q = z.object({ childId: z.string(), termId: z.string().optional() }).parse(req.query);
    success(res, await svc.childFees(req.user!.id, q.childId, q.termId));
  } catch (e) { next(e); }
});

router.get('/report-card', async (req, res, next) => {
  try {
    const q = z.object({ childId: z.string(), termId: z.string() }).parse(req.query);
    success(res, await svc.childReportCard(req.user!.id, q.childId, q.termId));
  } catch (e) { next(e); }
});

router.get('/terms', async (req, res, next) => {
  try {
    const terms = await db.term.findMany({
      include: { session: { select: { id: true, name: true } } },
      orderBy: { startDate: 'desc' },
    });
    success(res, terms);
  } catch (e) { next(e); }
});

export default router;