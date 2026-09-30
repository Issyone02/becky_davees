import { Request, Response, NextFunction } from 'express';
import * as svc from './student.service';
import { createStudentSchema, updateStudentSchema, linkParentSchema } from './student.validator';
import { success, paginated } from '../../shared/response';
import { parsePagination } from '../../shared/pagination';

export async function listController(req: Request, res: Response, next: NextFunction) {
  try {
    const p = parsePagination(req);
    const result = await svc.listStudents({
      ...p,
      classId: req.query.classId as string | undefined,
      sessionId: req.query.sessionId as string | undefined,
    });
    paginated(res, result.data, result.meta);
  } catch (e) { next(e); }
}

export async function getController(req: Request, res: Response, next: NextFunction) {
  try { success(res, await svc.getStudent(req.params.id)); } catch (e) { next(e); }
}

export async function createController(req: Request, res: Response, next: NextFunction) {
  try {
    const body = createStudentSchema.parse(req.body);
    success(res, await svc.createStudent(body, { id: req.user!.id, role: req.user!.role }), 201);
  } catch (e) { next(e); }
}

export async function updateController(req: Request, res: Response, next: NextFunction) {
  try {
    const body = updateStudentSchema.parse(req.body);
    success(res, await svc.updateStudent(req.params.id, body, { id: req.user!.id, role: req.user!.role }));
  } catch (e) { next(e); }
}

export async function linkParentController(req: Request, res: Response, next: NextFunction) {
  try {
    const body = linkParentSchema.parse(req.body);
    success(res, await svc.linkParent(req.params.id, body, { id: req.user!.id, role: req.user!.role }), 201);
  } catch (e) { next(e); }
}

export async function unlinkParentController(req: Request, res: Response, next: NextFunction) {
  try {
    success(res, await svc.unlinkParent(req.params.id, req.params.parentId, { id: req.user!.id, role: req.user!.role }));
  } catch (e) { next(e); }
}