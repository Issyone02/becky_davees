import { db } from '../../config/db';
import { Router } from 'express';
import { authenticate, requireRole } from '../../core/auth/auth.middleware';
import * as svc from './results.service';
import { success } from '../../shared/response';
import { z } from 'zod';

const router = Router();
router.use(authenticate);
const staff = requireRole('SUPER_ADMIN', 'ADMIN', 'TEACHER');
const adminOnly = requireRole('SUPER_ADMIN', 'ADMIN');

const saveSchema = z.object({
  classId: z.string().min(1),
  subjectId: z.string().min(1),
  termId: z.string().min(1),
  entries: z.array(z.object({
    studentId: z.string().min(1),
    testScore: z.coerce.number().min(0).max(30),
    examScore: z.coerce.number().min(0).max(70),
    teacherComment: z.string().max(500).optional(),
  })).min(1),
});

router.get('/entry-sheet', staff, async (req, res, next) => {
  try {
    const q = z.object({ classId: z.string(), subjectId: z.string(), termId: z.string() }).parse(req.query);
    success(res, await svc.getEntrySheet(q));
  } catch (e) { next(e); }
});

router.post('/bulk', staff, async (req, res, next) => {
  try { success(res, await svc.saveScores(saveSchema.parse(req.body), { id: req.user!.id, role: req.user!.role })); } catch (e) { next(e); }
});

router.post('/lock', adminOnly, async (req, res, next) => {
  try {
    const q = z.object({ classId: z.string(), subjectId: z.string(), termId: z.string(), locked: z.boolean() }).parse(req.body);
    success(res, await svc.setLock(q, { id: req.user!.id, role: req.user!.role }));
  } catch (e) { next(e); }
});

router.get('/class-sheet', staff, async (req, res, next) => {
  try {
    const q = z.object({ classId: z.string(), termId: z.string() }).parse(req.query);
    success(res, await svc.classResultSheet(q));
  } catch (e) { next(e); }
});

router.get('/report-card', staff, async (req, res, next) => {
  try {
    const q = z.object({ studentId: z.string(), termId: z.string() }).parse(req.query);
    success(res, await svc.reportCardData(q.studentId, q.termId));
  } catch (e) { next(e); }
});

router.post('/report-cards/generate', adminOnly, async (req, res, next) => {
  try {
    const q = z.object({ classId: z.string(), termId: z.string() }).parse(req.body);
    success(res, await svc.generateReportCards(q.classId, q.termId, { id: req.user!.id, role: req.user!.role }));
  } catch (e) { next(e); }
});

router.post('/conduct', staff, async (req, res, next) => {
  try {
    const q = z.object({
      studentId: z.string().min(1), termId: z.string().min(1),
      ratings: z.array(z.object({ category: z.enum(['quality', 'activity']), item: z.string().min(1), rating: z.enum(['exc', 'good', 'fair', 'poor']) })),
    }).parse(req.body);
    success(res, await svc.saveConduct(q, { id: req.user!.id, role: req.user!.role }));
  } catch (e) { next(e); }
});

router.post('/remarks', requireRole('SUPER_ADMIN', 'ADMIN', 'TEACHER', 'PARENT'), async (req, res, next) => {
  try {
    const q = z.object({
      studentId: z.string().min(1), termId: z.string().min(1),
      teacherComment: z.string().optional(), headTeacherComment: z.string().optional(),
      parentComment: z.string().optional(), healthComment: z.string().optional(),
    }).parse(req.body);
    success(res, await svc.saveRemarks(q, { id: req.user!.id, role: req.user!.role }));
  } catch (e) { next(e); }
});

router.post('/bulk-student', staff, async (req, res, next) => {
  try {
    const q = z.object({
      studentId: z.string().min(1),
      classId: z.string().min(1),
      termId: z.string().min(1),
      entries: z.array(z.object({
        subjectId: z.string().min(1),
        testScore: z.coerce.number().min(0).max(30),
        examScore: z.coerce.number().min(0).max(70),
      })).min(1),
    }).parse(req.body);
    success(res, await svc.saveStudentScores(q, { id: req.user!.id, role: req.user!.role }));
  } catch (e) { next(e); }
});

router.post('/bulk-class', staff, async (req, res, next) => {
  try {
    const q = z.object({
      classId: z.string().min(1),
      termId: z.string().min(1),
      students: z.array(z.object({
        studentId: z.string().min(1),
        entries: z.array(z.object({
          subjectId: z.string().min(1),
          testScore: z.coerce.number().min(0).max(30),
          examScore: z.coerce.number().min(0).max(70),
        })).min(1),
      })).min(1),
    }).parse(req.body);
    success(res, await svc.saveClassScores(q, { id: req.user!.id, role: req.user!.role }));
  } catch (e) { next(e); }
});

router.get('/report-cards-bulk', requireRole('SUPER_ADMIN', 'ADMIN'), async (req, res, next) => {
  try {
    const q = z.object({ classId: z.string(), termId: z.string() }).parse(req.query);
    const students = await db.student.findMany({ where: { classId: q.classId, status: 'active' }, orderBy: { fullName: 'asc' } });
    const cards = [];
    for (const s of students) {
      try { cards.push(await svc.reportCardData(s.id, q.termId)); } catch { /* skip students without data */ }
    }
    success(res, cards);
  } catch (e) { next(e); }
});


router.get('/roster', requireRole('SUPER_ADMIN', 'ADMIN', 'TEACHER'), async (req, res, next) => {
  try {
    const q = z.object({ classId: z.string(), termId: z.string() }).parse(req.query);
    success(res, await svc.classRosterForTerm(q.classId, q.termId));
  } catch (e) { next(e); }
});

export default router;