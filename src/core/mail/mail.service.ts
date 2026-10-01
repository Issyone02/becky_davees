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

export async function sendMail(to: string, subject: string, html: string) {
  const cfg = await db.messagingConfig.findUnique({ where: { id: 1 } });
  if (!cfg?.smtpHost) {
    console.log(`[mail:skipped — configure SMTP in System → Messaging] to=${to} subject=${subject}`);
    return { skipped: true, error: undefined as string | undefined };
  }
  try {
    if (cfg.smtpHost === 'brevo-http') {
      await sendViaBrevoApi(cfg, to, subject, html);
    } else {
      const t = await getTransporter(cfg);
      if (!t) return { skipped: true, error: undefined as string | undefined };
      await t.sendMail({ from: cfg.mailFrom ?? 'no-reply@schoolms.local', to, subject, html });
    }
    return { skipped: false, error: undefined as string | undefined };
  } catch (e: any) {
    console.error('[mail:failed]', e?.message ?? e);
    return { skipped: false, error: String(e?.message ?? e) };
  }
}