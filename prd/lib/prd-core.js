// PRD core: statuses, test-derived markers, filters with facet counts, review
// aggregation, disputes, staleness, campaigns, personal queue, the lock file and
// model validation.
//
// Pure ES module — no DOM, no Node imports — because every renderer must agree:
// the review page, the in-prototype panel, the API server, the PDF/CSV exports and
// the CLI scripts all import THIS file. A rule written twice drifts; the first
// visible symptom is a counter on screen that disagrees with the downloaded PDF.

// ── Statuses ────────────────────────────────────────────────
// `declared` is what the PRD author claims (ac.status). The displayed status is
// derived from the claim plus test results — see deriveStatus().
export const DECLARED = ['done', 'partial', 'missing', 'unverified'];

export const STATUS = {
  verified:   { mark: '✅', label: 'Подтверждено автотестом', chip: 'Реализовано (тест)', implemented: true,  tone: 'good' },
  manual:     { mark: '☑️', label: 'Проверено вручную',       chip: 'Проверено вручную',  implemented: true,  tone: 'good' },
  partial:    { mark: '❌', label: 'Частично',                chip: 'Частично',           implemented: false, tone: 'warn' },
  missing:    { mark: '❌', label: 'Не реализовано',          chip: 'Не реализовано',     implemented: false, tone: 'bad' },
  failing:    { mark: '🔴', label: 'Тест падает',             chip: 'Тест падает',        implemented: false, tone: 'bad' },
  unverified: { mark: '⚠️', label: 'Не проверено',            chip: 'Не проверено',       implemented: false, tone: 'muted' },
};
/** Order of filter chips and report columns. */
export const STATUS_ORDER = ['verified', 'manual', 'partial', 'missing', 'failing', 'unverified'];
// Worst first: a story is as good as its worst criterion. Comparing the other way
// hides unimplemented criteria behind a single passing one.
const WORST_FIRST = ['failing', 'missing', 'unverified', 'partial', 'manual', 'verified'];

export const PRIORITY = { must: 'Must Have', should: 'Should Have', could: 'Could Have', wont: "Won't Have" };
export const PRIORITY_ORDER = ['must', 'should', 'could', 'wont'];

export const ORIGIN = {
  prd: 'Из PRD',
  doc: 'Из документа',
  reverse: 'Восстановлено по коду',
};

export const REASONS = {
  broken: 'Не работает',
  different: 'Работает иначе',
  absent: 'Нет на экране',
  wrong: 'Требование неверное',
  unclear: 'Непонятно, как проверить',
};

export const RESOLUTIONS = {
  fixed: 'Исправлено — проверьте снова',
  explained: 'Разъяснено',
  'requirement-changed': 'Требование изменено',
  rejected: 'Отклонено',
};
// Replies that close a dispute without asking reviewers to look again.
const CLOSING = new Set(['explained', 'rejected', 'requirement-changed']);

export const REVIEW_FILTERS = [
  { id: 'reviewed', label: 'Есть рецензия' },
  { id: 'agreed', label: 'Согласовано' },
  { id: 'disagreed', label: 'Не согласовано' },
  { id: 'disputed', label: 'Оспорено' },
  { id: 'commented', label: 'Есть комментарий' },
  { id: 'stale', label: 'Устарело' },
  { id: 'none', label: 'Без рецензии' },
  { id: 'todo', label: 'Мне осталось', needsMe: true },
  { id: 'changed', label: 'Изменилось после моей оценки', needsMe: true },
  { id: 'answered', label: 'Ответили на моё замечание', needsMe: true },
  { id: 'recheck', label: 'Просят перепроверить', needsMe: true },
];

// ── Identity ────────────────────────────────────────────────
export const STORY_ID = /^US-[A-Z0-9]+-\d{3,}$/;
export const AC_ID = /^AC\d+$/;
export const EPIC_ID = /^EP-\d{2,}$/;
export const MODULE_ID = /^[a-z][a-z0-9-]*$/;

/** Full criterion key, the identity everything else points at: `US-LIB-001/AC4`. */
export const acKey = (story, ac) => `${story.id ?? story}/${ac.id ?? ac}`;
export const splitKey = (key) => {
  const i = String(key).lastIndexOf('/');
  return { storyId: key.slice(0, i), acId: key.slice(i + 1) };
};

export function normalizeText(text) {
  return String(text ?? '').normalize('NFC').toLowerCase().replace(/ё/g, 'е')
    .replace(/\s+/g, ' ').trim().replace(/[.;]+$/, '');
}

