import { db } from '../../config/db';
import { ForbiddenError, NotFoundError, ValidationError } from '../../shared/errors';
import { logAudit } from '../../core/audit/audit.service';
import * as notify from '../../core/notify/notify.service';
type Actor = { id: string; role: string };

/** Keeps the current-session enrollment row in sync with the student's live class. */
async function syncCurrentEnrollment(studentId: string, classId: string) {
  try {
    const setting = await db.schoolSetting.findFirst({ select: { currentSessionId: true } });
    if (!setting?.currentSessionId) return;
    const enr = await db.enrollment.findUnique({
      where: { studentId_sessionId: { studentId, sessionId: setting.currentSessionId } },
    });
    if (enr && enr.classId !== classId) {
      await db.enrollment.update({ where: { id: enr.id }, data: { classId, outcome: 'transferred' } });
    }
  } catch { /* never break report rendering */ }
}

function round1(n: number) { return Math.round(n * 10) / 10; }

async function resolveTeacherId(userId: string) {
  const t = await db.teacher.findUnique({ where: { userId }, select: { id: true } });
  return t?.id ?? null;
}

export async function classRosterForTerm(classId: string, termId: string) {
  const term = await db.term.findUnique({ where: { id: termId } });
  if (!term) return [];
  const setting = await db.schoolSetting.findFirst({ select: { currentSessionId: true } });
  if (setting?.currentSessionId && term.sessionId === setting.currentSessionId) {
    const active = await db.student.findMany({
      where: { classId, status: 'active' }, orderBy: { fullName: 'asc' },
      select: { id: true, studentId: true, fullName: true },
    });
    if (active.length) return active;
  }
  const enrolled = await db.enrollment.findMany({
    where: { sessionId: term.sessionId, classId },
    include: { student: { select: { id: true, studentId: true, fullName: true } } },
  });
  if (enrolled.length) return enrolled.map((e) => e.student);
  const withResults = await db.result.findMany({
    where: { termId, classId },
    select: { student: { select: { id: true, studentId: true, fullName: true } } },
    distinct: ['studentId'],
  });
  if (withResults.length) return withResults.map((r) => r.student);
  return db.student.findMany({
    where: { classId, status: 'active' }, orderBy: { fullName: 'asc' },
    select: { id: true, studentId: true, fullName: true },
  });
}

export async function gradeFor(score: number, sessionId: string) {
  const scale = await db.gradingScale.findMany({ where: { OR: [{ sessionId }, { sessionId: null }] } });
  const row = scale.find((g) => score >= g.minScore && score <= g.maxScore);
  return row ? { grade: row.grade, remark: row.remark } : { grade: null as string | null, remark: null as string | null };
}

export async function getEntrySheet(params: { classId: string; subjectId: string; termId: string }) {
  const [students, subject, term] = await Promise.all([
    db.student.findMany({ where: { classId: params.classId, status: 'active' }, orderBy: { fullName: 'asc' }, select: { id: true, studentId: true, fullName: true } }),
    db.subject.findUnique({ where: { id: params.subjectId } }),
    db.term.findUnique({ where: { id: params.termId } }),
  ]);
  const results = await db.result.findMany({
    where: { subjectId: params.subjectId, termId: params.termId, studentId: { in: students.map((s) => s.id) } },
  });

  const locked = results.length ? results[0].locked : false;
  return { students, results, subject, term, locked };
}

async function recomputePositions(classId: string, subjectId: string, termId: string) {
  const rows = await db.result.findMany({ where: { classId, subjectId, termId }, orderBy: { totalScore: 'desc' } });
  let pos = 0;
  let lastScore: number | null = null;
  for (let i = 0; i < rows.length; i++) {
    if (lastScore === null || rows[i].totalScore !== lastScore) { pos = i + 1; lastScore = rows[i].totalScore; }
    await db.result.update({ where: { id: rows[i].id }, data: { position: pos } });
  }
}

