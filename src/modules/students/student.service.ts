import { db } from '../../config/db';
import { Prisma } from '@prisma/client';
import { ConflictError, NotFoundError, ValidationError } from '../../shared/errors';
import { logAudit } from '../../core/audit/audit.service';

interface ListParams {
  skip: number; page: number; pageSize: number;
  search?: string; classId?: string; sessionId?: string;
}

export async function listStudents(p: ListParams) {
  const where: Prisma.StudentWhereInput = {
    ...(p.search ? { fullName: { contains: p.search } } : {}),
    ...(p.classId ? { classId: p.classId } : {}),
    ...(p.sessionId ? { sessionId: p.sessionId } : {}),
  };

  const [data, total] = await Promise.all([
    db.student.findMany({
      where,
      skip: p.skip,
      take: p.pageSize,
      orderBy: { createdAt: 'desc' },
      include: {
        class: true,
        session: true,
        parents: { include: { parent: { include: { user: true } } } },
      },
    }),
    db.student.count({ where }),
  ]);

  return { data, meta: { page: p.page, pageSize: p.pageSize, total, totalPages: Math.ceil(total / p.pageSize) } };
}

export async function getStudent(id: string) {
  const student = await db.student.findUnique({
    where: { id },
    include: {
      class: true,
      session: true,
      parents: { include: { parent: { include: { user: true } } } },
      attendance: true,
      results: true,
    },
  });
  if (!student) throw new NotFoundError('Student', id);
  return student;
}

function friendlyDuplicateError(e: any): never {
  if (e?.code === 'P2002') {
    const target = (e.meta?.target as string[])?.join(' & ') ?? 'value';
    throw new ConflictError(`Duplicate detected: a student with this ${target} already exists. Please use a unique value.`);
  }
  throw e;
}

export async function createStudent(input: Prisma.StudentUncheckedCreateInput, actor: { id: string; role: string }) {
  try {
    const student = await db.student.create({ data: input });
    await logAudit({
      userId: actor.id, userRole: actor.role,
      action: 'student.created', entityType: 'Student', entityId: student.id,
      afterValues: { studentId: student.studentId, fullName: student.fullName },
    });
    return student;
  } catch (e) { friendlyDuplicateError(e); }
}

export async function updateStudent(id: string, input: Prisma.StudentUncheckedUpdateInput, actor: { id: string; role: string }) {
  const before = await getStudent(id);
  try {
    const student = await db.student.update({ where: { id }, data: input });
    await logAudit({
      userId: actor.id, userRole: actor.role,
      action: 'student.updated', entityType: 'Student', entityId: id,
      beforeValues: { fullName: before.fullName, classId: before.classId },
      afterValues: { fullName: student.fullName, classId: student.classId },
    });
    return student;
  } catch (e) { friendlyDuplicateError(e); }
}

export async function linkParent(studentId: string, input: { parentId: string; relationship: string; isPrimary: boolean }, actor: { id: string; role: string }) {
  await getStudent(studentId);
  const existing = await db.parentStudent.findUnique({
    where: { parentId_studentId: { parentId: input.parentId, studentId } },
  });
  if (existing) throw new ConflictError('This parent is already linked to this student.');

  const link = await db.parentStudent.create({
    data: {
      parentId: input.parentId,
      studentId,
      relationship: input.relationship,
      isPrimary: input.isPrimary,
    },
  });
  await logAudit({
    userId: actor.id, userRole: actor.role,
    action: 'student.parent_linked', entityType: 'Student', entityId: studentId,
    afterValues: { parentId: input.parentId, relationship: input.relationship },
  });
  return link;
}

export async function unlinkParent(studentId: string, parentId: string, actor: { id: string; role: string }) {
  await db.parentStudent.deleteMany({ where: { studentId, parentId } });
  await logAudit({
    userId: actor.id, userRole: actor.role,
    action: 'student.parent_unlinked', entityType: 'Student', entityId: studentId,
    afterValues: { parentId },
  });
  return { success: true };
}

import * as XLSX from 'xlsx';

