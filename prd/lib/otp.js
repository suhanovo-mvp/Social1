// Email one-time codes and signed cookies for reviewers. Server-only (node:crypto).
//
// The code is a signature under a review, not a gate around secret data: it proves
// the reviewer owns the address so their history follows them across devices and
// an admin can see who said what. Still, the usual rules apply, because a weak OTP
// is an open mail relay and a guessable login:
//  - only an HMAC of the code is stored, never the code;
//  - codes expire (10 min) and die after 5 wrong attempts;
//  - re-sending has a cooldown and an hourly cap per address.
import { createHmac, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';

export const OTP_DEFAULTS = { ttlMinutes: 10, maxAttempts: 5, cooldownSeconds: 60, perHour: 5 };

const EMAIL = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]{2,}$/u;

export function normalizeEmail(raw) {
  const email = String(raw ?? '').trim().toLowerCase();
  return email.length <= 254 && EMAIL.test(email) ? email : null;
}

/** Display name: letters, digits, space, «_», «-», «.»; 2–40 chars. */
export function normalizeName(raw, fallback = null) {
  const name = String(raw ?? '').replace(/[^\p{L}\p{N} _.-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
  return name.length >= 2 ? name : fallback;
}

const hmac = (secret, value) => createHmac('sha256', secret).update(value).digest('hex');

/** Stable reviewer id for an address: same person, same id, on every device. */
export const emailReviewerId = (email, secret) => `e_${hmac(secret, `reviewer:${email}`).slice(0, 20)}`;
export const anonReviewerId = () => `a_${randomUUID().replace(/-/g, '').slice(0, 20)}`;

/**
 * Issue a code for an address. `prev` is the stored record for that address (or null).
 * Returns { ok, code, record } or { ok: false, error, retryAfter }.
 */
export function issueCode(email, prev, { secret, now = new Date(), ...opts } = {}) {
  const o = { ...OTP_DEFAULTS, ...opts };
  const t = now.getTime();
  if (prev?.sentAt) {
    const since = (t - Date.parse(prev.sentAt)) / 1000;
    if (since < o.cooldownSeconds) {
      const retryAfter = Math.ceil(o.cooldownSeconds - since);
      return { ok: false, error: `Новый код можно запросить через ${retryAfter} с`, retryAfter };
    }
  }
  const windowStart = prev?.windowStart && t - Date.parse(prev.windowStart) < 3600_000 ? prev.windowStart : now.toISOString();
  const sentCount = windowStart === prev?.windowStart ? (prev.sentCount ?? 0) + 1 : 1;
  if (sentCount > o.perHour) {
    const retryAfter = Math.ceil((Date.parse(windowStart) + 3600_000 - t) / 1000);
    return { ok: false, error: 'Слишком много запросов кода. Попробуйте через час', retryAfter };
  }
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  return {
    ok: true,
    code,
    record: {
      email,
      codeHash: hmac(secret, `${email}:${code}`),
      expiresAt: new Date(t + o.ttlMinutes * 60_000).toISOString(),
      attempts: 0,
      sentAt: now.toISOString(),
      sentCount,
      windowStart,
    },
  };
}

/** Check a code. Returns { ok } or { ok: false, error, record } with attempts counted. */
export function checkCode(record, rawCode, { secret, now = new Date(), maxAttempts = OTP_DEFAULTS.maxAttempts } = {}) {
  const code = String(rawCode ?? '').replace(/\D/g, '');
  if (!record) return { ok: false, error: 'Сначала запросите код' };
  if (Date.parse(record.expiresAt) < now.getTime()) return { ok: false, error: 'Срок действия кода истёк — запросите новый', expired: true };
  if ((record.attempts ?? 0) >= maxAttempts) return { ok: false, error: 'Слишком много неверных попыток — запросите новый код', locked: true };
  const expected = Buffer.from(record.codeHash, 'hex');
  const actual = Buffer.from(hmac(secret, `${record.email}:${code}`), 'hex');
  if (code.length === 6 && expected.length === actual.length && timingSafeEqual(expected, actual)) return { ok: true };
  const attempts = (record.attempts ?? 0) + 1;
  const left = maxAttempts - attempts;
  return {
    ok: false,
    error: left > 0 ? `Неверный код. Осталось попыток: ${left}` : 'Слишком много неверных попыток — запросите новый код',
    record: { ...record, attempts },
  };
}

// ── Signed cookie values ─────────────────────────────────────
const b64url = (buf) => Buffer.from(buf).toString('base64url');

export function signToken(payload, secret, ttlDays = 30) {
  const body = b64url(JSON.stringify({ ...payload, exp: Date.now() + ttlDays * 86400_000 }));
  return `${body}.${hmac(secret, body).slice(0, 43)}`;
}

export function readToken(token, secret) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expected = hmac(secret, body).slice(0, 43);
  if (!sig || sig.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return payload.exp && payload.exp > Date.now() ? payload : null;
  } catch {
    return null;
  }
}

export function codeEmail({ product, code, ttlMinutes = OTP_DEFAULTS.ttlMinutes }) {
  const subject = `Код для рецензирования: ${code}`;
  const text = [
    `Ваш код для рецензирования требований «${product}»: ${code}`,
    '',
    `Код действует ${ttlMinutes} минут. Введите его на странице рецензирования.`,
    'Если вы не запрашивали код, просто проигнорируйте это письмо.',
  ].join('\n');
  return { subject, text };
}
