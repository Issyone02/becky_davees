import { Router } from 'express';
import { authenticate, requireRole } from '../../core/auth/auth.middleware';
import * as svc from './communication.service';
import { success } from '../../shared/response';
import { z } from 'zod';

const router = Router();
router.use(authenticate);
const adminOnly = requireRole('SUPER_ADMIN', 'ADMIN');

const newsSchema = z.object({ title: z.string().min(3), body: z.string().min(3), audience: z.string().min(2), publish: z.boolean().optional() });
const eventSchema = z.object({
  title: z.string().min(3), description: z.string().nullish(), location: z.string().nullish(),
  startDate: z.coerce.date(), endDate: z.coerce.date().nullish(), audience: z.string().min(2),
});

router.get('/news', async (req, res, next) => {
  try {
    const q = z.object({ manage: z.string().optional() }).parse(req.query);
    const manage = q.manage === '1' && (req.user!.role === 'ADMIN' || req.user!.role === 'SUPER_ADMIN');
    success(res, await svc.listNews({ manage, role: req.user!.role }));
  } catch (e) { next(e); }
});

router.post('/news', adminOnly, async (req, res, next) => {
  try {
    const q = newsSchema.parse(req.body);
    success(res, await svc.createNews({ ...q, publish: q.publish ?? false }, { id: req.user!.id, role: req.user!.role }), 201);
  } catch (e) { next(e); }
});

router.patch('/news/:id', adminOnly, async (req, res, next) => {
  try {
    const q = newsSchema.partial().omit({ publish: true }).parse(req.body);
    success(res, await svc.updateNews(req.params.id, q, { id: req.user!.id, role: req.user!.role }));
  } catch (e) { next(e); }
});

router.post('/news/:id/publish', adminOnly, async (req, res, next) => {
  try { success(res, await svc.publishNews(req.params.id, { id: req.user!.id, role: req.user!.role })); } catch (e) { next(e); }
});

router.post('/news/:id/unpublish', adminOnly, async (req, res, next) => {
  try { success(res, await svc.unpublishNews(req.params.id, { id: req.user!.id, role: req.user!.role })); } catch (e) { next(e); }
});

router.delete('/news/:id', adminOnly, async (req, res, next) => {
  try { success(res, await svc.deleteNews(req.params.id, { id: req.user!.id, role: req.user!.role })); } catch (e) { next(e); }
});

router.get('/events', async (req, res, next) => {
  try { success(res, await svc.listEvents(req.user!.role)); } catch (e) { next(e); }
});

router.post('/events', adminOnly, async (req, res, next) => {
  try { success(res, await svc.createEvent(eventSchema.parse(req.body), { id: req.user!.id, role: req.user!.role }), 201); } catch (e) { next(e); }
});

router.patch('/events/:id', adminOnly, async (req, res, next) => {
  try { success(res, await svc.updateEvent(req.params.id, eventSchema.partial().parse(req.body), { id: req.user!.id, role: req.user!.role })); } catch (e) { next(e); }
});

router.delete('/events/:id', adminOnly, async (req, res, next) => {
  try { success(res, await svc.deleteEvent(req.params.id, { id: req.user!.id, role: req.user!.role })); } catch (e) { next(e); }
});

export default router;