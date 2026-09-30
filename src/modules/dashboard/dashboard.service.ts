import { db } from '../../config/db';

function daysAgo(n: number) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(0, 0, 0, 0);
  return d;
}

export async function stats(userId: string, role: string) {
  const currentSession = await db.academicSession.findFirst({ where: { isCurrent: true } });
  const currentTerm = currentSession
    ? await db.term.findFirst({ where: { sessionId: currentSession.id, isCurrent: true } })
    : null;

  if (role === 'TEACHER') {
    const teacher = await db.teacher.findUnique({ where: { userId } });
    if (!teacher) return { role, currentSession, currentTerm, my: {} };
    const [classes, students, today] = await Promise.all([
      db.teacherClassSubject.findMany({ where: { teacherId: teacher.id, termId: currentTerm?.id ?? '' }, select: { classId: true } }),
      db.teacherClassSubject.findMany({ where: { teacherId: teacher.id, termId: currentTerm?.id ?? '' }, select: { class: { include: { students: true } } } }),
          db.timetableEntry.count({ where: { teacherId: teacher.id, termId: currentTerm?.id ?? '', dayOfWeek: new Date().getDay() || 7 } }),
    ]);
    const uniqueClassIds = new Set(classes.map((c) => c.classId));
    const myStudentIds = new Set(students.flatMap((s) => s.class.students.map((st) => st.id)));
    return {
      role, currentSession, currentTerm,
      my: { classes: uniqueClassIds.size, students: myStudentIds.size, todayPeriods: today },
    };
  }

  if (role === 'PARENT') {
    const parent = await db.parent.findUnique({ where: { userId }, include: { students: { include: { student: true } } } });
    const kids = parent?.students.map((p) => p.student) ?? [];
    return { role, currentSession, currentTerm, my: { children: kids.length, names: kids.map((k) => ({ id: k.id, name: k.fullName, className: k.class?.name })) } };
  }

  // ADMIN / SUPER_ADMIN
  const [totalStudents, totalClasses, totalTeachers, pending, todayAttendance, collected, billed] = await Promise.all([
    db.student.count({ where: { status: 'active' } }),
    db.class.count(),
    db.teacher.count(),
    db.user.count({ where: { status: 'PENDING' } }),
    db.attendanceRecord.groupBy({ by: ['status'], where: { date: { gte: daysAgo(0) } }, _count: true }),
    currentTerm ? db.payment.aggregate({ where: { termId: currentTerm.id, status: 'paid' }, _sum: { amountPaid: true } }) : Promise.resolve({ _sum: { amountPaid: 0 } }),
    currentTerm ? db.feeStructure.aggregate({ where: { termId: currentTerm.id }, _sum: { amount: true } }) : Promise.resolve({ _sum: { amount: 0 } }),
  ]);
  const activeStudents = await db.student.count({ where: { status: 'active' } });
  const outstandingEstimate = (billed._sum.amount ?? 0) * activeStudents - (collected._sum.amountPaid ?? 0);

  return {
    role, currentSession, currentTerm,
    totals: {
      students: totalStudents, classes: totalClasses, teachers: totalTeachers, pendingRegistrations: pending,
      todayAttendance: Object.fromEntries(todayAttendance.map((g) => [g.status, g._count])),
      finance: { collected: collected._sum.amountPaid ?? 0, outstanding: outstandingEstimate },
    },
  };
}

export async function attendanceChart(days: number, userId: string, role: string) {
  const from = daysAgo(days - 1);
  let classIds: string[] | undefined;

  if (role === 'TEACHER') {
    const teacher = await db.teacher.findUnique({ where: { userId } });
    if (!teacher) return [];
    const assignments = await db.teacherClassSubject.findMany({ where: { teacherId: teacher.id }, select: { classId: true } });
    classIds = Array.from(new Set(assignments.map((a) => a.classId)));
  } else if (role === 'PARENT') {
    const parent = await db.parent.findUnique({ where: { userId }, include: { students: { include: { student: true } } } });
    if (!parent) return [];
    classIds = Array.from(new Set(parent.students.map((s) => s.student.classId)));
  }

  const where: any = { date: { gte: from } };
  if (classIds) where.classId = { in: classIds };
  const records = await db.attendanceRecord.findMany({ where, select: { date: true, status: true } });

  const byDate = new Map<string, { date: string; present: number; absent: number; late: number; excused: number }>();
  for (let i = 0; i < days; i++) {
    const d = new Date(from);
    d.setDate(d.getDate() + i);
    const key = d.toISOString().slice(0, 10);
    byDate.set(key, { date: d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }), present: 0, absent: 0, late: 0, excused: 0 });
  }
  for (const r of records) {
    const key = new Date(r.date).toISOString().slice(0, 10);
    const slot = byDate.get(key);
    if (slot && r.status in slot) (slot as any)[r.status]++;
  }
  return Array.from(byDate.values());
}

export async function recentAnnouncements(role: string, take = 5) {
  const all = await db.news.findMany({
    where: { status: 'published' },
    include: { author: { select: { fullName: true } } },
    orderBy: { publishedAt: 'desc' }, take: 20,
  });
  const canSee = (a: string) => a === 'all' || (a === 'teachers' && (role === 'TEACHER' || role === 'ADMIN' || role === 'SUPER_ADMIN')) || (a === 'parents' && (role === 'PARENT' || role === 'ADMIN' || role === 'SUPER_ADMIN'));
  return all.filter((n) => canSee(n.audience)).slice(0, take);
}

export async function upcomingEvents(role: string) {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const all = await db.event.findMany({
    where: {
      OR: [
        { endDate: { gte: startOfToday } },
        { endDate: null, startDate: { gte: startOfToday } },
      ],
    },
    orderBy: { startDate: 'asc' },
    take: 5,
  });
  const canSee = (a: string) => a === 'all' || (a === 'teachers' && (role === 'TEACHER' || role === 'ADMIN' || role === 'SUPER_ADMIN')) || (a === 'parents' && (role === 'PARENT' || role === 'ADMIN' || role === 'SUPER_ADMIN'));
  return all.filter((e) => canSee(e.audience));
}