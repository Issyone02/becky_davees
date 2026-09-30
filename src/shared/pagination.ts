import { Request } from 'express';
import { z } from 'zod';

const querySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().optional(),
  sortBy: z.string().optional(),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

export function parsePagination(req: Request) {
  const parsed = querySchema.safeParse(req.query);
  const q = parsed.success ? parsed.data : { page: 1, pageSize: 20, sortOrder: 'desc' as const };
  const skip = (q.page - 1) * q.pageSize;
  return { ...q, skip };
}