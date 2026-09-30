import searchRoutes from './modules/search/search.routes';
import timetableRoutes from './modules/timetable/timetable.routes';
import financeRoutes from './modules/finance/finance.routes';
import path from 'path';
import uploadsRoutes from './modules/uploads/uploads.routes';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import { env } from './config/env';
import authRoutes from './core/auth/auth.routes';
import userRoutes from './modules/users/user.routes';
import academicRoutes from './modules/academic/academic.routes';
import studentRoutes from './modules/students/student.routes';
import teacherRoutes from './modules/teachers/teacher.routes';
import registrationRoutes from './modules/registrations/registration.routes';
import dashboardRoutes from './modules/dashboard/dashboard.routes';
import attendanceRoutes from './modules/attendance/attendance.routes';
import resultsRoutes from './modules/results/results.routes';
import settingsRoutes from './modules/settings/settings.routes';
import { handleError } from './shared/errors';
import commsRoutes from './modules/communications/communication.routes';
import notificationRoutes from './modules/communications/notification.routes';
import usersRoutes from './modules/users/users.routes';
import auditRoutes from './modules/audit/audit.routes';
import parentRoutes from './modules/parent/parent.routes';
import parentsRoutes from './modules/parents/parent.routes';
import feedbackRoutes from './modules/feedback/feedback.routes';
import messagingRoutes from './modules/messaging/messaging.routes';
import promotionsRoutes from './modules/promotions/promotions.routes';

  

export function createApp() {
  const app = express();

  app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  }));

  app.use(cors({ origin: env.CORS_ORIGIN, credentials: true }));
  app.use(morgan('combined'));
  app.use(express.json({ limit: '2mb' }));
  app.use(cookieParser());
    app.use('/uploads', express.static(path.resolve(process.cwd(), process.env.UPLOAD_DIR || './uploads')));

  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: env.NODE_ENV === 'production' ? 300 : 10000,
    standardHeaders: true,
    legacyHeaders: false,
  });
  // Trust first proxy (required for rate limiters behind Render/Vercel/nginx)
  app.set('trust proxy', 1);
  app.use('/api/', limiter);

  app.get('/health', (_req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

  app.use('/api/auth', authRoutes);
  app.use('/api/users', userRoutes);
  app.use('/api/academic', academicRoutes);
  app.use('/api/students', studentRoutes);
  app.use('/api/teachers', teacherRoutes);
  app.use('/api/parents', parentsRoutes);
  app.use('/api/parents', parentRoutes);
  app.use('/api/registrations', registrationRoutes);
  app.use('/api/dashboard', dashboardRoutes);
  app.use('/api/attendance', attendanceRoutes);
  app.use('/api/results', resultsRoutes);
  app.use('/api/settings', settingsRoutes);
  app.use('/api/uploads', uploadsRoutes);
  app.use('/api/finance', financeRoutes);
  app.use('/api/timetable', timetableRoutes);
  app.use('/api/comms', commsRoutes);
  app.use('/api/notifications', notificationRoutes);
  app.use('/api/users', usersRoutes);
  app.use('/api/audit', auditRoutes);
  app.use('/api/parent', parentRoutes);
  app.use('/api/search', searchRoutes);
  app.use('/api/feedback', feedbackRoutes);
  app.use('/api/messaging', messagingRoutes);
  app.use('/api/promotions', promotionsRoutes);

  app.use((_req, res) => res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Endpoint not found' } }));

  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const { statusCode, body } = handleError(err);
    res.status(statusCode).json(body);
  });

  return app;
}