/** Accepts Excel Date cells, Excel serial numbers, yyyy-mm-dd, dd/mm/yyyy, dd-mm-yyyy, dd-mm-yy */
function parseDob(value: any): Date | null | 'invalid' {
  if (value == null || value === '') return null;
  if (value instanceof Date) return isNaN(value.getTime()) ? 'invalid' : value;
  if (typeof value === 'number' && isFinite(value)) {
    const d = new Date(Math.round((value - 25569) * 86400 * 1000)); // Excel serial → UTC ms
    return isNaN(d.getTime()) ? 'invalid' : d;
  }
  const s = String(value).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);           // yyyy-mm-dd
  if (m) return safeDate(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})$/);     // dd/mm/yyyy or dd-mm-yy
  if (m) {
    let y = +m[3];
    if (y < 100) y += y > 50 ? 1900 : 2000;
    return safeDate(y, +m[2], +m[1]);
  }
  const d = new Date(s);                                      // last-resort JS parse
  return isNaN(d.getTime()) ? 'invalid' : d;
}

function safeDate(y: number, mo: number, da: number): Date | 'invalid' {
  const d = new Date(Date.UTC(y, mo - 1, da));
  if (d.getUTCFullYear() !== y || d.getUTCMonth() !== mo - 1 || d.getUTCDate() !== da) return 'invalid';
  return d;
}

