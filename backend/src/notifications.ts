import nodemailer from 'nodemailer';
import { Fault, fault, id, iso } from './core.js';
import type { Api } from './core.js';
import { Storage } from './storage.js';

type MailJob = { id: string; state: 'queued' | 'sending' | 'succeeded' | 'failed'; subject: string; text: string; attempts: number; nextAttempt: number; testId?: string };
export type MailSender = (config: Api['NotificationSettings'], password: string, subject: string, text: string, messageId: string) => Promise<void>;
const smtpSender: MailSender = async (config, password, subject, text, messageId) => {
  const transport = nodemailer.createTransport({ host: config.smtpHost, port: config.smtpPort, secure: config.smtpSecurity === 'ssl', requireTLS: config.smtpSecurity === 'starttls', auth: { user: config.smtpUsername, pass: password }, connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 20000, logger: false, debug: false, disableFileAccess: true, disableUrlAccess: true });
  try { await transport.sendMail({ from: config.fromAddress, to: config.toAddress, subject, text, messageId: `<${messageId}@miyoushe.local>`, disableFileAccess: true, disableUrlAccess: true }); } finally { transport.close(); }
};
export class Notifications {
  constructor(private store: Storage, private sender: MailSender = smtpSender) {
    for (const job of store.all<MailJob>('outbox')) if (job.state === 'sending') { job.state = 'queued'; store.put('outbox', job.id, job); }
  }
  settings(): Api['NotificationSettings'] {
    return this.store.get('settings', 'notifications') ?? { enabled: false, policy: 'failures_and_actions', smtpHost: '', smtpPort: 465, smtpSecurity: 'ssl', smtpUsername: '', smtpPasswordConfigured: false, fromAddress: '', toAddress: '', version: 1 };
  }
  patch(input: Api['NotificationSettingsPatch']) {
    return this.store.tx(() => {
      const s = this.settings(); if (s.version !== input.version) throw new Fault(409, 'VERSION_CONFLICT', '通知设置已更新');
      if ((input.clearPassword && input.smtpPassword != null) || input.smtpPassword === '') throw new Fault(400, 'VALIDATION_ERROR', '保留、替换、清除密码只能选择一种方式');
      const { smtpPassword, clearPassword, ...publicInput } = input;
      Object.assign(s, publicInput, { version: s.version + 1 });
      if (clearPassword) { this.store.remove('secret', 'smtp'); s.smtpPasswordConfigured = false; }
      if (smtpPassword) { this.store.put('secret', 'smtp', this.store.vault.seal(smtpPassword, 'notification:smtp')); s.smtpPasswordConfigured = true; }
      if (/[\r\n]/.test(s.smtpHost + s.smtpUsername + s.fromAddress + s.toAddress)) throw new Fault(400, 'VALIDATION_ERROR', '通知配置含无效字符');
      if (s.enabled && !this.complete(s)) throw new Fault(400, 'VALIDATION_ERROR', '请先补齐邮件服务器和收件地址');
      this.store.put('settings', 'notifications', s); return s;
    });
  }
  private complete(s: Api['NotificationSettings']) { return !!(s.smtpHost && s.smtpUsername && s.smtpPasswordConfigured && s.fromAddress && s.toAddress); }
  queue(eventKey: string, subject: string, text: string, success = false) {
    const s = this.settings(); if (!s.enabled || !this.complete(s) || (success && s.policy !== 'every_run') || this.store.get('outbox', eventKey)) return;
    this.store.put('outbox', eventKey, { id: eventKey, state: 'queued', subject, text, attempts: 0, nextAttempt: Date.now() } satisfies MailJob);
  }
  test() {
    const s = this.settings(); if (!this.complete(s)) throw new Fault(409, 'NOTIFICATION_NOT_CONFIGURED', '请先保存完整的邮件通知配置');
    this.store.limit('notification-test', 1, 60000);
    const view: Api['NotificationTest'] = { id: id(), state: 'queued', error: null, createdAt: iso(), updatedAt: iso() };
    this.store.put('notification_test', view.id, view);
    this.store.put('outbox', 'test:' + view.id, { id: 'test:' + view.id, testId: view.id, state: 'queued', subject: '米游社面板测试通知', text: '这是一封由你主动触发的通知配置测试邮件。', attempts: 0, nextAttempt: Date.now() } satisfies MailJob); return view;
  }
  getTest(testId: string) { const t = this.store.get<Api['NotificationTest']>('notification_test', testId); if (!t) throw new Fault(404, 'NOT_FOUND', '测试记录不存在'); return t; }
  async tick() {
    for (const job of this.store.all<MailJob>('outbox').filter(j => j.state === 'queued' && j.nextAttempt <= Date.now()).slice(0, 2)) {
      job.state = 'sending'; this.store.put('outbox', job.id, job);
      const test = job.testId ? this.getTest(job.testId) : undefined;
      if (test) { test.state = 'sending'; this.store.put('notification_test', test.id, test); }
      try {
        const config = this.settings(), secret = this.store.get<string>('secret', 'smtp');
        if (!secret || !this.complete(config)) throw new Fault(409, 'NOTIFICATION_NOT_CONFIGURED', '邮件配置不完整');
        if (!job.testId && !config.enabled) { job.state = 'failed'; this.store.put('outbox', job.id, job); continue; }
        await this.sender(config, this.store.vault.open<string>(secret, 'notification:smtp'), job.subject, job.text, job.id.replace(/[^a-zA-Z0-9-]/g, '-'));
        job.state = 'succeeded'; if (test) test.state = 'succeeded';
      } catch {
        job.attempts++; job.state = job.attempts >= 3 || !!job.testId ? 'failed' : 'queued'; job.nextAttempt = Date.now() + 60000 * job.attempts;
        if (test) { test.state = 'failed'; test.error = new Fault(502, 'UPSTREAM_ERROR', '测试邮件未发送成功，请检查服务器配置').view(); }
      }
      this.store.put('outbox', job.id, job); if (test) { test.updatedAt = iso(); this.store.put('notification_test', test.id, test); }
    }
  }
}
