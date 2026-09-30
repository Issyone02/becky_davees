import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/core/auth/password';
import { env } from '../src/config/env';

const prisma = new PrismaClient();

async function main() {
  // ---- Super Admin bootstrap ----
  const existing = await prisma.user.findUnique({ where: { email: env.SUPER_ADMIN_EMAIL } });
  if (!existing) {
    const hash = await hashPassword(env.SUPER_ADMIN_PASSWORD);
    await prisma.user.create({
      data: {
        email: env.SUPER_ADMIN_EMAIL,
        fullName: env.SUPER_ADMIN_FULL_NAME,
        role: 'SUPER_ADMIN',
        status: 'ACTIVE',
        passwordHash: hash,
        mustChangePassword: false,
        emailVerifiedAt: new Date(),
      },
    });
    console.log(`✓ Super Admin created: ${env.SUPER_ADMIN_EMAIL}`);
  } else {
    console.log('Super Admin already exists');
  }

  // ---- Default grading scale ----
  const existingScale = await prisma.gradingScale.count();
  if (existingScale === 0) {
    await prisma.gradingScale.createMany({
      data: [
        { minScore: 75, maxScore: 100, grade: 'A', remark: 'Excellent' },
        { minScore: 65, maxScore: 74.99, grade: 'B', remark: 'Very Good' },
        { minScore: 50, maxScore: 64.99, grade: 'C', remark: 'Good' },
        { minScore: 40, maxScore: 49.99, grade: 'D', remark: 'Fair' },
        { minScore: 0, maxScore: 39.99, grade: 'F', remark: 'Fail' },
      ],
    });
    console.log('✓ Default grading scale seeded');
  }

  // ---- Default classes ----
  const classCount = await prisma.class.count();
  if (classCount === 0) {
    await prisma.class.createMany({
      data: [
        { name: 'Primary 1', level: 'primary' },
        { name: 'Primary 2', level: 'primary' },
        { name: 'Primary 3', level: 'primary' },
        { name: 'Primary 4', level: 'primary' },
        { name: 'Primary 5', level: 'primary' },
        { name: 'Primary 6', level: 'primary' },
        { name: 'JSS 1', level: 'junior' },
        { name: 'JSS 2', level: 'junior' },
        { name: 'JSS 3', level: 'junior' },
        { name: 'SSS 1', level: 'senior' },
        { name: 'SSS 2', level: 'senior' },
        { name: 'SSS 3', level: 'senior' },
      ],
    });
    console.log('✓ Default classes seeded');
  }

  // ---- Current academic session + terms ----
  let session = await prisma.academicSession.findFirst({ where: { isCurrent: true } });
  if (!session) {
    session = await prisma.academicSession.create({
      data: {
        name: '2026/2027',
        startDate: new Date('2026-09-01'),
        endDate: new Date('2027-07-31'),
        isCurrent: true,
      },
    });
    await prisma.term.createMany({
      data: [
        { sessionId: session.id, name: 'First Term', startDate: new Date('2026-09-01'), endDate: new Date('2026-12-18'), isCurrent: true },
        { sessionId: session.id, name: 'Second Term', startDate: new Date('2027-01-11'), endDate: new Date('2027-03-26'), isCurrent: false },
        { sessionId: session.id, name: 'Third Term', startDate: new Date('2027-04-19'), endDate: new Date('2027-07-09'), isCurrent: false },
      ],
    });
    console.log('✓ Academic session 2026/2027 + terms seeded');
  }

  // ---- Link session/term into school settings ----
  const currentTerm = await prisma.term.findFirst({ where: { sessionId: session.id, isCurrent: true } });
  await prisma.schoolSetting.updateMany({
    data: { currentSessionId: session.id, currentTermId: currentTerm?.id ?? null },
  });

  // ---- Sample students (development data) ----
  const studentCount = await prisma.student.count();
  if (studentCount === 0) {
    const primary1 = await prisma.class.findUnique({ where: { name: 'Primary 1' } });
    if (primary1) {
      await prisma.student.createMany({
        data: [
          { studentId: 'STD-0001', admissionNumber: 'ADM-0001', fullName: 'Ayesha Khan', dateOfBirth: new Date('2015-04-12'), gender: 'FEMALE', classId: primary1.id, sessionId: session.id },
          { studentId: 'STD-0002', admissionNumber: 'ADM-0002', fullName: 'Hina Ali', dateOfBirth: new Date('2015-07-03'), gender: 'FEMALE', classId: primary1.id, sessionId: session.id },
          { studentId: 'STD-0003', admissionNumber: 'ADM-0003', fullName: 'Mujeeb Akhtar', dateOfBirth: new Date('2014-11-21'), gender: 'MALE', classId: primary1.id, sessionId: session.id },
        ],
      });
      console.log('✓ Sample students seeded');
    }
  }

  // ---- Default school settings row ----
  const existingSettings = await prisma.schoolSetting.count();
  if (existingSettings === 0) {
    await prisma.schoolSetting.create({ data: { schoolName: 'My School', timezone: 'UTC' } });
    console.log('✓ School settings initialized');
  }
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });