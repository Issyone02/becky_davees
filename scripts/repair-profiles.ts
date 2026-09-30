import { prisma } from '../src/config/db';
import { randomUUID } from 'crypto';

async function main() {
  const missingParents = await prisma.user.findMany({
    where: { role: 'PARENT', parent: null },
    select: { id: true, fullName: true },
  });
  for (const u of missingParents) {
    await prisma.parent.create({
      data: { userId: u.id, parentCode: `PAR-${randomUUID().slice(0, 8).toUpperCase()}` },
    });
    console.log(`Created Parent profile for: ${u.fullName}`);
  }

  const missingTeachers = await prisma.user.findMany({
    where: { role: 'TEACHER', teacher: null },
    select: { id: true, fullName: true },
  });
  for (const u of missingTeachers) {
    await prisma.teacher.create({
      data: { userId: u.id, teacherCode: `TCH-${randomUUID().slice(0, 8).toUpperCase()}` },
    });
    console.log(`Created Teacher profile for: ${u.fullName}`);
  }

  console.log('Repair complete.');
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });