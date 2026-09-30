import { db } from '../../config/db';
import { hashPassword, verifyPassword, validatePasswordStrength, isPasswordInHistory, HISTORY_COUNT } from './password';
import { signAccessToken, signRefreshToken, verifyRefreshToken, hashRefreshToken, TokenPayload } from './jwt';
import { UnauthorizedError, ValidationError, ConflictError, ForbiddenError, NotFoundError, AppError } from '../../shared/errors';
import { checkLockout, recordFailure, recordSuccess } from './loginGuard';
import { logAudit } from '../audit/audit.service';
import { env } from '../../config/env';
import * as notify from '../notify/notify.service';
import { randomUUID } from 'crypto';

export async function login(emailOrUsername: string, password: string, ip?: string, userAgent?: string) {
  const identifier = emailOrUsername.toLowerCase().trim();

  // Guard: is this account temporarily locked?
  const lock = checkLockout(identifier);
  if (lock.locked) {
    const mins = Math.ceil(lock.retryAfterMs / 60000);
    throw new AppError(
      429,
      `Too many failed login attempts. Account temporarily locked. Try again in ${mins} minute(s).`,
      'ACCOUNT_LOCKED',
    );
  }

  const user = await db.user.findFirst({
    where: {
      OR: [{ email: emailOrUsername }, { username: emailOrUsername }],
      deletedAt: null,
    },
    include: { teacher: true, parent: true },
  });

  if (!user) {
    recordFailure(identifier);
    await logAudit({
      userId: null, userRole: null,
      action: 'auth.login_failed', entityType: 'User', entityId: null,
      afterValues: { identifier, reason: 'unknown_account' },
      ipAddress: ip ?? null, userAgent: userAgent ?? null,
    });
    throw new UnauthorizedError('Invalid credentials');
  }

  if (user.status !== 'ACTIVE') {
    throw new ForbiddenError(
      user.status === 'PENDING' ? 'Your account is pending approval.' :
      user.status === 'REJECTED' ? 'Your registration was rejected.' :
      'Your account is not active.',
    );
  }

  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) {
    recordFailure(identifier);
    await logAudit({
      userId: user.id, userRole: user.role,
      action: 'auth.login_failed', entityType: 'User', entityId: user.id,
      afterValues: { reason: 'wrong_password' },
      ipAddress: ip ?? null, userAgent: userAgent ?? null,
    });
    throw new UnauthorizedError('Invalid credentials');
  }

  // Success — clear failure history
  recordSuccess(identifier);

  const payload: TokenPayload = { sub: user.id, role: user.role, email: user.email };
  const accessToken = signAccessToken(payload);
  const { token: refreshToken, hash } = signRefreshToken(payload);

  await db.refreshToken.create({
    data: {
      userId: user.id,
      tokenHash: hash,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    },
  });

  await db.user.update({
    where: { id: user.id },
    data: { lastLoginAt: new Date(), lastLoginIp: ip ?? null },
  });

  await logAudit({
    userId: user.id, userRole: user.role,
    action: 'auth.login', entityType: 'User', entityId: user.id,
    ipAddress: ip ?? null, userAgent: userAgent ?? null,
  });

  return {
    accessToken,
    refreshToken,
    user: {
      id: user.id,
      email: user.email,
      username: user.username,
      fullName: user.fullName,
      role: user.role,
      mustChangePassword: user.mustChangePassword,
      profilePictureUrl: user.profilePictureUrl,
    },
  };
}

export async function refreshAccessToken(refreshToken: string) {
  const payload = verifyRefreshToken(refreshToken);
  const hash = hashRefreshToken(refreshToken);

  const stored = await db.refreshToken.findFirst({
    where: { userId: payload.sub, tokenHash: hash, expiresAt: { gt: new Date() } },
  });
  if (!stored) throw new UnauthorizedError('Invalid or expired refresh token');

  const user = await db.user.findUnique({ where: { id: payload.sub } });
  if (!user || user.status !== 'ACTIVE') throw new UnauthorizedError('User no longer active');

  // Rotate refresh token (using deleteMany to prevent P2025 errors on concurrent requests)
  await db.refreshToken.deleteMany({ where: { id: stored.id } });

  const newPayload: TokenPayload = { sub: user.id, role: user.role, email: user.email };
  const newAccess = signAccessToken(newPayload);
  const { token: newRefresh, hash: newHash } = signRefreshToken(newPayload);

  await db.refreshToken.create({
    data: {
      userId: user.id,
      tokenHash: newHash,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    },
  });

  return { accessToken: newAccess, refreshToken: newRefresh };
}

