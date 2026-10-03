import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

// Bypass the pooler (6543) and use the direct Postgres connection (5432)
const db = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL || process.env.DATABASE_URL } }
});

async function main() {
  const all = await db.attendanceRecord.findMany({ orderBy: { markedAt: 'desc' } });
  const seen = new Set<string>();
  const dupIds: string[] = [];
  
  for (const r of all) {
    const d = new Date(r.date);
    // Group by student and the exact UTC day
    const key = `${r.studentId}|${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
    if (seen.has(key)) dupIds.push(r.id);
    else seen.add(key);
  }
  
  if (dupIds.length > 0) {
    await db.attendanceRecord.deleteMany({ where: { id: { in: dupIds } } });
  }
  console.log(`Kept the latest marking per student-day; removed ${dupIds.length} duplicate row(s).`);
  await db.$disconnect();
}

main().catch((e) => { console.error('Failed:', e); process.exit(1); });