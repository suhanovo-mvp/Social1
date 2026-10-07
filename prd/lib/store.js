// Storage for reviews, reviewers, codes, replies, campaigns and re-check requests.
//
// Two implementations of one interface (see references/review.md):
//  - createSqlStore({ query, dialect }) — any SQL database through one function
//    `query(sql, params) → Promise<rows>`. Helpers below wrap node:sqlite, pg and Prisma.
//  - createJsonStore(file) — a single JSON file, for static prototypes without a database.
//
// Dates are ISO strings and JSON fields are TEXT so the same SQL runs on SQLite and
// PostgreSQL. Nothing here ever deletes a review because the PRD changed: rows whose
// criterion disappeared become "orphans" an admin re-attaches (aggregateReviews()).
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS prd_reviewers (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, email TEXT, name TEXT NOT NULL,
    consent_at TEXT, created_at TEXT NOT NULL, last_seen_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS prd_reviews (
    ac_key TEXT NOT NULL, reviewer_id TEXT NOT NULL, campaign_id TEXT NOT NULL DEFAULT '',
    verdict TEXT, reasons TEXT NOT NULL DEFAULT '[]', comment TEXT NOT NULL DEFAULT '',
    fingerprint TEXT NOT NULL, pin TEXT, updated_at TEXT NOT NULL,
    PRIMARY KEY (ac_key, reviewer_id, campaign_id))`,
  `CREATE TABLE IF NOT EXISTS prd_review_history (
    id TEXT PRIMARY KEY, ac_key TEXT NOT NULL, reviewer_id TEXT NOT NULL, campaign_id TEXT NOT NULL DEFAULT '',
    verdict TEXT, reasons TEXT NOT NULL DEFAULT '[]', comment TEXT NOT NULL DEFAULT '',
    fingerprint TEXT NOT NULL, at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS prd_review_history_reviewer ON prd_review_history (reviewer_id, at)`,
  `CREATE TABLE IF NOT EXISTS prd_otp (
    email TEXT PRIMARY KEY, code_hash TEXT NOT NULL, expires_at TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0, sent_at TEXT NOT NULL, sent_count INTEGER NOT NULL DEFAULT 1,
    window_start TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS prd_replies (
    id TEXT PRIMARY KEY, ac_key TEXT NOT NULL, author TEXT NOT NULL, text TEXT NOT NULL,
    resolution TEXT, at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS prd_campaigns (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, scope TEXT NOT NULL, keys TEXT NOT NULL,
    prd_version TEXT, note TEXT, created_by TEXT, created_at TEXT NOT NULL, deadline TEXT, closed_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS prd_rechecks (
    id TEXT PRIMARY KEY, ac_key TEXT NOT NULL, reviewer_id TEXT NOT NULL, reason TEXT,
    requested_at TEXT NOT NULL, done_at TEXT)`,
];

const json = (v, fallback) => { try { return v == null ? fallback : JSON.parse(v); } catch { return fallback; } };

const fromReview = (r) => ({
  key: r.ac_key, reviewerId: r.reviewer_id, campaignId: r.campaign_id || null,
  verdict: r.verdict || null, reasons: json(r.reasons, []), comment: r.comment ?? '',
  fingerprint: r.fingerprint, pin: json(r.pin, null), updatedAt: r.updated_at,
});
const fromReviewer = (r) => r && ({
  id: r.id, kind: r.kind, email: r.email ?? null, name: r.name,
  consentAt: r.consent_at ?? null, createdAt: r.created_at, lastSeenAt: r.last_seen_at ?? null,
});
const fromOtp = (r) => r && ({
  email: r.email, codeHash: r.code_hash, expiresAt: r.expires_at, attempts: Number(r.attempts),
  sentAt: r.sent_at, sentCount: Number(r.sent_count), windowStart: r.window_start,
});
const fromCampaign = (r) => ({
  id: r.id, title: r.title, scope: json(r.scope, {}), keys: json(r.keys, []), prdVersion: r.prd_version ?? null,
  note: r.note ?? '', createdBy: r.created_by ?? null, createdAt: r.created_at, deadline: r.deadline ?? null,
  closedAt: r.closed_at ?? null,
});

/** SQL store. dialect: 'sqlite' | 'postgres' (placeholders `?` become `$n`). */
export function createSqlStore({ query, dialect = 'sqlite' }) {
  const q = (sql, params = []) => {
    let n = 0;
    const text = dialect === 'postgres' ? sql.replace(/\?/g, () => `$${++n}`) : sql;
    return query(text, params);
  };
  return {
    async init() { for (const stmt of SCHEMA) await q(stmt); },

    async getReviewer(id) { return fromReviewer((await q('SELECT * FROM prd_reviewers WHERE id = ?', [id]))[0]); },
    async listReviewers() { return (await q('SELECT * FROM prd_reviewers ORDER BY created_at')).map(fromReviewer); },
    async saveReviewer(r) {
      await q(`INSERT INTO prd_reviewers (id, kind, email, name, consent_at, created_at, last_seen_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT (id) DO UPDATE SET name = excluded.name, email = excluded.email,
                 consent_at = COALESCE(excluded.consent_at, prd_reviewers.consent_at), last_seen_at = excluded.last_seen_at`,
      [r.id, r.kind, r.email ?? null, r.name, r.consentAt ?? null, r.createdAt, r.lastSeenAt ?? r.createdAt]);
    },

    async listReviews() {
      const rows = await q(`SELECT r.*, p.name AS reviewer_name, p.kind AS reviewer_kind
                            FROM prd_reviews r LEFT JOIN prd_reviewers p ON p.id = r.reviewer_id`);
      return rows.map((r) => ({ ...fromReview(r), name: r.reviewer_name ?? 'Рецензент', kind: r.reviewer_kind ?? 'anon' }));
    },
    async upsertReview(row) {
      const params = [row.key, row.reviewerId, row.campaignId ?? '', row.verdict ?? null, JSON.stringify(row.reasons ?? []),
        row.comment ?? '', row.fingerprint, row.pin ? JSON.stringify(row.pin) : null, row.updatedAt];
      await q(`INSERT INTO prd_reviews (ac_key, reviewer_id, campaign_id, verdict, reasons, comment, fingerprint, pin, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT (ac_key, reviewer_id, campaign_id) DO UPDATE SET verdict = excluded.verdict,
                 reasons = excluded.reasons, comment = excluded.comment, fingerprint = excluded.fingerprint,
                 pin = excluded.pin, updated_at = excluded.updated_at`, params);
    },
    async addHistory(row) {
      await q(`INSERT INTO prd_review_history (id, ac_key, reviewer_id, campaign_id, verdict, reasons, comment, fingerprint, at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.id, row.key, row.reviewerId, row.campaignId ?? '', row.verdict ?? null, JSON.stringify(row.reasons ?? []),
        row.comment ?? '', row.fingerprint, row.updatedAt]);
    },
    async listHistory(reviewerId) {
      const rows = await q('SELECT * FROM prd_review_history WHERE reviewer_id = ? ORDER BY at DESC', [reviewerId]);
      return rows.map((r) => ({ ...fromReview({ ...r, updated_at: r.at }), id: r.id }));
    },
    async rekeyReviews(from, to) {
      await q('UPDATE prd_reviews SET ac_key = ? WHERE ac_key = ?', [to, from]);
      await q('UPDATE prd_review_history SET ac_key = ? WHERE ac_key = ?', [to, from]);
      await q('UPDATE prd_replies SET ac_key = ? WHERE ac_key = ?', [to, from]);
    },

    async getOtp(email) { return fromOtp((await q('SELECT * FROM prd_otp WHERE email = ?', [email]))[0]); },
    async saveOtp(o) {
      await q(`INSERT INTO prd_otp (email, code_hash, expires_at, attempts, sent_at, sent_count, window_start)
               VALUES (?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT (email) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at,
                 attempts = excluded.attempts, sent_at = excluded.sent_at, sent_count = excluded.sent_count,
                 window_start = excluded.window_start`,
      [o.email, o.codeHash, o.expiresAt, o.attempts ?? 0, o.sentAt, o.sentCount ?? 1, o.windowStart]);
    },
    // Code used: kill it but keep the send counters, or the hourly cap resets on every login.
    async consumeOtp(email) { await q("UPDATE prd_otp SET code_hash = '', expires_at = '1970-01-01T00:00:00.000Z' WHERE email = ?", [email]); },

    async listReplies() {
      return (await q('SELECT * FROM prd_replies ORDER BY at')).map((r) => ({
        id: r.id, key: r.ac_key, author: r.author, text: r.text, resolution: r.resolution ?? null, at: r.at,
      }));
    },
    async addReply(r) {
      await q('INSERT INTO prd_replies (id, ac_key, author, text, resolution, at) VALUES (?, ?, ?, ?, ?, ?)',
        [r.id, r.key, r.author, r.text, r.resolution ?? null, r.at]);
    },

    async listCampaigns() { return (await q('SELECT * FROM prd_campaigns ORDER BY created_at DESC')).map(fromCampaign); },
    async saveCampaign(c) {
      await q(`INSERT INTO prd_campaigns (id, title, scope, keys, prd_version, note, created_by, created_at, deadline, closed_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT (id) DO UPDATE SET title = excluded.title, deadline = excluded.deadline,
                 note = excluded.note, closed_at = excluded.closed_at`,
      [c.id, c.title, JSON.stringify(c.scope ?? {}), JSON.stringify(c.keys ?? []), c.prdVersion ?? null, c.note ?? '',
        c.createdBy ?? null, c.createdAt, c.deadline ?? null, c.closedAt ?? null]);
    },

    async listRechecks() {
      return (await q('SELECT * FROM prd_rechecks ORDER BY requested_at')).map((r) => ({
        id: r.id, key: r.ac_key, reviewerId: r.reviewer_id, reason: r.reason ?? '', requestedAt: r.requested_at, doneAt: r.done_at ?? null,
      }));
    },
    async addRecheck(r) {
      await q('INSERT INTO prd_rechecks (id, ac_key, reviewer_id, reason, requested_at, done_at) VALUES (?, ?, ?, ?, ?, ?)',
        [r.id, r.key, r.reviewerId, r.reason ?? '', r.requestedAt, null]);
    },
  };
}

/** node:sqlite (Node ≥ 22.5): `new DatabaseSync(file)` → query function. */
export function sqliteQuery(db) {
  return async (sql, params = []) => {
    const stmt = db.prepare(sql);
    return /^\s*(select|with|pragma)/i.test(sql) ? stmt.all(...params) : (stmt.run(...params), []);
  };
}

/** pg Pool or Client → query function. */
export const pgQuery = (pool) => async (sql, params = []) => (await pool.query(sql, params)).rows;

/** Prisma client → query function (raw SQL against the same database Prisma manages). */
export function prismaQuery(prisma) {
  return async (sql, params = []) => (/^\s*(select|with)/i.test(sql)
    ? prisma.$queryRawUnsafe(sql, ...params)
    : (await prisma.$executeRawUnsafe(sql, ...params), []));
}

/**
 * JSON file store. Writes are serialized and atomic (temp file + rename), so a crash
 * mid-write cannot leave half a file. Fine for a prototype with a handful of
 * reviewers; use SQL once several people review at the same time on a server.
 */
export function createJsonStore(file) {
  let data = null;
  let chain = Promise.resolve();
  const empty = () => ({ reviewers: {}, reviews: {}, history: [], otp: {}, replies: [], campaigns: {}, rechecks: [] });
  const load = () => {
    if (data) return data;
    data = existsSync(file) ? { ...empty(), ...JSON.parse(readFileSync(file, 'utf8')) } : empty();
    return data;
  };
  const persist = () => {
    chain = chain.then(() => {
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(data, null, 1));
      renameSync(tmp, file);
    });
    return chain;
  };
  const rkey = (r) => `${r.key}\u0000${r.reviewerId}\u0000${r.campaignId ?? ''}`;
  return {
    async init() { load(); },
    async getReviewer(id) { return load().reviewers[id] ?? null; },
    async listReviewers() { return Object.values(load().reviewers); },
    async saveReviewer(r) {
      const prev = load().reviewers[r.id];
      data.reviewers[r.id] = { ...prev, ...r, consentAt: r.consentAt ?? prev?.consentAt ?? null };
      await persist();
    },
    async listReviews() {
      const d = load();
      return Object.values(d.reviews).map((r) => ({ ...r, name: d.reviewers[r.reviewerId]?.name ?? 'Рецензент', kind: d.reviewers[r.reviewerId]?.kind ?? 'anon' }));
    },
    async upsertReview(row) {
      load().reviews[rkey(row)] = {
        key: row.key, reviewerId: row.reviewerId, campaignId: row.campaignId ?? null, verdict: row.verdict ?? null,
        reasons: row.reasons ?? [], comment: row.comment ?? '', fingerprint: row.fingerprint, pin: row.pin ?? null, updatedAt: row.updatedAt,
      };
      await persist();
    },
    async addHistory(row) {
      load().history.push({ id: row.id, key: row.key, reviewerId: row.reviewerId, campaignId: row.campaignId ?? null,
        verdict: row.verdict ?? null, reasons: row.reasons ?? [], comment: row.comment ?? '', fingerprint: row.fingerprint, updatedAt: row.updatedAt });
      await persist();
    },
    async listHistory(reviewerId) { return load().history.filter((h) => h.reviewerId === reviewerId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); },
    async rekeyReviews(from, to) {
      const d = load();
      for (const [k, r] of Object.entries(d.reviews)) if (r.key === from) { delete d.reviews[k]; r.key = to; d.reviews[rkey(r)] = r; }
      for (const h of d.history) if (h.key === from) h.key = to;
      for (const r of d.replies) if (r.key === from) r.key = to;
      await persist();
    },
    async getOtp(email) { return load().otp[email] ?? null; },
    async saveOtp(o) { load().otp[o.email] = o; await persist(); },
    async consumeOtp(email) { const o = load().otp[email]; if (o) { o.codeHash = ''; o.expiresAt = '1970-01-01T00:00:00.000Z'; await persist(); } },
    async listReplies() { return [...load().replies]; },
    async addReply(r) { load().replies.push(r); await persist(); },
    async listCampaigns() { return Object.values(load().campaigns).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); },
    async saveCampaign(c) { load().campaigns[c.id] = c; await persist(); },
    async listRechecks() { return [...load().rechecks]; },
    async addRecheck(r) { load().rechecks.push({ ...r, doneAt: null }); await persist(); },
  };
}
