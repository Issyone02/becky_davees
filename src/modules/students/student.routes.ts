import { Router } from 'express';
import multer from 'multer';
import { authenticate, requireRole } from '../../core/auth/auth.middleware';
import { ValidationError, NotFoundError, ForbiddenError } from '../../shared/errors';
import { db } from '../../config/db';
import { z } from 'zod';
import { logAudit } from '../../core/audit/audit.service';
import { success } from '../../shared/response';
import * as c from './student.controller';
import * as svc from './student.service';

const router = Router();
router.use(authenticate);

// ---------- Student photo: admins OR the student's own parents ----------
router.patch('/:id/photo', async (req, res, next) => {
  try {
    const { photoUrl } = z.object({ photoUrl: z.string().nullable() }).parse(req.body);
    const studentId = req.params.id;
    const role = req.user!.role;
    if (role === 'PARENT') {
      const parent = await db.parent.findUnique({ where: { userId: req.user!.id } });
      const link = parent
        ? await db.parentStudent.findFirst({ where: { parentId: parent.id, studentId } })
        : null;
      if (!link) throw new ForbiddenError('You can only update photos for your own children.');
    } else if (role !== 'ADMIN' && role !== 'SUPER_ADMIN') {
      throw new ForbiddenError('You are not allowed to update student photos.');
    }
    const before = await db.student.findUnique({ where: { id: studentId } });
    if (!before) throw new NotFoundError('Student', studentId);
    const updated = await db.student.update({ where: { id: studentId }, data: { photoUrl } });
    await logAudit({
      userId: req.user!.id, userRole: role,
      action: 'student.photo_updated', entityType: 'Student', entityId: studentId,
      beforeValues: { photoUrl: before.photoUrl }, afterValues: { photoUrl },
    });
    success(res, updated);
  } catch (e) { next(e); }
});

router.use(requireRole('SUPER_ADMIN', 'ADMIN'));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// ---- Bulk routes MUST be declared BEFORE '/:id' so Express doesn't treat
// ---- "bulk-template"/"bulk-import" as a student id ----
router.get('/bulk-template', async (req, res, next) => {
  try {
    const classFilter = req.query.classFilter as string | undefined;
    const buffer = svc.generateBulkTemplate(classFilter);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="student-import-template.xlsx"');
    res.send(buffer);
  } catch (e) { next(e); }
});

router.post('/bulk-import', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) throw new ValidationError('No file uploaded.');
    success(res, await svc.bulkImportStudents(req.file.buffer, { id: req.user!.id, role: req.user!.role }));
  } catch (e: any) {
    if (e?.statusCode || e?.status || e?.code === 'P2002') { next(e); return; }
    next(new ValidationError(`Import failed: ${e?.message ?? 'Unknown server error'}`));
  }
});

// ---- Standard CRUD routes (parameterized routes last) ----
router.get('/', c.listController);
router.post('/', c.createController);
router.get('/:id', c.getController);
router.patch('/:id', c.updateController);
router.post('/:id/parents', c.linkParentController);
router.delete('/:id/parents/:parentId', c.unlinkParentController);

export default router;