import { Router } from 'express';
import { db } from '../../config/db';
import { success } from '../../shared/response';
import { z } from 'zod';

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

// Public news — only audience 'all' and published
router.get('/news', async (_req, res, next) => {
  try {
    const items = await db.news.findMany({
      where: { status: 'published', audience: 'all' },
      include: { author: { select: { fullName: true } } },
      orderBy: { publishedAt: 'desc' },
      take: 30,
    });
    success(res, items);
  } catch (e) { next(e); }
});

// Public upcoming events — only audience 'all'
router.get('/events', async (_req, res, next) => {
  try {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const items = await db.event.findMany({
      where: {
        audience: 'all',
        OR: [
          { endDate: { gte: startOfToday } },
          { endDate: null, startDate: { gte: startOfToday } },
        ],
      },
      orderBy: { startDate: 'asc' },
      take: 20,
    });
    success(res, items);
  } catch (e) { next(e); }
});

// Public contact form — emails the school's configured address
router.post('/contact', async (req, res, next) => {
  try {
    const q = z.object({
      name: z.string().min(2),
      email: z.string().email(),
      message: z.string().min(10),
    }).parse(req.body);
    const s = await db.schoolSetting.findFirst();
    if (!s?.email) {
      return res.status(400).json({ success: false, error: { code: 'NO_SCHOOL_EMAIL', message: 'School email not configured.' } });
    }
    const { sendMail } = await import('../../core/mail/mail.service');
    await sendMail(s.email, `Website enquiry from ${q.name}`, `
      <p><strong>Name:</strong> ${q.name}</p>
      <p><strong>Email:</strong> ${q.email}</p>
      <p><strong>Message:</strong></p><p>${q.message}</p>
    `);
    success(res, { sent: true });
  } catch (e) { next(e); }
});

export default router;