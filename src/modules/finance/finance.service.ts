import { db } from '../../config/db';
import { ConflictError, NotFoundError, ValidationError } from '../../shared/errors';
import { logAudit } from '../../core/audit/audit.service';
import * as notify from '../../core/notify/notify.service';

type Actor = { id: string; role: string };

function round2(n: number) { return Math.round(n * 100) / 100; }

// ---------- Fee structures ----------
export async function listFeeStructures(params: { sessionId?: string; termId?: string; classId?: string }) {
  return db.feeStructure.findMany({
    where: params,
    include: { class: true, term: true, session: true },
    orderBy: { id: 'asc' },
  });
}

export async function createFeeStructure(input: {
  classId: string; sessionId: string; termId: string; feeType: string; amount: number; dueDate: Date;
}, actor: Actor) {
  if (input.amount <= 0) throw new ValidationError('Amount must be greater than zero.');
  try {
    const fs = await db.feeStructure.create({ data: input });
    await logAudit({ userId: actor.id, userRole: actor.role, action: 'fee_structure.created', entityType: 'FeeStructure', entityId: String(fs.id), afterValues: { ...input, dueDate: String(input.dueDate) } });
    return fs;
  } catch (e: any) {
    if (e?.code === 'P2002') throw new ConflictError('A fee structure for this class, term and fee type already exists.');
    throw e;
  }
}

export async function updateFeeStructure(id: number, input: { feeType?: string; amount?: number; dueDate?: Date }, actor: Actor) {
  const before = await db.feeStructure.findUnique({ where: { id } });
  if (!before) throw new NotFoundError('FeeStructure', String(id));
  if (input.amount !== undefined && input.amount <= 0) throw new ValidationError('Amount must be greater than zero.');
  const fs = await db.feeStructure.update({ where: { id }, data: input });
  await logAudit({ userId: actor.id, userRole: actor.role, action: 'fee_structure.updated', entityType: 'FeeStructure', entityId: String(id), beforeValues: { amount: before.amount, feeType: before.feeType, dueDate: before.dueDate }, afterValues: input });
  return fs;
}

// ---------- Balances & ledger ----------
export async function studentBalances(params: { classId: string; termId: string }) {
  const [students, structures, payments] = await Promise.all([
    db.student.findMany({ where: { classId: params.classId, status: 'active' }, orderBy: { fullName: 'asc' } }),
    db.feeStructure.findMany({ where: { classId: params.classId, termId: params.termId } }),
    db.payment.findMany({ where: { student: { classId: params.classId }, termId: params.termId, status: 'paid' } }),
  ]);
  const rows = students.map((s) => {
    const totalBilled = round2(structures.reduce((a, f) => a + f.amount, 0));
    const totalPaid = round2(payments.filter((p) => p.studentId === s.id).reduce((a, p) => a + p.amountPaid, 0));
    const balance = round2(totalBilled - totalPaid);
    return {
      student: { id: s.id, studentId: s.studentId, fullName: s.fullName },
      totalBilled, totalPaid, balance,
      status: balance <= 0 ? (totalBilled > 0 ? 'paid' : 'unbilled') : totalPaid > 0 ? 'partial' : 'unpaid',
    };
  });
  return { rows, structures };
}

export async function studentLedger(studentId: string, termId: string) {
  const student = await db.student.findUnique({ where: { id: studentId }, include: { class: true } });
  if (!student) throw new NotFoundError('Student', studentId);
  const [structures, payments] = await Promise.all([
    db.feeStructure.findMany({ where: { classId: student.classId, termId } }),
    db.payment.findMany({
      where: { studentId, termId },
      include: { feeStructure: true, recorder: { select: { fullName: true } } },
      orderBy: { paymentDate: 'asc' },
    }),
  ]);
  const lines = structures.map((f) => {
    const paid = round2(payments.filter((p) => p.feeStructureId === f.id && p.status === 'paid').reduce((a, p) => a + p.amountPaid, 0));
    return { structure: f, paid, balance: round2(f.amount - paid) };
  });
  return { student, lines, payments };
}

