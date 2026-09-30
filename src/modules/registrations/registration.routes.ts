import { Router } from 'express';
import { authenticate, requireRole } from '../../core/auth/auth.middleware';
import { db } from '../../config/db';
import { success } from '../../shared/response';
import { approveRegistration, rejectRegistration } from '../../core/auth/auth.service';
import * as notify from '../../core/notify/notify.service';
import { z } from 'zod';

const router = Router();
router.use(authenticate);
router.use(requireRole('SUPER_ADMIN', 'ADMIN'));

router.get('/pending', async (_req, res, next) => {
  try {
    const list = await db.registration.findMany({
      where: { status: { in: ['pending', 'verified'] } },
      orderBy: { createdAt: 'desc' },
      include: { user: { select: { id: true, fullName: true, email: true, phone: true, role: true, createdAt: true } } },
    });
    success(res, list);
  } catch (e) { next(e); }
});

router.post('/:userId/approve', async (req, res, next) => {
  try {
    const result = await approveRegistration(req.params.userId, req.user!.id);
    void notify.emailRegistrationDecision(req.params.userId, true);
    success(res, result);
  } catch (e) { next(e); }
});

router.post('/:userId/reject', async (req, res, next) => {
  try {
    const { reason } = z.object({ reason: z.string().min(3) }).parse(req.body);
    const result = await rejectRegistration(req.params.userId, req.user!.id, reason);
    void notify.emailRegistrationDecision(req.params.userId, false, reason);
    success(res, result);
  } catch (e) { next(e); }
});

export default router;