import 'dotenv/config';
import { db } from '../src/config/db';

async function main() {
  const now = new Date();
  const future = await db.attendanceRecord.findMany({
    where: { date: { gt: now } },
    orderBy: { date: 'asc' },
  });
  console.log(`Future-dated attendance records found: ${future.length}`);
  for (const r of future) {
    console.log(`  student=${r.studentId} date=${r.date.toISOString()} status=${r.status}`);
  }
  if (future.length > 0) {
    await db.attendanceRecord.deleteMany({ where: { date: { gt: now } } });
    console.log(`Deleted ${future.length} impossible future record(s).`);
  } else {
    console.log('Nothing to delete.');
  }
  await db.$disconnect();
}

main().catch((e) => { console.error('Failed:', e); process.exit(1); });