import { createApp } from './app';
import { env } from './config/env';
import { prisma } from './config/db';
import { randomUUID } from 'crypto';

const app = createApp();

async function repairMissingProfiles() {
  try {
    const missingParents = await prisma.user.findMany({
      where: { role: 'PARENT', parent: null, deletedAt: null },
      select: { id: true },
    });
    for (const u of missingParents) {
      await prisma.parent.create({
        data: { userId: u.id, parentCode: `PAR-${randomUUID().slice(0, 8).toUpperCase()}` },
      });
    }

    const missingTeachers = await prisma.user.findMany({
      where: { role: 'TEACHER', teacher: null, deletedAt: null },
      select: { id: true },
    });
    for (const u of missingTeachers) {
      await prisma.teacher.create({
        data: { userId: u.id, teacherCode: `TCH-${randomUUID().slice(0, 8).toUpperCase()}` },
      });
    }

    const total = missingParents.length + missingTeachers.length;
    if (total) console.log(`Repaired ${total} missing profile(s) at startup.`);
  } catch (e) {
    console.error('Profile repair skipped:', e);
  }
}

async function main() {
  await prisma.$connect();
  await repairMissingProfiles();
  app.listen(env.PORT, () => {
    console.log(`API listening on http://localhost:${env.PORT} [${env.NODE_ENV}]`);
  });
}

main().catch((e) => {
  console.error('Fatal startup error:', e);
  process.exit(1);
});

process.on('SIGINT', async () => { await prisma.$disconnect(); process.exit(0); });
process.on('SIGTERM', async () => { await prisma.$disconnect(); process.exit(0); });