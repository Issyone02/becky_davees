import { Router } from 'express';
import { authenticate, requireRole } from '../../core/auth/auth.middleware';
import * as svc from './user.service';
import { success, paginated } from '../../shared/response';
import { handleError } from '../../shared/errors';
import { z } from 'zod';

const router = Router();
router.use(authenticate);

router.get('/', requireRole('SUPER_ADMIN', 'ADMIN'), async (req, res, next) => {
  try { paginated(res, (await svc.listUsers(req)).data, (await svc.listUsers(req)).meta); }
  catch (e) { next(e); }
});

router.post('/', requireRole('SUPER_ADMIN', 'ADMIN'), async (req, res, next) => {
  try {
    const body = z.object({
      email: z.string().email(), fullName: z.string().min(2),
      role: z.enum(['ADMIN', 'TEACHER', 'PARENT']),
      password: z.string().min(8), phone: z.string().optional(),
      username: z.string().optional(),
    }).parse(req.body);
    const user = await svc.createUser(body, req.user!.id);
    success(res, user, 201);
  } catch (e) { next(e); }
});

router.get('/:id', requireRole('SUPER_ADMIN', 'ADMIN'), async (req, res, next) => {
  try { success(res, await svc.getUser(req.params.id)); }
  catch (e) { next(e); }
});

router.patch('/:id', requireRole('SUPER_ADMIN', 'ADMIN'), async (req, res, next) => {
  try {
    const body = z.object({
      fullName: z.string().min(2).optional(),
      phone: z.string().optional(),
      status: z.enum(['ACTIVE', 'SUSPENDED', 'DEACTIVATED']).optional(),
    }).parse(req.body);
    success(res, await svc.updateUser(req.params.id, body, req.user!.id));
  } catch (e) { next(e); }
});

export default router;