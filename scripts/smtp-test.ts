import 'dotenv/config';
import nodemailer from 'nodemailer';

const key = process.env.BREVO_SMTP_KEY;
if (!key) { console.error('Missing BREVO_SMTP_KEY in .env'); process.exit(1); }

const transport = nodemailer.createTransport({
  host: 'smtp-relay.brevo.com',
  port: 587,
  secure: false,
  auth: { user: 'bc0a12001@smtp-brevo.com', pass: key },
});

transport
  .sendMail({
    from: 'olalereisaiah68@gmail.com',
    to: 'olalereissy@gmail.com',
    subject: 'Direct SMTP test',
    text: 'If you read this, the mail pipe works.',
  })
  .then(() => console.log('RESULT: SENT OK'))
  .catch((e) => console.log('RESULT: FAILED ->', e.responseCode || e.code, '|', e.message));