import { Router } from 'express';
import { authenticate } from '../../core/auth/auth.middleware';
import { db } from '../../config/db';
import { success } from '../../shared/response';
import { z } from 'zod';

const router = Router();
router.use(authenticate);

router.get('/', async (req, res, next) => {
  try {
    const { q } = z.object({ q: z.string().min(2) }).parse(req.query);
    const role = req.user!.role;
    const like = { contains: q };
    const out: any = { students: [], teachers: [], parents: [], classes: [], subjects: [] };

    if (role === 'PARENT') {
      const parent = await db.parent.findUnique({
        where: { userId: req.user!.id },
        include: { students: { include: { student: { include: { class: { select: { name: true } } } } } } },
      });
      out.students = (parent?.students.map((p) => p.student) ?? [])
        .filter((s) => s.fullName.toLowerCase().includes(q.toLowerCase()) || s.studentId.toLowerCase().includes(q.toLowerCase()))
        .slice(0, 5)
        .map((s) => ({ id: s.id, label: s.fullName, sub: `${s.studentId} · ${s.class.name}` }));
      success(res, out);
      return;
    }

    let classIds: string[] | undefined;
    if (role === 'TEACHER') {
      const teacher = await db.teacher.findUnique({ where: { userId: req.user!.id } });
      const assigns = await db.teacherClassSubject.findMany({ where: { teacherId: teacher?.id ?? 'none' }, select: { classId: true } });
      classIds = Array.from(new Set(assigns.map((a) => a.classId)));
    }

    out.students = (await db.student.findMany({
      where: {
        status: 'active',
        ...(classIds ? { classId: { in: classIds } } : {}),
        OR: [{ fullName: like }, { studentId: like }, { admissionNumber: like }],
      },
      include: { class: { select: { name: true } } },
      take: 5,
    })).map((s) => ({ id: s.id, label: s.fullName, sub: `${s.studentId} · ${s.class.name}` }));

    if (role !== 'TEACHER') {
      out.teachers = (await db.teacher.findMany({
        where: { OR: [{ user: { fullName: like } }, { teacherCode: like }] },
        include: { user: { select: { fullName: true } } },
        take: 5,
      })).map((t) => ({ id: t.id, label: t.user.fullName, sub: t.teacherCode }));

      out.parents = (await db.parent.findMany({
        where: { OR: [{ user: { fullName: like } }, { parentCode: like }] },
        include: { user: { select: { fullName: true } } },
        take: 5,
      })).map((p) => ({ id: p.id, label: p.user.fullName, sub: p.parentCode }));
    }

    if (role === 'TEACHER') {
      out.classes = (await db.class.findMany({ where: { id: { in: classIds ?? [] }, name: like }, take: 5 }))
        .map((c) => ({ id: c.id, label: c.name, sub: `Class · ${c.level}` }));
      const t2 = await db.teacher.findUnique({ where: { userId: req.user!.id } });
      const subjAssigns = await db.teacherClassSubject.findMany({ where: { teacherId: t2?.id ?? 'none' }, select: { subjectId: true } });
      const subjectIds = Array.from(new Set(subjAssigns.map((a) => a.subjectId)));
      out.subjects = (await db.subject.findMany({ where: { id: { in: subjectIds }, OR: [{ name: like }, { code: like }] }, take: 5 }))
        .map((s) => ({ id: s.id, label: s.name, sub: `Subject · ${s.code}` }));
    } else {
      out.classes = (await db.class.findMany({ where: { name: like }, take: 5 }))
        .map((c) => ({ id: c.id, label: c.name, sub: `Class · ${c.level}` }));
      out.subjects = (await db.subject.findMany({ where: { OR: [{ name: like }, { code: like }] }, take: 5 }))
        .map((s) => ({ id: s.id, label: s.name, sub: `Subject · ${s.code}` }));
    }

    success(res, out);
  } catch (e) { next(e); }
});

export default router;