export async function logout(userId: string, refreshTokenHash?: string) {
  if (refreshTokenHash) {
    await db.refreshToken.deleteMany({ where: { userId, tokenHash: refreshTokenHash } });
  } else {
    await db.refreshToken.deleteMany({ where: { userId } });
  }
  await logAudit({ userId, userRole: null, action: 'auth.logout', entityType: 'User', entityId: userId });
}

export async function registerTeacherOrParent(input: {
  email: string;
  fullName: string;
  phone?: string;
  password: string;
  role: 'TEACHER' | 'PARENT';
  submittedData?: Record<string, unknown>;
}) {
  const strength = validatePasswordStrength(input.password);
  if (!strength.valid) throw new ValidationError('Password does not meet requirements', strength.issues);

  const existing = await db.user.findFirst({
    where: { OR: [{ email: input.email }, input.phone ? { phone: input.phone } : {}] },
  });
  if (existing) throw new ConflictError('Email or phone already registered');

  const passwordHash = await hashPassword(input.password);

  const user = await db.user.create({
    data: {
      email: input.email,
      phone: input.phone,
      fullName: input.fullName,
      passwordHash,
      role: input.role,
      status: 'PENDING',
      mustChangePassword: true,
    },
  });

  const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

  await db.registration.create({
    data: {
      userId: user.id,
      role: input.role,
      submittedData: JSON.stringify(input.submittedData ?? {}),
      verificationCode,
      verificationCodeExpiresAt: expiresAt,
      status: 'pending',
    },
  });

  await logAudit({
    userId: user.id,
    userRole: input.role,
    action: 'registration.submitted',
    entityType: 'Registration',
    entityId: user.id,
  });

  return { userId: user.id, verificationCode };
}

export async function verifyEmail(userId: string, code: string) {
  const reg = await db.registration.findUnique({ where: { userId } });
  if (!reg) throw new NotFoundError('Registration');
  if (reg.verificationCode !== code) throw new ValidationError('Invalid verification code');
  if (reg.verificationCodeExpiresAt < new Date()) throw new ValidationError('Verification code expired');

  await db.user.update({ where: { id: userId }, data: { emailVerifiedAt: new Date() } });
  await db.registration.update({ where: { userId }, data: { status: 'verified' } });
  return { success: true };
}

export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
) {
  const user = await db.user.findUnique({ where: { id: userId } });
  if (!user) throw new NotFoundError('User');

  if (!await verifyPassword(currentPassword, user.passwordHash)) {
    throw new UnauthorizedError('Current password is incorrect');
  }

  const strength = validatePasswordStrength(newPassword);
  if (!strength.valid) throw new ValidationError('Password does not meet requirements', strength.issues);

  const history = await db.userPasswordHistory.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: HISTORY_COUNT,
  });
  const inHistory = await isPasswordInHistory(newPassword, history.map(h => h.passwordHash));
  if (inHistory) throw new ValidationError('Password was used recently');

  const newHash = await hashPassword(newPassword);
  await db.userPasswordHistory.create({ data: { userId, passwordHash: user.passwordHash } });
  
  const keep = await db.userPasswordHistory.findMany({
    where: { userId }, orderBy: { createdAt: 'desc' }, take: HISTORY_COUNT,
  });
  if (keep.length > HISTORY_COUNT) {
    await db.userPasswordHistory.deleteMany({
      where: { userId, id: { notIn: keep.slice(0, HISTORY_COUNT).map(k => k.id) } },
    });
  }

  await db.user.update({
    where: { id: userId },
    data: { passwordHash: newHash, mustChangePassword: false, passwordChangedAt: new Date() },
  });
  await db.refreshToken.deleteMany({ where: { userId } });

  await logAudit({ userId, userRole: user.role, action: 'password.changed', entityType: 'User', entityId: userId });
  return { success: true };
}

