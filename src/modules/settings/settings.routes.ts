import { Router } from 'express';
import { authenticate, requireRole } from '../../core/auth/auth.middleware';
import { db } from '../../config/db';
import { success } from '../../shared/response';
import { z } from 'zod';

const router = Router();
router.use(authenticate);

router.get('/', async (_req, res, next) => {
  try { success(res, await db.schoolSetting.findFirst()); } catch (e) { next(e); }
});

router.patch('/', requireRole('SUPER_ADMIN', 'ADMIN'), async (req, res, next) => {
  try {
    const q = z.object({
      schoolName: z.string().min(2),
      motto: z.string().nullable().optional(),
      address: z.string().nullable().optional(),
      phone: z.string().nullable().optional(),
      email: z.string().nullable().optional(),
      headTeacherName: z.string().nullable().optional(),
      logoUrl: z.string().nullable().optional(),
      officialStampUrl: z.string().nullable().optional(),
      headTeacherSignatureUrl: z.string().nullable().optional(),
    }).parse(req.body);
    const existing = await db.schoolSetting.findFirst();
    const updated = existing
      ? await db.schoolSetting.update({ where: { id: existing.id }, data: q })
      : await db.schoolSetting.create({ data: q });
    success(res, updated);
  } catch (e) { next(e); }
});

export default router;