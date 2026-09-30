import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { authenticate } from './auth.middleware';
import { db } from '../../config/db';
import { UnauthorizedError } from '../../shared/errors';
import { success } from '../../shared/response';
import * as c from './auth.controller';

const router = Router();

// Trust proxy headers (Render, Vercel, nginx, Cloudflare)
// Without this, all users behind a proxy share one IP bucket
const keyGenerator = (req: any) => {
  // If authenticated, key by user ID (prevents proxy-IP sharing)
  if (req.user?.id) return req.user.id;
  // Otherwise use real IP from forwarded headers
  return req.ip || req.connection.remoteAddress || 'unknown';
};

// Login limiter: generous in dev, strict in prod
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: process.env.NODE_ENV === 'production' ? 10 : 50,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator,
  message: {
    success: false,
    error: { code: 'RATE_LIMITED', message: 'Too many login attempts from this IP. Please try again later.' },
  },
});

// Refresh token limiter: prevent brute-force token guessing
const refreshLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: process.env.NODE_ENV === 'production' ? 30 : 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: { code: 'RATE_LIMITED', message: 'Too many refresh attempts. Please log in again.' },
  },
});

router.post('/login', loginLimiter, c.loginController);
router.post('/refresh', refreshLimiter, c.refreshController);
router.post('/logout', authenticate, c.logoutController);
router.post('/register', c.registerController);
router.post('/verify-email', authenticate, c.verifyEmailController);
router.post('/change-password', authenticate, (req, res, next) => {
  if (req.user!.role === 'SUPER_ADMIN') {
    return next(new ValidationError('The Super Admin password cannot be changed in-app.'));
  }
  c.changePasswordController(req, res, next);
});
router.post('/forgot-password', c.requestResetController);
router.get('/me', authenticate, c.meController);

// Liveness check: open sessions poll this; deactivated/deleted accounts fail instantly
router.get('/active', authenticate, async (req, res, next) => {
  try {
    const u = await db.user.findUnique({ where: { id: req.user!.id }, select: { status: true, deletedAt: true } });
    if (!u || u.deletedAt || u.status !== 'ACTIVE') throw new UnauthorizedError('Account no longer active');
    success(res, { active: true });
  } catch (e) { next(e); }
});

export default router;