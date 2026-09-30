import { db } from '../../config/db';
import { NotFoundError, ForbiddenError, ValidationError } from '../../shared/errors';
import { logAudit } from '../../core/audit/audit.service';
import * as notify from '../../core/notify/notify.service';

export const CATEGORIES = ['ACADEMIC', 'FINANCE', 'INFRASTRUCTURE', 'WELFARE', 'GENERAL'];
export const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'];
export const STATUSES = ['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'];

type Actor = { id: string; role: string };

async function adminUsers() {
  return db.user.findMany({
    where: { role: { in: ['ADMIN', 'SUPER_ADMIN'] }, status: 'ACTIVE', deletedAt: null },
    select: { id: true, email: true, fullName: true },
  });
}

async function notifyUsers(userIds: string[], type: string, title: string, body: string | null) {
  const rows = userIds.map((userId) => ({ userId, type, title, body }));
  if (rows.length) await db.$transaction(rows.map((r) => db.notification.create({ data: r })));
}

export async function createFeedback(actor: Actor, input: {
  category: string; priority: string; subject: string; message: string; attachmentUrl?: string | null;
}) {
  if (!CATEGORIES.includes(input.category)) throw new ValidationError('Invalid category.');
  if (!PRIORITIES.includes(input.priority)) throw new ValidationError('Invalid priority.');
  const fb = await db.feedback.create({
    data: {
      userId: actor.id, category: input.category, priority: input.priority,
      subject: input.subject, message: input.message, attachmentUrl: input.attachmentUrl ?? null,
    },
  });
  const admins = await adminUsers();
  await notifyUsers(admins.map((a) => a.id), 'feedback', `New ${input.priority} feedback: ${input.subject}`, input.message.slice(0, 200));
  if (input.priority === 'HIGH' || input.priority === 'URGENT') {
    for (const a of admins) {
      await notify.emailTo('feedback.replied', { email: fb.user.email, name: fb.user.fullName }, `Reply on your feedback: ${fb.subject}`, `<p>${message.replace(/\n/g, '<br/>')}</p>`);
    }
  }
  await logAudit({ userId: actor.id, userRole: actor.role, action: 'feedback.created', entityType: 'Feedback', entityId: fb.id, afterValues: { subject: fb.subject, priority: fb.priority } });
  return fb;
}

export async function listMine(userId: string) {
  return db.feedback.findMany({
    where: { userId },
    include: { replies: { include: { user: { select: { fullName: true, role: true } } }, orderBy: { createdAt: 'asc' } } },
    orderBy: { createdAt: 'desc' },
  });
}

export async function listForAdmin(params: {
  status?: string; category?: string; priority?: string; search?: string; skip: number; take: number;
}) {
  const where: any = {};
  if (params.status) where.status = params.status;
  if (params.category) where.category = params.category;
  if (params.priority) where.priority = params.priority;
  if (params.search) {
    where.OR = [
      { subject: { contains: params.search } },
      { message: { contains: params.search } },
      { user: { fullName: { contains: params.search } } },
    ];
  }
  const [items, total] = await Promise.all([
    db.feedback.findMany({
      where, skip: params.skip, take: params.take, orderBy: { createdAt: 'desc' },
      include: {
        user: { select: { fullName: true, role: true } },
        _count: { select: { replies: true } },
      },
    }),
    db.feedback.count({ where }),
  ]);
  return { items, total };
}

async function findFor(actor: Actor, id: string) {
  const fb = await db.feedback.findUnique({
    where: { id },
    include: {
      user: { select: { id: true, fullName: true, role: true, email: true } },
      replies: { include: { user: { select: { fullName: true, role: true } } }, orderBy: { createdAt: 'asc' } },
    },
  });
  if (!fb) throw new NotFoundError('Feedback', id);
  const isAdmin = actor.role === 'ADMIN' || actor.role === 'SUPER_ADMIN';
  if (!isAdmin && fb.userId !== actor.id) throw new ForbiddenError('You do not have access to this feedback.');
  return fb;
}

export async function getOne(actor: Actor, id: string) {
  return findFor(actor, id);
}

export async function reply(actor: Actor, id: string, message: string) {
  const fb = await findFor(actor, id);
  const r = await db.feedbackReply.create({
    data: { feedbackId: id, userId: actor.id, message },
    include: { user: { select: { fullName: true, role: true } } },
  });
  const isAdmin = actor.role === 'ADMIN' || actor.role === 'SUPER_ADMIN';
  if (isAdmin) {
    await notifyUsers([fb.userId], 'feedback', `Reply on your feedback: ${fb.subject}`, message.slice(0, 200));
    await sendMail(fb.user.email, `Reply on your feedback: ${fb.subject}`,
      `<p>${message.replace(/\n/g, '<br/>')}</p><p>— SchoolMS Administration</p>`);
  } else {
    const admins = await adminUsers();
    await notifyUsers(admins.map((a) => a.id), 'feedback', `Follow-up on: ${fb.subject}`, message.slice(0, 200));
  }
  await logAudit({ userId: actor.id, userRole: actor.role, action: 'feedback.replied', entityType: 'Feedback', entityId: id, afterValues: { message: message.slice(0, 100) } });
  return r;
}

export async function setStatus(actor: Actor, id: string, status: string) {
  if (!STATUSES.includes(status)) throw new ValidationError('Invalid status.');
  const fb = await findFor(actor, id);
  const updated = await db.feedback.update({ where: { id }, data: { status } });
  await notifyUsers([fb.userId], 'feedback', `Feedback ${status.replace(/_/g, ' ').toLowerCase()}: ${fb.subject}`, null);
  await logAudit({ userId: actor.id, userRole: actor.role, action: 'feedback.status_changed', entityType: 'Feedback', entityId: id, beforeValues: { status: fb.status }, afterValues: { status } });
  return updated;
}