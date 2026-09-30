import { z } from 'zod';

export const createStudentSchema = z.object({
  studentId: z.string().min(2).max(50),
  admissionNumber: z.string().min(2).max(50),
  fullName: z.string().min(2).max(120),
  dateOfBirth: z.coerce.date(),
  gender: z.enum(['MALE', 'FEMALE', 'OTHER']),
  classId: z.string().min(1),
  sessionId: z.string().min(1),
  status: z.string().default('active'),
});

export const updateStudentSchema = createStudentSchema.partial();

export const linkParentSchema = z.object({
  parentId: z.string().min(1),
  relationship: z.string().default('guardian'),
  isPrimary: z.boolean().default(false),
});