export async function saveScores(input: {
  classId: string; subjectId: string; termId: string;
  entries: { studentId: string; testScore: number; examScore: number; teacherComment?: string }[];
}, actor: Actor) {
  const term = await db.term.findUnique({ where: { id: input.termId }, include: { session: true } });
  if (!term) throw new NotFoundError('Term', input.termId);

  if (actor.role === 'TEACHER') {
    const teacherId = await resolveTeacherId(actor.id);
    if (!teacherId) throw new ForbiddenError('No teacher profile found.');
    const assigned = await db.teacherClassSubject.findFirst({
      where: { teacherId, classId: input.classId, subjectId: input.subjectId, termId: input.termId },
    });
    if (!assigned) throw new ForbiddenError('You are not assigned to this class/subject in the selected term.');
  }

    for (const e of input.entries) {
    if (e.testScore < 0 || e.testScore > 30) {
      throw new ValidationError(`CA score must be between 0 and 30 (received ${e.testScore}).`);
    }
    if (e.examScore < 0 || e.examScore > 70) {
      throw new ValidationError(`Exam score must be between 0 and 70 (received ${e.examScore}).`);
    }
  }

  const existing = await db.result.findMany({
    where: { subjectId: input.subjectId, termId: input.termId, studentId: { in: input.entries.map((e) => e.studentId) } },
  });
  if (existing.some((r) => r.locked) && actor.role === 'TEACHER') {
    throw new ForbiddenError('These results are locked. Ask an administrator to unlock them for changes.');
  }

  for (const e of input.entries) {
    const total = round1(e.testScore + e.examScore);
    const g = await gradeFor(total, term.sessionId);
    const prev = existing.find((r) => r.studentId === e.studentId);
    if (prev) {
      await db.result.update({
        where: { id: prev.id },
        data: {
          classId: input.classId,
          testScore: e.testScore, examScore: e.examScore, totalScore: total, grade: g.grade,
          teacherComment: e.teacherComment ?? prev.teacherComment,
        },
      });
    } else {
      await db.result.create({
        data: {
          studentId: e.studentId, subjectId: input.subjectId, classId: input.classId,
          sessionId: term.sessionId, termId: input.termId,
          testScore: e.testScore, examScore: e.examScore, totalScore: total,
          grade: g.grade, teacherComment: e.teacherComment ?? null, enteredBy: actor.id,
        },
      });
    }
  }

  await recomputePositions(input.classId, input.subjectId, input.termId);
  await logAudit({
    userId: actor.id, userRole: actor.role,
    action: existing.length ? 'results.updated' : 'results.entered',
    entityType: 'Result', entityId: input.classId,
    afterValues: { subjectId: input.subjectId, termId: input.termId, count: input.entries.length },
  });
  return { success: true };
}

export async function setLock(params: { classId: string; subjectId: string; termId: string; locked: boolean }, actor: Actor) {
  const res = await db.result.updateMany({
    where: { classId: params.classId, subjectId: params.subjectId, termId: params.termId },
    data: { locked: params.locked },
  });
  await logAudit({
    userId: actor.id, userRole: actor.role,
    action: params.locked ? 'results.locked' : 'results.unlocked',
    entityType: 'Result', entityId: params.classId,
    afterValues: { subjectId: params.subjectId, termId: params.termId, count: res.count },
  });
  return { success: true, count: res.count };
}

export async function classResultSheet(params: { classId: string; termId: string }) {
  const [students, classSubjects] = await Promise.all([
    db.student.findMany({ where: { classId: params.classId, status: 'active' }, orderBy: { fullName: 'asc' }, select: { id: true, studentId: true, fullName: true } }),
    db.classSubject.findMany({ where: { classId: params.classId }, include: { subject: true } }),
  ]);
  const results = await db.result.findMany({
    where: { termId: params.termId, studentId: { in: students.map((s) => s.id) } },
    include: { subject: { select: { id: true, name: true } } },
  });
  return { students, results, subjects: classSubjects.map((cs) => cs.subject) };
}

