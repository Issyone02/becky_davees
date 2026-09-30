import { env } from '../../config/env';

interface AttemptRecord {
  failures: number[];
  lockedUntil: number | null;
}

const store = new Map<string, AttemptRecord>();

// Environment-aware thresholds
const MAX_FAILURES = parseInt(process.env.LOGIN_MAX_FAILURES ?? '5', 10);
const WINDOW_MS = parseInt(process.env.LOGIN_WINDOW_MINUTES ?? '15', 10) * 60 * 1000;
const LOCK_MS = parseInt(process.env.LOGIN_LOCK_MINUTES ?? '15', 10) * 60 * 1000;

// Cleanup: remove stale records every 30 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, rec] of store.entries()) {
    if (rec.lockedUntil && rec.lockedUntil < now) {
      store.delete(key);
    } else if (!rec.lockedUntil && rec.failures.every((t) => now - t >= WINDOW_MS)) {
      store.delete(key);
    }
  }
}, 30 * 60 * 1000);

function getRecord(key: string): AttemptRecord {
  let rec = store.get(key);
  if (!rec) {
    rec = { failures: [], lockedUntil: null };
    store.set(key, rec);
  }
  return rec;
}

export function checkLockout(identifier: string): { locked: boolean; retryAfterMs: number } {
  const rec = getRecord(identifier.toLowerCase().trim());
  if (rec.lockedUntil && rec.lockedUntil > Date.now()) {
    return { locked: true, retryAfterMs: rec.lockedUntil - Date.now() };
  }
  if (rec.lockedUntil && rec.lockedUntil <= Date.now()) {
    rec.lockedUntil = null;
    rec.failures = [];
  }
  return { locked: false, retryAfterMs: 0 };
}

export function recordFailure(identifier: string): void {
  const key = identifier.toLowerCase().trim();
  const rec = getRecord(key);
  const now = Date.now();
  rec.failures.push(now);
  rec.failures = rec.failures.filter((t) => now - t < WINDOW_MS);
  if (rec.failures.length >= MAX_FAILURES) {
    rec.lockedUntil = now + LOCK_MS;
    rec.failures = [];
  }
}

export function recordSuccess(identifier: string): void {
  store.delete(identifier.toLowerCase().trim());
}

/** Admin action: forcibly unlock an account (for demo mishaps or support) */
export function forceUnlock(identifier: string): boolean {
  const key = identifier.toLowerCase().trim();
  const rec = store.get(key);
  if (rec) {
    store.delete(key);
    return true;
  }
  return false;
}

/** Clear all lockouts (dev convenience) */
export function clearAllLocks(): void {
  store.clear();
}