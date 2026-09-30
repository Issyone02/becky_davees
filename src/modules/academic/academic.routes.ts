import { Router } from 'express';
import { authenticate, requireRole } from '../../core/auth/auth.middleware';
import * as svc from './academic.service';
import { success } from '../../shared/response';
import { z } from 'zod';
import { db } from '../../config/db';
import { logAudit } from '../../core/audit/audit.service';

const router = Router();
router.use(authenticate);

const staff = requireRole('SUPER_ADMIN', 'ADMIN', 'TEACHER');
const adminOnly = requireRole('SUPER_ADMIN', 'ADMIN');

const sessionSchema = z.object({ name: z.string().min(4), startDate: z.coerce.date(), endDate: z.coerce.date() });
const termSchema = z.object({ sessionId: z.string().min(1), name: z.string().min(2), startDate: z.coerce.date(), endDate: z.coerce.date() });
const classSchema = z.object({ name: z.string().min(2), level: z.string().min(2), capacity: z.coerce.number().optional(), classTeacherId: z.string().nullable().optional() });
const subjectSchema = z.object({ name: z.string().min(2), code: z.string().min(2), description: z.string().optional() });
const assignmentSchema = z.object({
  teacherId: z.string().min(1), classId: z.string().min(1), subjectId: z.string().min(1),
  sessionId: z.string().min(1), termId: z.string().min(1),
});

// ---------- Reads ----------
router.get('/sessions', async (_req, res, next) => {
  try { success(res, await svc.listSessions()); } catch (e) { next(e); }
});
router.get('/terms', async (req, res, next) => {
  try { success(res, await svc.listTerms(req.query.sessionId as string | undefined)); } catch (e) { next(e); }
});
router.get('/current', staff, async (_req, res, next) => {
  try { success(res, await svc.resolveCurrentContext()); } catch (e) { next(e); }
});
router.get('/classes', staff, async (_req, res, next) => {
  try { success(res, await svc.listClasses()); } catch (e) { next(e); }
});
router.get('/subjects', staff, async (_req, res, next) => {
  try { success(res, await svc.listSubjects()); } catch (e) { next(e); }
});
router.get('/classes/:id/subjects', adminOnly, async (req, res, next) => {
  try { success(res, await svc.listClassSubjects(req.params.id)); } catch (e) { next(e); }
});
router.get('/assignments', adminOnly, async (req, res, next) => {
  try {
    success(res, await svc.listAssignments({
      classId: req.query.classId as string | undefined,
      termId: req.query.termId as string | undefined,
    }));
  } catch (e) { next(e); }
});

// ---------- Session writes ----------
router.post('/sessions', adminOnly, async (req, res, next) => {
  try { success(res, await svc.createSession(sessionSchema.parse(req.body), { id: req.user!.id, role: req.user!.role }), 201); } catch (e) { next(e); }
});
router.post('/sessions/:id/set-current', adminOnly, async (req, res, next) => {
  try { success(res, await svc.setCurrentSession(req.params.id, { id: req.user!.id, role: req.user!.role })); } catch (e) { next(e); }
});

// ---------- Term writes ----------
router.post('/terms', adminOnly, async (req, res, next) => {
  try { success(res, await svc.createTerm(termSchema.parse(req.body), { id: req.user!.id, role: req.user!.role }), 201); } catch (e) { next(e); }
});
router.post('/terms/:id/set-current', adminOnly, async (req, res, next) => {
  try { success(res, await svc.setCurrentTerm(req.params.id, { id: req.user!.id, role: req.user!.role })); } catch (e) { next(e); }
});

router.patch('/sessions/:id', adminOnly, async (req, res, next) => {
  try { success(res, await svc.updateSession(req.params.id, sessionSchema.partial().parse(req.body), { id: req.user!.id, role: req.user!.role })); } catch (e) { next(e); }
});
router.patch('/terms/:id', adminOnly, async (req, res, next) => {
  try { success(res, await svc.updateTerm(req.params.id, termSchema.partial().omit({ sessionId: true }).parse(req.body), { id: req.user!.id, role: req.user!.role })); } catch (e) { next(e); }
});

// ---------- Class writes ----------
router.post('/classes', adminOnly, async (req, res, next) => {
  try { success(res, await svc.createClass(classSchema.parse(req.body), { id: req.user!.id, role: req.user!.role }), 201); } catch (e) { next(e); }
});
router.patch('/classes/:id', adminOnly, async (req, res, next) => {
  try { success(res, await svc.updateClass(req.params.id, classSchema.partial().parse(req.body), { id: req.user!.id, role: req.user!.role })); } catch (e) { next(e); }
});
router.delete('/classes/:id', adminOnly, async (req, res, next) => {
  try { success(res, await svc.deleteClass(req.params.id, { id: req.user!.id, role: req.user!.role })); } catch (e) { next(e); }
});