export async function reportCardData(studentId: string, termId: string) {
  const student = await db.student.findUnique({ where: { id: studentId }, include: { class: true, session: true } });
  if (!student) throw new NotFoundError('Student', studentId);
  const term = await db.term.findUnique({ where: { id: termId }, include: { session: true } });
  if (!term) throw new NotFoundError('Term', termId);

  // Class context: ongoing session = live placement; past sessions = enrollment/result history
  const setting = await db.schoolSetting.findFirst({ select: { currentSessionId: true } });
  let histClassId: string;
  if (setting?.currentSessionId && term.sessionId === setting.currentSessionId) {
    histClassId = student.classId;
    await syncCurrentEnrollment(studentId, student.classId);
  } else {
    const enrollment = await db.enrollment.findUnique({ where: { studentId_sessionId: { studentId, sessionId: term.sessionId } } });
    const fallbackClass = await db.result.findFirst({ where: { studentId, termId }, select: { classId: true } });
    histClassId = enrollment?.classId ?? fallbackClass?.classId ?? student.classId;
  }
  const histClass = (await db.class.findUnique({ where: { id: histClassId } })) ?? student.class;
  const studentView = { ...student, class: histClass };

  const results = await db.result.findMany({
    where: { studentId, termId },
    include: { subject: { select: { name: true, code: true } } },
    orderBy: { totalScore: 'desc' },
  });
  if (!results.length) throw new NotFoundError('Results for this student in the selected term');

    const enriched: any[] = [];
  for (const r of results) {
    const gr = await gradeFor(r.totalScore, term.sessionId);
    enriched.push({ ...r, remark: gr.remark });
  }

  const average = round1(results.reduce((a, r) => a + r.totalScore, 0) / results.length);
  const g = await gradeFor(average, term.sessionId);

  const classmates = await db.result.findMany({ where: { termId, classId: histClassId }, select: { studentId: true }, distinct: ['studentId'] });
  const allResults = await db.result.findMany({ where: { termId, studentId: { in: classmates.map((c) => c.studentId) } } });
  const perStudent = new Map<string, number[]>();
  for (const r of allResults) {
    if (!perStudent.has(r.studentId)) perStudent.set(r.studentId, []);
    perStudent.get(r.studentId)!.push(r.totalScore);
  }
  const averages = Array.from(perStudent.entries())
    .map(([sid, scores]) => ({ sid, avg: scores.reduce((a, b) => a + b, 0) / scores.length }))
    .sort((a, b) => b.avg - a.avg);
  const position = averages.findIndex((a) => a.sid === studentId) + 1;

  const settings = await db.schoolSetting.findFirst();

  // Attendance summary
  const openedRows = await db.attendanceRecord.findMany({
    where: { classId: histClassId, termId }, select: { date: true }, distinct: ['date'],
  });

  const myAttendance = await db.attendanceRecord.findMany({ where: { studentId, termId } });
  const attendance = {
    opened: openedRows.length,
    present: myAttendance.filter((a) => a.status === 'present' || a.status === 'late').length,
    punctual: myAttendance.filter((a) => a.status === 'present').length,
  };

  // Next term resumption date
  const sessionTerms = await db.term.findMany({ where: { sessionId: term.sessionId }, orderBy: { startDate: 'asc' } });
  let nextTermStart: Date | null = sessionTerms.find((t) => t.startDate > term.startDate)?.startDate ?? null;
  if (!nextTermStart) {
    const nextSession = await db.academicSession.findFirst({
      where: { startDate: { gt: term.session.startDate } },
      orderBy: { startDate: 'asc' }, include: { terms: { orderBy: { startDate: 'asc' } } },
    });
    nextTermStart = nextSession?.terms[0]?.startDate ?? null;
  }

  // Other terms' totals (for the First/Second Term columns)
  // Only show terms that occurred BEFORE the current term in this session
  const otherTerms = sessionTerms.filter((t) => t.startDate < term.startDate);
  const otherTotals = await db.result.findMany({
    where: { studentId, termId: { in: otherTerms.map((t) => t.id) } },
    select: { subjectId: true, termId: true, totalScore: true },
  });

  const conduct = await db.studentConduct.findMany({ where: { studentId, termId } });
  const remarks = await db.studentTermRemark.findUnique({ where: { studentId_termId: { studentId, termId } } });

  const cls = await db.class.findUnique({
    where: { id: histClassId },
    include: { classTeacher: { include: { user: { select: { fullName: true } } } } },
  });
  const teacherSig = cls?.classTeacherId
    ? await db.teacher.findUnique({ where: { id: cls.classTeacherId }, select: { signatureUrl: true } })
    : null;

  return {
    student: studentView, term, results: enriched, average, grade: g.grade, remark: g.remark,
    position, classSize: averages.length, noInClass: averages.length, settings,
    attendance, nextTermStart,
    otherTerms: otherTerms.map((t) => ({ id: t.id, name: t.name })),
    otherTotals, conduct, remarks,
    classTeacherName: cls?.classTeacher?.user.fullName ?? null,
    signatures: {
      teacher: teacherSig?.signatureUrl ?? null,
      headTeacher: settings?.headTeacherSignatureUrl ?? null,
      stamp: settings?.officialStampUrl ?? null,
    },
  };
}

