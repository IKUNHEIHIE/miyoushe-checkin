import { DatabaseSync, backup } from 'node:sqlite';
import { chmodSync, openSync, closeSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { Fault, Vault, id, iso } from './core.js';
import type { Config } from './core.js';

export class Storage {
  readonly db: DatabaseSync;
  readonly vault: Vault;
  readonly instance: string;
  private lockPath?: string;
  constructor(config: Config) {
    if (config.databasePath !== ':memory:') {
      const path = config.databasePath + '.lock';
      try { const fd = openSync(path, 'wx', 0o600); writeFileSync(fd, JSON.stringify({ pid: process.pid, databasePath: config.databasePath })); closeSync(fd); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const old = JSON.parse(readFileSync(path, 'utf8')) as { pid: number; databasePath: string };
        if (old.databasePath !== config.databasePath || !Number.isInteger(old.pid) || old.pid < 1) throw Error('Unrecognized database lock; refusing to remove it');
        try { process.kill(old.pid, 0); throw Error('Another backend instance holds this database'); }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e; }
        unlinkSync(path); const fd = openSync(path, 'wx', 0o600); writeFileSync(fd, JSON.stringify({ pid: process.pid, databasePath: config.databasePath })); closeSync(fd);
      }
      this.lockPath = path;
    }
    try { this.db = new DatabaseSync(config.databasePath); }
    catch (e) { if (this.lockPath) unlinkSync(this.lockPath); throw e; }
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS administrators(id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, singleton INTEGER UNIQUE NOT NULL DEFAULT 1 CHECK(singleton=1));
      CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY, admin_id TEXT NOT NULL REFERENCES administrators(id), expires_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY, aid TEXT UNIQUE NOT NULL, public_json TEXT NOT NULL, private_json TEXT NOT NULL, credential_version INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS documents(kind TEXT NOT NULL,id TEXT NOT NULL,json TEXT NOT NULL,created_at TEXT NOT NULL, PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS daily_claims(account_id TEXT NOT NULL,business_date TEXT NOT NULL,community_id INTEGER NOT NULL,task_kind TEXT NOT NULL,state TEXT NOT NULL,run_id TEXT NOT NULL,PRIMARY KEY(account_id,business_date,community_id,task_kind));
      CREATE TABLE IF NOT EXISTS rate_limits(key TEXT PRIMARY KEY,count INTEGER NOT NULL,expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS idempotency(key TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,response TEXT,expires_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS documents_kind_created ON documents(kind,created_at DESC,id DESC);
      INSERT OR IGNORE INTO schema_migrations VALUES(1,strftime('%Y-%m-%dT%H:%M:%fZ','now'));`);
    try { if (config.databasePath !== ':memory:') chmodSync(config.databasePath, 0o600); } catch { /* Windows ACLs are managed by the deployment owner. */ }
    const instance = this.db.prepare('SELECT value FROM meta WHERE key=?').get('instance') as { value: string } | undefined;
    this.instance = instance?.value ?? id();
    this.db.prepare('INSERT OR IGNORE INTO meta VALUES(?,?)').run('instance', this.instance);
    this.vault = new Vault(config.key, this.instance);
    const check = this.db.prepare('SELECT value FROM meta WHERE key=?').get('keycheck') as { value: string } | undefined;
    if (check) { try { this.vault.open(check.value, 'keycheck'); } catch { this.close(); throw Error('Encryption key does not match existing data; refusing to start'); } }
    else this.db.prepare('INSERT INTO meta VALUES(?,?)').run('keycheck', this.vault.seal('verified', 'keycheck'));
  }
  tx<T>(fn: () => T): T { this.db.exec('BEGIN IMMEDIATE'); try { const value = fn(); this.db.exec('COMMIT'); return value; } catch (e) { this.db.exec('ROLLBACK'); throw e; } }
  get<T>(kind: string, key: string): T | undefined { const row = this.db.prepare('SELECT json FROM documents WHERE kind=? AND id=?').get(kind, key) as { json: string } | undefined; return row ? JSON.parse(row.json) as T : undefined; }
  put<T>(kind: string, key: string, value: T) { this.db.prepare('INSERT INTO documents(kind,id,json,created_at) VALUES(?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET json=excluded.json').run(kind, key, JSON.stringify(value), iso()); }
  remove(kind: string, key: string) { this.db.prepare('DELETE FROM documents WHERE kind=? AND id=?').run(kind, key); }
  all<T>(kind: string): T[] { return (this.db.prepare('SELECT json FROM documents WHERE kind=? ORDER BY created_at DESC,id DESC').all(kind) as { json: string }[]).map(r => JSON.parse(r.json) as T); }
  limit(key: string, maximum: number, windowMs: number) {
    this.tx(() => {
      const now = Date.now(), hashed = this.vault.mac('rate', key);
      const row = this.db.prepare('SELECT count,expires_at FROM rate_limits WHERE key=?').get(hashed) as { count: number; expires_at: number } | undefined;
      if (row && row.expires_at > now && row.count >= maximum) throw new Fault(429, 'RATE_LIMITED', '操作过于频繁，请稍后再试', true, { retryAfterSeconds: Math.ceil((row.expires_at - now) / 1000) });
      this.db.prepare('INSERT INTO rate_limits VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET count=excluded.count,expires_at=excluded.expires_at').run(hashed, row && row.expires_at > now ? row.count + 1 : 1, row && row.expires_at > now ? row.expires_at : now + windowMs);
    });
  }
  async backup(path: string) { await backup(this.db, path); }
  close() { this.db.close(); if (this.lockPath) { unlinkSync(this.lockPath); this.lockPath = undefined; } }
}
