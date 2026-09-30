import { env } from './env';

interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

const memoryStore = new Map<string, CacheEntry>();

function sweep() {
  const now = Date.now();
  for (const [k, v] of memoryStore.entries()) {
    if (v.expiresAt < now) memoryStore.delete(k);
  }
}

setInterval(sweep, 60_000);

export const cache = {
  async get<T>(key: string): Promise<T | null> {
    if (!env.REDIS_URL) {
      const entry = memoryStore.get(key);
      if (!entry || entry.expiresAt < Date.now()) return null;
      return entry.value as T;
    }
    // Redis implementation can be added here
    return null;
  },
  async set(key: string, value: unknown, ttlSeconds = 300): Promise<void> {
    if (!env.REDIS_URL) {
      memoryStore.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
      return;
    }
  },
  async del(key: string): Promise<void> {
    if (!env.REDIS_URL) {
      memoryStore.delete(key);
      return;
    }
  },
};