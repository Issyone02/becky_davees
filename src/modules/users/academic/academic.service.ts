import { db } from '../../config/db';

export async function listClasses() {
  return db.class.findMany({
    orderBy: { name: 'asc' },
    include: { _count: { select: { students: true } } },
  });
}

export async function listSessions() {
  return db.academicSession.findMany({ orderBy: { startDate: 'desc' } });
}

export async function listTerms(sessionId?: string) {
  return db.term.findMany({
    where: sessionId ? { sessionId } : {},
    orderBy: { startDate: 'asc' },
  });
}