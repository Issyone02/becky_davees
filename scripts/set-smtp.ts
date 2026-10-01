import 'dotenv/config';
import { db } from '../src/config/db';

const apiKey = process.env.BREVO_API_KEY;
if (!apiKey) { console.error('Missing BREVO_API_KEY in .env'); process.exit(1); }

async function main() {
  console.log('Writing Brevo HTTPS-API mail settings to the cloud database...');
  await db.messagingConfig.upsert({
    where: { id: 1 },
    update: {
      smtpHost: 'brevo-http',
      smtpPort: 587,
      smtpUser: 'bc0a12001@smtp-brevo.com',
      smtpPass: apiKey,
      mailFrom: 'olalereisaiah68@gmail.com',
    },
    create: {
      id: 1,
      smtpHost: 'brevo-http',
      smtpPort: 587,
      smtpUser: 'bc0a12001@smtp-brevo.com',
      smtpPass: apiKey,
      mailFrom: 'olalereisaiah68@gmail.com',
    },
  });
  console.log('✅ Success! Mail settings stamped into the cloud database.');
  await db.$disconnect();
}

main().catch((e) => { console.error('❌ Failed:', e); process.exit(1); });