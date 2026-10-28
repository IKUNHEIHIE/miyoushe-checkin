// Formatting, clock, and idempotency utilities

export function getNowMs(): number { return Date.now(); }

export function getNowIso(): string {
  return new Date(getNowMs()).toISOString();
}

export function formatShanghaiDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    }).format(new Date(ms));
  } catch {
    return iso;
  }
}

export function getRemainingSeconds(targetIso: string | null | undefined, nowMs = getNowMs()): number {
  if (!targetIso) return 0;
  const targetMs = Date.parse(targetIso);
  if (Number.isNaN(targetMs)) return 0;
  return Math.max(0, Math.ceil((targetMs - nowMs) / 1000));
}

export function formatRemainingDuration(targetIso: string | null | undefined, nowMs = getNowMs()): string {
  if (!targetIso) return '未知';
  const seconds = getRemainingSeconds(targetIso, nowMs);
  if (seconds <= 0) return '已到期';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    const remHours = hours % 24;
    return `约 ${days} 天 ${remHours} 小时`;
  }
  if (hours > 0) {
    return `约 ${hours} 小时 ${minutes} 分钟`;
  }
  if (minutes > 0) {
    return `${minutes} 分 ${secs} 秒`;
  }
  return `${secs} 秒`;
}

export function generateIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback RFC4122 v4 UUID
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export function isValidCnPhone(phone: string): boolean {
  return /^1[3-9][0-9]{9}$/.test(phone);
}

export function isValidSmsCode(code: string): boolean {
  return /^[0-9]{6}$/.test(code);
}

export function maskPhoneForDisplay(phone: string): string {
  if (!/^1[3-9][0-9]{9}$/.test(phone)) return '139****0000';
  return `${phone.slice(0, 3)}****${phone.slice(7)}`;
}

export function formatPadTwo(n: number): string {
  return String(n).padStart(2, '0');
}
