import { Router } from 'express';
import { db } from '../../config/db';
import { success } from '../../shared/response';

const router = Router();

// Public receipt verification — returns ONLY what the printed receipt already shows.
router.get('/verify/receipt/:id', async (req, res, next) => {
  try {
    const p = await db.payment.findUnique({
      where: { id: req.params.id },
      include: {
        student: { include: { class: { select: { name: true } } } },
        feeStructure: { select: { feeType: true } },
      },
    });
    if (!p) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Receipt not found' } });
    }
    const s = await db.schoolSetting.findFirst();
    success(res, {
      kind: 'receipt',
      receiptNumber: p.receiptNumber,
      status: p.status,
      amountPaid: Number(p.amountPaid),
      paymentMethod: p.paymentMethod,
      paymentDate: p.paymentDate,
      studentName: p.student?.fullName ?? null,
      studentCode: p.student?.studentId ?? null,
      className: p.student?.class?.name ?? null,
      feeType: p.feeStructure?.feeType ?? null,
      schoolName: s?.schoolName ?? null,
      logoUrl: s?.logoUrl ?? null,
      motto: s?.motto ?? null,
    });
  } catch (e) { next(e); }
});

// Public report-card verification — genuine only if a generated card exists for student+term.
router.get('/verify/report-card/:studentId/:termId', async (req, res, next) => {
  try {
    const student = await db.student.findUnique({
      where: { id: req.params.studentId },
      include: { class: { select: { name: true } } },
    });
    const term = await db.term.findUnique({
      where: { id: req.params.termId },
      include: { session: { select: { name: true } } },
    });
    const card = await db.reportCard.findFirst({
      where: { studentId: req.params.studentId, termId: req.params.termId },
    });
    if (!student || !term || !card) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Report card not found' } });
    }
    const s = await db.schoolSetting.findFirst();
    success(res, {
      kind: 'report-card',
      studentName: student.fullName,
      studentCode: student.studentId,
      className: student.class?.name ?? null,
      termName: term.name,
      sessionName: (term as any).session?.name ?? null,
      generatedAt: (card as any).generatedAt ?? (card as any).createdAt ?? null,
      schoolName: s?.schoolName ?? null,
      logoUrl: s?.logoUrl ?? null,
      motto: s?.motto ?? null,
    });
  } catch (e) { next(e); }
});

export default router;