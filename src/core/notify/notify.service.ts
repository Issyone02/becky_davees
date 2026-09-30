import { db } from '../../config/db';
import { sendMail } from '../mail/mail.service';
import { sendSms } from '../sms/sms.service';
import { logAudit } from '../audit/audit.service';

async function brand() {
  return db.schoolSetting.findUnique({ where: { id: 1 } });
}

function wrap(s: any, title: string, body: string) {
  return `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;background:#f4f5fb;margin:0;padding:24px;">
  <div style="max-width:640px;margin:auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb;">
    <div style="background:#4f46e5;color:#fff;padding:20px 24px;">
      <div style="font-size:18px;font-weight:800;text-transform:uppercase;">${s?.schoolName ?? 'School'}</div>
      ${s?.motto ? `<div style="font-size:12px;font-style:italic;">${s.motto}</div>` : ''}
    </div>
    <div style="padding:24px;color:#1f2937;font-size:14px;line-height:1.6;">
      <h2 style="margin:0 0 12px;font-size:16px;">${title}</h2>
      ${body}
    </div>
    <div style="padding:14px 24px;background:#f9fafb;color:#6b7280;font-size:11px;">
      Computer-generated message from ${s?.schoolName ?? 'SchoolMS'} portal.
    </div>
  </div></body></html>`;
}

async function log(channel: string, event: string, recipient: string, subject: string | null, status: string, error?: string) {
  try {
    await db.notificationLog.create({ data: { channel, event, recipient, subject, status, error: error ?? null } });
  } catch { /* never break the flow */ }
}

export async function emailTo(event: string, to: { email: string; name: string }, title: string, body: string,
  sms?: { phone: string | null | undefined; text: string }) {
  const s = await brand();
  const r = await sendMail(to.email, `${s?.schoolName ?? 'School'}: ${title}`, wrap(s, title, body));
  await log('EMAIL', event, to.email, title, r.skipped ? 'SKIPPED' : r.error ? 'FAILED' : 'SENT', r.error);
  if (sms?.phone) await smsTo(event, sms.phone, sms.text);
}

export async function smsTo(event: string, phone: string, text: string) {
  const cfg = await db.messagingConfig.findUnique({ where: { id: 1 } });
  let on = !!cfg?.smsEnabled;
  if (on) { try { on = (JSON.parse(cfg!.smsEvents || '{}') as any)[event] !== false; } catch { /* default on */ } }
  if (!on) return;
  const r = await sendSms(phone, text);
  await log('SMS', event, phone, null, r.skipped ? 'SKIPPED' : r.ok ? 'SENT' : 'FAILED', r.error);
}

export async function sendBranded(email: string, title: string, body: string) {
  const s = await brand();
  const r = await sendMail(email, `${s?.schoolName ?? 'School'}: ${title}`, wrap(s, title, body));
  await log('EMAIL', 'test', email, title, r.skipped ? 'SKIPPED' : r.error ? 'FAILED' : 'SENT', r.error);
  return r;
}

/* ---------- event helpers (self-loading; safe to call with void) ---------- */

export async function emailPaymentRecorded(paymentId: string) {
  try {
    const p = await db.payment.findUnique({
      where: { id: paymentId },
      include: {
        student: { include: { class: true, parents: { include: { parent: { include: { user: true } } } } } },
        feeStructure: true,
        parent: { include: { user: true } },
      },
    });
    if (!p) return;
    const guardian = p.parent?.user ?? p.student.parents[0]?.parent.user;
    if (!guardian?.email) return;
    await emailTo('payment.recorded', { email: guardian.email, name: guardian.fullName },
      `Payment Received — ${p.receiptNumber}`,
      `<p>Dear ${guardian.fullName},</p>
       <p>We confirm receipt of <strong>${Number(p.amountPaid).toLocaleString()}</strong> for <strong>${p.feeStructure.feeType}</strong> (${p.student.fullName}, ${p.student.class.name}).</p>
       <p>Receipt No: <strong>${p.receiptNumber}</strong></p><p>Thank you.</p>`,
      { phone: guardian.phone, text: `Payment of ${Number(p.amountPaid).toLocaleString()} received for ${p.student.fullName} (${p.feeStructure.feeType}). Receipt ${p.receiptNumber}.` });
  } catch (e) { console.error('[notify:payment]', e); }
}

