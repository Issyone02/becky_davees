import { db } from '../../config/db';
import { NotFoundError, ValidationError } from '../../shared/errors';
import { logAudit } from '../../core/audit/audit.service';

type Actor = { id: string; role: string };

export interface EntryInput {
  classId: string; subjectId: string; teacherId: string;
  dayOfWeek: number; startTime: string; endTime: string; termId: string;
}

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];

function overlap(aStart: string, aEnd: string, bStart: string, bEnd: string) {
  return aStart < bEnd && bStart < aEnd;
}

export async function listEntries(params: { classId?: string; termId?: string; teacherId?: string }) {
  return db.timetableEntry.findMany({
    where: params,
    include: {
      class: true,
      subject: true,
      teacher: { include: { user: { select: { fullName: true } } } },
    },
    orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }],
  });
}

async function upsertEntry(id: number | null, input: EntryInput, actor: Actor) {
  if (input.dayOfWeek < 1 || input.dayOfWeek > 5) {
    throw new ValidationError('Day must be Monday (1) to Friday (5).');
  }
  if (!/^\d{2}:\d{2}$/.test(input.startTime) || !/^\d{2}:\d{2}$/.test(input.endTime)) {
    throw new ValidationError('Times must be in 24-hour HH:MM format.');
  }
  if (input.endTime <= input.startTime) throw new ValidationError('End time must be after start time.');

  const term = await db.term.findUnique({ where: { id: input.termId } });
  if (!term) throw new NotFoundError('Term', input.termId);

  const assigned = await db.teacherClassSubject.findFirst({
    where: { teacherId: input.teacherId, classId: input.classId, subjectId: input.subjectId, termId: input.termId },
  });
  if (!assigned) {
    throw new ValidationError('This teacher is not assigned to this class/subject in the selected term. Assign them first in Academics → Teacher Assignments.');
  }

  const exclude = id ? { id } : undefined;
  const classEntries = await db.timetableEntry.findMany({
    where: { classId: input.classId, dayOfWeek: input.dayOfWeek, termId: input.termId, NOT: exclude },
    include: { subject: true },
  });
  for (const e of classEntries) {
    if (overlap(input.startTime, input.endTime, e.startTime, e.endTime)) {
      throw new ValidationError(`Class clash: this class already has ${e.subject.name} ${e.startTime}–${e.endTime} on ${DAYS[input.dayOfWeek - 1]}.`);
    }
  }

  const teacherEntries = await db.timetableEntry.findMany({
    where: { teacherId: input.teacherId, dayOfWeek: input.dayOfWeek, termId: input.termId, NOT: exclude },
    include: { class: true },
  });
  for (const e of teacherEntries) {
    if (overlap(input.startTime, input.endTime, e.startTime, e.endTime)) {
      throw new ValidationError(`Teacher clash: this teacher already has ${e.class.name} ${e.startTime}–${e.endTime} on ${DAYS[input.dayOfWeek - 1]}.`);
    }
  }

  const data = { ...input, sessionId: term.sessionId };
  const entry = id
    ? await db.timetableEntry.update({ where: { id }, data })
    : await db.timetableEntry.create({ data });

  await logAudit({
    userId: actor.id, userRole: actor.role,
    action: id ? 'timetable.updated' : 'timetable.created',
    entityType: 'TimetableEntry', entityId: String(entry.id),
    afterValues: { ...input },
  });
  return entry;
}

export async function createEntry(input: EntryInput, actor: Actor) {
  return upsertEntry(null, input, actor);
}

export async function updateEntry(id: number, input: Partial<EntryInput>, actor: Actor) {
  const existing = await db.timetableEntry.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError('TimetableEntry', String(id));
  const merged: EntryInput = {
    classId: input.classId ?? existing.classId,
    subjectId: input.subjectId ?? existing.subjectId,
    teacherId: input.teacherId ?? existing.teacherId,
    dayOfWeek: input.dayOfWeek ?? existing.dayOfWeek,
    startTime: input.startTime ?? existing.startTime,
    endTime: input.endTime ?? existing.endTime,
    termId: input.termId ?? existing.termId,
  };
  return upsertEntry(id, merged, actor);
}

export async function deleteEntry(id: number, actor: Actor) {
  const existing = await db.timetableEntry.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError('TimetableEntry', String(id));
  await db.timetableEntry.delete({ where: { id } });
  await logAudit({
    userId: actor.id, userRole: actor.role, action: 'timetable.deleted',
    entityType: 'TimetableEntry', entityId: String(id),
    beforeValues: { classId: existing.classId, dayOfWeek: existing.dayOfWeek, startTime: existing.startTime },
  });
  return { success: true };
}