// 53-bit string hash (cyrb53). Sync and identical in browser and Node — crypto.subtle
// is async and node:crypto does not exist in the browser.
function cyrb53(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/**
 * Fingerprint of a criterion's wording. A review stores the fingerprint it was given
 * against; when the wording changes the review becomes "stale" instead of silently
 * transferring its agreement to a different requirement.
 */
export const fingerprint = (text) => cyrb53(normalizeText(text)).toString(36);

// ── Index ───────────────────────────────────────────────────
/**
 * Lookup tables over a PRD object. Array order in the model is display order;
 * ids are identity. New criteria get the next free number wherever they appear.
 */
export function indexPrd(prd) {
  const modules = new Map((prd.modules ?? []).map((m) => [m.id, m]));
  const epics = new Map((prd.epics ?? []).map((e) => [e.id, e]));
  const scopes = new Map((prd.scopes ?? []).map((s) => [s.id, s]));
  const stories = new Map();
  const criteria = new Map();
  for (const story of prd.stories ?? []) {
    stories.set(story.id, story);
    for (const ac of story.criteria ?? []) {
      const key = acKey(story, ac);
      criteria.set(key, { key, story, ac, fingerprint: fingerprint(ac.text), retired: Boolean(ac.retired) });
    }
  }
  return { prd, modules, epics, scopes, stories, criteria };
}

export const scopeOf = (index, story) => index.modules.get(story.module)?.scope ?? null;
export const activeCriteria = (story) => (story.criteria ?? []).filter((ac) => !ac.retired);

// ── Status derivation ───────────────────────────────────────
const hasEvidence = (ac, story) =>
  (Array.isArray(ac.evidence) && ac.evidence.length > 0) ||
  (Array.isArray(story?.evidence) && story.evidence.length > 0);

/**
 * Displayed status = author's claim corrected by tests.
 *  - a failing linked test turns done/unverified into `failing` (a regression is loud);
 *  - passing tests turn done/unverified into `verified`;
 *  - partial/missing stay as declared: a test may cover only the implemented part,
 *    or be written ahead of the code;
 *  - `done` with no tests needs evidence (how it was checked) to show as `manual`,
 *    otherwise it is `unverified` — a quiet "done" nobody checked is the lie this
 *    whole page exists to prevent.
 */
export function deriveStatus(ac, story, testResult) {
  const declared = DECLARED.includes(ac.status) ? ac.status : 'unverified';
  const failed = (testResult?.failed ?? 0) > 0;
  const passed = (testResult?.passed ?? 0) > 0;
  const kept = declared === 'partial' || declared === 'missing';
  if (failed) return kept ? declared : 'failing';
  if (passed) return kept ? declared : 'verified';
  if (declared === 'done') return hasEvidence(ac, story) ? 'manual' : 'unverified';
  return declared;
}

/** Map key → displayed status for every criterion (retired included, for archives). */
export function statusMap(index, tests = null) {
  const results = tests?.results ?? tests ?? {};
  const map = new Map();
  for (const { key, story, ac } of index.criteria.values()) {
    map.set(key, deriveStatus(ac, story, results[key]));
  }
  return map;
}

export function worstStatus(statuses) {
  let worst = null;
  for (const s of statuses) {
    if (worst === null || WORST_FIRST.indexOf(s) < WORST_FIRST.indexOf(worst)) worst = s;
  }
  return worst ?? 'unverified';
}

export function summarize(keys, statusOf) {
  const byStatus = Object.fromEntries(STATUS_ORDER.map((s) => [s, 0]));
  let total = 0;
  for (const key of keys) {
    const s = statusOf.get(key);
    if (!s) continue;
    byStatus[s] += 1;
    total += 1;
  }
  const implemented = byStatus.verified + byStatus.manual;
  return { total, byStatus, implemented, percent: total ? Math.round((implemented / total) * 100) : 0 };
}

/** Story badge: worst status plus implemented/total, e.g. "Частично · 6/8". */
export function storySummary(story, statusOf) {
  const keys = activeCriteria(story).map((ac) => acKey(story, ac));
  const sum = summarize(keys, statusOf);
  const status = keys.length ? worstStatus(keys.map((k) => statusOf.get(k))) : 'unverified';
  return { ...sum, status, text: `${STATUS[status].chip} · ${sum.implemented}/${sum.total}` };
}

// ── Reviews ─────────────────────────────────────────────────
// Row shape (one per reviewer per criterion per campaign, see references/review.md):
// { key, reviewerId, kind: 'email'|'anon', name, verdict: 'agree'|'disagree'|null,
//   reasons: string[], comment, fingerprint, campaignId, pin, updatedAt (ISO) }
const emptyEntry = () => ({
  agree: { email: [], anon: [] },
  disagree: { email: [], anon: [] },
  stale: [],
  comments: [],
  replies: [],
  reasons: {},
  mine: null,
  disputed: false,
  awaitingRecheck: false,
});

/**
 * Collapse review rows into per-criterion facts. The latest row per reviewer wins
 * (a reviewer can answer again in a later campaign). Rows for criteria that no longer
 * exist are returned as `orphans` — they are never dropped, an admin re-attaches them.
 */
export function aggregateReviews(index, rows, {
  replies = [], statusOf = null, disputeFrom = 'email', me = null,
} = {}) {
  const latest = new Map();
  for (const row of rows ?? []) {
    const k = `${row.key}\u0000${row.reviewerId}`;
    const prev = latest.get(k);
    if (!prev || String(prev.updatedAt) < String(row.updatedAt)) latest.set(k, row);
  }

  const byKey = new Map();
  const orphans = [];
  const reviewers = new Map();
  for (const row of latest.values()) {
    const crit = index.criteria.get(row.key);
    if (!crit) { orphans.push(row); continue; }
    const entry = byKey.get(row.key) ?? emptyEntry();
    const kind = row.kind === 'anon' ? 'anon' : 'email';
    const stale = Boolean(row.fingerprint) && row.fingerprint !== crit.fingerprint;
    const mark = { id: row.reviewerId, name: row.name, kind, at: row.updatedAt, reasons: row.reasons ?? [] };
    if (row.verdict && stale) entry.stale.push(mark);
    else if (row.verdict === 'agree') entry.agree[kind].push(mark);
    else if (row.verdict === 'disagree') {
      entry.disagree[kind].push(mark);
      for (const r of mark.reasons) entry.reasons[r] = (entry.reasons[r] ?? 0) + 1;
    }
    const text = String(row.comment ?? '').trim();
    if (text) entry.comments.push({ ...mark, text, stale, verdict: row.verdict ?? null, pin: row.pin ?? null });
    if (me && row.reviewerId === me) {
      entry.mine = { verdict: row.verdict ?? null, reasons: row.reasons ?? [], comment: row.comment ?? '', stale, at: row.updatedAt };
    }
    byKey.set(row.key, entry);
    if (!reviewers.has(row.reviewerId)) reviewers.set(row.reviewerId, { id: row.reviewerId, name: row.name, kind });
  }

  for (const reply of replies ?? []) {
    if (!index.criteria.has(reply.key)) continue;
    const entry = byKey.get(reply.key) ?? emptyEntry();
    entry.replies.push(reply);
    byKey.set(reply.key, entry);
  }

  for (const [key, entry] of byKey) {
    entry.comments.sort((a, b) => String(a.at).localeCompare(String(b.at)));
    entry.replies.sort((a, b) => String(a.at).localeCompare(String(b.at)));
    const implemented = statusOf ? STATUS[statusOf.get(key)]?.implemented : true;
    const against = disputeFrom === 'any'
      ? [...entry.disagree.email, ...entry.disagree.anon]
      : entry.disagree.email;
    const lastClosing = [...entry.replies].reverse().find((r) => CLOSING.has(r.resolution));
    const lastFixed = [...entry.replies].reverse().find((r) => r.resolution === 'fixed');
    // A dispute is open while someone disagrees after the last closing reply.
    const open = against.filter((m) => !lastClosing || String(m.at) > String(lastClosing.at));
    entry.disputed = Boolean(implemented) && open.length > 0;
    entry.awaitingRecheck = Boolean(lastFixed) && open.some((m) => String(m.at) <= String(lastFixed.at));
  }

  return { byKey, orphans, reviewers: [...reviewers.values()] };
}

const freshVerdicts = (e) => e
  ? e.agree.email.length + e.agree.anon.length + e.disagree.email.length + e.disagree.anon.length
  : 0;

/** Does one criterion pass a "Рецензия цензоров" filter? */
export function matchesReview(filterId, key, agg, ctx = {}) {
  const e = agg?.byKey.get(key);
  const disagree = e ? e.disagree.email.length + e.disagree.anon.length : 0;
  const agree = e ? e.agree.email.length + e.agree.anon.length : 0;
  switch (filterId) {
    case 'reviewed': return freshVerdicts(e) > 0;
    case 'agreed': return agree > 0 && disagree === 0;
    case 'disagreed': return disagree > 0;
    case 'disputed': return Boolean(e?.disputed);
    case 'commented': return Boolean(e?.comments.length);
    case 'stale': return Boolean(e?.stale.length);
    case 'none': return freshVerdicts(e) === 0 && !e?.comments.length;
    case 'todo': return Boolean(ctx.me) && !(e?.mine?.verdict && !e.mine.stale);
    case 'changed': return Boolean(ctx.me && e?.mine?.stale);
    case 'answered': return Boolean(ctx.me && e?.mine?.verdict === 'disagree' && e.replies.some((r) => String(r.at) > String(e.mine.at)));
    case 'recheck': return Boolean(ctx.recheckKeys?.has(key));
    default: return true;
  }
}

// ── Filters ─────────────────────────────────────────────────
export const FILTER_KEYS = ['scope', 'module', 'epic', 'story', 'status', 'priority', 'review', 'origin', 'release', 'campaign', 'q', 'retired'];

/** Keep only values the model knows; unknown values are dropped, not trusted. */
export function normalizeFilter(index, raw = {}, ctx = {}) {
  const get = (k) => {
    const v = typeof raw.get === 'function' ? raw.get(k) : raw[k];
    return v === undefined || v === null || v === '' || v === 'all' ? null : String(v);
  };
  const f = {};
  const scope = get('scope'); if (scope && index.scopes.has(scope)) f.scope = scope;
  const module = get('module'); if (module && index.modules.has(module)) f.module = module;
  const epic = get('epic'); if (epic && (index.epics.has(epic) || epic === 'none')) f.epic = epic;
  const story = get('story'); if (story && index.stories.has(story)) f.story = story;
  const status = get('status'); if (status && STATUS[status]) f.status = status;
  const priority = get('priority'); if (priority && PRIORITY[priority]) f.priority = priority;
  const review = get('review');
  if (review && REVIEW_FILTERS.some((r) => r.id === review && (!r.needsMe || ctx.me))) f.review = review;
  const origin = get('origin'); if (origin && ORIGIN[origin]) f.origin = origin;
  const release = get('release'); if (release) f.release = release;
  const campaign = get('campaign'); if (campaign && ctx.campaigns?.some((c) => c.id === campaign)) f.campaign = campaign;
  const q = get('q'); if (q && q.trim()) f.q = q.trim().slice(0, 200);
  if (get('retired') === '1') f.retired = true;
  return f;
}

export function filterToQuery(filter) {
  const params = new URLSearchParams();
  for (const k of FILTER_KEYS) if (filter[k] !== undefined && filter[k] !== null && filter[k] !== false) params.set(k, filter[k] === true ? '1' : String(filter[k]));
  return params.toString();
}

const storyText = (story) => normalizeText([story.id, story.title, story.as, story.iWant, story.soThat].join(' '));

function storyPasses(index, story, f) {
  if (f.scope && scopeOf(index, story) !== f.scope) return false;
  if (f.module && story.module !== f.module) return false;
  if (f.epic && (f.epic === 'none' ? Boolean(story.epic) : story.epic !== f.epic)) return false;
  if (f.story && story.id !== f.story) return false;
  if (f.priority && story.priority !== f.priority) return false;
  if (f.origin && (story.origin ?? 'prd') !== f.origin) return false;
  if (f.release && String(story.release ?? '') !== String(f.release)) return false;
  return true;
}

function criterionPasses(story, ac, f, ctx, storyHit) {
  const key = acKey(story, ac);
  if (!f.retired && ac.retired) return false;
  if (f.status && ctx.statusOf.get(key) !== f.status) return false;
  if (f.review && !matchesReview(f.review, key, ctx.reviews, ctx)) return false;
  if (f.campaign) {
    const c = ctx.campaigns?.find((x) => x.id === f.campaign);
    if (!c || !c.keys.includes(key)) return false;
  }
  if (f.q && !storyHit && !normalizeText(`${key} ${ac.text} ${ac.note ?? ''}`).includes(normalizeText(f.q))) return false;
  return true;
}

const hasCriterionFilter = (f) => Boolean(f.status || f.review || f.campaign || f.q);

/**
 * Stories and their criteria under a filter. Story-level filters (scope, module,
 * epic, priority, origin, release) select stories; criterion-level filters (status,
 * review, campaign, text) select criteria and drop stories left with none.
 * ctx: { statusOf, reviews, me, recheckKeys, campaigns }
 */
export function selectEntries(index, ctx, filter = {}) {
  const f = filter;
  const entries = [];
  for (const story of index.prd.stories ?? []) {
    if (!storyPasses(index, story, f)) continue;
    const storyHit = f.q ? storyText(story).includes(normalizeText(f.q)) : false;
    const criteria = (story.criteria ?? []).filter((ac) => criterionPasses(story, ac, f, ctx, storyHit));
    if (criteria.length === 0 && (hasCriterionFilter(f) || activeCriteria(story).length > 0)) continue;
    entries.push({ story, criteria });
  }
  return entries;
}

export const entryKeys = (entries) => entries.flatMap(({ story, criteria }) => criteria.map((ac) => acKey(story, ac)));

/**
 * Facet counts: each group is counted with every OTHER filter applied, so a chip
 * shows exactly how many items clicking it would leave. Criterion facets count
 * criteria; story facets count stories.
 */
export function facetCounts(index, ctx, filter = {}) {
  const without = (k) => { const g = { ...filter }; delete g[k]; return selectEntries(index, ctx, g); };
  const out = { status: {}, review: {}, priority: {}, module: {}, epic: {}, scope: {}, origin: {} };

  const forStatus = without('status');
  out.status.all = entryKeys(forStatus).length;
  for (const s of STATUS_ORDER) out.status[s] = 0;
  for (const key of entryKeys(forStatus)) out.status[ctx.statusOf.get(key)] += 1;

  const forReview = without('review');
  const reviewKeys = entryKeys(forReview);
  out.review.all = reviewKeys.length;
  for (const r of REVIEW_FILTERS) out.review[r.id] = reviewKeys.filter((k) => matchesReview(r.id, k, ctx.reviews, ctx)).length;

  const storyFacet = (name, valueOf) => {
    const entries = without(name);
    out[name].all = entries.length;
    for (const { story } of entries) {
      const v = valueOf(story) ?? 'none';
      out[name][v] = (out[name][v] ?? 0) + 1;
    }
  };
  storyFacet('priority', (s) => s.priority);
  storyFacet('module', (s) => s.module);
  storyFacet('epic', (s) => s.epic);
  storyFacet('scope', (s) => scopeOf(index, s));
  storyFacet('origin', (s) => s.origin ?? 'prd');
  return out;
}

/** Human description of active filters, for report headers and file names. */
export function describeFilter(index, f, ctx = {}) {
  const parts = [];
  if (f.scope) parts.push(`Область: ${index.scopes.get(f.scope)?.title ?? f.scope}`);
  if (f.module) parts.push(`Модуль: ${index.modules.get(f.module)?.title ?? f.module}`);
  if (f.epic) parts.push(`Эпик: ${f.epic === 'none' ? 'без эпика' : `${f.epic} ${index.epics.get(f.epic)?.title ?? ''}`.trim()}`);
  if (f.story) parts.push(`История: ${f.story}`);
  if (f.priority) parts.push(`Приоритет: ${PRIORITY[f.priority]}`);
  if (f.status) parts.push(`Критерий: ${STATUS[f.status].label.toLowerCase()}`);
  if (f.review) parts.push(`Рецензия: ${REVIEW_FILTERS.find((r) => r.id === f.review)?.label.toLowerCase()}`);
  if (f.origin) parts.push(`Источник: ${ORIGIN[f.origin].toLowerCase()}`);
  if (f.release) parts.push(`Релиз: ${f.release}`);
  if (f.campaign) parts.push(`Раунд: ${ctx.campaigns?.find((c) => c.id === f.campaign)?.title ?? f.campaign}`);
  if (f.q) parts.push(`Поиск: «${f.q}»`);
  return parts;
}

export function filterSlug(f) {
  const bits = ['scope', 'module', 'epic', 'story', 'priority', 'status', 'review', 'origin', 'release', 'campaign']
    .filter((k) => f[k]).map((k) => String(f[k]).toLowerCase().replace(/[^a-z0-9-]+/g, '-'));
  return bits.length ? bits.join('_') : 'all';
}

// ── Grouping and matrix ─────────────────────────────────────
/** Group entries by module or by epic, in model order; empty groups are omitted. */
export function groupEntries(index, entries, by = 'module', statusOf = null) {
  const order = by === 'epic'
    ? [...index.epics.values()].map((e) => ({ id: e.id, title: `${e.id} ${e.title}`, item: e }))
    : [...index.modules.values()].map((m) => ({ id: m.id, title: m.title, item: m }));
  const groups = new Map(order.map((g) => [g.id, { ...g, kind: by, entries: [] }]));
  for (const entry of entries) {
    const id = (by === 'epic' ? entry.story.epic : entry.story.module) || 'none';
    if (!groups.has(id)) groups.set(id, { id, title: by === 'epic' ? 'Без эпика' : 'Без модуля', item: null, kind: by, entries: [] });
    groups.get(id).entries.push(entry);
  }
  return [...groups.values()].filter((g) => g.entries.length).map((g) => ({
    ...g,
    summary: statusOf ? summarize(entryKeys(g.entries), statusOf) : null,
  }));
}

/** Epic × module readiness matrix: where the product is thin, on one screen. */
export function epicModuleMatrix(index, entries, statusOf) {
  const cells = new Map();
  const usedEpics = new Set(), usedModules = new Set();
  for (const { story, criteria } of entries) {
    const e = story.epic || 'none', m = story.module || 'none';
    usedEpics.add(e); usedModules.add(m);
    const id = `${e}|${m}`;
    const keys = criteria.filter((ac) => !ac.retired).map((ac) => acKey(story, ac));
    const prev = cells.get(id) ?? { epic: e, module: m, keys: [], stories: 0 };
    prev.keys.push(...keys); prev.stories += 1;
    cells.set(id, prev);
  }
  for (const cell of cells.values()) Object.assign(cell, summarize(cell.keys, statusOf));
  return {
    epics: [...index.epics.values()].filter((e) => usedEpics.has(e.id)).concat(usedEpics.has('none') ? [{ id: 'none', title: 'Без эпика' }] : []),
    modules: [...index.modules.values()].filter((m) => usedModules.has(m.id)),
    cells,
  };
}

// ── Campaigns, re-checks, personal queue ────────────────────
/**
 * Criteria a campaign covers, frozen at start: later PRD growth must not silently
 * widen a round people already agreed to review. scope: { module | epic | story | filter }.
 */
export function campaignKeys(index, ctx, scope = {}) {
  const filter = { ...(scope.filter ?? {}) };
  for (const k of ['module', 'epic', 'story', 'scope', 'priority', 'status', 'review', 'origin', 'release']) {
    if (scope[k]) filter[k] = scope[k];
  }
  return entryKeys(selectEntries(index, ctx, filter));
}

export function campaignProgress(campaign, rows, index = null) {
  const keys = new Set(campaign.keys);
  const perReviewer = new Map();
  const reviewedKeys = new Set();
  for (const row of rows ?? []) {
    if (row.campaignId !== campaign.id || !keys.has(row.key) || !row.verdict) continue;
    if (index) {
      const crit = index.criteria.get(row.key);
      if (crit && row.fingerprint && row.fingerprint !== crit.fingerprint) continue;
    }
    reviewedKeys.add(row.key);
    const r = perReviewer.get(row.reviewerId) ?? { id: row.reviewerId, name: row.name, kind: row.kind, done: new Set() };
    r.done.add(row.key);
    perReviewer.set(row.reviewerId, r);
  }
  return {
    total: keys.size,
    reviewed: reviewedKeys.size,
    percent: keys.size ? Math.round((reviewedKeys.size / keys.size) * 100) : 0,
    reviewers: [...perReviewer.values()].map((r) => ({ ...r, done: r.done.size })),
  };
}

/** Re-check requests still open for a reviewer: answered again after the request? Done. */
export function openRechecks(rechecks, rows, reviewerId) {
  const mineLatest = new Map();
  for (const row of rows ?? []) {
    if (row.reviewerId !== reviewerId) continue;
    if (!mineLatest.has(row.key) || String(mineLatest.get(row.key)) < String(row.updatedAt)) mineLatest.set(row.key, row.updatedAt);
  }
  return (rechecks ?? []).filter((r) => r.reviewerId === reviewerId && !r.doneAt &&
    !(mineLatest.has(r.key) && String(mineLatest.get(r.key)) > String(r.requestedAt)));
}

/** What a reviewer should look at next — the strip above the filters. */
export function personalQueue(index, agg, me, { rechecks = [], rows = [], campaign = null } = {}) {
  if (!me) return null;
  const scope = campaign ? campaign.keys : [...index.criteria.values()].filter((c) => !c.retired).map((c) => c.key);
  const todo = [], changed = [], answered = [];
  for (const key of scope) {
    const e = agg.byKey.get(key);
    const mine = e?.mine;
    if (!mine?.verdict || mine.stale) todo.push(key);
    if (mine?.stale) changed.push(key);
    if (mine?.verdict === 'disagree' && e.replies.some((r) => String(r.at) > String(mine.at))) answered.push(key);
  }
  const recheck = openRechecks(rechecks, rows, me).map((r) => r.key);
  return { todo, changed, answered, recheck };
}

// ── Reports ─────────────────────────────────────────────────
/** One flat row per criterion — CSV, spreadsheets, and the JSON export share it. */
export function reportRows(index, entries, statusOf, agg) {
  const rows = [];
  for (const { story, criteria } of entries) {
    for (const ac of criteria) {
      const key = acKey(story, ac);
      const e = agg?.byKey.get(key);
      rows.push({
        scope: index.scopes.get(scopeOf(index, story))?.title ?? '',
        module: index.modules.get(story.module)?.title ?? story.module ?? '',
        epic: story.epic ? `${story.epic} ${index.epics.get(story.epic)?.title ?? ''}`.trim() : '',
        story: story.id,
        storyTitle: story.title,
        priority: PRIORITY[story.priority] ?? '',
        origin: ORIGIN[story.origin ?? 'prd'],
        key,
        criterion: ac.text,
        status: STATUS[statusOf.get(key)].label,
        agreeEmail: e?.agree.email.length ?? 0,
        agreeAnon: e?.agree.anon.length ?? 0,
        disagreeEmail: e?.disagree.email.length ?? 0,
        disagreeAnon: e?.disagree.anon.length ?? 0,
        disputed: e?.disputed ? 'да' : '',
        stale: e?.stale.length ?? 0,
        comments: (e?.comments ?? []).map((c) => `${c.name}${c.kind === 'anon' ? ' (аноним)' : ''}: ${c.text}`).join(' | '),
      });
    }
  }
  return rows;
}

export const REPORT_COLUMNS = [
  ['scope', 'Область'], ['module', 'Модуль'], ['epic', 'Эпик'], ['story', 'История'],
  ['storyTitle', 'Название истории'], ['priority', 'Приоритет'], ['origin', 'Источник'],
  ['key', 'Критерий'], ['criterion', 'Текст критерия'], ['status', 'Статус реализации'],
  ['agreeEmail', 'Согласны (почта)'], ['agreeAnon', 'Согласны (аноним)'],
  ['disagreeEmail', 'Не согласны (почта)'], ['disagreeAnon', 'Не согласны (аноним)'],
  ['disputed', 'Оспорено'], ['stale', 'Устаревших оценок'], ['comments', 'Комментарии'],
];

/** CSV for Excel in a Russian locale: `;` separator and a UTF-8 BOM, or Excel shows mojibake. */
export function toCsv(rows, columns = REPORT_COLUMNS) {
  const cell = (v) => {
    const s = String(v ?? '');
    return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [columns.map(([, title]) => cell(title)).join(';')];
  for (const row of rows) lines.push(columns.map(([k]) => cell(row[k])).join(';'));
  return `﻿${lines.join('\r\n')}\r\n`;
}

// ── Lock file ───────────────────────────────────────────────
/**
 * prd.lock.json — every id ever issued, with the wording fingerprint of each
 * criterion revision. Commit it. It makes three silent failures loud:
 *  - an id disappeared (reviews and test tags would point at nothing) → error;
 *  - a wording moved to another id (someone renumbered) → error;
 *  - a wording changed → revision bump, old text kept so reviewers see "было → стало".
 */
export function updateLock(index, prevLock = null, { today = new Date().toISOString().slice(0, 10) } = {}) {
  const items = structuredClone(prevLock?.items ?? {});
  const problems = [];
  const changes = [];
  const current = new Map();
  for (const m of index.modules.values()) current.set(`module:${m.id}`, { kind: 'module' });
  for (const e of index.epics.values()) current.set(e.id, { kind: 'epic' });
  for (const s of index.stories.values()) current.set(s.id, { kind: 'story' });
  for (const c of index.criteria.values()) current.set(c.key, { kind: 'ac', crit: c });

  for (const [id, item] of Object.entries(items)) {
    if (!current.has(id)) {
      problems.push({ level: 'error', id, msg: `исчез из PRD. Номера не удаляют и не переиспользуют — верните ${item.kind === 'ac' ? 'критерий с retired: true' : 'запись'}` });
    }
  }

  const prevByFp = new Map();
  for (const [id, item] of Object.entries(items)) if (item.kind === 'ac' && item.fp) prevByFp.set(item.fp, id);

  for (const [id, info] of current) {
    const prev = items[id];
    if (info.kind !== 'ac') {
      if (!prev) { items[id] = { kind: info.kind, issued: today }; changes.push({ id, change: 'new' }); }
      continue;
    }
    const { crit } = info;
    if (!prev) {
      const movedFrom = prevByFp.get(crit.fingerprint);
      if (movedFrom && movedFrom !== id && current.get(movedFrom)?.crit?.fingerprint !== crit.fingerprint) {
        problems.push({ level: 'error', id, msg: `формулировка раньше принадлежала ${movedFrom}. Похоже на перенумерацию: верните прежний номер, новый критерий получает следующий свободный` });
      }
      items[id] = { kind: 'ac', fp: crit.fingerprint, rev: 1, issued: today, history: [{ rev: 1, fp: crit.fingerprint, at: today, text: crit.ac.text }] };
      if (crit.retired) items[id].retired = today;
      changes.push({ id, change: 'new' });
      continue;
    }
    if (prev.fp !== crit.fingerprint) {
      const rev = (prev.rev ?? 1) + 1;
      prev.history = [...(prev.history ?? []), { rev, fp: crit.fingerprint, at: today, text: crit.ac.text }];
      prev.fp = crit.fingerprint;
      prev.rev = rev;
      changes.push({ id, change: 'reworded', rev });
    }
    if (crit.retired && !prev.retired) { prev.retired = today; changes.push({ id, change: 'retired' }); }
    if (!crit.retired && prev.retired) { delete prev.retired; changes.push({ id, change: 'restored' }); }
  }

  const sorted = Object.fromEntries(Object.entries(items).sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true })));
  return { lock: { version: 1, product: index.prd.product?.id ?? null, items: sorted }, problems, changes };
}

