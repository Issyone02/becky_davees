import bcrypt from 'bcryptjs';

const SALT_ROUNDS = 12;
const MIN_LENGTH = 8;
const HISTORY_COUNT = 5;

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export function validatePasswordStrength(password: string): { valid: boolean; issues: string[] } {
  const issues: string[] = [];
  if (password.length < MIN_LENGTH) issues.push(`Password must be at least ${MIN_LENGTH} characters`);
  if (!/[A-Z]/.test(password)) issues.push('Password must contain at least one uppercase letter');
  if (!/[a-z]/.test(password)) issues.push('Password must contain at least one lowercase letter');
  if (!/[0-9]/.test(password)) issues.push('Password must contain at least one digit');
  const common = ['password', '12345678', 'qwerty12', 'admin123', 'school12'];
  if (common.some(c => password.toLowerCase().includes(c))) {
    issues.push('Password is too common');
  }
  return { valid: issues.length === 0, issues };
}

export async function isPasswordInHistory(
  password: string,
  historyHashes: string[],
): Promise<boolean> {
  for (const h of historyHashes) {
    if (await verifyPassword(password, h)) return true;
  }
  return false;
}

export { HISTORY_COUNT };