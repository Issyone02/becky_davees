import { Router } from 'express';
import multer from 'multer';
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { authenticate } from '../../core/auth/auth.middleware';
import { success } from '../../shared/response';
import { db } from '../../config/db';

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const BUCKET = 'school-uploads';
const MAX_BYTES = (Number(process.env.MAX_FILE_SIZE_MB) || 5) * 1024 * 1024;

const supabase =
  SUPABASE_URL && SUPABASE_SERVICE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } })
    : null;

// Guard 1: extension allow-list
const ALLOWED_EXT = ['jpg', 'jpeg', 'png', 'webp'];

// Guard 2: magic-byte sniffing — the file's own bytes decide the truth
function sniff(buf: Buffer): string | null {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

function extFor(mime: string): string {
  return mime === 'image/jpeg' ? 'jpg' : mime === 'image/png' ? 'png' : 'webp';
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES } });

const router = Router();

router.post('/', authenticate, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: { code: 'NO_FILE', message: 'No file uploaded' } });
    }
    if (!supabase) {
      return res.status(500).json({ success: false, error: { code: 'STORAGE_NOT_CONFIGURED', message: 'Supabase storage env vars missing' } });
    }

    const buf = req.file.buffer;

    // Guard 3: server-side size cap
    if (buf.length > MAX_BYTES) {
      return res.status(413).json({ success: false, error: { code: 'TOO_LARGE', message: 'File exceeds size limit' } });
    }

    // Guard 1: extension allow-list from the original name
    const originalExt = (req.file.originalname.split('.').pop() || '').toLowerCase();
    if (!ALLOWED_EXT.includes(originalExt)) {
      return res.status(400).json({ success: false, error: { code: 'BAD_EXTENSION', message: 'Only .jpg, .jpeg, .png, .webp are allowed.' } });
    }

    // Guard 2: bytes must prove it is a real image (kills MIME spoofing)
    const sniffed = sniff(buf);
    if (!sniffed) {
      return res.status(400).json({ success: false, error: { code: 'BAD_CONTENT', message: 'File content is not a real JPEG, PNG or WEBP image.' } });
    }

    // Guards 4 + 5: server-generated random name and forced content-type
    const key = `${crypto.randomUUID()}.${extFor(sniffed)}`;

    const { error } = await supabase.storage.from(BUCKET).upload(key, buf, {
      contentType: sniffed,
      upsert: false,
    });
    if (error) {
      return res.status(500).json({ success: false, error: { code: 'STORAGE_UPLOAD_FAILED', message: error.message } });
    }

    const url = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${key}`;

    // Guard 7: immutable audit trail
    await db.auditLog
      .create({
        data: {
          userId: req.user!.id,
          userRole: (req.user as any)?.role ?? null,
          action: 'upload.create',
          entityType: 'storage',
          entityId: key,
          afterValues: JSON.stringify({ bucket: BUCKET, bytes: buf.length, mime: sniffed }),
          ipAddress: req.ip ?? null,
          userAgent: (req.headers['user-agent'] as string) ?? null,
        },
      })
      .catch(() => undefined);

    success(res, { url }, 201);
  } catch (e: any) {
    if (e?.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ success: false, error: { code: 'TOO_LARGE', message: 'File exceeds size limit' } });
    }
    return res.status(500).json({ success: false, error: { code: 'UPLOAD_ERROR', message: e?.message ?? 'Upload failed' } });
  }
});

export default router;