export async function saveConduct(input: {
  studentId: string; termId: string;
  ratings: { category: string; item: string; rating: string }[];
}, actor: Actor) {
  const student = await db.student.findUnique({ where: { id: input.studentId } });
  if (!student) throw new NotFoundError('Student', input.studentId);
  if (actor.role === 'TEACHER') {
    const teacherId = await resolveTeacherId(actor.id);
    const assigned = teacherId && await db.teacherClassSubject.findFirst({
      where: { teacherId, classId: student.classId, termId: input.termId },
    });
    if (!assigned) throw new ForbiddenError('Only a teacher assigned to this class can edit conduct observations.');
  }
  for (const r of input.ratings) {
    await db.studentConduct.upsert({
      where: { studentId_termId_category_item: { studentId: input.studentId, termId: input.termId, category: r.category, item: r.item } },
      update: { rating: r.rating },
      create: { studentId: input.studentId, termId: input.termId, category: r.category, item: r.item, rating: r.rating },
    });
  }
  await logAudit({ userId: actor.id, userRole: actor.role, action: 'conduct.updated', entityType: 'StudentConduct', entityId: input.studentId, afterValues: { termId: input.termId, count: input.ratings.length } });
  return { success: true };
}

export async function saveRemarks(input: {
  studentId: string; termId: string;
  teacherComment?: string; headTeacherComment?: string; parentComment?: string; healthComment?: string;
}, actor: Actor) {
  const data: Record<string, string> = {};
  if (actor.role === 'TEACHER') {
    const student = await db.student.findUnique({ where: { id: input.studentId } });
    const teacherId = await resolveTeacherId(actor.id);
    const assigned = teacherId && student && await db.teacherClassSubject.findFirst({
      where: { teacherId, classId: student.classId, termId: input.termId },
    });
    if (!assigned) throw new ForbiddenError('Only a teacher assigned to this class can edit these comments.');
    if (input.teacherComment !== undefined) data.teacherComment = input.teacherComment;
    if (input.healthComment !== undefined) data.healthComment = input.healthComment;
  } else if (actor.role === 'ADMIN' || actor.role === 'SUPER_ADMIN') {
    if (input.headTeacherComment !== undefined) data.headTeacherComment = input.headTeacherComment;
  } else if (actor.role === 'PARENT') {
    if (input.parentComment !== undefined) data.parentComment = input.parentComment;
  } else {
    throw new ForbiddenError('Your role cannot edit report card comments.');
  }
  if (!Object.keys(data).length) throw new ValidationError('No editable fields for your role.');

  await db.studentTermRemark.upsert({
    where: { studentId_termId: { studentId: input.studentId, termId: input.termId } },
    update: data,
    create: { studentId: input.studentId, termId: input.termId, ...data },
  });
  await logAudit({ userId: actor.id, userRole: actor.role, action: 'report_card.remarks_updated', entityType: 'StudentTermRemark', entityId: input.studentId, afterValues: { termId: input.termId, fields: Object.keys(data) } });
  return { success: true };
}

