import { db } from '../../config/db';
import { ConflictError, NotFoundError, ValidationError } from '../../shared/errors';
import { logAudit } from '../../core/audit/audit.service';

type Actor = { id: string; role: string };

// ================= SESSIONS =================
export async function listSessions() {
  return db.academicSession.findMany({
    orderBy: { startDate: 'desc' },
    include: { terms: { orderBy: { startDate: 'asc' } }, _count: { select: { students: true } } },
  });
}

export async function createSession(input: { name: string; startDate: Date; endDate: Date }, actor: Actor) {
  if (input.endDate <= input.startDate) throw new ValidationError('End date must be after start date');
  const exists = await db.academicSession.findUnique({ where: { name: input.name } });
  if (exists) throw new ConflictError(`Session "${input.name}" already exists`);
  const session = await db.academicSession.create({
    data: { name: input.name, startDate: input.startDate, endDate: input.endDate, isCurrent: false },
  });
  await logAudit({ userId: actor.id, userRole: actor.role, action: 'session.created', entityType: 'AcademicSession', entityId: session.id, afterValues: { name: session.name } });
  return session;
}

export async function setCurrentSession(id: string, actor: Actor) {
  const session = await db.academicSession.findUnique({ where: { id } });
  if (!session) throw new NotFoundError('Session', id);
  await db.$transaction([
    db.academicSession.updateMany({ data: { isCurrent: false } }),
    db.academicSession.update({ where: { id }, data: { isCurrent: true } }),
    db.schoolSetting.updateMany({ data: { currentSessionId: id } }),
  ]);
  await logAudit({ userId: actor.id, userRole: actor.role, action: 'session.set_current', entityType: 'AcademicSession', entityId: id, afterValues: { name: session.name } });
  return session;
}

// ================= TERMS =================
export async function listTerms(sessionId?: string) {
  return db.term.findMany({ where: sessionId ? { sessionId } : {}, orderBy: { startDate: 'asc' }, include: { session: true } });
}

export async function createTerm(input: { sessionId: string; name: string; startDate: Date; endDate: Date }, actor: Actor) {
  if (input.endDate <= input.startDate) throw new ValidationError('End date must be after start date');
  const exists = await db.term.findUnique({ where: { sessionId_name: { sessionId: input.sessionId, name: input.name } } });
  if (exists) throw new ConflictError(`"${input.name}" already exists in this session`);
  const term = await db.term.create({ data: input });
  await logAudit({ userId: actor.id, userRole: actor.role, action: 'term.created', entityType: 'Term', entityId: term.id, afterValues: { name: term.name } });
  return term;
}

export async function setCurrentTerm(id: string, actor: Actor) {
  const term = await db.term.findUnique({ where: { id } });
  if (!term) throw new NotFoundError('Term', id);
  await db.$transaction([
    db.term.updateMany({ where: { sessionId: term.sessionId }, data: { isCurrent: false } }),
    db.term.update({ where: { id }, data: { isCurrent: true } }),
    db.schoolSetting.updateMany({ data: { currentTermId: id, currentSessionId: term.sessionId } }),
  ]);
  await logAudit({ userId: actor.id, userRole: actor.role, action: 'term.set_current', entityType: 'Term', entityId: id, afterValues: { name: term.name } });
  return term;
}

export async function updateSession(id: string, input: { name?: string; startDate?: Date; endDate?: Date }, actor: Actor) {
  const before = await db.academicSession.findUnique({ where: { id } });
  if (!before) throw new NotFoundError('Session', id);

  if (input.name && input.name !== before.name) {
    const exists = await db.academicSession.findUnique({ where: { name: input.name } });
    if (exists) throw new ConflictError(`Session "${input.name}" already exists`);
  }
  const nextStart = input.startDate ?? before.startDate;
  const nextEnd = input.endDate ?? before.endDate;
  if (nextEnd <= nextStart) throw new ValidationError('End date must be after start date');

  const session = await db.academicSession.update({ where: { id }, data: input });
  await logAudit({
    userId: actor.id, userRole: actor.role,
    action: 'session.updated', entityType: 'AcademicSession', entityId: id,
    beforeValues: { name: before.name, startDate: before.startDate, endDate: before.endDate },
    afterValues: { name: session.name, startDate: session.startDate, endDate: session.endDate },
  });
  return session;
}

