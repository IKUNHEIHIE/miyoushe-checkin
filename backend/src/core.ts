import { argon2, createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { components } from './api-types.js';

export type Api = components['schemas'];
export type Account = Api['Account'];
export type Run = Api['Run'];
export type Device = { id: string; fp?: string };
export type Credentials = { aid: string; mid: string; stoken: string; ltoken: string; cookieToken: string; cookieExpiresAt: string | null };
export type Config = { databasePath: string; key: Buffer; bootstrapToken: string; origins: string[]; secureCookie: boolean; timeoutMs: number; host: string; port: number };
export const id = randomUUID;
export const iso = (ms = Date.now()) => new Date(ms).toISOString();
export const day = (ms = Date.now()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms);
export const hash = (s: string) => createHash('sha256').update(s).digest('hex');
export const maskPhone = (s: string) => s.slice(0, 3) + '****' + s.slice(-4);
export const emptyPage = <T>(items: T[], nextCursor: string | null = null) => ({ items, page: { nextCursor, hasMore: nextCursor !== null } });
export function constantEqual(a: string, b: string) { const x = Buffer.from(a); const y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); }
export class Fault extends Error {
  constructor(public status: number, public code: Api['Error']['code'], message: string, public retryable = false, public details?: Api['ErrorDetails']) { super(message); }
  view(): Api['Error'] { return { code: this.code, message: this.message, retryable: this.retryable, ...(this.details ? { details: this.details } : {}) }; }
}
export function fault(e: unknown): Fault { return e instanceof Fault ? e : new Fault(500, 'INTERNAL_ERROR', '操作暂时无法完成，请稍后重试'); }
export function configFromEnv(): Config {
  const raw = process.env.DATA_ENCRYPTION_KEY ?? '';
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32 || key.toString('base64') !== raw) throw Error('DATA_ENCRYPTION_KEY must be exactly 32 random bytes encoded as base64');
  const bootstrapToken = process.env.BOOTSTRAP_TOKEN ?? '';
  if (bootstrapToken.length < 32) throw Error('BOOTSTRAP_TOKEN must have at least 32 random characters');
  const origins = (process.env.ALLOWED_ORIGINS ?? '').split(',').map(s => s.trim()).filter(Boolean);
  if (!origins.length || origins.some(s => { try { return new URL(s).origin !== s; } catch { return true; } })) throw Error('ALLOWED_ORIGINS must contain exact http(s) origins');
  if (origins.some(s => !/^https?:\/\//.test(s))) throw Error('Invalid origin scheme');
  const secureCookie = process.env.COOKIE_SECURE === 'true';
  if (process.env.NODE_ENV === 'production' && !secureCookie) throw Error('Production requires COOKIE_SECURE=true');
  const databasePath = resolve(process.env.DATABASE_PATH ?? './data/miyoushe.sqlite');
  mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
  const port = Number(process.env.PORT ?? 3000), timeoutMs = Number(process.env.UPSTREAM_TIMEOUT_MS ?? 15000);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60000) throw Error('Invalid PORT or UPSTREAM_TIMEOUT_MS');
  return { databasePath, key, bootstrapToken, origins, secureCookie, timeoutMs, host: process.env.HOST ?? '127.0.0.1', port };
}
export class Vault {
  constructor(private key: Buffer, private instance: string) {}
  mac(purpose: string, text: string) { return createHmac('sha256', this.key).update(purpose + '\0' + text).digest('hex'); }
  seal(value: unknown, purpose: string) {
    const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    cipher.setAAD(Buffer.from(this.instance + '\0' + purpose));
    const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return JSON.stringify({ keyId: 'primary', nonce: nonce.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') });
  }
  open<T>(encrypted: string, purpose: string): T {
    const x = JSON.parse(encrypted) as { nonce: string; tag: string; data: string };
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(x.nonce, 'base64'));
    decipher.setAAD(Buffer.from(this.instance + '\0' + purpose)); decipher.setAuthTag(Buffer.from(x.tag, 'base64'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(x.data, 'base64')), decipher.final()]).toString('utf8')) as T;
  }
}
function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => argon2('argon2id', { message: password, nonce: salt, parallelism: 1, tagLength: 32, memory: 65536, passes: 3 }, (err, key) => err ? reject(err) : resolve(key)));
}
export async function passwordHash(password: string) { const salt = randomBytes(16); return `argon2id$65536$3$1$${salt.toString('base64')}$${(await derive(password, salt)).toString('base64')}`; }
export async function passwordMatches(password: string, stored: string) { const parts = stored.split('$'); if (parts.length !== 6 || parts[0] !== 'argon2id') return false; return constantEqual((await derive(password, Buffer.from(parts[4]!, 'base64'))).toString('base64'), parts[5]!); }
export function nextSchedule(hour: number, minute: number, now = Date.now()) {
  let target = Date.parse(`${day(now)}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+08:00`);
  if (target <= now) target += 86400000;
  return iso(target);
}
