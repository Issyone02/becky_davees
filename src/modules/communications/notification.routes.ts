import { Router } from 'express';
import { authenticate } from '../../core/auth/auth.middleware';
import * as svc from './communication.service';
import { success } from '../../shared/response';

const router = Router();
router.use(authenticate);

router.get('/', async (req, res, next) => {
  try { success(res, await svc.myNotifications(req.user!.id)); } catch (e) { next(e); }
});

router.get('/unread-count', async (req, res, next) => {
  try { success(res, await svc.unreadCount(req.user!.id)); } catch (e) { next(e); }
});

router.post('/read-all', async (req, res, next) => {
  try { success(res, await svc.markAllRead(req.user!.id)); } catch (e) { next(e); }
});

router.post('/:id/read', async (req, res, next) => {
  try { success(res, await svc.markRead(req.params.id, req.user!.id)); } catch (e) { next(e); }
});

export default router;