export async function emailReportCardsPublished(classId: string, termId: string) {
  try {
    const students = await db.student.findMany({
      where: { classId, status: 'active' },
      include: { parents: { include: { parent: { include: { user: true } } } }, class: true },
    });
    const term = await db.term.findUnique({ where: { id: termId }, include: { session: true } });
    for (const st of students) {
      for (const ps of st.parents) {
        const u = ps.parent.user;
        if (!u.email) continue;
        await emailTo('reportcard.published', { email: u.email, name: u.fullName },
          `Report Card Published — ${st.fullName}`,
          `<p>Dear ${u.fullName},</p>
           <p>The ${term?.name ?? ''} ${term?.session?.name ?? ''} report card for <strong>${st.fullName}</strong> (${st.class.name}) is now available.</p>
           <p>Log in to the portal to view, print or download it.</p>`,
          { phone: u.phone, text: `Report card for ${st.fullName} (${term?.name ?? ''}) is available on the school portal.` });
      }
    }
  } catch (e) { console.error('[notify:reportcards]', e); }
}

export async function emailRegistrationDecision(userId: string, approved: boolean, reason?: string | null) {
  try {
    const u = await db.user.findUnique({ where: { id: userId } });
    if (!u?.email) return;
    await emailTo(approved ? 'registration.approved' : 'registration.rejected', { email: u.email, name: u.fullName },
      approved ? 'Registration Approved' : 'Registration Update',
      approved
        ? `<p>Congratulations ${u.fullName},</p><p>Your registration as <strong>${u.role}</strong> has been approved. You can now log in to the portal.</p>`
        : `<p>Dear ${u.fullName},</p><p>Your registration was not approved.${reason ? `<br/>Reason: ${reason}` : ''}</p><p>Contact the school office for clarification.</p>`);
  } catch (e) { console.error('[notify:registration]', e); }
}

export async function emailPasswordReset(userId: string, temp: string) {
  try {
    const u = await db.user.findUnique({ where: { id: userId } });
    if (!u?.email) return;
    await emailTo('password.reset', { email: u.email, name: u.fullName }, 'Password Reset by Administrator',
      `<p>Hello ${u.fullName},</p><p>An administrator reset your password.</p>
       <p>Temporary password: <strong style="font-family:monospace;">${temp}</strong></p>
       <p>You will be required to change it at next login.</p>`);
  } catch (e) { console.error('[notify:password]', e); }
}

export async function sendSessionNotice(actor: { id: string; role: string }, input: { title: string; body: string; audience: string }) {
  const where: any = { status: 'ACTIVE', deletedAt: null };
  if (input.audience === 'teachers') where.role = { in: ['TEACHER', 'ADMIN', 'SUPER_ADMIN'] };
  if (input.audience === 'parents') where.role = 'PARENT';
  const users = await db.user.findMany({ where, select: { id: true, email: true, phone: true, fullName: true } });
  await db.$transaction(users.map((u) => db.notification.create({ data: { userId: u.id, type: 'notice', title: input.title, body: input.body } })));
  for (const u of users) {
    if (u.email) {
      await emailTo('session.notice', { email: u.email, name: u.fullName }, input.title,
        `<p>${input.body.replace(/\n/g, '<br/>')}</p>`,
        { phone: u.phone, text: `${input.title} — ${input.body.slice(0, 140)}` });
    }
  }
  await logAudit({ userId: actor.id, userRole: actor.role, action: 'notice.sent', entityType: 'Notice', entityId: null, afterValues: { title: input.title, audience: input.audience, recipients: users.length } });
  return { count: users.length };
}