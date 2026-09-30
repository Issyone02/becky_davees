import { db } from '../../config/db';
import { NotFoundError, ValidationError } from '../../shared/errors';
import { logAudit } from '../../core/audit/audit.service';

type Actor = { id: string; role: string };

export const AUDIENCES = ['all', 'teachers', 'parents'];

function audienceWhere(audience: string) {
  if (audience === 'teachers') return { role: 'TEACHER' };
  if (audience === 'parents') return { role: 'PARENT' };
  return {}; // 'all'
}

export function canSee(audience: string, role: string): boolean {
  if (audience === 'all') return true;
  if (audience === 'teachers') return role === 'TEACHER' || role === 'ADMIN' || role === 'SUPER_ADMIN';
  if (audience === 'parents') return role === 'PARENT' || role === 'ADMIN' || role === 'SUPER_ADMIN';
  return true;
}

async function notifyAudience(audience: string, type: string, title: string, body: string | null, excludeUserId?: string) {
  const users = await db.user.findMany({
    where: { status: 'ACTIVE', ...audienceWhere(audience) },
    select: { id: true },
  });
  const rows = users
    .filter((u) => u.id !== excludeUserId)
    .map((u) => ({ userId: u.id, type, title, body }));
  if (rows.length) {
    await db.$transaction(rows.map((r) => db.notification.create({ data: r })));
  }
  return rows.length;
}

// ---------------- News ----------------
export async function listNews(params: { manage: boolean; role: string }) {
  if (params.manage) {
    return db.news.findMany({ include: { author: { select: { fullName: true } } }, orderBy: { createdAt: 'desc' } });
  }
  const all = await db.news.findMany({
    where: { status: 'published' },
    include: { author: { select: { fullName: true } } },
    orderBy: { publishedAt: 'desc' },
  });
  return all.filter((n) => canSee(n.audience, params.role));
}

export async function createNews(input: { title: string; body: string; audience: string; publish: boolean }, actor: Actor) {
  if (!AUDIENCES.includes(input.audience)) throw new ValidationError('Invalid audience.');
  const news = await db.news.create({
    data: {
      title: input.title, body: input.body, audience: input.audience,
      status: input.publish ? 'published' : 'draft',
      publishedAt: input.publish ? new Date() : null,
      authorId: actor.id,
    },
  });
  let notified = 0;
  if (input.publish) {
    notified = await notifyAudience(input.audience, 'news', input.title, input.body.slice(0, 200), actor.id);
  }
  await logAudit({ userId: actor.id, userRole: actor.role, action: input.publish ? 'news.published' : 'news.created', entityType: 'News', entityId: news.id, afterValues: { title: news.title, audience: news.audience, notified } });
  return news;
}

export async function updateNews(id: string, input: { title?: string; body?: string; audience?: string }, actor: Actor) {
  const before = await db.news.findUnique({ where: { id } });
  if (!before) throw new NotFoundError('News', id);
  if (input.audience && !AUDIENCES.includes(input.audience)) throw new ValidationError('Invalid audience.');
  const news = await db.news.update({ where: { id }, data: input });
  await logAudit({ userId: actor.id, userRole: actor.role, action: 'news.updated', entityType: 'News', entityId: id, beforeValues: { title: before.title }, afterValues: { title: news.title } });
  return news;
}

export async function publishNews(id: string, actor: Actor) {
  const news = await db.news.findUnique({ where: { id } });
  if (!news) throw new NotFoundError('News', id);
  if (news.status === 'published') throw new ValidationError('This announcement is already published.');
  const updated = await db.news.update({ where: { id }, data: { status: 'published', publishedAt: new Date() } });
  const notified = await notifyAudience(news.audience, 'news', news.title, news.body.slice(0, 200), actor.id);
  await logAudit({ userId: actor.id, userRole: actor.role, action: 'news.published', entityType: 'News', entityId: id, afterValues: { title: news.title, notified } });
  return updated;
}

export async function unpublishNews(id: string, actor: Actor) {
  const news = await db.news.findUnique({ where: { id } });
  if (!news) throw new NotFoundError('News', id);
  if (news.status !== 'published') throw new ValidationError('This announcement is not currently published.');
  const updated = await db.news.update({ where: { id }, data: { status: 'draft', publishedAt: null } });
  await logAudit({ userId: actor.id, userRole: actor.role, action: 'news.unpublished', entityType: 'News', entityId: id, beforeValues: { title: news.title, status: 'published' }, afterValues: { title: updated.title, status: 'draft' } });
  return updated;
}

export async function deleteNews(id: string, actor: Actor) {
  const before = await db.news.findUnique({ where: { id } });
  if (!before) throw new NotFoundError('News', id);
  await db.news.delete({ where: { id } });
  await logAudit({ userId: actor.id, userRole: actor.role, action: 'news.deleted', entityType: 'News', entityId: id, beforeValues: { title: before.title } });
  return { success: true };
}

// ---------------- Events ----------------
export async function listEvents(role: string) {
  const all = await db.event.findMany({ orderBy: { startDate: 'asc' } });
  return all.filter((e) => canSee(e.audience, role));
}

export async function createEvent(input: {
  title: string; description?: string | null; location?: string | null;
  startDate: Date; endDate?: Date | null; audience: string;
}, actor: Actor) {
  if (!AUDIENCES.includes(input.audience)) throw new ValidationError('Invalid audience.');
  if (input.endDate && input.endDate < input.startDate) throw new ValidationError('End date must be on or after the start date.');
  const ev = await db.event.create({ data: { ...input, endDate: input.endDate ?? null } });
  const notified = await notifyAudience(input.audience, 'event', `Event: ${input.title}`, input.description?.slice(0, 200) ?? null, actor.id);
  await logAudit({ userId: actor.id, userRole: actor.role, action: 'event.created', entityType: 'Event', entityId: ev.id, afterValues: { title: ev.title, notified } });
  return ev;
}

export async function updateEvent(id: string, input: {
  title?: string; description?: string | null; location?: string | null;
  startDate?: Date; endDate?: Date | null; audience?: string;
}, actor: Actor) {
  const before = await db.event.findUnique({ where: { id } });
  if (!before) throw new NotFoundError('Event', id);
  const nextStart = input.startDate ?? before.startDate;
  const nextEnd = input.endDate !== undefined ? input.endDate : before.endDate;
  if (nextEnd && nextEnd < nextStart) throw new ValidationError('End date must be on or after the start date.');
  const ev = await db.event.update({ where: { id }, data: input });
  await logAudit({ userId: actor.id, userRole: actor.role, action: 'event.updated', entityType: 'Event', entityId: id, beforeValues: { title: before.title }, afterValues: { title: ev.title } });
  return ev;
}

export async function deleteEvent(id: string, actor: Actor) {
  const before = await db.event.findUnique({ where: { id } });
  if (!before) throw new NotFoundError('Event', id);
  await db.event.delete({ where: { id } });
  await logAudit({ userId: actor.id, userRole: actor.role, action: 'event.deleted', entityType: 'Event', entityId: id, beforeValues: { title: before.title } });
  return { success: true };
}

// ---------------- Notifications ----------------
export async function myNotifications(userId: string) {
  return db.notification.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 50 });
}

export async function unreadCount(userId: string) {
  return db.notification.count({ where: { userId, read: false } });
}

export async function markRead(id: string, userId: string) {
  await db.notification.updateMany({ where: { id, userId }, data: { read: true } });
  return { success: true };
}

export async function markAllRead(userId: string) {
  await db.notification.updateMany({ where: { userId, read: false }, data: { read: true } });
  return { success: true };
}