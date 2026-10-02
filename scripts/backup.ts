import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { db } from '../src/config/db';

const TABLES: Array<[string, any]> = [
  ['users', db.user],
  ['security_question_answers', db.securityQuestionAnswer],
  ['teachers', db.teacher],
  ['parents', db.parent],
  ['students', db.student],
  ['parent_student', db.parentStudent],
  ['academic_sessions', db.academicSession],
  ['terms', db.term],
  ['classes', db.class],
  ['subjects', db.subject],
  ['class_subjects', db.classSubject],
  ['teacher_class_subject', db.teacherClassSubject],
  ['attendance_records', db.attendanceRecord],
  ['attendance_corrections', db.attendanceCorrection],
  ['results', db.result],
  ['report_cards', db.reportCard],
  ['grading_scales', db.gradingScale],
  ['fee_structures', db.feeStructure],
  ['payments', db.payment],
  ['payment_audits', db.paymentAudit],
  ['news', db.news],
  ['events', db.event],
  ['notifications', db.notification],
  ['feedback', db.feedback],
  ['feedback_replies', db.feedbackReply],
  ['timetable_entries', db.timetableEntry],
  ['school_settings', db.schoolSetting],
  ['registrations', db.registration],
  ['audit_logs', db.auditLog],
  ['student_conduct', db.studentConduct],
  ['student_term_remarks', db.studentTermRemark],
  ['messaging_config', db.messagingConfig],
  ['notification_logs', db.notificationLog],
  ['promotion_batches', db.promotionBatch],
  ['promotion_entries', db.promotionEntry],
  ['enrollments', db.enrollment],
];

async function main() {
  const out: Record<string, any[]> = {};
  for (const [name, delegate] of TABLES) {
    out[name] = await delegate.findMany();
    console.log(`  ${name}: ${out[name].length} rows`);
  }
  const dir = path.resolve(process.cwd(), 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  const file = path.join(dir, `schoolms-backup-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`✅ Backup saved: ${file}`);
  await db.$disconnect();
}

main().catch((e) => { console.error('❌ Backup failed:', e); process.exit(1); });