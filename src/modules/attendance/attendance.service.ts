import { db } from '../../config/db';
import { ForbiddenError, NotFoundError, ValidationError } from '../../shared/errors';
import { logAudit } from '../../core/audit/audit.service';

type Actor = { id: string; role: string };
const LOCK_WINDOW_MS = 24 * 60 * 60 * 1000;

function fmt(d: Date) { return d.toISOString().slice(0, 10); }
function dayStart(dateStr: string) { return new Date(dateStr + 'T00:00:00'); }

async function resolveTeacherId(userId: string): Promise<string | null> {
  const teacher = await db.teacher.findUnique({ where: { userId }, select: { id: true } });
  return teacher?.id ?? null;
}

export async function myTeachingClasses(userId: string, termId?: string) {
  const teacherId = await resolveTeacherId(userId);
  if (!teacherId) return [];

  const assignments = await db.teacherClassSubject.findMany({
    where: termId ? { teacherId, termId } : { teacherId },
    include: { class: true, subject: true },
  });

  // Fetch term/session names separately (no relations on TeacherClassSubject)
  const termIds = Array.from(new Set(assignments.map((a) => a.termId)));
  const sessionIds = Array.from(new Set(assignments.map((a) => a.sessionId)));
  const [terms, sessions] = await Promise.all([
    db.term.findMany({ where: { id: { in: termIds } } }),
    db.academicSession.findMany({ where: { id: { in: sessionIds } } }),
  ]);
  const termMap = new Map(terms.map((t) => [t.id, t]));
  const sessionMap = new Map(sessions.map((s) => [s.id, s]));

  const map = new Map<string, {
    classId: string; className: string;
    subjects: { id: string; name: string }[];
    terms: { id: string; name: string; sessionId: string; sessionName: string }[];
  }>();

  for (const a of assignments) {
    if (!map.has(a.classId)) {
      map.set(a.classId, { classId: a.classId, className: a.class.name, subjects: [], terms: [] });
    }
    const entry = map.get(a.classId)!;
    if (!entry.subjects.some((s) => s.id === a.subjectId)) {
      entry.subjects.push({ id: a.subjectId, name: a.subject.name });
    }
    if (!entry.terms.some((t) => t.id === a.termId)) {
      const t = termMap.get(a.termId);
      const s = sessionMap.get(a.sessionId);
      entry.terms.push({
        id: a.termId,
        name: t?.name ?? 'Term',
        sessionId: a.sessionId,
        sessionName: s?.name ?? 'Session',
      });
    }
  }
  return Array.from(map.values());
}

export async function getRegister(params: { classId: string; date: string; termId: string }) {
  const date = dayStart(params.date);
  const [students, records] = await Promise.all([
    db.student.findMany({
      where: { classId: params.classId, status: 'active' },
      orderBy: { fullName: 'asc' },
      select: { id: true, studentId: true, fullName: true, gender: true },
    }),
    db.attendanceRecord.findMany({
      where: { classId: params.classId, date, termId: params.termId },
      include: { marker: { select: { fullName: true } } },
    }),
  ]);
  return { students, records };
}

export async function saveRegister(input: {
  classId: string; sessionId: string; termId: string; date: string;
  entries: { studentId: string; status: string }[];
  reason?: string;
}, actor: Actor) {
  const date = dayStart(input.date);

  const term = await db.term.findUnique({ where: { id: input.termId } });
  if (!term) throw new NotFoundError('Term', input.termId);
  if (date < term.startDate || date > term.endDate) {
    throw new ValidationError(`${input.date} is outside ${term.name} (${fmt(term.startDate)} to ${fmt(term.endDate)}).`);
  }

  // Permission: teachers may only mark classes they teach in this term
  if (actor.role === 'TEACHER') {
    const teacherId = await resolveTeacherId(actor.id);
    if (!teacherId) throw new ForbiddenError('No teacher profile found for your account.');
    const assigned = await db.teacherClassSubject.findFirst({
      where: { teacherId, classId: input.classId, termId: input.termId },
    });
    if (!assigned) throw new ForbiddenError('You are not assigned to teach this class in the selected term.');
  }

  const existing = await db.attendanceRecord.findMany({
    where: { classId: input.classId, date, termId: input.termId },
  });
  const isUpdate = existing.length > 0;

  if (isUpdate) {
    const markedAt = existing[0].markedAt.getTime();
    const withinWindow = Date.now() - markedAt < LOCK_WINDOW_MS;
    if (!withinWindow && actor.role === 'TEACHER') {
      throw new ForbiddenError('This register is locked: the 24-hour edit window has passed. Contact an administrator for corrections.');
    }
    if (!input.reason || input.reason.trim().length < 5) {
      throw new ValidationError('A reason (minimum 5 characters) is required to modify an existing register.');
    }
  }

  for (const e of input.entries) {
    const prev = existing.find((x) => x.studentId === e.studentId);
    if (prev) {
      if (prev.status !== e.status) {
        await db.attendanceRecord.update({
          where: { id: prev.id },
          data: { status: e.status, lastEditedAt: new Date(), lastEditedBy: actor.id, editCount: { increment: 1 } },
        });
        await db.attendanceCorrection.create({
          data: {
            attendanceId: prev.id,
            previousStatus: prev.status,
            newStatus: e.status,
            reason: input.reason!.trim(),
            approvedBy: actor.id,
          },
        });
      }
    } else {
      await db.attendanceRecord.create({
        data: {
          studentId: e.studentId, classId: input.classId, sessionId: input.sessionId,
          termId: input.termId, date, status: e.status, markedBy: actor.id,
        },
      });
    }
  }

  await logAudit({
    userId: actor.id, userRole: actor.role,
    action: isUpdate ? 'attendance.updated' : 'attendance.marked',
    entityType: 'AttendanceRecord', entityId: input.classId,
    afterValues: { date: input.date, termId: input.termId, students: input.entries.length, reason: input.reason ?? null },
  });

  return { success: true, updated: isUpdate };
}

export async function classReport(params: { classId: string; termId: string; from?: string; to?: string }) {
  const where: any = { classId: params.classId, termId: params.termId };
  if (params.from || params.to) {
    where.date = {};
    if (params.from) where.date.gte = dayStart(params.from);
    if (params.to) where.date.lte = new Date(params.to + 'T23:59:59');
  }
  const records = await db.attendanceRecord.findMany({
    where,
    include: { student: { select: { id: true, studentId: true, fullName: true } } },
  });
  const byStudent = new Map<string, any>();
  for (const r of records) {
    if (!byStudent.has(r.studentId)) {
      byStudent.set(r.studentId, { student: r.student, present: 0, absent: 0, late: 0, excused: 0, total: 0 });
    }
    const row = byStudent.get(r.studentId);
    row[r.status] = (row[r.status] ?? 0) + 1;
    row.total += 1;
  }
  return Array.from(byStudent.values()).map((row) => ({
    ...row,
    rate: row.total ? Math.round(((row.present + row.late) / row.total) * 100) : 0,
  }));
}