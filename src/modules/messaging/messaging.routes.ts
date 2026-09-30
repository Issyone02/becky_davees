import { Router } from 'express';
import { authenticate, requireRole } from '../../core/auth/auth.middleware';
import { db } from '../../config/db';
import { success } from '../../shared/response';
import { sendSms } from '../../core/sms/sms.service';
import * as notify from '../../core/notify/notify.service';
import { z } from 'zod';

const router = Router();
router.use(authenticate);
router.use(requireRole('SUPER_ADMIN', 'ADMIN'));

router.get('/config', async (_req, res, next) => {
  try {
    const cfg = await db.messagingConfig.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} });
    success(res, cfg);
  } catch (e) { next(e); }
});

router.put('/config', async (req, res, next) => {
  try {
    const q = z.object({
      smtpHost: z.string().nullish(), smtpPort: z.coerce.number().nullish(),
      smtpUser: z.string().nullish(), smtpPass: z.string().nullish(), mailFrom: z.string().nullish(),
      smsEnabled: z.boolean().optional(), smsProvider: z.string().nullish(),
      smsApiKey: z.string().nullish(), smsSenderId: z.string().nullish(), smsEvents: z.string().optional(),
    }).parse(req.body);
    const cfg = await db.messagingConfig.upsert({ where: { id: 1 }, create: { id: 1, ...q }, update: q });
    success(res, cfg);
  } catch (e) { next(e); }
});

router.post('/test-email', async (req, res, next) => {
  try {
    const { email } = z.object({ email: z.string().email() }).parse(req.body);
    const r = await notify.sendBranded(email, 'Test Message', '<p>If you can read this, email delivery is configured correctly.</p>');
    success(res, r);
  } catch (e) { next(e); }
});

router.post('/test-sms', async (req, res, next) => {
  try {
    const { phone } = z.object({ phone: z.string().min(10) }).parse(req.body);
    const r = await sendSms(phone, 'Test message from SchoolMS — SMS delivery is configured.');
    success(res, r);
  } catch (e) { next(e); }
});

router.get('/logs', async (_req, res, next) => {
  try {
    const logs = await db.notificationLog.findMany({ orderBy: { createdAt: 'desc' }, take: 25 });
    success(res, logs);
  } catch (e) { next(e); }
});

router.post('/session-notice', async (req, res, next) => {
  try {
    const q = z.object({ title: z.string().min(3), body: z.string().min(10), audience: z.enum(['all', 'teachers', 'parents']) }).parse(req.body);
    success(res, await notify.sendSessionNotice({ id: req.user!.id, role: req.user!.role }, q));
  } catch (e) { next(e); }
});

export default router;