export async function generateReportCards(classId: string, termId: string, actor: Actor) {
  const term = await db.term.findUnique({ where: { id: termId }, include: { session: true } });
  if (!term) throw new NotFoundError('Term', termId);
  const students = await db.student.findMany({ where: { classId, status: 'active' } });
  const settings = await db.schoolSetting.findFirst();
  let count = 0;

  for (const s of students) {
    const data = await reportCardData(s.id, termId).catch(() => null);
    if (!data) continue;
    const total = round1(data.results.reduce((a, r) => a + r.totalScore, 0));
    await db.reportCard.upsert({
      where: { studentId_sessionId_termId: { studentId: s.id, sessionId: term.sessionId, termId } },
      update: {
        totalScore: total, averageScore: data.average, overallGrade: data.grade ?? '',
        overallPosition: data.position,
        schoolNameSnapshot: settings?.schoolName ?? '', headTeacherNameSnapshot: settings?.headTeacherName ?? '',
        termStartDate: term.startDate, termEndDate: term.endDate, generatedAt: new Date(),
      },
      create: {
        studentId: s.id, sessionId: term.sessionId, termId, classId,
        totalScore: total, averageScore: data.average, overallGrade: data.grade ?? '',
        overallPosition: data.position,
        schoolNameSnapshot: settings?.schoolName ?? '', headTeacherNameSnapshot: settings?.headTeacherName ?? '',
        termStartDate: term.startDate, termEndDate: term.endDate, generatedBy: actor.id,
      },
    });
    count++;
  }

  await logAudit({
    userId: actor.id, userRole: actor.role, action: 'report_cards.generated',
    entityType: 'ReportCard', entityId: classId, afterValues: { termId, count },
  });
  void notify.emailReportCardsPublished(classId, termId);
  return { success: true, count };
}

export async function saveStudentScores(input: {
  studentId: string; classId: string; termId: string;
  entries: { subjectId: string; testScore: number; examScore: number }[];
}, actor: Actor) {
  const term = await db.term.findUnique({ where: { id: input.termId }, include: { session: true } });
  if (!term) throw new NotFoundError('Term', input.termId);
  const student = await db.student.findUnique({ where: { id: input.studentId } });
  if (!student) throw new NotFoundError('Student', input.studentId);

  for (const e of input.entries) {
    if (e.testScore < 0 || e.testScore > 30) {
      throw new ValidationError(`CA score must be between 0 and 30 (received ${e.testScore}).`);
    }
    if (e.examScore < 0 || e.examScore > 70) {
      throw new ValidationError(`Exam score must be between 0 and 70 (received ${e.examScore}).`);
    }
  }

  // Teachers may only save subjects they are assigned to in this class/term
  if (actor.role === 'TEACHER') {
    const teacherId = await resolveTeacherId(actor.id);
    if (!teacherId) throw new ForbiddenError('No teacher profile found.');
    const assigned = await db.teacherClassSubject.findMany({
      where: { teacherId, classId: input.classId, termId: input.termId },
      select: { subjectId: true },
    });
    const allowed = new Set(assigned.map((a) => a.subjectId));
    if (input.entries.some((e) => !allowed.has(e.subjectId))) {
      throw new ForbiddenError('You can only enter scores for subjects you are assigned to in this class and term.');
    }
  }

  const subjectIds = input.entries.map((e) => e.subjectId);
  const existing = await db.result.findMany({
    where: { studentId: input.studentId, termId: input.termId, subjectId: { in: subjectIds } },
  });
  if (existing.some((r) => r.locked) && actor.role === 'TEACHER') {
    throw new ForbiddenError('Some of these results are locked. Ask an administrator to unlock them.');
  }

  for (const e of input.entries) {
    const total = round1(e.testScore + e.examScore);
    const g = await gradeFor(total, term.sessionId);
    const prev = existing.find((r) => r.subjectId === e.subjectId);
    if (prev) {
      await db.result.update({
        where: { id: prev.id },
        data: { classId: input.classId, testScore: e.testScore, examScore: e.examScore, totalScore: total, grade: g.grade },
      });
    } else {
      await db.result.create({
        data: {
          studentId: input.studentId, subjectId: e.subjectId, classId: input.classId,
          sessionId: term.sessionId, termId: input.termId,
          testScore: e.testScore, examScore: e.examScore, totalScore: total,
          grade: g.grade, enteredBy: actor.id,
        },
      });
    }
    await recomputePositions(input.classId, e.subjectId, input.termId);
  }

  await logAudit({
    userId: actor.id, userRole: actor.role,
    action: existing.length ? 'results.updated' : 'results.entered',
    entityType: 'Result', entityId: input.studentId,
    afterValues: { termId: input.termId, subjects: subjectIds.length },
  });
  return { success: true, saved: input.entries.length };
}

