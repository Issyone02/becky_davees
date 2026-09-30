import { db } from '../../config/db';
import { ForbiddenError, NotFoundError } from '../../shared/errors';
import { reportCardData } from '../results/results.service';

function round2(n: number) { return Math.round(n * 100) / 100; }

async function assertMyChild(userId: string, childId: string) {
  const link = await db.parentStudent.findFirst({ where: { studentId: childId, parent: { userId } } });
  if (!link) throw new ForbiddenError('This child is not linked to your account.');
  return link;
}

export async function listChildren(userId: string) {
  const parent = await db.parent.findUnique({
    where: { userId },
    include: { students: { include: { student: { include: { class: true } } } } },
  });
  if (!parent) return [];
  const term = await db.term.findFirst({ where: { isCurrent: true } });
  const out = [];
  for (const ps of parent.students) {
    const s = ps.student;
    let attendanceRate: number | null = null;
    let average: number | null = null;
    if (term) {
      const att = await db.attendanceRecord.findMany({ where: { studentId: s.id, termId: term.id }, select: { status: true } });
      attendanceRate = att.length ? Math.round(((att.filter((a) => a.status === 'present' || a.status === 'late').length) / att.length) * 1000) / 10 : null;
      const res = await db.result.findMany({ where: { studentId: s.id, termId: term.id }, select: { totalScore: true } });
      average = res.length ? Math.round((res.reduce((a, r) => a + r.totalScore, 0) / res.length) * 10) / 10 : null;
    }
    out.push({
      id: s.id, studentId: s.studentId, fullName: s.fullName, gender: s.gender,
      className: s.class.name, classId: s.classId, relationship: ps.relationship, isPrimary: ps.isPrimary,
      attendanceRate, average, photoUrl: s.photoUrl,
    });
  }
  return out;
}

export async function childAttendance(userId: string, childId: string, termId?: string) {
  await assertMyChild(userId, childId);
  const term = termId ? await db.term.findUnique({ where: { id: termId } }) : await db.term.findFirst({ where: { isCurrent: true } });
  const where: any = { studentId: childId };
  if (term) where.termId = term.id;
  const records = await db.attendanceRecord.findMany({ where, orderBy: { date: 'desc' }, select: { id: true, date: true, status: true } });
  const counts = { present: 0, absent: 0, late: 0, excused: 0 };
  for (const r of records) if (r.status in counts) (counts as any)[r.status]++;
  const rate = records.length ? Math.round(((counts.present + counts.late) / records.length) * 1000) / 10 : null;
  return { term, records, counts, rate };
}

export async function childResults(userId: string, childId: string, termId?: string) {
  await assertMyChild(userId, childId);
  const term = termId
    ? await db.term.findUnique({ where: { id: termId }, include: { session: true } })
    : await db.term.findFirst({ where: { isCurrent: true }, include: { session: true } });
  if (!term) throw new NotFoundError('Term', 'current');
  const results = await db.result.findMany({
    where: { studentId: childId, termId: term.id },
    include: { subject: { select: { name: true, code: true } } },
    orderBy: { totalScore: 'desc' },
  });
  const average = results.length ? Math.round((results.reduce((a, r) => a + r.totalScore, 0) / results.length) * 10) / 10 : null;
  const scale = await db.gradingScale.findMany({ where: { OR: [{ sessionId: term.sessionId }, { sessionId: null }] } });
  const g = average != null ? scale.find((x) => average >= x.minScore && average <= x.maxScore) : undefined;
  return { term, results, average, grade: g?.grade ?? null, remark: g?.remark ?? null };
}

export async function childFees(userId: string, childId: string, termId?: string) {
  await assertMyChild(userId, childId);
  const student = await db.student.findUnique({ where: { id: childId } });
  const term = termId ? await db.term.findUnique({ where: { id: termId } }) : await db.term.findFirst({ where: { isCurrent: true } });
  if (!student || !term) throw new NotFoundError('Record', 'child/term');
  const structures = await db.feeStructure.findMany({ where: { classId: student.classId, termId: term.id } });
  const payments = await db.payment.findMany({
    where: { studentId: childId, termId: term.id },
    include: { feeStructure: true },
    orderBy: { paymentDate: 'desc' },
  });
  const lines = structures.map((f) => {
    const paid = round2(payments.filter((p) => p.feeStructureId === f.id && p.status === 'paid').reduce((a, p) => a + p.amountPaid, 0));
    return { structure: f, paid, balance: round2(f.amount - paid) };
  });
  const totalBilled = round2(structures.reduce((a, f) => a + f.amount, 0));
  const totalPaid = round2(payments.filter((p) => p.status === 'paid').reduce((a, p) => a + p.amountPaid, 0));
  return { term, lines, payments, totalBilled, totalPaid, balance: round2(totalBilled - totalPaid) };
}

export async function childReportCard(userId: string, childId: string, termId: string) {
  await assertMyChild(userId, childId);
  return reportCardData(childId, termId);
}