/** Previous wording of a criterion, for "было → стало" next to a stale review. */
export function previousWording(lock, key, fp) {
  const hist = lock?.items?.[key]?.history ?? [];
  return hist.find((h) => h.fp === fp)?.text ?? null;
}

// ── Model validation ────────────────────────────────────────
/**
 * Structural checks shared by scripts/validate-prd.mjs and the server at start-up.
 * Each one corresponds to an error that looks fine until someone relies on the page.
 */
export function validatePrd(prd, { tests = null } = {}) {
  const problems = [];
  const err = (id, msg) => problems.push({ level: 'error', id, msg });
  const warn = (id, msg) => problems.push({ level: 'warn', id, msg });
  if (!prd || typeof prd !== 'object') { err('PRD', 'модель не загружена'); return problems; }
  if (!prd.product?.title) warn('product', 'нет product.title — заголовок страницы и отчётов будет пустым');

  const scopeIds = new Set((prd.scopes ?? []).map((s) => s.id));
  const moduleIds = new Set();
  const codes = new Set();
  for (const m of prd.modules ?? []) {
    if (!MODULE_ID.test(m.id ?? '')) err(`module:${m.id}`, 'id модуля — латиница в нижнем регистре, цифры и дефис');
    if (moduleIds.has(m.id)) err(`module:${m.id}`, 'модуль продублирован');
    moduleIds.add(m.id);
    if (!m.title) err(`module:${m.id}`, 'нет title');
    if (m.scope && scopeIds.size && !scopeIds.has(m.scope)) err(`module:${m.id}`, `неизвестная область «${m.scope}»`);
    if (m.code) { if (codes.has(m.code)) warn(`module:${m.id}`, `код ${m.code} уже занят другим модулем`); codes.add(m.code); }
  }
  if (moduleIds.size === 0) err('modules', 'нет ни одного модуля');

  const epicIds = new Set();
  for (const e of prd.epics ?? []) {
    if (!EPIC_ID.test(e.id ?? '')) err(e.id ?? 'epic', 'id эпика — EP-01, EP-02…');
    if (epicIds.has(e.id)) err(e.id, 'эпик продублирован');
    epicIds.add(e.id);
    if (!e.title) err(e.id, 'нет title');
    if (e.priority && !PRIORITY[e.priority]) err(e.id, `неизвестный приоритет «${e.priority}»`);
  }
  if (epicIds.size === 0) warn('epics', 'эпики не заданы: группировка «по эпикам» и матрица будут пустыми');

  const storyIds = new Set();
  const usedEpics = new Set(), usedModules = new Set();
  const allKeys = new Set();
  const results = tests?.results ?? tests ?? null;
  for (const [i, story] of (prd.stories ?? []).entries()) {
    const sid = story.id ?? `#${i}`;
    if (!STORY_ID.test(story.id ?? '')) { err(sid, 'id истории — US-<КОД>-001'); continue; }
    if (storyIds.has(story.id)) err(sid, 'история продублирована');
    storyIds.add(story.id);
    if (!moduleIds.has(story.module)) err(sid, `неизвестный модуль «${story.module}»`);
    usedModules.add(story.module);
    if (epicIds.size) {
      if (!story.epic) err(sid, 'у истории нет эпика (story.epic) — эпики в модели заданы, значит обязательны');
      else if (!epicIds.has(story.epic)) err(sid, `неизвестный эпик «${story.epic}»`);
    }
    if (story.epic) usedEpics.add(story.epic);
    if (!PRIORITY[story.priority]) err(sid, `неизвестный приоритет «${story.priority}»`);
    if (!story.title) err(sid, 'нет title');
    if (!story.as || !story.iWant) warn(sid, 'нет формулировки «Как …, я хочу …» — рецензенту не понятен контекст критериев');
    if (story.origin && !ORIGIN[story.origin]) err(sid, `неизвестный origin «${story.origin}»`);
    if (!Array.isArray(story.criteria) || story.criteria.length === 0) { warn(sid, 'нет критериев приёмки'); continue; }

    const acIds = new Set();
    let maxNum = 0;
    for (const ac of story.criteria) {
      const key = `${story.id}/${ac.id}`;
      if (!AC_ID.test(ac.id ?? '')) { err(key, 'id критерия — AC1, AC2…'); continue; }
      if (acIds.has(ac.id)) err(key, 'критерий продублирован');
      acIds.add(ac.id);
      allKeys.add(key);
      maxNum = Math.max(maxNum, Number(ac.id.slice(2)));
      if (!String(ac.text ?? '').trim()) err(key, 'пустой текст: по нему нельзя понять, что проверять');
      if (ac.status && !DECLARED.includes(ac.status)) err(key, `статус «${ac.status}»: допустимы ${DECLARED.join(', ')}`);
      if (ac.retired) continue;
      const t = results?.[key];
      if (ac.status === 'done' && !t && !hasEvidence(ac, story)) {
        warn(key, 'done без автотеста и без evidence — будет показан как «не проверено». Добавьте тест с меткой или evidence');
      }
      if (ac.status === 'missing' && (t?.passed ?? 0) > 0 && !t.failed) warn(key, 'объявлен missing, но связанные тесты проходят — проверьте статус или метку теста');
      if ((story.origin === 'reverse') && !(ac.code?.length)) warn(key, 'восстановленный критерий без ссылки на код (ac.code: ["file:line"])');
      if (ac.howToVerify && !Array.isArray(ac.howToVerify.steps)) err(key, 'howToVerify.steps должен быть массивом шагов');
      if (ac.links?.route && !String(ac.links.route).startsWith('/')) err(key, 'links.route — путь от корня, начинается с /');
    }
    for (const ac of story.criteria) {
      if (ac.replaces) for (const r of [].concat(ac.replaces)) {
        if (!String(r).includes('/')) err(`${story.id}/${ac.id}`, `replaces: «${r}» — нужен полный ключ US-…/ACn`);
      }
    }
  }
  for (const story of prd.stories ?? []) for (const ac of story.criteria ?? []) {
    for (const r of [].concat(ac.replaces ?? [])) if (String(r).includes('/') && !allKeys.has(r)) {
      err(`${story.id}/${ac.id}`, `replaces ссылается на несуществующий ${r} (заменённый критерий остаётся в модели с retired: true)`);
    }
  }
  for (const id of epicIds) if (!usedEpics.has(id)) warn(id, 'у эпика нет историй');
  for (const id of moduleIds) if (!usedModules.has(id)) warn(`module:${id}`, 'у модуля нет историй');
  if (results) for (const key of Object.keys(results)) if (!allKeys.has(key)) warn(key, 'метка теста указывает на несуществующий критерий');
  return problems;
}
