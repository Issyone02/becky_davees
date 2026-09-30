import { Response } from 'express';

export function success(res: Response, data: unknown, statusCode = 200) {
  return res.status(statusCode).json({ success: true, data });
}

export function paginated(
  res: Response,
  data: unknown[],
  meta: { page: number; pageSize: number; total: number; totalPages: number },
) {
  return res.status(200).json({ success: true, data, meta });
}