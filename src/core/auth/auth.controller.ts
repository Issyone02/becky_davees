import { Request, Response, NextFunction } from 'express';
import * as authService from './auth.service';
import { success } from '../../shared/response';
import { UnauthorizedError } from '../../shared/errors';
import { db } from '../../config/db';
import { z } from 'zod';

const loginSchema = z.object({
  emailOrUsername: z.string().min(1),
  password: z.string().min(1),
});

const registerSchema = z.object({
  email: z.string().email(),
  fullName: z.string().min(2),
  phone: z.string().optional(),
  password: z.string().min(8),
  role: z.enum(['TEACHER', 'PARENT']),
  submittedData: z.record(z.unknown()).optional(),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8),
});

export async function loginController(req: Request, res: Response, next: NextFunction) {
  try {
    const body = loginSchema.parse(req.body);
    const result = await authService.login(body.emailOrUsername, body.password, req.ip, req.headers['user-agent'] as string);
    res.cookie('refreshToken', result.refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
      path: '/',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });
    success(res, result);
  } catch (e) { next(e); }
}

export async function refreshController(req: Request, res: Response, next: NextFunction) {
  try {
    const token = req.body.refreshToken ?? req.cookies?.refreshToken;
    if (!token) throw new UnauthorizedError('Missing refresh token');
    const result = await authService.refreshAccessToken(token);
    res.cookie('refreshToken', result.refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
      path: '/',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });
    success(res, result);
  } catch (e) { next(e); }
}

export async function logoutController(req: Request, res: Response, next: NextFunction) {
  try {
    await authService.logout(req.user!.id, req.body.refreshTokenHash);
    res.clearCookie('refreshToken', { path: '/' });
    success(res, { message: 'Logged out' });
  } catch (e) { next(e); }
}

export async function registerController(req: Request, res: Response, next: NextFunction) {
  try {
    const body = registerSchema.parse(req.body);
    const result = await authService.registerTeacherOrParent(body);
    success(res, result, 201);
  } catch (e) { next(e); }
}

export async function verifyEmailController(req: Request, res: Response, next: NextFunction) {
  try {
    const { code } = z.object({ code: z.string().length(6) }).parse(req.body);
    const result = await authService.verifyEmail(req.user!.id, code);
    success(res, result);
  } catch (e) { next(e); }
}

export async function changePasswordController(req: Request, res: Response, next: NextFunction) {
  try {
    const body = changePasswordSchema.parse(req.body);
    const result = await authService.changePassword(req.user!.id, body.currentPassword, body.newPassword);
    success(res, result);
  } catch (e) { next(e); }
}

export async function requestResetController(req: Request, res: Response, next: NextFunction) {
  try {
    const { email } = z.object({ email: z.string().email() }).parse(req.body);
    const result = await authService.requestPasswordReset(email);
    success(res, result);
  } catch (e) { next(e); }
}

export async function meController(req: Request, res: Response, next: NextFunction) {
  try {
    const user = await db.user.findUnique({
      where: { id: req.user!.id },
      include: { teacher: true, parent: { include: { students: { include: { student: true } } } } },
    });
    success(res, user);
  } catch (e) { next(e); }
}