export async function saveClassScores(input: {
  classId: string; termId: string;
  students: { studentId: string; entries: { subjectId: string; testScore: number; examScore: number }[] }[];
}, actor: Actor) {
  const term = await db.term.findUnique({ where: { id: input.termId }, include: { session: true } });
  if (!term) throw new NotFoundError('Term', input.termId);

  let allowed: Set<string> | null = null;
  if (actor.role === 'TEACHER') {
    const teacherId = await resolveTeacherId(actor.id);
    if (!teacherId) throw new ForbiddenError('No teacher profile found.');
    const assigned = await db.teacherClassSubject.findMany({
      where: { teacherId, classId: input.classId, termId: input.termId },
      select: { subjectId: true },
    });
    allowed = new Set(assigned.map((a) => a.subjectId));
  }

  const studentIds = input.students.map((s) => s.studentId);
  const subjectIds = Array.from(new Set(input.students.flatMap((s) => s.entries.map((e) => e.subjectId))));

  if (allowed) {
    const offending = subjectIds.filter((sid) => !allowed!.has(sid));
    if (offending.length) {
      throw new ForbiddenError('The sheet contains subjects you are not assigned to teach in this class/term.');
    }
  }

  for (const s of input.students) {
    for (const e of s.entries) {
      if (e.testScore < 0 || e.testScore > 30) {
        throw new ValidationError(`CA score for student ${s.studentId} must be 0–30 (received ${e.testScore}).`);
      }
      if (e.examScore < 0 || e.examScore > 70) {
        throw new ValidationError(`Exam score for student ${s.studentId} must be 0–70 (received ${e.examScore}).`);
      }
    }
  }

  const existing = await db.result.findMany({
    where: { studentId: { in: studentIds }, termId: input.termId, subjectId: { in: subjectIds } },
  });
  if (actor.role === 'TEACHER' && existing.some((r) => r.locked)) {
    throw new ForbiddenError('Some results in this sheet are locked. Ask an administrator to unlock them.');
  }

  let saved = 0;
  for (const s of input.students) {
    for (const e of s.entries) {
      const total = round1(e.testScore + e.examScore);
      const g = await gradeFor(total, term.sessionId);
      const prev = existing.find((r) => r.studentId === s.studentId && r.subjectId === e.subjectId);
      if (prev) {
        await db.result.update({
          where: { id: prev.id },
          data: { classId: input.classId, testScore: e.testScore, examScore: e.examScore, totalScore: total, grade: g.grade },
        });
      } else {
        await db.result.create({
          data: {
            studentId: s.studentId, subjectId: e.subjectId, classId: input.classId,
            sessionId: term.sessionId, termId: input.termId,
            testScore: e.testScore, examScore: e.examScore, totalScore: total,
            grade: g.grade, enteredBy: actor.id,
          },
        });
      }
      saved++;
    }
  }

  for (const sid of subjectIds) {
    await recomputePositions(input.classId, sid, input.termId);
  }

  await logAudit({
    userId: actor.id, userRole: actor.role,
    action: 'results.bulk_imported', entityType: 'Result', entityId: input.classId,
    afterValues: { termId: input.termId, students: input.students.length, scores: saved },
  });

  return { students: input.students.length, scores: saved };
}