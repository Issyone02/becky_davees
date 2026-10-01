import { db } from '../src/config/db';

async function main() {
  const all = await db.attendanceRecord.findMany({ orderBy: { markedAt: 'asc' } });
  const seen = new Set<string>();
  const dupIds: string[] = [];
  for (const r of all) {
    const d = new Date(r.date);
    const key = `${r.studentId}|${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    if (seen.has(key)) dupIds.push(r.id);
    else seen.add(key);
  }
  if (dupIds.length > 0) {
    await db.attendanceRecord.deleteMany({ where: { id: { in: dupIds } } });
  }
  console.log(`Removed ${dupIds.length} duplicate attendance record(s).`);
  await db.$disconnect();
}

main();