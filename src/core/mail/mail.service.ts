import nodemailer from 'nodemailer';
import { db } from '../../config/db';

let cache: { at: number; transporter: nodemailer.Transporter | null } = { at: -1, transporter: null };

async function getTransporter(cfg: any) {
  if (!cfg?.smtpHost || cfg.smtpHost === 'brevo-http') return null;
  const stamp = new Date(cfg.updatedAt).getTime();
  if (cache.at === stamp && cache.transporter) return cache.transporter;
  cache = {
    at: stamp,
    transporter: nodemailer.createTransport({
      host: cfg.smtpHost,
      port: cfg.smtpPort ?? 587,
      secure: cfg.smtpPort === 465,
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 30000,
      auth: cfg.smtpUser ? { user: cfg.smtpUser, pass: cfg.smtpPass ?? undefined } : undefined,
    }),
  };
  return cache.transporter;
}

async function sendViaBrevoApi(cfg: any, to: string, subject: string, html: string) {
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key': cfg.smtpPass as string,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({
      sender: { email: cfg.mailFrom ?? 'no-reply@schoolms.local', name: 'Becky Davees School' },
      to: [{ email: to }],
      subject,
      htmlContent: html,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Brevo API ${res.status}: ${text.slice(0, 200)}`);
  }
}

function brandWrap(s: any, inner: string): string {
  const name = s?.schoolName ?? 'The School';
  const motto = s?.motto ? `<div style="font-size:12px;font-style:italic;color:#6b7280;margin-top:2px;">${s.motto}</div>` : '';
  const logo = s?.logoUrl ? `<img src="${s.logoUrl}" alt="${name} logo" style="height:56px;margin:0 auto 8px;display:block;" />` : '';
  const contact = [s?.address, s?.phone, s?.email].filter(Boolean).join(' &nbsp;|&nbsp; ');
  return `
  <div style="font-family:Arial,Helvetica,sans-serif;background:#f3f4f6;padding:24px 12px;">
    <div style="max-width:600px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:10px;overflow:hidden;">
      <div style="padding:24px 24px 16px;text-align:center;border-bottom:3px solid #4f46e5;">
        ${logo}
        <div style="font-size:18px;font-weight:700;color:#111827;">${name}</div>
        ${motto}
      </div>
      <div style="padding:24px;font-size:14px;color:#111827;line-height:1.6;">
        ${inner}
      </div>
      <div style="padding:16px 24px;background:#f9fafb;border-top:1px solid #e5e7eb;text-align:center;font-size:11px;color:#6b7280;">
        ${contact ? `<div style="margin-bottom:4px;">${contact}</div>` : ''}
        <div>This is an automated message from ${name}. Please do not reply directly to this email.</div>
      </div>
    </div>
  </div>`;
}

export async function sendMail(to: string, subject: string, html: string) {
  const cfg = await db.messagingConfig.findUnique({ where: { id: 1 } });
  if (!cfg?.smtpHost) {
    console.log(`[mail:skipped — configure SMTP in System → Messaging] to=${to} subject=${subject}`);
    return { skipped: true, error: undefined as string | undefined };
  }
  const settings = await db.schoolSetting.findFirst().catch(() => null);
  const body = brandWrap(settings, html);
  try {
    if (cfg.smtpHost === 'brevo-http') {
      await sendViaBrevoApi(cfg, to, subject, body);
    } else {
      const t = await getTransporter(cfg);
      if (!t) return { skipped: true, error: undefined as string | undefined };
      await t.sendMail({ from: cfg.mailFrom ?? 'no-reply@schoolms.local', to, subject, html: body });
    }
    return { skipped: false, error: undefined as string | undefined };
  } catch (e: any) {
    console.error('[mail:failed]', e?.message ?? e);
    return { skipped: false, error: String(e?.message ?? e) };
  }
}