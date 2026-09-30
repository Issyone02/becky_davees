import { Router } from 'express';
import { authenticate, requireRole } from '../../core/auth/auth.middleware';
import * as svc from './finance.service';
import { success } from '../../shared/response';
import { z } from 'zod';

const router = Router();
router.use(authenticate);
const adminOnly = requireRole('SUPER_ADMIN', 'ADMIN');

router.get('/fee-structures', adminOnly, async (req, res, next) => {
  try {
    const q = z.object({ sessionId: z.string().optional(), termId: z.string().optional(), classId: z.string().optional() }).parse(req.query);
    success(res, await svc.listFeeStructures(q));
  } catch (e) { next(e); }
});

router.post('/fee-structures', adminOnly, async (req, res, next) => {
  try {
    const q = z.object({ classId: z.string(), sessionId: z.string(), termId: z.string(), feeType: z.string().min(2), amount: z.coerce.number().positive(), dueDate: z.coerce.date() }).parse(req.body);
    success(res, await svc.createFeeStructure(q, { id: req.user!.id, role: req.user!.role }), 201);
  } catch (e) { next(e); }
});

router.patch('/fee-structures/:id', adminOnly, async (req, res, next) => {
  try {
    const q = z.object({ feeType: z.string().min(2).optional(), amount: z.coerce.number().positive().optional(), dueDate: z.coerce.date().optional() }).parse(req.body);
    success(res, await svc.updateFeeStructure(Number(req.params.id), q, { id: req.user!.id, role: req.user!.role }));
  } catch (e) { next(e); }
});

router.get('/balances', adminOnly, async (req, res, next) => {
  try {
    const q = z.object({ classId: z.string(), termId: z.string() }).parse(req.query);
    success(res, await svc.studentBalances(q));
  } catch (e) { next(e); }
});

router.get('/ledger', adminOnly, async (req, res, next) => {
  try {
    const q = z.object({ studentId: z.string(), termId: z.string() }).parse(req.query);
    success(res, await svc.studentLedger(q.studentId, q.termId));
  } catch (e) { next(e); }
});

router.get('/payments', adminOnly, async (req, res, next) => {
  try {
    const q = z.object({ termId: z.string().optional(), classId: z.string().optional() }).parse(req.query);
    success(res, await svc.listPayments(q));
  } catch (e) { next(e); }
});

router.post('/payments', adminOnly, async (req, res, next) => {
  try {
    const q = z.object({
      studentId: z.string().min(1),
      feeStructureId: z.coerce.number().int().positive(),
      amountPaid: z.coerce.number().positive(),
      paymentMethod: z.string().min(2),
      paymentDate: z.coerce.date(),
      parentId: z.string().nullish(),
    }).parse(req.body);
    success(res, await svc.recordPayment(q, { id: req.user!.id, role: req.user!.role }), 201);
  } catch (e) { next(e); }
});

router.post('/payments/:id/void', adminOnly, async (req, res, next) => {
  try {
    const q = z.object({ reason: z.string().min(3) }).parse(req.body);
    success(res, await svc.voidPayment(req.params.id, q.reason, { id: req.user!.id, role: req.user!.role }));
  } catch (e) { next(e); }
});

router.get('/payments/:id/receipt', adminOnly, async (req, res, next) => {
  try { success(res, await svc.receiptData(req.params.id)); } catch (e) { next(e); }
});

router.post('/fee-structures/carry-forward', requireRole('SUPER_ADMIN', 'ADMIN'), async (req, res, next) => {
  try {
    const q = z.object({
      fromSessionId: z.string(), fromTermId: z.string(),
      toSessionId: z.string(), toTermId: z.string(),
      classId: z.string().optional(),
    }).parse(req.body);
    success(res, await svc.carryForwardFeeStructures(q, { id: req.user!.id, role: req.user!.role }));
  } catch (e) { next(e); }
});

export default router;