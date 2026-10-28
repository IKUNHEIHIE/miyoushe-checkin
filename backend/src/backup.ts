import { resolve } from 'node:path';
import { existsSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { configFromEnv } from './core.js';
import { DatabaseSync, backup } from 'node:sqlite';
import { Vault } from './core.js';

const target = process.argv[2];
if (!target) throw Error('Usage: npm run backup -- /absolute/path/to/new-backup.sqlite');
const output = resolve(target), config = configFromEnv();
if (output === config.databasePath || existsSync(output)) throw Error('Backup target must be a new file, different from the active database');
mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
const db = new DatabaseSync(config.databasePath, { readOnly: true });
try {
  const instance = db.prepare("SELECT value FROM meta WHERE key='instance'").get() as { value: string };
  const keycheck = db.prepare("SELECT value FROM meta WHERE key='keycheck'").get() as { value: string };
  new Vault(config.key, instance.value).open(keycheck.value, 'keycheck');
  await backup(db, output); chmodSync(output, 0o600); console.log('Encrypted database backup completed. Preserve the encryption key separately.');
} finally { db.close(); }
