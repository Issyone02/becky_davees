import { Router } from 'express';
import { authenticate } from '../../core/auth/auth.middleware';
import * as svc from './dashboard.service';
import { success } from '../../shared/response';
import { z } from 'zod';

const router = Router();
router.use(authenticate);

router.get('/stats', async (req, res, next) => {
  try { success(res, await svc.stats(req.user!.id, req.user!.role)); } catch (e) { next(e); }
});

router.get('/attendance-chart', async (req, res, next) => {
  try {
    const q = z.object({ days: z.coerce.number().int().min(1).max(90).default(14) }).parse(req.query);
    success(res, await svc.attendanceChart(q.days, req.user!.id, req.user!.role));
  } catch (e) { next(e); }
});

router.get('/announcements', async (req, res, next) => {
  try { success(res, await svc.recentAnnouncements(req.user!.role)); } catch (e) { next(e); }
});

router.get('/events', async (req, res, next) => {
  try { success(res, await svc.upcomingEvents(req.user!.role)); } catch (e) { next(e); }
});

export default router;