import { db } from '../../config/db';
import { NotFoundError, ValidationError } from '../../shared/errors';
import { logAudit } from '../../core/audit/audit.service';

type Actor = { id: string; role: string };
export type Decision = 'PROMOTE' | 'REPEAT' | 'GRADUATE' | 'WITHDRAW';

export async function preview(fromSessionId: string) {
  const [classes, allClasses] = await Promise.all([
    db.class.findMany({
      include: { students: { where: { status: 'active' }, orderBy: { fullName: 'asc' } } },
      orderBy: { name: 'asc' },
    }),
    db.class.findMany({ orderBy: { name: 'asc' } }),
  ]);
  const rows = classes
    .filter((c) => c.students.length > 0)
    .map((c) => ({
      classId: c.id,
      className: c.name,
      students: c.students.map((s) => ({ id: s.id, studentId: s.studentId, fullName: s.fullName })),
      defaultDecision: /sss\s*3/i.test(c.name) ? 'GRADUATE' : 'PROMOTE',
    }));
  return { classes: rows, allClasses: allClasses.map((c) => ({ id: c.id, name: c.name })) };
}

export async function apply(actor: Actor, input: {
  fromSessionId: string;
  toSessionId: string | null;
  entries: { studentId: string; decision: Decision; toClassId?: string | null }[];
}) {
  if (!input.entries.length) throw new ValidationError('No students selected for promotion.');
  if (input.entries.some((e) => e.decision === 'PROMOTE' && !e.toClassId)) {
    throw new ValidationError('Every student marked PROMOTE must have a destination class.');
  }
  if (input.entries.some((e) => (e.decision === 'PROMOTE' || e.decision === 'REPEAT') && !input.toSessionId)) {
    throw new ValidationError('Select (or create) the new session before promoting or repeating students.');
  }

  const counts = { promoted: 0, repeated: 0, graduated: 0, withdrawn: 0 };
  const batch = await db.$transaction(async (tx) => {
    const b = await tx.promotionBatch.create({
      data: { fromSessionId: input.fromSessionId, toSessionId: input.toSessionId, createdBy: actor.id },
    });
    for (const e of input.entries) {
      const student = await tx.student.findUnique({ where: { id: e.studentId } });
      if (!student) continue;
      const fromClassId = student.classId;
      let toClassId: string | null = null;

      if (e.decision === 'PROMOTE') {
        toClassId = e.toClassId!;
        await tx.student.update({ where: { id: e.studentId }, data: { classId: toClassId } });
        counts.promoted++;
      } else if (e.decision === 'REPEAT') {
        toClassId = student.classId;
        counts.repeated++;
      } else if (e.decision === 'GRADUATE') {
        await tx.student.update({ where: { id: e.studentId }, data: { status: 'graduated', graduatedAt: new Date() } });
        counts.graduated++;
      } else {
        await tx.student.update({ where: { id: e.studentId }, data: { status: 'withdrawn' } });
        counts.withdrawn++;
      }

      await tx.promotionEntry.create({
        data: { batchId: b.id, studentId: e.studentId, fromClassId, toClassId, decision: e.decision },
      });

      await tx.enrollment.upsert({
        where: { studentId_sessionId: { studentId: e.studentId, sessionId: input.fromSessionId } },
        update: { outcome: e.decision.toLowerCase() },
        create: { studentId: e.studentId, sessionId: input.fromSessionId, classId: fromClassId, outcome: e.decision.toLowerCase() },
      });

      if (input.toSessionId && (e.decision === 'PROMOTE' || e.decision === 'REPEAT')) {
        await tx.enrollment.upsert({
          where: { studentId_sessionId: { studentId: e.studentId, sessionId: input.toSessionId } },
          update: { classId: toClassId!, outcome: e.decision.toLowerCase() },
          create: { studentId: e.studentId, sessionId: input.toSessionId, classId: toClassId!, outcome: e.decision.toLowerCase() },
        });
      }
    }
    await tx.promotionBatch.update({ where: { id: b.id }, data: { counts: JSON.stringify(counts) } });
    return b;
  });

  await logAudit({
    userId: actor.id, userRole: actor.role, action: 'promotion.applied',
    entityType: 'PromotionBatch', entityId: batch.id,
    afterValues: { fromSessionId: input.fromSessionId, toSessionId: input.toSessionId, ...counts },
  });
  return { batch, counts };
}

export async function batches() {
  return db.promotionBatch.findMany({
    orderBy: { createdAt: 'desc' },
    include: {
      fromSession: { select: { name: true } },
      toSession: { select: { name: true } },
      entries: { include: { student: { select: { fullName: true, studentId: true } } } },
    },
  });
}

export async function alumni() {
  return db.student.findMany({
    where: { status: 'graduated' },
    include: { class: { select: { name: true } } },
    orderBy: { graduatedAt: 'desc' },
  });
}

export async function transcript(studentId: string) {
  const student = await db.student.findUnique({ where: { id: studentId }, include: { class: true } });
  if (!student) throw new NotFoundError('Student', studentId);
  const cards = await db.reportCard.findMany({
    where: { studentId },
    include: { term: { select: { name: true } }, session: { select: { name: true } } },
    orderBy: { termStartDate: 'asc' },
  });
  return { student, cards };
}