// ---------- Payments ----------
export async function recordPayment(input: {
  studentId: string; feeStructureId: number; amountPaid: number;
  paymentMethod: string; paymentDate: Date; parentId?: string | null;
}, actor: Actor) {
  if (input.amountPaid <= 0) throw new ValidationError('Amount paid must be greater than zero.');
  const student = await db.student.findUnique({ where: { id: input.studentId } });
  if (!student) throw new NotFoundError('Student', input.studentId);
  const structure = await db.feeStructure.findUnique({ where: { id: input.feeStructureId } });
  if (!structure) throw new NotFoundError('FeeStructure', String(input.feeStructureId));
  if (structure.classId !== student.classId) throw new ValidationError('This fee structure does not belong to the selected student\'s class.');

  const paidSoFar = await db.payment.aggregate({
    where: { studentId: input.studentId, feeStructureId: input.feeStructureId, status: 'paid' },
    _sum: { amountPaid: true },
  });
  const remaining = round2(structure.amount - (paidSoFar._sum.amountPaid ?? 0));
  if (input.amountPaid > remaining) {
    throw new ValidationError(`Amount exceeds the outstanding balance for "${structure.feeType}" (remaining: ${remaining.toFixed(2)}).`);
  }

  const count = await db.payment.count();
  const receiptNumber = `RCP-${new Date().getFullYear()}-${String(count + 1).padStart(5, '0')}`;
  const paymentReference = `PAY-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`;

  const payment = await db.payment.create({
    data: {
      studentId: input.studentId,
      parentId: input.parentId ?? null,
      feeStructureId: input.feeStructureId,
      amountPaid: input.amountPaid,
      paymentReference,
      paymentMethod: input.paymentMethod,
      paymentDate: input.paymentDate,
      receiptNumber,
      recordedBy: actor.id,
      sessionId: structure.sessionId,
      termId: structure.termId,
      status: 'paid',
    },
  });

  await db.paymentAudit.create({
    data: {
      paymentId: payment.id, action: 'payment.recorded',
      newValues: JSON.stringify({ amountPaid: input.amountPaid, method: input.paymentMethod, receiptNumber }),
      performedBy: actor.id,
    },
  });
  await logAudit({ userId: actor.id, userRole: actor.role, action: 'payment.recorded', entityType: 'Payment', entityId: payment.id, afterValues: { studentId: input.studentId, amount: input.amountPaid, receiptNumber } });
  void notify.emailPaymentRecorded(payment.id);
  return payment;
}

export async function voidPayment(id: string, reason: string, actor: Actor) {
  const payment = await db.payment.findUnique({ where: { id } });
  if (!payment) throw new NotFoundError('Payment', id);
  if (payment.status === 'voided') throw new ValidationError('This payment is already voided.');
  const updated = await db.payment.update({ where: { id }, data: { status: 'voided' } });
  await db.paymentAudit.create({
    data: {
      paymentId: id, action: 'payment.voided',
      previousValues: JSON.stringify({ status: 'paid', amountPaid: payment.amountPaid }),
      newValues: JSON.stringify({ status: 'voided', reason }),
      performedBy: actor.id,
    },
  });
  await logAudit({ userId: actor.id, userRole: actor.role, action: 'payment.voided', entityType: 'Payment', entityId: id, beforeValues: { status: 'paid', amount: payment.amountPaid }, afterValues: { status: 'voided', reason } });
  return updated;
}

export async function listPayments(params: { termId?: string; classId?: string }) {
  const where: any = {};
  if (params.termId) where.termId = params.termId;
  if (params.classId) where.student = { classId: params.classId };
  return db.payment.findMany({
    where,
    include: {
      student: { select: { id: true, studentId: true, fullName: true } },
      feeStructure: true,
      recorder: { select: { fullName: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
}

export async function receiptData(id: string) {
  const payment = await db.payment.findUnique({
    where: { id },
    include: {
      student: { include: { class: true } },
      feeStructure: true,
      recorder: { select: { fullName: true } },
      parent: { include: { user: { select: { fullName: true } } } },
    },
  });
  if (!payment) throw new NotFoundError('Payment', id);
  const settings = await db.schoolSetting.findFirst();
  return { payment, settings };
}

// ---------- Carry forward (inherit) fee structures ----------
export async function carryForwardFeeStructures(input: {
  fromSessionId: string; fromTermId: string; toSessionId: string; toTermId: string; classId?: string;
}, actor: Actor) {
  const where: any = { sessionId: input.fromSessionId, termId: input.fromTermId };
  if (input.classId) where.classId = input.classId;
  const sources = await db.feeStructure.findMany({ where });
  const toTerm = await db.term.findUnique({ where: { id: input.toTermId } });
  let created = 0;
  let skipped = 0;
  for (const s of sources) {
    const existing = await db.feeStructure.findFirst({
      where: { classId: s.classId, termId: input.toTermId, feeType: s.feeType },
    });
    if (existing) { skipped++; continue; }
    await db.feeStructure.create({
      data: {
        classId: s.classId, sessionId: input.toSessionId, termId: input.toTermId,
        feeType: s.feeType, amount: s.amount, dueDate: toTerm?.endDate ?? s.dueDate,
      },
    });
    created++;
  }
  await logAudit({
    userId: actor.id, userRole: actor.role, action: 'fee_structures.carried_forward',
    entityType: 'FeeStructure', entityId: input.toTermId,
    afterValues: { fromTermId: input.fromTermId, created, skipped },
  });
  return { created, skipped };
}