export async function updateTerm(id: string, input: { name?: string; startDate?: Date; endDate?: Date }, actor: Actor) {
  const before = await db.term.findUnique({ where: { id } });
  if (!before) throw new NotFoundError('Term', id);

  if (input.name && input.name !== before.name) {
    const exists = await db.term.findUnique({ where: { sessionId_name: { sessionId: before.sessionId, name: input.name } } });
    if (exists) throw new ConflictError(`"${input.name}" already exists in this session`);
  }
  const nextStart = input.startDate ?? before.startDate;
  const nextEnd = input.endDate ?? before.endDate;
  if (nextEnd <= nextStart) throw new ValidationError('End date must be after start date');

  const term = await db.term.update({ where: { id }, data: input });
  await logAudit({
    userId: actor.id, userRole: actor.role,
    action: 'term.updated', entityType: 'Term', entityId: id,
    beforeValues: { name: before.name, startDate: before.startDate, endDate: before.endDate },
    afterValues: { name: term.name, startDate: term.startDate, endDate: term.endDate },
  });
  return term;
}

export async function resolveCurrentContext() {
  const today = new Date();

  // Layer 2a: term whose date range contains today
  const byDate = await db.term.findFirst({
    where: { startDate: { lte: today }, endDate: { gte: today } },
    include: { session: true },
  });
  if (byDate) {
    return {
      sessionId: byDate.sessionId, termId: byDate.id,
      sessionName: byDate.session.name, termName: byDate.name,
      source: 'date',
    };
  }

  // Layer 2b: flagged current term (holiday gaps, extensions)
  const flaggedTerm = await db.term.findFirst({ where: { isCurrent: true }, include: { session: true } });
  if (flaggedTerm) {
    return {
      sessionId: flaggedTerm.sessionId, termId: flaggedTerm.id,
      sessionName: flaggedTerm.session.name, termName: flaggedTerm.name,
      source: 'flag',
    };
  }

  // Layer 2c: flagged current session (no terms configured yet)
  const flaggedSession = await db.academicSession.findFirst({ where: { isCurrent: true } });
  if (flaggedSession) {
    return {
      sessionId: flaggedSession.id, termId: null,
      sessionName: flaggedSession.name, termName: null,
      source: 'flag',
    };
  }

  return { sessionId: null, termId: null, sessionName: null, termName: null, source: 'none' };
}

// ================= CLASSES =================

const CLASS_LEVELS: Record<string, { label: string; max: number }> = {
  nursery: { label: 'Nursery', max: 2 },
  primary: { label: 'Primary', max: 6 },
  junior: { label: 'JSS', max: 3 },
  senior: { label: 'SSS', max: 3 },
};

export function validateClassName(name: string, level: string): string | null {
  const cfg = CLASS_LEVELS[level];
  if (!cfg) return 'Unknown class level.';
  const match = name.trim().match(/^(.+?)\s+(\d+)(?:\s*\(([^)]+)\))?$/);
  if (!match) return `Class name must look like "${cfg.label} 1" or "${cfg.label} 1 (Science)".`;
  const prefix = match[1].trim().toLowerCase();
  const num = parseInt(match[2], 10);
  if (prefix !== cfg.label.toLowerCase()) {
    return `A "${cfg.label}" level class must be named "${cfg.label} <number>".`;
  }
  if (num < 1 || num > cfg.max) {
    return `${cfg.label} classes only accept numbers 1 to ${cfg.max}. "${name.trim()}" is not allowed.`;
  }
  return null;
}

export async function listClasses() {
  return db.class.findMany({
    orderBy: { name: 'asc' },
    include: { _count: { select: { students: true, classSubjects: true } } },
  });
}

export async function createClass(input: { name: string; level: string; capacity?: number; department?: string | null }, actor: Actor) {
  const nameError = validateClassName(input.name, input.level);
  if (nameError) throw new ValidationError(nameError);
  const exists = await db.class.findUnique({ where: { name: input.name } });
  if (exists) throw new ConflictError(`Class "${input.name}" already exists`);
  const cls = await db.class.create({ data: input });
  await logAudit({ userId: actor.id, userRole: actor.role, action: 'class.created', entityType: 'Class', entityId: cls.id, afterValues: { name: cls.name } });
  return cls;
}