// ---------- Subject writes ----------
router.post('/subjects', adminOnly, async (req, res, next) => {
  try { success(res, await svc.createSubject(subjectSchema.parse(req.body), { id: req.user!.id, role: req.user!.role }), 201); } catch (e) { next(e); }
});
router.patch('/subjects/:id', adminOnly, async (req, res, next) => {
  try { success(res, await svc.updateSubject(req.params.id, subjectSchema.partial().parse(req.body), { id: req.user!.id, role: req.user!.role })); } catch (e) { next(e); }
});

router.post('/classes/:id/subjects/bulk', adminOnly, async (req, res, next) => {
  try {
    const q = z.object({ subjectIds: z.array(z.string()).min(1) }).parse(req.body);
    const classId = req.params.id;
    const existing = await db.classSubject.findMany({ where: { classId }, select: { subjectId: true } });
    const existingIds = new Set(existing.map((e) => e.subjectId));
    const toCreate = q.subjectIds.filter((id) => !existingIds.has(id));
    if (toCreate.length) {
      await db.$transaction(
        toCreate.map((subjectId) => db.classSubject.create({ data: { classId, subjectId } })),
      );
    }
    await logAudit({
      userId: req.user!.id, userRole: req.user!.role, action: 'class_subjects.bulk_assigned',
      entityType: 'ClassSubject', entityId: classId,
      afterValues: { subjectIds: toCreate, skipped: q.subjectIds.length - toCreate.length },
    });
    success(res, { created: toCreate.length, skipped: q.subjectIds.length - toCreate.length });
  } catch (e) { next(e); }
});


// ---------- Class ↔ Subject ----------
router.post('/classes/:id/subjects', adminOnly, async (req, res, next) => {
  try {
    const { subjectId } = z.object({ subjectId: z.string().min(1) }).parse(req.body);
    success(res, await svc.assignSubjectToClass(req.params.id, subjectId, { id: req.user!.id, role: req.user!.role }), 201);
  } catch (e) { next(e); }
});
router.delete('/classes/:id/subjects/:subjectId', adminOnly, async (req, res, next) => {
  try { success(res, await svc.removeSubjectFromClass(req.params.id, req.params.subjectId, { id: req.user!.id, role: req.user!.role })); } catch (e) { next(e); }
});

router.post('/assignments/bulk', adminOnly, async (req, res, next) => {
  try {
    const q = z.object({
      teacherId: z.string().min(1), classId: z.string().min(1),
      subjectIds: z.array(z.string()).min(1),
      sessionId: z.string().min(1), termId: z.string().min(1),
    }).parse(req.body);
    success(res, await svc.createAssignmentsBulk(q, { id: req.user!.id, role: req.user!.role }), 201);
  } catch (e) { next(e); }
});

// ---------- Teacher assignments ----------
router.post('/assignments', adminOnly, async (req, res, next) => {
  try { success(res, await svc.createAssignment(assignmentSchema.parse(req.body), { id: req.user!.id, role: req.user!.role }), 201); } catch (e) { next(e); }
});
router.delete('/assignments/:id', adminOnly, async (req, res, next) => {
  try { success(res, await svc.deleteAssignment(Number(req.params.id), { id: req.user!.id, role: req.user!.role })); } catch (e) { next(e); }
});

router.get('/grading-scale', adminOnly, async (req, res, next) => {
  try { success(res, await svc.listGradingScale(req.query.sessionId as string | undefined)); } catch (e) { next(e); }
});

router.post('/grading-scale', adminOnly, async (req, res, next) => {
  try {
    const q = z.object({ minScore: z.coerce.number(), maxScore: z.coerce.number(), grade: z.string().min(1), remark: z.string().min(1), sessionId: z.string().nullish() }).parse(req.body);
    success(res, await svc.createGradingScale(q, { id: req.user!.id, role: req.user!.role }), 201);
  } catch (e) { next(e); }
});

router.patch('/grading-scale/:id', adminOnly, async (req, res, next) => {
  try {
    const q = z.object({ minScore: z.coerce.number().optional(), maxScore: z.coerce.number().optional(), grade: z.string().min(1).optional(), remark: z.string().min(1).optional(), sessionId: z.string().nullish() }).parse(req.body);
    success(res, await svc.updateGradingScale(Number(req.params.id), q, { id: req.user!.id, role: req.user!.role }));
  } catch (e) { next(e); }
});

router.delete('/grading-scale/:id', adminOnly, async (req, res, next) => {
  try { success(res, await svc.deleteGradingScale(Number(req.params.id), { id: req.user!.id, role: req.user!.role })); } catch (e) { next(e); }
});

export default router;