import { prisma } from '../src/config/db';

const arg = process.argv[2];

async function main() {
  if (!arg || arg === 'list') {
    const all = await prisma.academicSession.findMany({ orderBy: { startDate: 'asc' }, include: { terms: true } });
    for (const s of all) console.log(`${s.id}  ${s.name}  (${s.terms.length} terms)${s.isCurrent ? '  [current]' : ''}`);
    if (!all.length) console.log('No sessions found.');
    await prisma.$disconnect();
    return;
  }

  const session = await prisma.academicSession.findUnique({ where: { id: arg }, include: { terms: true } });
  if (!session) { console.error('Session not found. Run with "list" to see IDs.'); process.exit(1); }
  const termIds = session.terms.map((t) => t.id);
  const inTerms = { termId: { in: termIds } };

  await prisma.paymentAudit.deleteMany({ where: { payment: inTerms } });
  await prisma.payment.deleteMany({ where: inTerms });
  await prisma.feeStructure.deleteMany({ where: inTerms });
  await prisma.reportCard.deleteMany({ where: inTerms });
  await prisma.result.deleteMany({ where: inTerms });
  await prisma.attendanceRecord.deleteMany({ where: inTerms });
  await prisma.studentTermRemark.deleteMany({ where: inTerms });
  await prisma.studentConduct.deleteMany({ where: inTerms });
  try { await prisma.timetableEntry.deleteMany({ where: inTerms }); } catch { /* optional field */ }
  await prisma.teacherClassSubject.deleteMany({ where: inTerms });
  await prisma.enrollment.deleteMany({ where: { sessionId: session.id } });
  await prisma.promotionEntry.deleteMany({ where: { batch: { OR: [{ fromSessionId: session.id }, { toSessionId: session.id }] } } });
  await prisma.promotionBatch.deleteMany({ where: { OR: [{ fromSessionId: session.id }, { toSessionId: session.id }] } });
  await prisma.term.deleteMany({ where: { sessionId: session.id } });
  await prisma.academicSession.delete({ where: { id: session.id } });

  console.log(`Deleted session "${session.name}" with all terms and dependent data.`);
  console.log('Students, classes, users and school settings were NOT touched.');
  await prisma.$disconnect();
}
main();