export async function requestPasswordReset(email: string) {
  const user = await db.user.findFirst({ where: { email, deletedAt: null } });
  if (user && user.status === 'ACTIVE') {
    const token = randomUUID();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    await db.user.update({ where: { id: user.id }, data: { resetToken: token, resetTokenExpires: expiresAt } });
    const link = `${process.env.FRONTEND_URL ?? 'http://localhost:5173'}/reset-password?token=${token}`;
    await notify.emailTo(
      'password.reset-request',
      { email: user.email, name: user.fullName },
      'Password Reset Request',
      `<p>Hello ${user.fullName},</p>
       <p>We received a request to reset your portal password.</p>
       <p><a href="${link}" style="display:inline-block;background:#4f46e5;color:#ffffff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600;">Set a New Password</a></p>
       <p>Or copy this link: ${link}</p>
       <p>The link expires in <strong>60 minutes</strong> and can be used <strong>once</strong>.</p>
       <p>If you did not request this, you can safely ignore this email.</p>`,
    );
    await logAudit({ userId: user.id, userRole: user.role, action: 'password.reset_requested', entityType: 'User', entityId: user.id });
  }
  return { success: true, message: 'If the email exists, a reset link has been sent.' };
}

export async function resetWithToken(token: string, newPassword: string) {
  const user = await db.user.findFirst({ where: { resetToken: token, deletedAt: null } });
  if (user?.role === 'SUPER_ADMIN') throw new ValidationError('The Super Admin password cannot be changed in-app.');
  if (!user || !user.resetTokenExpires || user.resetTokenExpires < new Date()) {
    throw new ValidationError('This reset link is invalid or has expired. Please request a new one.');
  }
  const strength = validatePasswordStrength(newPassword);
  if (!strength.valid) throw new ValidationError('Password does not meet requirements', strength.issues);
  const history = await db.userPasswordHistory.findMany({ where: { userId: user.id }, orderBy: { createdAt: 'desc' }, take: HISTORY_COUNT });
  if (await isPasswordInHistory(newPassword, history.map((h) => h.passwordHash))) {
    throw new ValidationError('Password was used recently');
  }
  const newHash = await hashPassword(newPassword);
  await db.userPasswordHistory.create({ data: { userId: user.id, passwordHash: user.passwordHash } });
  await db.user.update({
    where: { id: user.id },
    data: { passwordHash: newHash, resetToken: null, resetTokenExpires: null, mustChangePassword: false, passwordChangedAt: new Date() },
  });
  await db.refreshToken.deleteMany({ where: { userId: user.id } });
  await logAudit({ userId: user.id, userRole: user.role, action: 'password.reset_via_link', entityType: 'User', entityId: user.id });
  await notify.emailTo(
    'password.reset-completed',
    { email: user.email, name: user.fullName },
    'Your Password Was Changed',
    `<p>Hello ${user.fullName},</p><p>Your portal password was just changed via a reset link.</p><p>If this was not you, contact the school administrator immediately.</p>`,
  );
  return { success: true };
}

export async function approveRegistration(registrationUserId: string, reviewerId: string) {
  const reg = await db.registration.findUnique({ where: { userId: registrationUserId } });
  if (!reg) throw new NotFoundError('Registration');
  if (reg.status !== 'pending' && reg.status !== 'verified') {
    throw new ValidationError(`Cannot approve registration in status: ${reg.status}`);
  }

  const user = await db.user.findUnique({ where: { id: registrationUserId } });
  if (!user) throw new NotFoundError('User');

  await db.$transaction([
    db.user.update({ where: { id: registrationUserId }, data: { status: 'ACTIVE' } }),
    db.registration.update({
      where: { userId: registrationUserId },
      data: { status: 'approved', reviewedBy: reviewerId, reviewedAt: new Date() },
    }),
    user.role === 'TEACHER'
      ? db.teacher.create({ data: { userId: registrationUserId, teacherCode: `TCH-${Date.now()}` } })
      : db.parent.create({ data: { userId: registrationUserId, parentCode: `PAR-${Date.now()}` } }),
  ]);

  await logAudit({
    userId: reviewerId,
    userRole: 'ADMIN',
    action: 'registration.approved',
    entityType: 'Registration',
    entityId: registrationUserId,
    afterValues: { userId: registrationUserId, role: user.role },
  });

  return { success: true };
}

export async function rejectRegistration(registrationUserId: string, reviewerId: string, reason: string) {
  const reg = await db.registration.findUnique({ where: { userId: registrationUserId } });
  if (!reg) throw new NotFoundError('Registration');

  await db.$transaction([
    db.user.update({ where: { id: registrationUserId }, data: { status: 'REJECTED' } }),
    db.registration.update({
      where: { userId: registrationUserId },
      data: { status: 'rejected', reviewedBy: reviewerId, reviewedAt: new Date(), rejectionReason: reason },
    }),
  ]);

  await logAudit({
    userId: reviewerId,
    userRole: 'ADMIN',
    action: 'registration.rejected',
    entityType: 'Registration',
    entityId: registrationUserId,
    afterValues: { reason },
  });

  return { success: true };
}