import { db } from '../../config/db';

// --- Simple in-memory cache (30 seconds) ---
const cache = new Map<string, { data: any; expires: number }>();
function getCached<T>(key: string): T | null {
  const entry = cache.get(key);
  if (entry && entry.expires > Date.now()) return entry.data as T;
  return null;
}
function setCache<T>(key: string, data: T, ttlMs = 30000) {
  cache.set(key, { data, expires: Date.now() + ttlMs });
}

function daysAgo(n: number) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(0, 0, 0, 0);
  return d;
}

export async function stats(userId: string, role: string) {
  const cacheKey = `stats:${role}:${userId}`;
  const cached = getCached<any>(cacheKey);
  if (cached) return cached;

  const currentSession = await db.academicSession.findFirst({ where: { isCurrent: true } });
  const currentTerm = currentSession
    ? await db.term.findFirst({ where: { sessionId: currentSession.id, isCurrent: true } })
    : null;

  let result: any;

  if (role === 'TEACHER') {
    // OPTIMIZATION: Fetch teacher and their classes in ONE query
    const teacher = await db.teacher.findUnique({
      where: { userId },
      include: {
        classSubjects: {
          where: { termId: currentTerm?.id ?? '' },
          include: { class: { include: { students: true } } }
        }
      }
    });
    
    if (!teacher) {
      result = { role, currentSession, currentTerm, my: {} };
    } else {
      // Run the periods count in parallel with processing the classes we already fetched
      const todayPeriods = await db.timetableEntry.count({ 
        where: { teacherId: teacher.id, termId: currentTerm?.id ?? '', dayOfWeek: new Date().getDay() || 7 } 
      });
      
      const uniqueClassIds = new Set(teacher.classSubjects.map((c) => c.classId));
      const myStudentIds = new Set(teacher.classSubjects.flatMap((s) => s.class.students.map((st) => st.id)));
      
      result = {
        role, currentSession, currentTerm,
        my: { classes: uniqueClassIds.size, students: myStudentIds.size, todayPeriods },
      };
    }
  } else if (role === 'PARENT') {
    const parent = await db.parent.findUnique({ 
      where: { userId }, 
      include: { students: { include: { student: { include: { class: true } } } } } 
    });
    const kids = parent?.students.map((p) => p.student) ?? [];
    result = { 
      role, currentSession, currentTerm, 
      my: { children: kids.length, names: kids.map((k) => ({ id: k.id, name: k.fullName, className: k.class?.name })) } 
    };
  } else {
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
    
    // OPTIMIZATION: Removed duplicate activeStudents query. Reusing totalStudents.
    const outstandingEstimate = (billed._sum.amount ?? 0) * totalStudents - (collected._sum.amountPaid ?? 0);

    result = {
      role, currentSession, currentTerm,
      totals: {
        students: totalStudents, classes: totalClasses, teachers: totalTeachers, pendingRegistrations: pending,
        todayAttendance: Object.fromEntries(todayAttendance.map((g) => [g.status, g._count])),
        finance: { collected: collected._sum.amountPaid ?? 0, outstanding: outstandingEstimate },
      },
    };
  }

  setCache(cacheKey, result);
  return result;
}

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

export async function attendanceChart(days: number, userId: string, role: string) {
  const cacheKey = `chart:${role}:${userId}:${days}`;
  const cached = getCached<any>(cacheKey);
  if (cached) return cached;

  const from = daysAgo(days - 1);
  let classIds: string[] | undefined;

  if (role === 'TEACHER') {
    const teacher = await db.teacher.findUnique({
      where: { userId },
      include: { classSubjects: { select: { classId: true } } }
    });
    if (!teacher) return [];
    classIds = Array.from(new Set(teacher.classSubjects.map((a) => a.classId)));
  } else if (role === 'PARENT') {
    const parent = await db.parent.findUnique({
      where: { userId },
      include: { students: { select: { student: { select: { classId: true } } } } }
    });
    if (!parent) return [];
    classIds = Array.from(new Set(parent.students.map((s) => s.student.classId)));
  }

  const where: any = { date: { gte: from } };
  if (classIds) where.classId = { in: classIds };
  const records = await db.attendanceRecord.findMany({ where, select: { date: true, status: true } });

  const byDate = new Map<string, { date: string; iso: string; present: number; absent: number; late: number; excused: number }>();
  const cursor = new Date(from);
  for (let i = 0; i < days; i++) {
    const key = dayKey(cursor);
    byDate.set(key, {
      date: cursor.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }),
      iso: key,
      present: 0,
      absent: 0,
      late: 0,
      excused: 0,
    });
    cursor.setDate(cursor.getDate() + 1);
  }
  for (const r of records) {
    const slot = byDate.get(dayKey(new Date(r.date)));
    if (slot && r.status in slot) (slot as any)[r.status]++;
  }

  const result = Array.from(byDate.values());
  setCache(cacheKey, result, 60000);
  return result;
}

export async function recentAnnouncements(role: string, take = 5) {
  // OPTIMIZATION: Push role filtering to the database instead of JS memory
  const allowedAudiences = ['all'];
  if (role === 'TEACHER' || role === 'ADMIN' || role === 'SUPER_ADMIN') allowedAudiences.push('teachers');
  if (role === 'PARENT' || role === 'ADMIN' || role === 'SUPER_ADMIN') allowedAudiences.push('parents');

  return db.news.findMany({
    where: { status: 'published', audience: { in: allowedAudiences } },
    include: { author: { select: { fullName: true } } },
    orderBy: { publishedAt: 'desc' }, 
    take,
  });
}

export async function upcomingEvents(role: string) {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  
  const allowedAudiences = ['all'];
  if (role === 'TEACHER' || role === 'ADMIN' || role === 'SUPER_ADMIN') allowedAudiences.push('teachers');
  if (role === 'PARENT' || role === 'ADMIN' || role === 'SUPER_ADMIN') allowedAudiences.push('parents');

  return db.event.findMany({
    where: {
      audience: { in: allowedAudiences },
      OR: [
        { endDate: { gte: startOfToday } },
        { endDate: null, startDate: { gte: startOfToday } },
      ],
    },
    orderBy: { startDate: 'asc' },
    take: 5,
  });
}