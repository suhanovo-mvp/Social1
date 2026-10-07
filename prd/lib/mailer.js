// Mail delivery for reviewer codes. Server-only, no dependencies.
//
// If the project already sends mail (nodemailer, a provider SDK, its own mailer),
// wrap that instead: the review server only needs { send({ to, subject, text }) }.
//
//  - createDevMailer(): keeps letters in memory (and optionally in a folder) and the
//    API exposes them at GET /dev/mail. Local development works without SMTP, and a
//    forgotten dev mailer in production is refused at start-up by prd-server.js.
//  - createSmtpMailer(): plain SMTP with implicit TLS (port 465) or STARTTLS (587)
//    and AUTH LOGIN — enough for Yandex 360, Mail.ru, Unisender Go, SendPulse, Gmail.
import { connect as tcpConnect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export function createDevMailer({ dir = null, keep = 50 } = {}) {
  const letters = [];
  if (dir) mkdirSync(dir, { recursive: true });
  return {
    dev: true,
    letters,
    async send({ to, subject, text }) {
      const letter = { id: randomUUID(), to, subject, text, at: new Date().toISOString() };
      letters.unshift(letter);
      letters.length = Math.min(letters.length, keep);
      if (dir) writeFileSync(join(dir, `${letter.at.replace(/[:.]/g, '-')}.json`), JSON.stringify(letter, null, 2));
      return { id: letter.id };
    },
  };
}

const encodeHeader = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`);
const wrap76 = (s) => s.replace(/.{1,76}/g, '$&\r\n');

export function buildMessage({ from, to, subject, text, domain = 'localhost' }) {
  return [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${randomUUID()}@${domain}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(Buffer.from(text, 'utf8').toString('base64')),
  ].join('\r\n');
}

/**
 * SMTP client. secure: true → TLS from the first byte (465); secure: false with
 * starttls: true (default) → upgrade after EHLO (587). starttls: false only for a
 * local test server — never send passwords over an unencrypted connection.
 */
export function createSmtpMailer({ host, port = 465, secure = port === 465, starttls = true, user, pass, from, timeoutMs = 15000 }) {
  if (!host || !from) throw new Error('SMTP: нужны host и from');
  const address = (s) => (String(s).match(/<([^>]+)>/)?.[1] ?? String(s)).trim();

  async function send({ to, subject, text }) {
    let socket = secure ? tlsConnect({ host, port, servername: host }) : tcpConnect({ host, port });
    socket.setTimeout(timeoutMs);
    let buffer = '';
    let waiting = null;

    // Многострочный ответ заканчивается строкой «NNN текст» (пробел после кода).
    const tryResolve = () => {
      if (!waiting) return;
      const lines = buffer.split('\r\n');
      const done = lines.findIndex((l) => /^\d{3} /.test(l));
      if (done < 0) return;
      buffer = lines.slice(done + 1).join('\r\n');
      const w = waiting; waiting = null;
      w.resolve({ code: Number(lines[done].slice(0, 3)), text: lines.slice(0, done + 1).join('\n') });
    };
    const attach = (s) => {
      s.setEncoding('utf8');
      s.on('data', (chunk) => { buffer += chunk; tryResolve(); });
      s.on('timeout', () => { waiting?.reject(new Error('SMTP: таймаут')); s.destroy(); });
      s.on('error', (e) => waiting?.reject(e));
    };
    const read = () => new Promise((resolve, reject) => { waiting = { resolve, reject }; tryResolve(); });
    const cmd = async (line, expect) => {
      const r = read();
      if (line !== null) socket.write(`${line}\r\n`);
      const reply = await r;
      if (!expect.includes(reply.code)) throw new Error(`SMTP ${line?.split(' ')[0] ?? 'greeting'}: ${reply.text}`);
      return reply;
    };

    attach(socket);
    try {
      await cmd(null, [220]);
      let ehlo = await cmd(`EHLO ${from.split('@').pop().replace(/>.*/, '')}`, [250]);
      if (!secure && starttls) {
        await cmd('STARTTLS', [220]);
        socket.removeAllListeners('data');
        socket = tlsConnect({ socket, servername: host });
        attach(socket);
        await new Promise((resolve, reject) => { socket.once('secureConnect', resolve); socket.once('error', reject); });
        ehlo = await cmd(`EHLO ${from.split('@').pop().replace(/>.*/, '')}`, [250]);
      }
      if (user) {
        await cmd('AUTH LOGIN', [334]);
        await cmd(Buffer.from(user).toString('base64'), [334]);
        await cmd(Buffer.from(pass ?? '').toString('base64'), [235]);
      }
      await cmd(`MAIL FROM:<${address(from)}>`, [250]);
      await cmd(`RCPT TO:<${address(to)}>`, [250, 251]);
      await cmd('DATA', [354]);
      const body = buildMessage({ from, to, subject, text, domain: address(from).split('@')[1] })
        .replace(/\r\n\./g, '\r\n..');
      await cmd(`${body}\r\n.`, [250]);
      await cmd('QUIT', [221]).catch(() => {});
      return { ok: true, ehlo: ehlo.text.split('\n')[0] };
    } finally {
      socket.end();
    }
  }
  return { dev: false, send };
}

/** SMTP from environment: PRD_SMTP_URL=smtps://user:pass@smtp.yandex.ru:465 and PRD_MAIL_FROM. */
export function mailerFromEnv(env = process.env) {
  if (!env.PRD_SMTP_URL) return null;
  const url = new URL(env.PRD_SMTP_URL);
  const secure = url.protocol === 'smtps:';
  return createSmtpMailer({
    host: url.hostname,
    port: Number(url.port) || (secure ? 465 : 587),
    secure,
    user: decodeURIComponent(url.username),
    pass: decodeURIComponent(url.password),
    from: env.PRD_MAIL_FROM ?? decodeURIComponent(url.username),
  });
}
