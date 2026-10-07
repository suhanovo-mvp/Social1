// PRD review API — framework-agnostic. Server-only.
//
// createPrdApi() returns { handle(req) } where req is a plain object
//   { method, path, query: URLSearchParams, body, cookies, headers, ip }
// and the result is { status, headers, body, cookies }. Two adapters at the bottom
// mount it in node:http / Express / Connect (nodeAdapter) and in anything that speaks
// the Fetch API — Next.js route handlers, Hono, Bun, Deno (fetchAdapter).
//
// The page (review-ui.js), the in-prototype panel and the exports all go through
// this API, so access rules live in one place. See references/review.md for the
// contract and references/integration-recipes.md for wiring per stack.
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import {
  indexPrd, statusMap, aggregateReviews, personalQueue, campaignKeys, campaignProgress,
  normalizeFilter, selectEntries, reportRows, toCsv, describeFilter, filterSlug,
  REASONS, RESOLUTIONS, validatePrd,
} from './prd-core.js';
import {
  normalizeEmail, normalizeName, issueCode, checkCode, signToken, readToken,
  emailReviewerId, anonReviewerId, codeEmail, OTP_DEFAULTS,
} from './otp.js';

export const SESSION_COOKIE = 'prd_reviewer';
export const ACCESS_COOKIE = 'prd_access';

const val = async (v) => (typeof v === 'function' ? v() : v);

/**
 * A JSON file as a value source: re-read only when its mtime changes, so
 * `tests: watchJson('prd/test-results.json')` picks up a new test run without a
 * restart and without re-indexing the model on every request.
 */
export function watchJson(file, fallback = null) {
  let mtime = -1, value = fallback;
  return () => {
    if (!existsSync(file)) return fallback;
    const m = statSync(file).mtimeMs;
    if (m !== mtime) {
      try { value = JSON.parse(readFileSync(file, 'utf8')); mtime = m; } catch { /* файл пишется — вернём прежнее */ }
    }
    return value;
  };
}

/** Server config from environment variables (see references/integration-recipes.md). */
export function configFromEnv(env = process.env) {
  const list = (v) => String(v ?? '').split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);
  const invite = list(env.PRD_INVITE);
  return {
    secret: env.PRD_SECRET,
    admins: list(env.PRD_ADMINS),
    access: ['public', 'link', 'invite'].includes(env.PRD_ACCESS) ? env.PRD_ACCESS : 'public',
    linkToken: env.PRD_LINK_TOKEN || null,
    allowAnonymous: env.PRD_ALLOW_ANON !== '0' && env.PRD_ALLOW_ANON !== 'false',
    invite: { emails: invite.filter((x) => x.includes('@') && !x.startsWith('@')), domains: invite.filter((x) => !x.includes('@') || x.startsWith('@')) },
    disputeFrom: env.PRD_DISPUTE_FROM === 'any' ? 'any' : 'email',
    trustProxy: env.PRD_TRUST_PROXY === '1',
  };
}