export async function bulkImportStudents(fileBuffer: Buffer, actor: { id: string; role: string }) {
  const workbook = XLSX.read(fileBuffer, { cellDates: true });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' }) as Record<string, any>[];

  if (rows.length === 0) throw new ValidationError('The file is empty.');
  if (rows.length > 500) throw new ValidationError('Maximum 500 students per import.');

  const errors: string[] = [];
  const validRows: {
    studentId: string | null;
    admissionNumber: string | null;
    fullName: string;
    gender: 'male' | 'female' | null;
    dateOfBirth: Date | null;
    classId: string;
    guardianEmail: string | null;
  }[] = [];

  // Load all classes and parents once
  const allClasses = await db.class.findMany({ select: { id: true, name: true } });
  const classMap = new Map(allClasses.map((c) => [c.name.toLowerCase(), c.id]));
  const allParents = await db.user.findMany({ where: { role: 'PARENT' }, select: { id: true, email: true } });
  const parentMap = new Map(allParents.map((p) => [p.email.toLowerCase(), p.id]));

  const seenStudentIds = new Set<string>();
  const seenAdmissionNos = new Set<string>();
  const seenNameClassCombos = new Set<string>();

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNum = i + 2; // Excel row (1-indexed + header)
    const rowErrors: string[] = [];

    const studentId = String(row['Student ID'] ?? '').trim() || null;
    const admissionNumber = String(row['Admission Number'] ?? '').trim() || null;
    const fullName = String(row['Full Name'] ?? '').trim();
    const genderRaw = String(row['Gender'] ?? '').trim().toLowerCase();
    const dobRaw = String(row['Date of Birth'] ?? '').trim();
    const className = String(row['Class'] ?? '').trim();
    const guardianEmail = String(row['Guardian Email'] ?? '').trim() || null;

    // Validate required fields
    if (!fullName) rowErrors.push(`Row ${rowNum}: Full Name is required.`);
    if (!className) rowErrors.push(`Row ${rowNum}: Class is required.`);

    // Validate class exists
    const classId = classMap.get(className.toLowerCase());
    if (className && !classId) rowErrors.push(`Row ${rowNum}: Class "${className}" does not exist.`);

    // Validate gender
    let gender: 'male' | 'female' | null = null;
    if (genderRaw) {
      if (genderRaw === 'male' || genderRaw === 'm') gender = 'male';
      else if (genderRaw === 'female' || genderRaw === 'f') gender = 'female';
      else rowErrors.push(`Row ${rowNum}: Gender must be Male or Female (got "${genderRaw}").`);
    }

    // Validate date of birth (any Excel/date format)
    let dateOfBirth: Date | null = null;
    if (dobRaw) {
      const parsed = parseDob(row['Date of Birth']);
      if (parsed === 'invalid') {
        rowErrors.push(`Row ${rowNum}: Date of Birth "${dobRaw}" is invalid (use yyyy-mm-dd or dd/mm/yyyy).`);
      } else {
        dateOfBirth = parsed;
      }
    }

    // Validate guardian email if provided
    if (guardianEmail) {
      const emailLower = guardianEmail.toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailLower)) {
        rowErrors.push(`Row ${rowNum}: Guardian Email "${guardianEmail}" is not a valid email.`);
      } else if (!parentMap.has(emailLower)) {
        rowErrors.push(`Row ${rowNum}: Guardian Email "${guardianEmail}" does not match any existing parent account.`);
      }
    }

    // Validate unique Student ID
    if (studentId) {
      if (seenStudentIds.has(studentId)) {
        rowErrors.push(`Row ${rowNum}: Student ID "${studentId}" is duplicated in the file.`);
      } else {
        const existing = await db.student.findUnique({ where: { studentId } });
        if (existing) rowErrors.push(`Row ${rowNum}: Student ID "${studentId}" already exists in the database.`);
        seenStudentIds.add(studentId);
      }
    }

    // Validate unique Admission Number
    if (admissionNumber) {
      if (seenAdmissionNos.has(admissionNumber)) {
        rowErrors.push(`Row ${rowNum}: Admission Number "${admissionNumber}" is duplicated in the file.`);
      } else {
        const existing = await db.student.findFirst({ where: { admissionNumber } });
        if (existing) rowErrors.push(`Row ${rowNum}: Admission Number "${admissionNumber}" already exists in the database.`);
        seenAdmissionNos.add(admissionNumber);
      }
    }

    // Validate unique full name + class combo (prevent twins with same name in same class)
    if (fullName && classId) {
      const combo = `${fullName.toLowerCase()}__${classId}`;
      if (seenNameClassCombos.has(combo)) {
        rowErrors.push(`Row ${rowNum}: Duplicate student "${fullName}" in class "${className}".`);
      } else {
        const existing = await db.student.findFirst({ where: { fullName, classId } });
        if (existing) rowErrors.push(`Row ${rowNum}: A student named "${fullName}" already exists in class "${className}".`);
        seenNameClassCombos.add(combo);
      }
    }

    if (rowErrors.length > 0) {
      errors.push(...rowErrors);
    } else {
      validRows.push({
        studentId,
        admissionNumber,
        fullName,
        gender,
        dateOfBirth,
        classId: classId!,
        guardianEmail,
      });
    }
  }

  if (errors.length > 0) {
    return { status: 'error' as const, errors };
  }

  // All rows valid — import in transaction
  const setting = await db.schoolSetting.findFirst({ select: { currentSessionId: true } });
  if (!setting?.currentSessionId) throw new ValidationError('No current session is set. Please set a current session in Academics → Sessions first.');

  let created = 0;
  let guardiansLinked = 0;
  const createdStudents: { id: string; fullName: string; guardianEmail: string | null }[] = [];

  await db.$transaction(async (tx) => {
    for (const row of validRows) {
      // Auto-generate IDs if blank
      const studentId = row.studentId ?? `STD-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
      const admissionNumber = row.admissionNumber ?? `ADM-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

      const student = await tx.student.create({
        data: {
          studentId,
          admissionNumber,
          fullName: row.fullName,
          gender: row.gender ?? 'male',
          dateOfBirth: row.dateOfBirth,
          classId: row.classId,
          sessionId: setting.currentSessionId,
          status: 'active',
        },
      });

      // Create enrollment for current session
      await tx.enrollment.create({
        data: {
          studentId: student.id,
          sessionId: setting.currentSessionId,
          classId: row.classId,
          outcome: 'enrolled',
        },
      });

      // Link guardian if email provided
      if (row.guardianEmail) {
        const parentId = parentMap.get(row.guardianEmail.toLowerCase());
        if (parentId) {
          await tx.parentStudent.create({
            data: {
              parentId,
              studentId: student.id,
              relationship: 'guardian',
              isPrimary: true,
            },
          });
          guardiansLinked++;
        }
      }

      createdStudents.push({ id: student.id, fullName: row.fullName, guardianEmail: row.guardianEmail });
      created++;
    }

  }, { timeout: 60000, maxWait: 20000 });

  await logAudit({
    userId: actor.id,
    userRole: actor.role,
    action: 'students.bulk_imported',
    entityType: 'Student',
    entityId: null,
    afterValues: { count: created, guardiansLinked },
  });

  return { status: 'success' as const, created, guardiansLinked };
}

export function generateBulkTemplate(classFilter?: string) {
  const header = ['Student ID', 'Admission Number', 'Full Name', 'Gender', 'Date of Birth', 'Class', 'Guardian Email'];
  const exampleRow = ['', '', 'John Doe', 'Male', '2015-05-20', classFilter || 'Primary 1', 'parent@example.com'];
  const ws = XLSX.utils.aoa_to_sheet([header, exampleRow]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Students');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}