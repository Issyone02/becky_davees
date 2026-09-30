import nodemailer from 'nodemailer';
import { db } from '../../config/db';

let cache: { at: number; transporter: nodemailer.Transporter | null } = { at: -1, transporter: null };

async function getTransporter(cfg: any) {
  if (!cfg?.smtpHost) return null;
  const stamp = new Date(cfg.updatedAt).getTime();
  if (cache.at === stamp && cache.transporter) return cache.transporter;
  cache = {
    at: stamp,
    transporter: nodemailer.createTransport({
      host: cfg.smtpHost,
      port: cfg.smtpPort ?? 587,
      secure: cfg.smtpPort === 465,
      auth: cfg.smtpUser ? { user: cfg.smtpUser, pass: cfg.smtpPass ?? undefined } : undefined,
    }),
  };
  return cache.transporter;
}

export async function sendMail(to: string, subject: string, html: string) {
  const cfg = await db.messagingConfig.findUnique({ where: { id: 1 } });
  const t = await getTransporter(cfg);
  if (!t) {
    console.log(`[mail:skipped — configure SMTP in System → Messaging] to=${to} subject=${subject}`);
    return { skipped: true, error: undefined as string | undefined };
  }
  try {
    await t.sendMail({ from: cfg.mailFrom ?? 'no-reply@schoolms.local', to, subject, html });
    return { skipped: false, error: undefined as string | undefined };
  } catch (e: any) {
    console.error('[mail:failed]', e?.message ?? e);
    return { skipped: false, error: String(e?.message ?? e) };
  }
}