export function createPrdApi(options) {
  const {
    prd, tests = null, lock = null, releases = null,
    store, mailer = null, exporters = {}, config: cfg = {}, now = () => new Date(),
  } = options;
  const production = cfg.production ?? process.env.NODE_ENV === 'production';
  const config = {
    access: 'public',            // public | link | invite
    linkToken: null,             // for access: 'link' — the secret part of the shared URL (?k=…)
    allowAnonymous: true,        // anonymous reviewing (never in invite mode)
    invite: { emails: [], domains: [] },
    admins: [],                  // admin emails; admins sign in with the same email code
    disputeFrom: 'email',        // whose disagreement makes a criterion "оспорено": email | any
    secureCookies: production,
    cookiePath: '/',
    trustProxy: false,
    otp: {},
    ...cfg,
    production,
  };
  if (!config.secret || String(config.secret).length < 16) {
    throw new Error('PRD review: нужен config.secret длиной от 16 символов (PRD_SECRET) — им подписываются cookie и коды');
  }
  if (!store) throw new Error('PRD review: не передано хранилище (store)');
  if (production && mailer?.dev) {
    throw new Error('PRD review: в production нужна настоящая почта (PRD_SMTP_URL) — dev-почта показывает коды всем');
  }
  if (config.access === 'link' && !config.linkToken) throw new Error('PRD review: access=link требует linkToken');
  // Без почты сервер работает (просмотр и анонимные оценки), но об этом надо сказать
  // при старте, а не тогда, когда первый рецензент получит «Почта не настроена».
  if (!mailer) console.warn('[prd-review] почта не настроена (PRD_SMTP_URL): вход по коду из письма недоступен');
  const otpOpts = { ...OTP_DEFAULTS, ...config.otp };
  const admins = new Set((config.admins ?? []).map(normalizeEmail).filter(Boolean));
  const inviteEmails = new Set((config.invite?.emails ?? []).map(normalizeEmail).filter(Boolean));
  const inviteDomains = new Set((config.invite?.domains ?? []).map((d) => String(d).toLowerCase().replace(/^@/, '')));
  const anonymousAllowed = config.allowAnonymous && config.access !== 'invite';

  let ready = null;
  const init = () => (ready ??= store.init());

  // ── Model cache: index and statuses are recomputed only when the inputs change ──
  let cache = {};
  async function model() {
    const [p, t, l, r] = await Promise.all([val(prd), val(tests), val(lock), val(releases)]);
    if (p !== cache.prd || t !== cache.tests) {
      const problems = validatePrd(p).filter((x) => x.level === 'error');
      if (problems.length) {
        throw new Error(`PRD review: модель PRD содержит ошибки — запустите scripts/validate-prd.mjs.\n${problems.slice(0, 5).map((x) => `${x.id}: ${x.msg}`).join('\n')}`);
      }
      const index = indexPrd(p);
      cache = { prd: p, tests: t, index, statusOf: statusMap(index, t) };
    }
    return { ...cache, lock: l, releases: r };
  }

  // ── Responses ─────────────────────────────────────────────
  const cookie = (name, value, maxAgeSec) => [
    `${name}=${value}`, `Path=${config.cookiePath}`, 'HttpOnly', 'SameSite=Lax',
    `Max-Age=${maxAgeSec}`, config.secureCookies ? 'Secure' : null,
  ].filter(Boolean).join('; ');
  const json = (status, body, cookies = []) => ({
    status, cookies,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store' },
    body: JSON.stringify(body),
  });
  const fail = (status, error, extra = {}) => json(status, { error, ...extra });
  // ASCII file name plus RFC 5987 UTF-8 name: Cyrillic in a bare filename breaks the header.
  const file = (buf, type, name) => ({
    status: 200, cookies: [],
    headers: {
      'Content-Type': type,
      'Content-Disposition': `attachment; filename="${name.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      'Cache-Control': 'private, no-store',
    },
    body: buf,
  });

  // ── Session and access ────────────────────────────────────
  // config.externalAdmin(req) — вход администратора самого продукта (например, его
  // собственная админ-сессия) тоже даёт права администратора рецензирования. Без
  // своей сессии рецензента такой администратор рецензирует под общим именем.
  const EXTERNAL_ADMIN = { id: 'product-admin', kind: 'email', name: config.externalAdminName ?? 'Администратор', email: null, isAdmin: true };
  // config.externalReviewer(req) → { email, name } — вошедший в сам продукт рецензирует
  // под своим именем без кода из письма: продукт уже проверил, кто он. Идентификатор
  // выводится из почты так же, как при подтверждении кодом, — история у человека одна.
  // Собственная сессия рецензента (выбранная явно) важнее.
  function productReviewer(req) {
    const ext = config.externalReviewer?.(req);
    const email = normalizeEmail(ext?.email);
    if (!email || !emailAllowed(email)) return null;
    return { id: emailReviewerId(email, config.secret), kind: 'email', name: normalizeName(ext.name, email.split('@')[0]),
             email, isAdmin: admins.has(email), external: true };
  }
  function session(req) {
    const own = ownSession(req) ?? productReviewer(req);
    if (!config.externalAdmin?.(req)) return own;
    return own ? { ...own, isAdmin: true } : EXTERNAL_ADMIN;
  }
  function ownSession(req) {
    const s = readToken(req.cookies?.[SESSION_COOKIE], config.secret);
    if (!s?.id) return null;
    if (s.kind === 'anon' && !anonymousAllowed) return null;
    if (s.kind === 'email' && !emailAllowed(s.email)) return null;
    return { id: s.id, kind: s.kind, name: s.name, email: s.email ?? null, isAdmin: s.kind === 'email' && admins.has(s.email) };
  }
  function emailAllowed(email) {
    if (!email) return false;
    if (config.access !== 'invite' || admins.has(email)) return true;
    return inviteEmails.has(email) || inviteDomains.has(email.split('@')[1]);
  }
  function access(req) {
    if (config.access !== 'link') return { ok: true, cookies: [] };
    const k = req.query?.get?.('k');
    if (k && k === config.linkToken) {
      return { ok: true, cookies: [cookie(ACCESS_COOKIE, signToken({ access: 'link' }, config.secret, 90), 90 * 86400)] };
    }
    if (readToken(req.cookies?.[ACCESS_COOKIE], config.secret)?.access === 'link') return { ok: true, cookies: [] };
    if (session(req)?.isAdmin) return { ok: true, cookies: [] };
    return { ok: false };
  }

  const ipHits = new Map();
  function ipLimited(ip, limit = 10) {
    const t = Date.now();
    const hits = (ipHits.get(ip) ?? []).filter((x) => t - x < 3600_000);
    hits.push(t);
    ipHits.set(ip, hits);
    if (ipHits.size > 5000) ipHits.clear();
    return hits.length > limit;
  }

  // ── Review helpers ────────────────────────────────────────
  async function reviewContext(m, me) {
    const [rows, replies, campaigns, rechecks] = await Promise.all([
      store.listReviews(), store.listReplies(), store.listCampaigns(), store.listRechecks(),
    ]);
    const agg = aggregateReviews(m.index, rows, { replies, statusOf: m.statusOf, disputeFrom: config.disputeFrom, me: me?.id ?? null });
    return { rows, replies, campaigns, rechecks, agg };
  }

  const names = (marks) => marks.map((x) => x.name);
  function publicEntry(e) {
    return {
      agree: { email: names(e.agree.email), anon: names(e.agree.anon) },
      disagree: {
        email: e.disagree.email.map((x) => ({ name: x.name, reasons: x.reasons })),
        anon: e.disagree.anon.map((x) => ({ name: x.name, reasons: x.reasons })),
      },
      stale: e.stale.map((x) => ({ name: x.name, kind: x.kind })),
      comments: e.comments.map((c) => ({ name: c.name, kind: c.kind, text: c.text, at: c.at, stale: c.stale, verdict: c.verdict, reasons: c.reasons, pin: c.pin })),
      replies: e.replies.map((r) => ({ author: r.author, text: r.text, resolution: r.resolution, at: r.at })),
      reasons: e.reasons,
      disputed: e.disputed,
      awaitingRecheck: e.awaitingRecheck,
      mine: e.mine,
    };
  }

  function campaignView(c, rows, index) {
    const p = campaignProgress(c, rows, index);
    return { id: c.id, title: c.title, scope: c.scope, keys: c.keys, note: c.note, deadline: c.deadline,
      createdAt: c.createdAt, closedAt: c.closedAt, prdVersion: c.prdVersion,
      progress: { total: p.total, reviewed: p.reviewed, percent: p.percent, reviewers: p.reviewers.map((r) => ({ name: r.name, kind: r.kind, done: r.done })) } };
  }

  function exportData(m, rc, filter) {
    const ctx = { statusOf: m.statusOf, reviews: rc.agg, campaigns: rc.campaigns };
    const entries = selectEntries(m.index, ctx, filter);
    return {
      product: m.prd.product ?? {},
      prd: m.prd, index: m.index, entries, statusOf: m.statusOf, reviews: rc.agg,
      filter, filterLabels: describeFilter(m.index, filter, ctx), slug: filterSlug(filter),
      campaign: filter.campaign ? rc.campaigns.find((c) => c.id === filter.campaign) : null,
      tests: m.tests, releases: m.releases, generatedAt: now(),
    };
  }

  // ── Routes ────────────────────────────────────────────────
  const routes = {
    async 'GET /state'(req, me) {
      const m = await model();
      const rc = await reviewContext(m, me);
      const reviews = {};
      for (const [key, e] of rc.agg.byKey) reviews[key] = publicEntry(e);
      const testsByKey = {};
      for (const [key, t] of Object.entries(m.tests?.results ?? {})) {
        if (m.index.criteria.has(key)) testsByKey[key] = { passed: t.passed ?? 0, failed: t.failed ?? 0, skipped: t.skipped ?? 0, tests: (t.tests ?? []).slice(0, 12) };
      }
      const revisions = {};
      for (const [key, item] of Object.entries(m.lock?.items ?? {})) {
        if (item.kind === 'ac' && (item.rev ?? 1) > 1) revisions[key] = { rev: item.rev, history: (item.history ?? []).map((h) => ({ rev: h.rev, at: h.at, text: h.text })) };
      }
      return json(200, {
        prd: m.prd,
        statuses: Object.fromEntries(m.statusOf),
        tests: { generatedAt: m.tests?.generatedAt ?? null, source: m.tests?.source ?? null, byKey: testsByKey },
        revisions,
        reviews,
        reviewers: { email: rc.agg.reviewers.filter((r) => r.kind === 'email').length, anon: rc.agg.reviewers.filter((r) => r.kind === 'anon').length },
        campaigns: rc.campaigns.map((c) => campaignView(c, rc.rows, m.index)),
        releases: m.releases ?? null,
        me,
        queue: me ? personalQueue(m.index, rc.agg, me.id, { rechecks: rc.rechecks, rows: rc.rows }) : null,
        config: {
          access: config.access, allowAnonymous: anonymousAllowed, disputeFrom: config.disputeFrom,
          devMail: Boolean(mailer?.dev), reasons: REASONS, resolutions: RESOLUTIONS,
          exports: {
            reportPdf: Boolean(exporters.reportPdf), reportCsv: true,
            pitchPdf: Boolean(exporters.pitchPdf), pitchPptx: Boolean(exporters.pitchPptx),
            changelogPdf: Boolean(exporters.changelogPdf),
            decks: (exporters.decks ?? []).map((d) => ({ id: d.id, title: d.title, description: d.description ?? '', pdf: Boolean(d.pdf), pptx: Boolean(d.pptx) })),
          },
        },
      });
    },

    async 'POST /session/anonymous'(req) {
      if (!anonymousAllowed) return fail(403, 'Анонимное рецензирование отключено администратором');
      const name = normalizeName(req.body?.name, `Аноним-${Math.random().toString(36).slice(2, 6)}`);
      const reviewer = { id: anonReviewerId(), kind: 'anon', email: null, name, createdAt: now().toISOString() };
      await store.saveReviewer(reviewer);
      const token = signToken({ id: reviewer.id, kind: 'anon', name }, config.secret, 30);
      return json(200, { me: { id: reviewer.id, kind: 'anon', name, email: null, isAdmin: false } }, [cookie(SESSION_COOKIE, token, 30 * 86400)]);
    },

    async 'POST /session/email'(req) {
      const email = normalizeEmail(req.body?.email);
      if (!email) return fail(400, 'Проверьте адрес почты');
      if (!req.body?.consent) return fail(400, 'Нужно согласие на обработку адреса почты');
      if (!emailAllowed(email)) return fail(403, 'Этот адрес не приглашён к рецензированию. Обратитесь к администратору проекта');
      if (!mailer) return fail(503, 'Почта не настроена: администратору нужно задать PRD_SMTP_URL');
      if (ipLimited(req.ip)) return fail(429, 'Слишком много запросов кода с этого адреса. Попробуйте позже');
      const issued = issueCode(email, await store.getOtp(email), { secret: config.secret, now: now(), ...otpOpts });
      if (!issued.ok) return fail(429, issued.error, { retryAfter: issued.retryAfter });
      const m = await model();
      const letter = codeEmail({ product: m.prd.product?.title ?? 'PRD', code: issued.code, ttlMinutes: otpOpts.ttlMinutes });
      try {
        await mailer.send({ to: email, ...letter });
      } catch (e) {
        return fail(502, 'Не удалось отправить письмо. Попробуйте позже или сообщите администратору', { detail: production ? undefined : String(e.message) });
      }
      await store.saveOtp(issued.record);
      return json(200, { sent: true, email, ttlMinutes: otpOpts.ttlMinutes, cooldownSeconds: otpOpts.cooldownSeconds, devMail: Boolean(mailer.dev) });
    },

    async 'POST /session/verify'(req) {
      const email = normalizeEmail(req.body?.email);
      if (!email) return fail(400, 'Проверьте адрес почты');
      const record = await store.getOtp(email);
      const result = checkCode(record, req.body?.code, { secret: config.secret, now: now(), maxAttempts: otpOpts.maxAttempts });
      if (!result.ok) {
        if (result.record) await store.saveOtp(result.record);
        return fail(400, result.error);
      }
      await store.consumeOtp(email);
      const id = emailReviewerId(email, config.secret);
      const existing = await store.getReviewer(id);
      const name = normalizeName(req.body?.name, existing?.name ?? email.split('@')[0]);
      const t = now().toISOString();
      await store.saveReviewer({ id, kind: 'email', email, name, consentAt: existing?.consentAt ?? t, createdAt: existing?.createdAt ?? t, lastSeenAt: t });
      const token = signToken({ id, kind: 'email', name, email }, config.secret, 30);
      return json(200, { me: { id, kind: 'email', name, email, isAdmin: admins.has(email) } }, [cookie(SESSION_COOKIE, token, 30 * 86400)]);
    },

    async 'POST /session/logout'() {
      return json(200, { me: null }, [cookie(SESSION_COOKIE, '', 0)]);
    },

    async 'PUT /reviews'(req, me) {
      if (!me) return fail(401, 'Выберите способ рецензирования: анонимно или с почтой', { needSession: true });
      const m = await model();
      const b = req.body ?? {};
      const crit = m.index.criteria.get(String(b.key ?? ''));
      if (!crit) return fail(404, 'Критерий не найден — возможно, PRD обновился. Обновите страницу');
      if (crit.retired) return fail(409, 'Критерий выведен из PRD и больше не рецензируется');
      const verdict = b.verdict === 'agree' || b.verdict === 'disagree' ? b.verdict : null;
      const reasons = verdict === 'disagree' ? [...new Set([].concat(b.reasons ?? []).filter((r) => REASONS[r]))] : [];
      const comment = String(b.comment ?? '').trim().slice(0, 2000);
      let campaignId = null;
      if (b.campaignId) {
        const c = (await store.listCampaigns()).find((x) => x.id === b.campaignId);
        if (!c || c.closedAt) return fail(409, 'Раунд рецензирования закрыт');
        if (!c.keys.includes(crit.key)) return fail(400, 'Критерий не входит в этот раунд');
        campaignId = c.id;
      }
      const pin = b.pin && typeof b.pin === 'object'
        ? { route: String(b.pin.route ?? '').slice(0, 300), selector: String(b.pin.selector ?? '').slice(0, 300) }
        : null;
      const row = {
        key: crit.key, reviewerId: me.id, campaignId, verdict, reasons, comment,
        fingerprint: crit.fingerprint, pin, updatedAt: now().toISOString(),
      };
      await store.upsertReview(row);
      await store.addHistory({ id: randomUUID(), ...row });
      const rc = await reviewContext(m, me);
      const entry = rc.agg.byKey.get(crit.key);
      return json(200, {
        ok: true, key: crit.key, entry: entry ? publicEntry(entry) : null,
        queue: personalQueue(m.index, rc.agg, me.id, { rechecks: rc.rechecks, rows: rc.rows }),
      });
    },

    async 'GET /me/history'(req, me) {
      if (!me) return fail(401, 'Нужно войти', { needSession: true });
      return json(200, { history: (await store.listHistory(me.id)).slice(0, 500) });
    },

    async 'GET /export/report.csv'(req, me) {
      const m = await model();
      const rc = await reviewContext(m, me);
      const filter = normalizeFilter(m.index, req.query, { me: me?.id, campaigns: rc.campaigns });
      const data = exportData(m, rc, filter);
      if (!data.entries.length) return fail(404, 'Под фильтры не подошло ни одного требования');
      const csv = toCsv(reportRows(m.index, data.entries, m.statusOf, rc.agg));
      return file(Buffer.from(csv, 'utf8'), 'text/csv; charset=utf-8', `prd-report-${data.slug}.csv`);
    },

    async 'GET /export/report.pdf'(req, me) {
      if (!exporters.reportPdf) return fail(501, 'PDF-отчёт не подключён (exporters.reportPdf)');
      const m = await model();
      const rc = await reviewContext(m, me);
      const filter = normalizeFilter(m.index, req.query, { me: me?.id, campaigns: rc.campaigns });
      const data = exportData(m, rc, filter);
      // Пустой файл — ошибка фильтра, а не документ: сказать правду безопаснее.
      if (!data.entries.length) return fail(404, 'Под фильтры не подошло ни одного требования');
      return file(await exporters.reportPdf(data), 'application/pdf', `prd-report-${data.slug}.pdf`);
    },

    async 'GET /export/pitch.pdf'(req, me) {
      if (!exporters.pitchPdf) return fail(501, 'Презентация не подключена (exporters.pitchPdf)');
      const m = await model();
      const data = exportData(m, await reviewContext(m, me), {});
      return file(await exporters.pitchPdf(data), 'application/pdf', `${m.prd.product?.id ?? 'product'}-presentation.pdf`);
    },

    async 'GET /export/pitch.pptx'(req, me) {
      if (!exporters.pitchPptx) return fail(501, 'Презентация не подключена (exporters.pitchPptx)');
      const m = await model();
      const data = exportData(m, await reviewContext(m, me), {});
      return file(await exporters.pitchPptx(data), 'application/vnd.openxmlformats-officedocument.presentationml.presentation', `${m.prd.product?.id ?? 'product'}-presentation.pptx`);
    },

    // Несколько презентаций из одной модели: exporters.decks = [{ id, title, description, pdf, pptx }]
    async 'GET /export/deck/:file'(req, me, params) {
      const [, id, ext] = String(params.file).match(/^([a-z0-9-]+)\.(pdf|pptx)$/) ?? [];
      const deck = (exporters.decks ?? []).find((d) => d.id === id);
      if (!deck || !deck[ext]) return fail(404, 'Такой презентации нет');
      const m = await model();
      const data = exportData(m, await reviewContext(m, me), {});
      const type = ext === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
      return file(await deck[ext](data), type, `${m.prd.product?.id ?? 'product'}-${id}.${ext}`);
    },

    async 'GET /export/changelog.pdf'() {
      if (!exporters.changelogPdf) return fail(501, 'История релизов не подключена (exporters.changelogPdf)');
      const m = await model();
      if (!m.releases?.length) return fail(404, 'Релизов пока нет');
      return file(await exporters.changelogPdf({ product: m.prd.product ?? {}, releases: m.releases, index: m.index, generatedAt: now() }),
        'application/pdf', `${m.prd.product?.id ?? 'product'}-changelog.pdf`);
    },

    // ── Admin ───────────────────────────────────────────────
    async 'GET /export/reviews.json'(req, me) {
      if (!me?.isAdmin) return fail(403, 'Только для администратора');
      const [reviewers, reviews, replies, campaigns, rechecks] = await Promise.all([
        store.listReviewers(), store.listReviews(), store.listReplies(), store.listCampaigns(), store.listRechecks(),
      ]);
      const m = await model();
      const body = JSON.stringify({ exportedAt: now().toISOString(), product: m.prd.product ?? null, reviewers, reviews, replies, campaigns, rechecks }, null, 2);
      return file(Buffer.from(body, 'utf8'), 'application/json; charset=utf-8', `prd-reviews-${now().toISOString().slice(0, 10)}.json`);
    },

    async 'POST /admin/campaigns'(req, me) {
      if (!me?.isAdmin) return fail(403, 'Только для администратора');
      const m = await model();
      const rc = await reviewContext(m, me);
      const b = req.body ?? {};
      const title = String(b.title ?? '').trim().slice(0, 140);
      if (title.length < 3) return fail(400, 'Назовите раунд');
      const scope = {};
      for (const k of ['module', 'epic', 'story']) if (b.scope?.[k]) scope[k] = String(b.scope[k]);
      const filter = normalizeFilter(m.index, { ...(b.scope?.filter ?? {}), ...scope }, { me: me.id, campaigns: rc.campaigns });
      for (const k of Object.keys(scope)) if (!filter[k]) return fail(400, `Неизвестное значение ${k}: «${scope[k]}»`);
      const keys = campaignKeys(m.index, { statusOf: m.statusOf, reviews: rc.agg, campaigns: rc.campaigns }, { filter });
      if (!keys.length) return fail(400, 'В раунд не попал ни один критерий');
      const deadline = b.deadline && !Number.isNaN(Date.parse(b.deadline)) ? new Date(b.deadline).toISOString().slice(0, 10) : null;
      const campaign = {
        id: randomUUID().slice(0, 8), title, scope: { ...scope, filter }, keys, note: String(b.note ?? '').slice(0, 1000),
        prdVersion: m.prd.product?.version ?? null, createdBy: me.email, createdAt: now().toISOString(), deadline, closedAt: null,
      };
      await store.saveCampaign(campaign);
      return json(200, { campaign: campaignView(campaign, rc.rows, m.index) });
    },

    async 'POST /admin/campaigns/:id/close'(req, me, params) {
      if (!me?.isAdmin) return fail(403, 'Только для администратора');
      const c = (await store.listCampaigns()).find((x) => x.id === params.id);
      if (!c) return fail(404, 'Раунд не найден');
      c.closedAt = c.closedAt ? null : now().toISOString(); // повторный вызов открывает раунд снова
      await store.saveCampaign(c);
      return json(200, { campaign: c });
    },

    async 'POST /admin/replies'(req, me) {
      if (!me?.isAdmin) return fail(403, 'Только для администратора');
      const m = await model();
      const b = req.body ?? {};
      if (!m.index.criteria.has(b.key)) return fail(404, 'Критерий не найден');
      const text = String(b.text ?? '').trim().slice(0, 4000);
      if (!text) return fail(400, 'Пустой ответ');
      const resolution = RESOLUTIONS[b.resolution] ? b.resolution : null;
      const reply = { id: randomUUID(), key: b.key, author: me.name, text, resolution, at: now().toISOString() };
      await store.addReply(reply);
      let rechecks = 0;
      if (resolution === 'fixed') {
        const rc = await reviewContext(m, me);
        const e = rc.agg.byKey.get(b.key);
        for (const mark of [...(e?.disagree.email ?? []), ...(e?.disagree.anon ?? [])]) {
          await store.addRecheck({ id: randomUUID(), key: b.key, reviewerId: mark.id, reason: 'fixed', requestedAt: reply.at });
          rechecks += 1;
        }
      }
      return json(200, { reply, rechecks });
    },

    async 'POST /admin/rechecks'(req, me) {
      if (!me?.isAdmin) return fail(403, 'Только для администратора');
      const m = await model();
      const b = req.body ?? {};
      if (!m.index.criteria.has(b.key)) return fail(404, 'Критерий не найден');
      const rc = await reviewContext(m, me);
      const e = rc.agg.byKey.get(b.key);
      const marks = e ? [...e.disagree.email, ...e.disagree.anon, ...e.agree.email, ...e.agree.anon, ...e.stale] : [];
      const ids = Array.isArray(b.reviewerIds) && b.reviewerIds.length ? marks.filter((x) => b.reviewerIds.includes(x.id)) : marks;
      if (!ids.length) return fail(400, 'Этот критерий ещё никто не рецензировал — перепроверять некому');
      const at = now().toISOString();
      for (const mark of ids) await store.addRecheck({ id: randomUUID(), key: b.key, reviewerId: mark.id, reason: String(b.reason ?? '').slice(0, 300), requestedAt: at });
      return json(200, { requested: ids.length });
    },

    async 'GET /admin/reviewers'(req, me) {
      if (!me?.isAdmin) return fail(403, 'Только для администратора');
      const [reviewers, rows] = await Promise.all([store.listReviewers(), store.listReviews()]);
      const counts = new Map();
      for (const r of rows) if (r.verdict || r.comment) counts.set(r.reviewerId, (counts.get(r.reviewerId) ?? 0) + 1);
      return json(200, { reviewers: reviewers.map((r) => ({ ...r, reviews: counts.get(r.id) ?? 0 })) });
    },

    async 'GET /admin/orphans'(req, me) {
      if (!me?.isAdmin) return fail(403, 'Только для администратора');
      const m = await model();
      const rc = await reviewContext(m, me);
      const byKey = new Map();
      for (const o of rc.agg.orphans) {
        const g = byKey.get(o.key) ?? { key: o.key, count: 0, reviewers: new Set() };
        g.count += 1; g.reviewers.add(o.name);
        byKey.set(o.key, g);
      }
      return json(200, { orphans: [...byKey.values()].map((g) => ({ ...g, reviewers: [...g.reviewers] })) });
    },

    async 'POST /admin/orphans/attach'(req, me) {
      if (!me?.isAdmin) return fail(403, 'Только для администратора');
      const m = await model();
      const { from, to } = req.body ?? {};
      if (m.index.criteria.has(from)) return fail(400, `${from} есть в PRD — это не потерянная рецензия`);
      if (!m.index.criteria.has(to)) return fail(404, `Критерия ${to} нет в PRD`);
      await store.rekeyReviews(from, to);
      // Отпечаток не меняем: рецензенты увидят «устарело» и подтвердят оценку уже к новому тексту.
      return json(200, { ok: true });
    },

    async 'GET /dev/mail'() {
      if (!mailer?.dev || production) return fail(404, 'Не найдено');
      return json(200, { letters: mailer.letters.slice(0, 20) });
    },
  };

  const table = Object.entries(routes).map(([sig, fn]) => {
    const [method, pattern] = sig.split(' ');
    const keys = [];
    const rx = new RegExp(`^${pattern.replace(/:([a-z]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; })}$`);
    return { method, rx, keys, fn };
  });

  async function handle(req) {
    try {
      await init();
      const method = String(req.method ?? 'GET').toUpperCase();
      const path = (req.path || '/').replace(/\/+$/, '') || '/';
      const route = table.find((r) => r.method === method && r.rx.test(path));
      if (!route) return fail(404, 'Неизвестный метод API');
      // CSRF: изменяющие запросы обязаны нести собственный заголовок. Форма с чужого
      // сайта его поставить не может, а fetch с чужого домена упрётся в CORS.
      if (method !== 'GET' && req.headers?.['x-prd-request'] !== '1') return fail(403, 'Нет заголовка X-PRD-Request');
      const gate = access(req);
      const me = session(req);
      if (me === EXTERNAL_ADMIN && method !== 'GET') {
        const t = now().toISOString();
        await store.saveReviewer({ id: me.id, kind: me.kind, email: null, name: me.name, createdAt: t, lastSeenAt: t });
      }
      // Рецензент из продукта заводится при первой оценке — его имя нужно в сводках и отчётах
      if (me?.external && method !== 'GET') {
        const existing = await store.getReviewer(me.id);
        const t = now().toISOString();
        await store.saveReviewer({ id: me.id, kind: 'email', email: me.email, name: me.name,
          consentAt: existing?.consentAt ?? t, createdAt: existing?.createdAt ?? t, lastSeenAt: t });
      }
      if (!gate.ok && !path.startsWith('/session/')) return fail(403, 'Нужна ссылка доступа от администратора проекта', { needAccess: true });
      const params = {};
      const match = path.match(route.rx);
      route.keys.forEach((k, i) => { params[k] = decodeURIComponent(match[i + 1]); });
      const res = await route.fn({ ...req, query: req.query ?? new URLSearchParams() }, me, params);
      res.cookies = [...(gate.cookies ?? []), ...(res.cookies ?? [])];
      return res;
    } catch (e) {
      console.error('[prd-review]', e);
      return fail(500, production ? 'Внутренняя ошибка' : String(e.message ?? e));
    }
  }

  return { handle, config, model };
}

// ── Adapters ────────────────────────────────────────────────
export function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i > 0) {
      const k = part.slice(0, i).trim();
      try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { out[k] = part.slice(i + 1).trim(); }
    }
  }
  return out;
}

async function readJsonBody(req, limit = 64 * 1024) {
  if (req.body !== undefined && typeof req.body === 'object') return req.body; // Express json() already parsed it
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw Object.assign(new Error('too large'), { status: 413 });
    chunks.push(c);
  }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return {}; }
}

const clientIp = (headers, socketIp, trustProxy) =>
  (trustProxy && String(headers['x-forwarded-for'] ?? '').split(',')[0].trim()) || socketIp || 'unknown';

/**
 * node:http / Express / Connect. Returns true when the request was handled.
 *   const prd = nodeAdapter(api, { mount: '/api/prd' });
 *   http.createServer(async (req, res) => { if (await prd(req, res)) return; … });
 *   app.use((req, res, next) => prd(req, res, next));
 */
export function nodeAdapter(api, { mount = '/api/prd' } = {}) {
  return async function prdHandler(req, res, next) {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== mount && !url.pathname.startsWith(`${mount}/`)) { if (next) next(); return false; }
    let body = null;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      try { body = await readJsonBody(req); } catch { res.writeHead(413).end(); return true; }
    }
    const out = await api.handle({
      method: req.method, path: url.pathname.slice(mount.length) || '/', query: url.searchParams, body,
      cookies: parseCookies(req.headers.cookie), headers: req.headers,
      ip: clientIp(req.headers, req.socket?.remoteAddress, api.config.trustProxy),
    });
    const headers = { ...out.headers };
    if (out.cookies?.length) headers['Set-Cookie'] = out.cookies;
    res.writeHead(out.status, headers);
    res.end(out.body);
    return true;
  };
}

/**
 * Fetch API (Next.js app router, Hono, Bun, Deno):
 *   // app/api/prd/[...path]/route.ts
 *   const handler = fetchAdapter(api, { mount: '/api/prd' });
 *   export { handler as GET, handler as POST, handler as PUT };
 */
export function fetchAdapter(api, { mount = '/api/prd' } = {}) {
  return async function prdFetch(request) {
    const url = new URL(request.url);
    let body = null;
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      try { body = await request.json(); } catch { body = {}; }
    }
    const headers = Object.fromEntries([...request.headers.entries()].map(([k, v]) => [k.toLowerCase(), v]));
    const out = await api.handle({
      method: request.method, path: url.pathname.slice(mount.length) || '/', query: url.searchParams, body,
      cookies: parseCookies(headers.cookie), headers, ip: clientIp(headers, null, true),
    });
    const h = new Headers(out.headers);
    for (const c of out.cookies ?? []) h.append('Set-Cookie', c);
    return new Response(out.body, { status: out.status, headers: h });
  };
}