export async function updateClass(
  id: string,
  input: { name?: string; level?: string; capacity?: number; classTeacherId?: string | null; department?: string | null },
  actor: Actor,
) {
  const before = await db.class.findUnique({ where: { id } });
  if (!before) throw new NotFoundError('Class', id);
  const nameError = validateClassName(input.name ?? before.name, input.level ?? before.level);
  if (nameError) throw new ValidationError(nameError);
  const cls = await db.class.update({ where: { id }, data: input });
  await logAudit({
    userId: actor.id, userRole: actor.role,
    action: 'class.updated', entityType: 'Class', entityId: id,
    beforeValues: { name: before.name, classTeacherId: before.classTeacherId },
    afterValues: { name: cls.name, classTeacherId: cls.classTeacherId },
  });
  return cls;
}

export async function deleteClass(id: string, actor: Actor) {
  const cls = await db.class.findUnique({
    where: { id },
    include: { _count: { select: { students: true, classSubjects: true, teacherClassSubjects: true } } },
  });
  if (!cls) throw new NotFoundError('Class', id);
  if (cls._count.students > 0) throw new ValidationError('Cannot delete a class that still has students.');
  if (cls._count.classSubjects > 0 || cls._count.teacherClassSubjects > 0) {
    throw new ValidationError('Cannot delete a class with subject or teacher assignments. Remove them first.');
  }
  await db.class.delete({ where: { id } });
  await logAudit({ userId: actor.id, userRole: actor.role, action: 'class.deleted', entityType: 'Class', entityId: id, beforeValues: { name: cls.name } });
  return { success: true };
}

// ================= SUBJECTS =================
export async function listSubjects() {
  return db.subject.findMany({ orderBy: { name: 'asc' }, include: { _count: { select: { classSubjects: true } } } });
}

export async function createSubject(input: { name: string; code: string; description?: string }, actor: Actor) {
  const code = input.code.trim().toUpperCase();
  const exists = await db.subject.findFirst({ where: { OR: [{ code }, { name: input.name }] } });
  if (exists) throw new ConflictError(`Subject "${input.name}" or code "${code}" already exists`);
  const subject = await db.subject.create({ data: { ...input, code } });
  await logAudit({ userId: actor.id, userRole: actor.role, action: 'subject.created', entityType: 'Subject', entityId: subject.id, afterValues: { name: subject.name, code } });
  return subject;
}

export async function updateSubject(id: string, input: { name?: string; code?: string; description?: string }, actor: Actor) {
  const before = await db.subject.findUnique({ where: { id } });
  if (!before) throw new NotFoundError('Subject', id);
  const data = { ...input, code: input.code ? input.code.trim().toUpperCase() : undefined };
  const subject = await db.subject.update({ where: { id }, data });
  await logAudit({ userId: actor.id, userRole: actor.role, action: 'subject.updated', entityType: 'Subject', entityId: id, beforeValues: { name: before.name }, afterValues: { name: subject.name } });
  return subject;
}

// ================= CLASS ↔ SUBJECT =================
export async function listClassSubjects(classId: string) {
  return db.classSubject.findMany({ where: { classId }, include: { subject: true } });
}

export async function assignSubjectToClass(classId: string, subjectId: string, actor: Actor) {
  const exists = await db.classSubject.findUnique({ where: { classId_subjectId: { classId, subjectId } } });
  if (exists) throw new ConflictError('This subject is already assigned to this class');
  const link = await db.classSubject.create({ data: { classId, subjectId } });
  await logAudit({ userId: actor.id, userRole: actor.role, action: 'class.subject_assigned', entityType: 'Class', entityId: classId, afterValues: { subjectId } });
  return link;
}

export async function removeSubjectFromClass(classId: string, subjectId: string, actor: Actor) {
  await db.classSubject.deleteMany({ where: { classId, subjectId } });
  await logAudit({ userId: actor.id, userRole: actor.role, action: 'class.subject_removed', entityType: 'Class', entityId: classId, afterValues: { subjectId } });
  return { success: true };
}

// ================= TEACHER ASSIGNMENTS =================
export async function listAssignments(params: { classId?: string; termId?: string }) {
  const rows = await db.teacherClassSubject.findMany({
    where: params,
    include: {
      teacher: { include: { user: { select: { fullName: true } } } },
      class: true,
      subject: true,
    },
    orderBy: { id: 'desc' },
  });

  // Resolve term names separately (TeacherClassSubject has no term relation)
  const termIds = Array.from(new Set(rows.map((r) => r.termId)));
  const terms = await db.term.findMany({ where: { id: { in: termIds } } });
  const termMap = new Map(terms.map((t) => [t.id, t]));

  return rows.map((r) => ({ ...r, term: termMap.get(r.termId) ?? null }));
}

