import { db } from '../../config/db';

export async function sendSms(to: string, text: string) {
  const cfg = await db.messagingConfig.findUnique({ where: { id: 1 } });
  if (!cfg?.smsEnabled || !cfg.smsApiKey) {
    console.log(`[sms:skipped — SMS disabled or no API key] to=${to}`);
    return { skipped: true, ok: false, error: undefined as string | undefined };
  }
  try {
    const res = await fetch('https://api.termii.com/api/sms/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        key: cfg.smsApiKey,
        to: to.replace(/^0/, '234'),
        from: cfg.smsSenderId ?? 'SchoolMS',
        sms: text,
        type: 'plain',
        channel: 'generic',
      }),
    });
    const json: any = await res.json().catch(() => ({}));
    return { skipped: false, ok: res.ok, error: res.ok ? undefined : (json?.message ?? `HTTP ${res.status}`) };
  } catch (e: any) {
    console.error('[sms:failed]', e?.message ?? e);
    return { skipped: false, ok: false, error: String(e?.message ?? e) };
  }
}