export async function createAssignment(
  input: { teacherId: string; classId: string; subjectId: string; sessionId: string; termId: string },
  actor: Actor,
) {
  const classSubject = await db.classSubject.findUnique({
    where: { classId_subjectId: { classId: input.classId, subjectId: input.subjectId } },
  });
  if (!classSubject) {
    throw new ValidationError('Assign this subject to the class first (Class Subjects tab) before assigning a teacher.');
  }
  const exists = await db.teacherClassSubject.findUnique({
    where: {
      teacherId_classId_subjectId_sessionId_termId: {
        teacherId: input.teacherId, classId: input.classId, subjectId: input.subjectId,
        sessionId: input.sessionId, termId: input.termId,
      },
    },
  });
  if (exists) throw new ConflictError('This teacher is already assigned to this class/subject for the selected term.');

  const assignment = await db.teacherClassSubject.create({ data: input });
  await logAudit({ userId: actor.id, userRole: actor.role, action: 'teacher.assigned', entityType: 'TeacherClassSubject', entityId: String(assignment.id), afterValues: input });
  return assignment;
}

export async function deleteAssignment(id: number, actor: Actor) {
  await db.teacherClassSubject.delete({ where: { id } });
  await logAudit({ userId: actor.id, userRole: actor.role, action: 'teacher.unassigned', entityType: 'TeacherClassSubject', entityId: String(id) });
  return { success: true };
}

export async function listGradingScale(sessionId?: string) {
  return db.gradingScale.findMany({
    where: sessionId ? { OR: [{ sessionId }, { sessionId: null }] } : {},
    orderBy: { minScore: 'asc' },
  });
}

export async function createGradingScale(input: {
  minScore: number; maxScore: number; grade: string; remark: string; sessionId?: string | null;
}, actor: Actor) {
  if (input.minScore > input.maxScore) throw new ValidationError('Minimum score must not exceed maximum score.');
  const row = await db.gradingScale.create({ data: input });
  await logAudit({ userId: actor.id, userRole: actor.role, action: 'grading_scale.created', entityType: 'GradingScale', entityId: String(row.id), afterValues: input });
  return row;
}

export async function updateGradingScale(id: number, input: {
  minScore?: number; maxScore?: number; grade?: string; remark?: string; sessionId?: string | null;
}, actor: Actor) {
  const before = await db.gradingScale.findUnique({ where: { id } });
  if (!before) throw new NotFoundError('GradingScale', String(id));
  const row = await db.gradingScale.update({ where: { id }, data: input });
  await logAudit({ userId: actor.id, userRole: actor.role, action: 'grading_scale.updated', entityType: 'GradingScale', entityId: String(id), beforeValues: before, afterValues: input });
  return row;
}

export async function deleteGradingScale(id: number, actor: Actor) {
  const before = await db.gradingScale.findUnique({ where: { id } });
  if (!before) throw new NotFoundError('GradingScale', String(id));
  await db.gradingScale.delete({ where: { id } });
  await logAudit({ userId: actor.id, userRole: actor.role, action: 'grading_scale.deleted', entityType: 'GradingScale', entityId: String(id), beforeValues: before });
  return { success: true };
}

export async function createAssignmentsBulk(
  input: { teacherId: string; classId: string; subjectIds: string[]; sessionId: string; termId: string },
  actor: Actor,
) {
  let created = 0;
  let skipped = 0;
  for (const subjectId of input.subjectIds) {
    const classSubject = await db.classSubject.findUnique({ where: { classId_subjectId: { classId: input.classId, subjectId } } });
    if (!classSubject) { skipped++; continue; }
    const exists = await db.teacherClassSubject.findUnique({
      where: {
        teacherId_classId_subjectId_sessionId_termId: {
          teacherId: input.teacherId, classId: input.classId, subjectId,
          sessionId: input.sessionId, termId: input.termId,
        },
      },
    });
    if (exists) { skipped++; continue; }
    await db.teacherClassSubject.create({
      data: { teacherId: input.teacherId, classId: input.classId, subjectId, sessionId: input.sessionId, termId: input.termId },
    });
    created++;
  }
  await logAudit({
    userId: actor.id, userRole: actor.role, action: 'teacher.assigned_bulk',
    entityType: 'TeacherClassSubject', entityId: input.classId,
    afterValues: { teacherId: input.teacherId, termId: input.termId, created, skipped },
  });
  return { created, skipped };
}