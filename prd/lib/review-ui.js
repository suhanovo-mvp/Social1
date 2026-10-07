// PRD review UI — the review page, the "check one by one" focus mode and the panel
// that lives inside the prototype. Vanilla ES module, no dependencies, works in any
// stack: React/Next/Vue pages mount it into a container, static prototypes include it
// with a <script type="module">.
//
//   import { mountReviewPage } from './review-ui.js';
//   mountReviewPage(document.getElementById('prd'), { api: '/api/prd' });
//
//   import { mountReviewPanel } from './review-ui.js';   // in the prototype's root layout
//   mountReviewPanel({ api: '/api/prd' });                // invisible until ?review=1
//
// Both views share one controller, one API client and prd-core.js, so the page, the
// panel and the PDF can never count differently. Styles are injected once (scoped by
// .prd-root) or into the panel's shadow root; override the --prd-* variables to theme.
import * as core from './prd-core.js';

// ── Small helpers ───────────────────────────────────────────
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const attr = esc;
function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  const w = m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
  return `${n} ${w}`;
}
const fmtDate = (iso) => {
  if (!iso) return '';
  const d = new Date(String(iso).length === 10 ? `${iso}T00:00:00` : iso);
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }).replace(/\s*г\.$/, '');
};
const fmtDateTime = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
};
const store = {
  get(k, d = null) { try { const v = sessionStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch { /* приватный режим */ } },
};
const cssEscape = (s) => (window.CSS?.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&'));
const anchorSelector = (key) => `[data-ac~="${cssEscape(key)}"]`;

// ── API client ──────────────────────────────────────────────
function createClient(base) {
  // Ссылка доступа (?k=…) нужна серверу один раз: он поставит cookie.
  const k = new URLSearchParams(location.search).get('k');
  async function call(method, path, body) {
    const url = `${base}${path}${method === 'GET' && k && path === '/state' ? `${path.includes('?') ? '&' : '?'}k=${encodeURIComponent(k)}` : ''}`;
    const res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-PRD-Request': '1' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || `Ошибка ${res.status}`), { status: res.status, data });
    return data;
  }
  return {
    base,
    state: () => call('GET', '/state'),
    anonymous: (name) => call('POST', '/session/anonymous', { name }),
    requestCode: (email, name, consent) => call('POST', '/session/email', { email, name, consent }),
    verify: (email, code, name) => call('POST', '/session/verify', { email, code, name }),
    logout: () => call('POST', '/session/logout', {}),
    review: (payload) => call('PUT', '/reviews', payload),
    history: () => call('GET', '/me/history'),
    devMail: () => call('GET', '/dev/mail'),
    admin: {
      createCampaign: (b) => call('POST', '/admin/campaigns', b),
      toggleCampaign: (id) => call('POST', `/admin/campaigns/${encodeURIComponent(id)}/close`, {}),
      reply: (b) => call('POST', '/admin/replies', b),
      recheck: (b) => call('POST', '/admin/rechecks', b),
      reviewers: () => call('GET', '/admin/reviewers'),
      orphans: () => call('GET', '/admin/orphans'),
      attach: (from, to) => call('POST', '/admin/orphans/attach', { from, to }),
    },
  };
}

// ── Controller: state shared by page, focus mode and panel ──
class Controller {
  constructor({ api = '/api/prd', routeFor = null, prototypeBase = '' } = {}) {
    this.client = createClient(api);
    this.routeFor = routeFor;
    this.prototypeBase = prototypeBase;
    this.data = null;
    this.drafts = new Map();      // key → { comment } — набранный текст переживает перерисовку
    this.campaign = store.get('prd-campaign');
    this.listeners = new Set();
    this.saving = new Set();
    this.error = null;
  }
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(what = 'all', key = null) { for (const fn of this.listeners) fn(what, key); }

  async load() {
    try {
      this.data = await this.client.state();
      this.error = null;
    } catch (e) {
      this.error = e;
    }
    this.rebuild();
    this.emit('all');
    // Оценка, начатая до выбора способа рецензирования, сохраняется сразу после входа
    if (this.me && this.pending) { const p = this.pending; this.pending = null; this.saveReview(p.key, p.patch); }
  }

  rebuild() {
    if (!this.data) return;
    this.index = core.indexPrd(this.data.prd);
    this.statusOf = new Map(Object.entries(this.data.statuses));
    this.agg = { byKey: new Map(Object.entries(this.data.reviews ?? {})) };
    this.recheckKeys = new Set(this.data.queue?.recheck ?? []);
    if (this.campaign && !this.openCampaigns().some((c) => c.id === this.campaign)) this.setCampaign(null);
    // Ключ → релиз, в котором критерий впервые упомянут: «Реализовано в 0.4.0».
    this.releaseOf = new Map();
    for (const rel of [...(this.data.releases ?? [])].reverse()) {
      for (const ch of rel.changes ?? []) for (const ref of ch.refs ?? []) if (!this.releaseOf.has(ref)) this.releaseOf.set(ref, rel.version);
    }
  }

  get me() { return this.data?.me ?? null; }
  ctx() {
    return { statusOf: this.statusOf, reviews: this.agg, me: this.me?.id ?? null, recheckKeys: this.recheckKeys, campaigns: this.data?.campaigns ?? [] };
  }
  openCampaigns() { return (this.data?.campaigns ?? []).filter((c) => !c.closedAt); }
  setCampaign(id) { this.campaign = id; store.set('prd-campaign', id); }
  entry(key) { return this.agg?.byKey.get(key) ?? null; }
  crit(key) { return this.index?.criteria.get(key) ?? null; }

  protoUrl(story, ac) {
    const key = core.acKey(story, ac);
    if (this.routeFor) return this.routeFor(story, ac, key);
    const route = ac.links?.route ?? story.route ?? this.index.modules.get(story.module)?.route;
    if (!route) return null;
    const url = new URL(`${this.prototypeBase}${route}`, location.origin);
    url.searchParams.set('review', '1');
    url.searchParams.set('prd-highlight', key);
    return url.pathname + url.search + url.hash;
  }

  async saveReview(key, patch) {
    if (!this.me) { this.pending = { key, patch }; this.emit('need-session', key); return; }
    const mine = this.entry(key)?.mine ?? {};
    const draft = this.drafts.get(key) ?? {};
    const payload = {
      key,
      verdict: 'verdict' in patch ? patch.verdict : (mine.stale ? null : mine.verdict ?? null),
      reasons: 'reasons' in patch ? patch.reasons : mine.reasons ?? [],
      comment: 'comment' in patch ? patch.comment : (draft.comment ?? mine.comment ?? ''),
      campaignId: this.campaign && this.openCampaigns().find((c) => c.id === this.campaign)?.keys.includes(key) ? this.campaign : null,
    };
    if (patch.pin) payload.pin = patch.pin;
    else if ('comment' in patch && draft.pin) payload.pin = draft.pin;
    this.saving.add(key);
    this.emit('criterion', key);
    try {
      const res = await this.client.review(payload);
      if (res.entry) this.data.reviews[key] = res.entry; else delete this.data.reviews[key];
      this.data.queue = res.queue;
      if ('comment' in patch) this.drafts.delete(key);
      this.rebuild();
      this.toast('comment' in patch ? 'Комментарий сохранён' : payload.verdict === 'agree' ? 'Сохранено: согласен' : payload.verdict === 'disagree' ? 'Сохранено: не согласен' : 'Отметка снята');
    } catch (e) {
      if (e.data?.needSession) { this.data.me = null; this.emit('need-session', key); }
      this.toast(e.message, true);
    } finally {
      this.saving.delete(key);
      this.emit('review-saved', key);
    }
  }

  toast(text, isError = false) { this.emit('toast', { text, isError }); }
}

// ── Shared templates ────────────────────────────────────────
function markHtml(status) {
  const s = core.STATUS[status] ?? core.STATUS.unverified;
  return `<span class="prd-mark prd-tone-${s.tone}" title="${attr(s.label)}" aria-label="${attr(s.label)}">${s.mark}</span>`;
}

function chipHtml({ act, name, value, text, count, active, disabled = false, extra = '' }) {
  return `<button type="button" class="prd-chip${active ? ' is-active' : ''}${disabled && !active ? ' is-empty' : ''}" data-act="${act}" data-name="${attr(name)}" data-value="${attr(value ?? '')}" aria-pressed="${active}" ${extra}>${text}${count !== undefined ? `<span class="prd-chip__n"> · ${count}</span>` : ''}</button>`;
}

function reviewSummaryHtml(e) {
  if (!e) return '';
  const a = e.agree.email.length, aa = e.agree.anon.length;
  const d = e.disagree.email.length, da = e.disagree.anon.length;
  const bits = [];
  if (a || d) bits.push(`<span title="С подтверждённой почтой">👍 ${a} · 👎 ${d}</span>`);
  if (aa || da) bits.push(`<span class="prd-muted" title="Анонимные оценки считаются отдельно">аноним 👍 ${aa} · 👎 ${da}</span>`);
  if (e.stale.length) bits.push(`<span class="prd-badge prd-tone-muted" title="Оценки к прежней формулировке">устарело ${e.stale.length}</span>`);
  if (e.disputed) bits.push('<span class="prd-badge prd-tone-bad">Оспорено</span>');
  if (e.awaitingRecheck) bits.push('<span class="prd-badge prd-tone-warn">Исправлено — ждёт перепроверки</span>');
  return bits.length ? `<div class="prd-review-sum">${bits.join('')}</div>` : '';
}

function commentsHtml(c, key, e) {
  if (!e || (!e.comments.length && !e.replies.length)) return '';
  const reasons = c.data.config.reasons ?? core.REASONS;
  const items = [
    ...e.comments.map((x) => ({ at: x.at, html: `<li class="prd-comment${x.stale ? ' is-stale' : ''}">
      <div class="prd-comment__head"><strong>${esc(x.name)}</strong>${x.kind === 'anon' ? ' <span class="prd-badge prd-tone-muted">аноним</span>' : ''}
      ${x.verdict === 'agree' ? '<span class="prd-badge prd-tone-good">согласен</span>' : x.verdict === 'disagree' ? '<span class="prd-badge prd-tone-bad">не согласен</span>' : ''}
      ${(x.reasons ?? []).map((r) => `<span class="prd-badge">${esc(reasons[r] ?? r)}</span>`).join('')}
      ${x.stale ? '<span class="prd-badge prd-tone-muted">к прежней формулировке</span>' : ''}
      <span class="prd-muted">${esc(fmtDateTime(x.at))}</span>
      ${x.pin ? `<a class="prd-link" href="${attr(pinUrl(x.pin, key))}" target="_blank" rel="noopener">📍 на экране</a>` : ''}</div>
      <div class="prd-comment__text">${esc(x.text)}</div></li>` })),
    ...e.replies.map((r) => ({ at: r.at, html: `<li class="prd-comment prd-comment--reply">
      <div class="prd-comment__head"><strong>${esc(r.author)}</strong> <span class="prd-badge prd-tone-accent">ответ команды</span>
      ${r.resolution ? `<span class="prd-badge">${esc((c.data.config.resolutions ?? core.RESOLUTIONS)[r.resolution] ?? r.resolution)}</span>` : ''}
      <span class="prd-muted">${esc(fmtDateTime(r.at))}</span></div>
      <div class="prd-comment__text">${esc(r.text)}</div></li>` })),
  ].sort((x, y) => String(x.at).localeCompare(String(y.at)));
  return `<ul class="prd-comments">${items.map((i) => i.html).join('')}</ul>`;
}

function pinUrl(pin, key) {
  const url = new URL(pin.route || '/', location.origin);
  url.searchParams.set('review', '1');
  url.searchParams.set('prd-highlight', key);
  url.searchParams.set('prd-pin', pin.selector);
  return url.pathname + url.search;
}

function reviewControlHtml(c, key, { compact = false } = {}) {
  const crit = c.crit(key);
  if (!crit || crit.retired) return '';
  const e = c.entry(key);
  const mine = e?.mine && !e.mine.stale ? e.mine : null;
  const verdict = mine?.verdict ?? null;
  const reasons = c.data.config.reasons ?? core.REASONS;
  const draft = c.drafts.get(key)?.comment;
  const comment = draft ?? mine?.comment ?? '';
  const busy = c.saving.has(key);
  const pending = c.drafts.get(key)?.pin;
  const reverse = crit.story.origin === 'reverse';
  return `<div class="prd-control${busy ? ' is-busy' : ''}" data-control="${attr(key)}">
    ${e?.mine?.stale ? '<p class="prd-note prd-tone-warn">Вы оценивали прежнюю формулировку — посмотрите и оцените заново.</p>' : ''}
    <div class="prd-control__row">
      <span class="prd-control__q">${reverse ? 'Так и должно работать?' : 'Реализовано верно?'}</span>
      <button type="button" class="prd-btn prd-btn--verdict${verdict === 'agree' ? ' is-agree' : ''}" data-act="verdict" data-key="${attr(key)}" data-verdict="agree" aria-pressed="${verdict === 'agree'}" title="Согласен (A)">👍 Согласен</button>
      <button type="button" class="prd-btn prd-btn--verdict${verdict === 'disagree' ? ' is-disagree' : ''}" data-act="verdict" data-key="${attr(key)}" data-verdict="disagree" aria-pressed="${verdict === 'disagree'}" title="Не согласен (D)">👎 Не согласен</button>
      ${busy ? '<span class="prd-muted">сохраняем…</span>' : mine?.at ? `<span class="prd-muted">сохранено ${esc(fmtDateTime(mine.at))}</span>` : ''}
    </div>
    ${verdict === 'disagree' ? `<div class="prd-control__reasons" role="group" aria-label="Причина">${Object.entries(reasons).map(([id, label], i) =>
      chipHtml({ act: 'reason', name: key, value: id, text: `${compact ? '' : `<kbd>${i + 1}</kbd> `}${esc(label)}`, active: mine?.reasons?.includes(id) })).join('')}</div>` : ''}
    ${pending ? '<p class="prd-note">📍 Комментарий будет приколот к выбранному элементу экрана.</p>' : ''}
    ${c.me ? '' : '<p class="prd-muted prd-small">Первая оценка предложит выбрать способ рецензирования — анонимно или с почтой — и сохранится сразу после этого.</p>'}
    <div class="prd-control__comment">
      <textarea class="prd-input" rows="${compact ? 2 : 2}" maxlength="2000" placeholder="Комментарий к критерию (необязательно). ⌘/Ctrl+Enter — сохранить" data-draft="${attr(key)}">${esc(comment)}</textarea>
      <button type="button" class="prd-btn" data-act="save-comment" data-key="${attr(key)}" ${draft === undefined ? 'disabled' : ''}>Сохранить комментарий</button>
    </div>
  </div>`;
}

function testsHtml(c, key) {
  const t = c.data.tests?.byKey?.[key];
  if (!t) return '';
  const failedNames = (t.tests ?? []).filter((x) => x.status === 'failed').map((x) => x.name);
  if (t.failed) return `<div class="prd-tests prd-tone-bad">🔴 ${plural(t.failed, 'тест падает', 'теста падают', 'тестов падают')}${failedNames.length ? `: ${esc(failedNames.slice(0, 2).join('; '))}` : ''}</div>`;
  if (t.passed) return `<div class="prd-tests prd-tone-good">${plural(t.passed, 'автотест проходит', 'автотеста проходят', 'автотестов проходят')}</div>`;
  if (t.skipped) return `<div class="prd-tests prd-muted">${plural(t.skipped, 'тест пропущен', 'теста пропущены', 'тестов пропущено')}</div>`;
  return '';
}

function howToHtml(ac) {
  const h = ac.howToVerify;
  if (!h) return '';
  return `<details class="prd-howto"><summary>Как проверить</summary>
    ${h.given ? `<p><strong>Подготовка:</strong> ${esc(h.given)}</p>` : ''}
    ${h.steps?.length ? `<ol>${h.steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>` : ''}
    ${h.data ? `<p><strong>Данные:</strong> ${esc(h.data)}</p>` : ''}
    ${h.expect ? `<p><strong>Ожидается:</strong> ${esc(h.expect)}</p>` : ''}
  </details>`;
}

function revisionHtml(c, key) {
  const r = c.data.revisions?.[key];
  const e = c.entry(key);
  if (!r || !(e?.stale?.length || e?.mine?.stale)) return '';
  const prev = r.history?.[r.history.length - 2];
  return prev ? `<p class="prd-note">Формулировка изменена ${esc(fmtDate(r.history.at(-1).at))} (ред. ${r.rev}). Было: «${esc(prev.text)}»</p>` : '';
}

function criterionHtml(c, story, ac, { admin = false } = {}) {
  const key = core.acKey(story, ac);
  const status = c.statusOf.get(key);
  const e = c.entry(key);
  const url = c.protoUrl(story, ac);
  const rel = c.releaseOf.get(key);
  return `<li class="prd-ac${ac.retired ? ' is-retired' : ''}" data-key="${attr(key)}" id="${attr(key)}">
    <div class="prd-ac__main">
      ${markHtml(status)}
      <div class="prd-ac__body">
        <div class="prd-ac__text"><a class="prd-ac__id" href="#${attr(key)}" title="Ссылка на критерий">${esc(ac.id)}</a> ${esc(ac.text)}
          ${ac.retired ? '<span class="prd-badge prd-tone-muted">выведен из PRD</span>' : ''}
          ${core.STATUS[status].implemented ? '' : `<span class="prd-badge prd-tone-${core.STATUS[status].tone}">${esc(core.STATUS[status].label)}</span>`}
        </div>
        ${ac.note ? `<div class="prd-ac__note">${esc(ac.note)}</div>` : ''}
        ${testsHtml(c, key)}
        ${ac.code?.length ? `<div class="prd-ac__note">Где в коде: ${ac.code.map((x) => `<code>${esc(x)}</code>`).join(', ')}</div>` : ''}
        ${revisionHtml(c, key)}
        <div class="prd-ac__meta">
          ${reviewSummaryHtml(e)}
          ${rel ? `<span class="prd-muted">в релизе ${esc(rel)}</span>` : ''}
          ${url && !ac.retired ? `<a class="prd-link" href="${attr(url)}" target="_blank" rel="noopener" title="Откроет экран и подсветит элемент">Показать в прототипе ↗</a>` : ''}
        </div>
        ${howToHtml(ac)}
        ${commentsHtml(c, key, e)}
        ${reviewControlHtml(c, key)}
        ${admin && !ac.retired ? `<div class="prd-admin-row">
          <button type="button" class="prd-btn prd-btn--ghost" data-act="admin-reply-open" data-key="${attr(key)}">Ответить</button>
          <button type="button" class="prd-btn prd-btn--ghost" data-act="admin-recheck" data-key="${attr(key)}">Запросить перепроверку</button>
          <div class="prd-admin-reply" data-reply="${attr(key)}" hidden>
            <textarea class="prd-input" rows="2" maxlength="4000" placeholder="Ответ рецензентам"></textarea>
            <select class="prd-input"><option value="">Без решения</option>${Object.entries(c.data.config.resolutions ?? core.RESOLUTIONS).map(([id, label]) => `<option value="${attr(id)}">${esc(label)}</option>`).join('')}</select>
            <button type="button" class="prd-btn prd-btn--primary" data-act="admin-reply" data-key="${attr(key)}">Отправить</button>
          </div></div>` : ''}
      </div>
    </div>
  </li>`;
}

function panelGroupsHtml(c, items, tools) {
  const order = [...c.index.criteria.keys()];
  const sorted = [...items].sort((a, b) => order.indexOf(core.acKey(a.story, a.ac)) - order.indexOf(core.acKey(b.story, b.ac)));
  const epics = new Map();
  for (const it of sorted) {
    const eid = it.story.epic ?? '';
    if (!epics.has(eid)) epics.set(eid, new Map());
    const stories = epics.get(eid);
    if (!stories.has(it.story.id)) stories.set(it.story.id, { story: it.story, acs: [] });
    stories.get(it.story.id).acs.push(it.ac);
  }
  const epicOrder = [...(c.index.epics?.keys?.() ?? [])];
  return [...epics.entries()].sort(([a], [b]) => epicOrder.indexOf(a) - epicOrder.indexOf(b)).map(([eid, stories]) => {
    const epic = eid ? c.index.epics.get(eid) : null;
    return `<section class="prd-pgroup">
      ${epic ? `<div class="prd-pgroup__epic"><span class="prd-pgroup__id">${esc(epic.id)}</span> ${esc(epic.title)}</div>` : ''}
      ${[...stories.values()].map(({ story, acs }) => {
        const mod = c.index.modules.get(story.module);
        return `<div class="prd-pstory" data-priority="${attr(story.priority)}"><div class="prd-pgroup__story">
          <div class="prd-pgroup__story-title"><span class="prd-pgroup__id">${esc(story.id)}</span> ${esc(story.title)}
            ${core.PRIORITY[story.priority] ? `<span class="prd-badge prd-tone-muted">${esc(core.PRIORITY[story.priority])}</span>` : ''}</div>
          ${story.as ? `<div class="prd-muted prd-small">Как ${esc(story.as)}, я хочу ${esc(story.iWant)}${story.soThat ? `, чтобы ${esc(story.soThat)}` : ''}.</div>` : ''}
          ${mod ? `<div class="prd-muted prd-small">Модуль: ${esc(mod.title)}</div>` : ''}
        </div>
        <ul class="prd-acs">${acs.map((ac) => `${criterionHtml(c, story, ac)}${tools(core.acKey(story, ac))}`).join('')}</ul></div>`;
      }).join('')}
    </section>`;
  }).join('');
}

function storyHtml(c, story, criteria, opts = {}) {
  const sum = core.storySummary(story, c.statusOf);
  const epic = story.epic ? c.index.epics.get(story.epic) : null;
  const mod = c.index.modules.get(story.module);
  return `<article class="prd-story" data-story="${attr(story.id)}">
    <header class="prd-story__head">
      <h3 class="prd-story__title"><span class="prd-story__id">${esc(story.id)}</span> ${esc(story.title)}</h3>
      <div class="prd-story__badges">
        <span class="prd-badge">${esc(core.PRIORITY[story.priority] ?? '')}</span>
        ${story.origin && story.origin !== 'prd' ? `<span class="prd-badge prd-tone-accent" title="${story.origin === 'reverse' ? 'Требование описывает то, что уже сделано в коде; подтвердите, что так и должно быть' : 'Перенесено из документа'}">${esc(core.ORIGIN[story.origin])}</span>` : ''}
        <span class="prd-badge prd-badge--status prd-tone-${core.STATUS[sum.status].tone}">${core.STATUS[sum.status].mark} ${esc(sum.text)}</span>
      </div>
    </header>
    ${story.as ? `<p class="prd-story__text">Как <strong>${esc(story.as)}</strong>, я хочу ${esc(story.iWant)}${story.soThat ? `, чтобы ${esc(story.soThat)}` : ''}.${story.intent === 'inferred' ? ' <span class="prd-muted" title="Цель восстановлена по коду и требует подтверждения">(цель предположена)</span>' : ''}</p>` : ''}
    <div class="prd-story__chips">
      ${epic ? `<button type="button" class="prd-tag" data-act="filter" data-name="epic" data-value="${attr(epic.id)}">${esc(epic.id)} · ${esc(epic.title)}</button>` : ''}
      ${mod ? `<button type="button" class="prd-tag" data-act="filter" data-name="module" data-value="${attr(mod.id)}">${esc(mod.title)}</button>` : ''}
      ${story.release ? `<span class="prd-tag">Релиз ${esc(story.release)}</span>` : ''}
    </div>
    <ul class="prd-acs">${criteria.map((ac) => criterionHtml(c, story, ac, opts)).join('')}</ul>
  </article>`;
}

// ── Session dialog: choose anonymous or email, confirm the email, then review ──
function openSessionDialog(c, host = document.body) {
  const dlg = document.createElement('dialog');
  dlg.className = 'prd-dialog prd-root';
  host.appendChild(dlg);
  const cfg = c.data?.config ?? {};
  let step = cfg.allowAnonymous ? 'choose' : 'email';
  let email = '', name = '', cooldownUntil = 0, timer = null;

  const render = (error = '') => {
    if (step === 'choose') {
      dlg.innerHTML = `<form method="dialog" class="prd-dialog__body">
        <h2>Как вы хотите рецензировать?</h2>
        <div class="prd-choice">
          <button type="button" class="prd-choice__card" data-step="anon"><strong>Анонимно</strong>
            <span>Оценки сохранятся сразу. Вернуться к ним можно только в этом браузере. Анонимные голоса показываются отдельно от подтверждённых.</span></button>
          <button type="button" class="prd-choice__card" data-step="email"><strong>С подтверждением почты</strong>
            <span>История ваших оценок сохраняется и доступна с любого устройства. Адрес видит только администратор проекта.</span></button>
        </div>
        <div class="prd-dialog__foot"><button class="prd-btn" value="cancel">Отмена</button></div></form>`;
    } else if (step === 'anon') {
      dlg.innerHTML = `<form class="prd-dialog__body" data-form="anon">
        <h2>Анонимное рецензирование</h2>
        <label class="prd-field"><span>Как подписать ваши оценки (необязательно)</span>
          <input class="prd-input" name="name" maxlength="40" autocomplete="nickname" placeholder="например, Гость из маркетинга"></label>
        ${error ? `<p class="prd-error" role="alert">${esc(error)}</p>` : ''}
        <div class="prd-dialog__foot">${cfg.allowAnonymous ? '<button type="button" class="prd-btn" data-step="choose">Назад</button>' : ''}
          <button class="prd-btn prd-btn--primary" type="submit">Начать рецензирование</button></div></form>`;
    } else if (step === 'email') {
      dlg.innerHTML = `<form class="prd-dialog__body" data-form="email">
        <h2>Подтвердите почту</h2>
        <p class="prd-muted">Пришлём шестизначный код. После подтверждения вы сразу перейдёте к рецензированию.</p>
        <label class="prd-field"><span>Почта</span><input class="prd-input" name="email" type="email" required autocomplete="email" value="${attr(email)}"></label>
        <label class="prd-field"><span>Имя для подписи под оценками</span><input class="prd-input" name="name" maxlength="40" autocomplete="name" value="${attr(name)}" placeholder="Мария Иванова"></label>
        <label class="prd-check"><input type="checkbox" name="consent" required> <span>Согласен на обработку адреса почты для подтверждения и подписи моих оценок</span></label>
        ${error ? `<p class="prd-error" role="alert">${esc(error)}</p>` : ''}
        <div class="prd-dialog__foot">${cfg.allowAnonymous ? '<button type="button" class="prd-btn" data-step="choose">Назад</button>' : '<button type="button" class="prd-btn" data-close>Отмена</button>'}
          <button class="prd-btn prd-btn--primary" type="submit">Получить код</button></div></form>`;
    } else if (step === 'code') {
      const left = Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000));
      dlg.innerHTML = `<form class="prd-dialog__body" data-form="code">
        <h2>Введите код из письма</h2>
        <p class="prd-muted">Код отправлен на <strong>${esc(email)}</strong>. Он действует 10 минут.</p>
        <input class="prd-input prd-input--code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]{6,7}" maxlength="7" required placeholder="000000" aria-label="Код из письма">
        ${cfg.devMail ? '<p class="prd-note">Режим разработки: письма не отправляются. <button type="button" class="prd-link" data-devmail>Показать код</button></p>' : ''}
        ${error ? `<p class="prd-error" role="alert">${esc(error)}</p>` : ''}
        <div class="prd-dialog__foot"><button type="button" class="prd-btn" data-step="email">Изменить почту</button>
          <button type="button" class="prd-btn" data-resend ${left ? 'disabled' : ''}>${left ? `Новый код через ${left} с` : 'Отправить код ещё раз'}</button>
          <button class="prd-btn prd-btn--primary" type="submit">Подтвердить</button></div></form>`;
    }
    dlg.querySelector('input:not([type=checkbox])')?.focus();
  };

  const tick = () => {
    clearInterval(timer);
    timer = setInterval(() => {
      if (step !== 'code') return clearInterval(timer);
      const btn = dlg.querySelector('[data-resend]');
      const left = Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000));
      if (btn) { btn.disabled = left > 0; btn.textContent = left ? `Новый код через ${left} с` : 'Отправить код ещё раз'; }
      if (!left) clearInterval(timer);
    }, 1000);
  };
  const done = async () => { dlg.close(); await c.load(); c.toast('Можно рецензировать'); };
  const sendCode = async () => {
    const res = await c.client.requestCode(email, name, true);
    cooldownUntil = Date.now() + (res.cooldownSeconds ?? 60) * 1000;
    step = 'code'; render(); tick();
  };

  dlg.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-step],[data-resend],[data-devmail],[data-close]');
    if (!t) return;
    if (t.dataset.close !== undefined) return dlg.close();
    if (t.dataset.step) { step = t.dataset.step; render(); return; }
    if (t.dataset.resend !== undefined) { try { await sendCode(); } catch (err) { render(err.message); } return; }
    if (t.dataset.devmail !== undefined) {
      const { letters } = await c.client.devMail();
      const code = letters.find((l) => l.to === email)?.text.match(/\d{6}/)?.[0];
      const input = dlg.querySelector('[name=code]');
      if (code && input) input.value = code;
    }
  });
  dlg.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const fd = new FormData(form);
    const btn = form.querySelector('[type=submit]');
    if (btn) btn.disabled = true;
    try {
      if (form.dataset.form === 'anon') { await c.client.anonymous(fd.get('name')); await done(); }
      if (form.dataset.form === 'email') {
        email = String(fd.get('email') ?? '').trim(); name = String(fd.get('name') ?? '').trim();
        await sendCode();
      }
      if (form.dataset.form === 'code') { await c.client.verify(email, fd.get('code'), name); await done(); }
    } catch (err) {
      if (err.data?.retryAfter && form.dataset.form === 'email') { cooldownUntil = Date.now() + err.data.retryAfter * 1000; }
      render(err.message);
    }
  });
  dlg.addEventListener('close', () => { clearInterval(timer); dlg.remove(); });
  render();
  dlg.showModal();
}

// ── Focus mode: one criterion at a time next to the live prototype ──
function openFocus(c, keys, startKey = null) {
  if (!keys.length) { c.toast('Под текущие фильтры не попал ни один критерий', true); return; }
  if (!c.me) { openSessionDialog(c); return; }
  const wrap = document.createElement('div');
  wrap.className = 'prd-focus prd-root';
  wrap.setAttribute('role', 'dialog');
  wrap.setAttribute('aria-label', 'Проверка критериев подряд');
  document.body.appendChild(wrap);
  document.documentElement.classList.add('prd-noscroll');
  let i = Math.max(0, startKey ? keys.indexOf(startKey) : 0);
  let lastRoute = null;

  const render = () => {
    const key = keys[i];
    const crit = c.crit(key);
    if (!crit) return;
    const { story, ac } = crit;
    const url = c.protoUrl(story, ac);
    const embedUrl = url ? `${url}${url.includes('?') ? '&' : '?'}prd-embed=1` : null;
    const doneCount = keys.filter((k) => { const m = c.entry(k)?.mine; return m?.verdict && !m.stale; }).length;
    wrap.innerHTML = `<div class="prd-focus__side">
      <div class="prd-focus__top">
        <button type="button" class="prd-btn prd-btn--ghost" data-f="close" title="Esc">✕ Закрыть</button>
        <span class="prd-muted">${i + 1} из ${keys.length} · оценено ${doneCount}</span>
        <span><button type="button" class="prd-btn" data-f="prev" title="K или ←" ${i === 0 ? 'disabled' : ''}>←</button>
        <button type="button" class="prd-btn" data-f="next" title="J или →" ${i === keys.length - 1 ? 'disabled' : ''}>→</button></span>
      </div>
      <div class="prd-progress"><span style="width:${Math.round((doneCount / keys.length) * 100)}%"></span></div>
      <p class="prd-muted prd-focus__story">${esc(story.id)} · ${esc(story.title)}</p>
      ${story.as ? `<p class="prd-story__text">Как <strong>${esc(story.as)}</strong>, я хочу ${esc(story.iWant)}${story.soThat ? `, чтобы ${esc(story.soThat)}` : ''}.</p>` : ''}
      <ul class="prd-acs">${criterionHtml(c, story, ac)}</ul>
      <p class="prd-keys"><kbd>A</kbd> согласен · <kbd>D</kbd> не согласен · <kbd>1</kbd>–<kbd>5</kbd> причина · <kbd>C</kbd> комментарий · <kbd>J</kbd>/<kbd>K</kbd> следующий/предыдущий · <kbd>Esc</kbd> закрыть</p>
    </div>
    <div class="prd-focus__frame">${embedUrl
      ? `<iframe title="Прототип" src="${attr(embedUrl)}"></iframe>`
      : '<div class="prd-focus__empty">У этого критерия нет экрана в прототипе — проверьте по описанию и шагам «Как проверить».</div>'}</div>`;
    const frame = wrap.querySelector('iframe');
    if (frame) {
      // Тот же экран — не перезагружаем, а просим подсветить другой элемент.
      if (lastRoute && lastRoute === url?.split('?')[0]) frame.src = embedUrl;
      lastRoute = url?.split('?')[0];
      frame.addEventListener('load', () => highlightInFrame(frame, key));
    }
  };

  const go = (d) => { i = Math.min(keys.length - 1, Math.max(0, i + d)); render(); };
  const close = () => { off(); document.removeEventListener('keydown', onKey, true); wrap.remove(); document.documentElement.classList.remove('prd-noscroll'); c.emit('all'); };
  const onKey = (e) => {
    const typing = e.target.closest?.('textarea,input,select');
    if (e.key === 'Escape') { if (typing) { e.target.blur(); return; } close(); return; }
    if (typing) return;
    const key = keys[i];
    const k = e.key.toLowerCase();
    if (k === 'a' || k === 'ф') { e.preventDefault(); c.saveReview(key, { verdict: 'agree', reasons: [] }); }
    else if (k === 'd' || k === 'в') { e.preventDefault(); c.saveReview(key, { verdict: 'disagree' }); }
    else if (k === 'j' || k === 'о' || e.key === 'ArrowRight') { e.preventDefault(); go(1); }
    else if (k === 'k' || k === 'л' || e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
    else if (k === 'c' || k === 'с') { e.preventDefault(); wrap.querySelector('textarea[data-draft]')?.focus(); }
    else if (/^[1-9]$/.test(e.key)) {
      const ids = Object.keys(c.data.config.reasons ?? core.REASONS);
      const id = ids[Number(e.key) - 1];
      const mine = c.entry(key)?.mine;
      if (id && mine?.verdict === 'disagree') {
        const set = new Set(mine.reasons ?? []);
        set.has(id) ? set.delete(id) : set.add(id);
        c.saveReview(key, { verdict: 'disagree', reasons: [...set] });
      }
    }
  };
  wrap.addEventListener('click', (e) => {
    const f = e.target.closest('[data-f]')?.dataset.f;
    if (f === 'close') close();
    if (f === 'prev') go(-1);
    if (f === 'next') go(1);
  });
  bindCriterionActions(c, wrap);
  const off = c.on((what, key) => {
    if ((what === 'review-saved' || what === 'criterion') && key === keys[i]) {
      const li = wrap.querySelector(`.prd-focus__side [data-key="${cssEscape(key)}"]`);
      if (li) li.outerHTML = criterionHtml(c, c.crit(key).story, c.crit(key).ac);
      const done = keys.filter((k) => { const m = c.entry(k)?.mine; return m?.verdict && !m.stale; }).length;
      wrap.querySelector('.prd-progress span')?.style.setProperty('width', `${Math.round((done / keys.length) * 100)}%`);
      const counter = wrap.querySelector('.prd-focus__top .prd-muted');
      if (counter) counter.textContent = `${i + 1} из ${keys.length} · оценено ${done}`;
    }
  });
  document.addEventListener('keydown', onKey, true);
  render();
}

/** Same-origin prototype: highlight the element directly, panel or no panel. */
function highlightInFrame(frame, key) {
  try {
    frame.contentWindow.postMessage({ type: 'prd-highlight', key }, location.origin);
    const doc = frame.contentDocument;
    const el = doc?.querySelector(anchorSelector(key));
    if (!el) return;
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' });
    const r = el.getBoundingClientRect();
    let box = doc.getElementById('prd-frame-highlight');
    if (!box) {
      box = doc.createElement('div');
      box.id = 'prd-frame-highlight';
      box.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483646;border:3px solid #a78bfa;border-radius:8px;box-shadow:0 0 0 9999px rgba(10,10,20,.35);transition:all .2s';
      doc.body.appendChild(box);
    }
    Object.assign(box.style, { left: `${r.left - 6}px`, top: `${r.top - 6}px`, width: `${r.width + 12}px`, height: `${r.height + 12}px` });
  } catch { /* другой origin — подсветит панель внутри прототипа по postMessage */ }
}

/** Delegated handlers for verdict / reasons / comment — shared by every view. */
function bindCriterionActions(c, root) {
  root.addEventListener('click', (e) => {
    const t = e.target.closest('[data-act]');
    if (!t || !root.contains(t)) return;
    const key = t.dataset.key ?? t.dataset.name;
    switch (t.dataset.act) {
      case 'verdict': {
        const mine = c.entry(key)?.mine;
        const current = mine && !mine.stale ? mine.verdict : null;
        const verdict = current === t.dataset.verdict ? null : t.dataset.verdict; // повторный клик снимает отметку
        c.saveReview(key, { verdict, reasons: verdict === 'disagree' ? (mine?.reasons ?? []) : [] });
        break;
      }
      case 'reason': {
        const mine = c.entry(key)?.mine;
        const set = new Set(mine?.reasons ?? []);
        set.has(t.dataset.value) ? set.delete(t.dataset.value) : set.add(t.dataset.value);
        c.saveReview(key, { verdict: 'disagree', reasons: [...set] });
        break;
      }
      case 'save-comment': {
        const ta = root.querySelector(`textarea[data-draft="${cssEscape(key)}"]`);
        c.saveReview(key, { comment: ta?.value ?? '' });
        break;
      }
      default:
    }
  });
  root.addEventListener('input', (e) => {
    const key = e.target.dataset?.draft;
    if (!key) return;
    c.drafts.set(key, { ...c.drafts.get(key), comment: e.target.value });
    const btn = e.target.closest('.prd-control__comment')?.querySelector('[data-act=save-comment]');
    if (btn) btn.disabled = false;
  });
  root.addEventListener('keydown', (e) => {
    const key = e.target.dataset?.draft;
    if (key && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); c.saveReview(key, { comment: e.target.value }); }
  });
}

// ── The review page ─────────────────────────────────────────
export function mountReviewPage(root, opts = {}) {
  injectStyles(document);
  const c = new Controller(opts);
  const ui = {
    tab: 'reqs', group: 'module', view: 'list', filter: {}, scope: null,
    title: opts.title ?? 'Требования и готовность', intro: opts.intro ?? null,
  };
  root.classList.add('prd-root', 'prd-page');
  root.innerHTML = '<div class="prd-loading">Загружаем требования…</div>';
  const live = document.createElement('div');
  live.className = 'prd-toast';
  live.setAttribute('role', 'status');
  live.setAttribute('aria-live', 'polite');
  root.after(live);

  const readUrl = () => {
    const p = new URLSearchParams(location.search);
    ui.tab = ['reqs', 'releases', 'product', 'admin'].includes(p.get('tab')) ? p.get('tab') : 'reqs';
    ui.group = p.get('group') === 'epic' ? 'epic' : 'module';
    ui.view = p.get('view') === 'matrix' ? 'matrix' : 'list';
    ui.rawFilter = p;
  };
  const writeUrl = () => {
    const p = new URLSearchParams(core.filterToQuery(ui.filter));
    if (ui.tab !== 'reqs') p.set('tab', ui.tab);
    if (ui.group !== 'module') p.set('group', ui.group);
    if (ui.view !== 'list') p.set('view', ui.view);
    const qs = p.toString();
    history.replaceState(history.state, '', `${location.pathname}${qs ? `?${qs}` : ''}${location.hash}`);
  };

  readUrl();

  function scopes() { return [...c.index.scopes.values()]; }

  function exportHref(kind) {
    const qs = core.filterToQuery(ui.filter);
    return `${c.client.base}/export/${kind}${qs ? `?${qs}` : ''}`;
  }

  function headerHtml() {
    const sc = scopes();
    const counts = (scopeId) => {
      const entries = core.selectEntries(c.index, c.ctx(), { scope: scopeId });
      return `${plural(entries.length, 'история', 'истории', 'историй')} · ${plural(core.entryKeys(entries).length, 'критерий', 'критерия', 'критериев')}`;
    };
    const me = c.me;
    return `<div class="prd-top">
      <nav class="prd-scopes" aria-label="Области PRD">${sc.length > 1 ? sc.map((s) => `<button type="button" class="prd-scope${ui.filter.scope === s.id ? ' is-active' : ''}" data-act="scope" data-value="${attr(s.id)}" aria-pressed="${ui.filter.scope === s.id}"><strong>${esc(s.title)}</strong> <span class="prd-muted">${counts(s.id)}</span></button>`).join('') : ''}</nav>
      <div class="prd-session">${me
        ? `<span class="prd-muted">${me.kind === 'anon' ? 'Анонимно' : me.external ? 'Учётная запись портала' : 'Почта подтверждена'}:</span> <strong>${esc(me.name)}</strong>${me.isAdmin ? ' <span class="prd-badge prd-tone-accent">администратор</span>' : ''}
           ${me.external ? '' : '<button type="button" class="prd-btn prd-btn--ghost" data-act="logout">Выйти</button>'}`
        : '<button type="button" class="prd-btn prd-btn--outline" data-act="start-review">Рецензировать</button>'}</div>
    </div>
    <nav class="prd-tabs" role="tablist">
      ${[['reqs', 'Требования'], ['releases', 'Релизы'], ['product', 'О продукте'], ...(me?.isAdmin ? [['admin', 'Администрирование']] : [])]
        .map(([id, label]) => `<button type="button" role="tab" class="prd-tab${ui.tab === id ? ' is-active' : ''}" aria-selected="${ui.tab === id}" data-act="tab" data-value="${id}">${label}</button>`).join('')}
    </nav>`;
  }

  function summaryHtml(entries) {
    const keys = core.entryKeys(entries).filter((k) => !c.crit(k)?.retired);
    const s = core.summarize(keys, c.statusOf);
    const seg = core.STATUS_ORDER.filter((st) => s.byStatus[st]).map((st) =>
      `<span class="prd-bar__seg prd-bg-${st}" style="flex:${s.byStatus[st]}" title="${attr(core.STATUS[st].label)}: ${s.byStatus[st]}"></span>`).join('');
    const notDone = s.total - s.implemented;
    const testsAt = c.data.tests?.generatedAt;
    const labels = core.describeFilter(c.index, ui.filter, c.ctx());
    return `<section class="prd-summary">
      <div class="prd-summary__main">
        <p class="prd-summary__head">Реализовано <strong>${s.implemented}</strong> из ${plural(s.total, 'критерия', 'критериев', 'критериев')} — <strong>${s.percent} %</strong></p>
        <div class="prd-bar" role="img" aria-label="Готовность ${s.percent} %">${seg}</div>
        <p class="prd-summary__line">
          ${s.byStatus.verified ? `✅ тестом: ${s.byStatus.verified} · ` : ''}${s.byStatus.manual ? `☑️ вручную: ${s.byStatus.manual} · ` : ''}
          ❌ не реализовано: ${notDone - s.byStatus.unverified - s.byStatus.failing} (частично ${s.byStatus.partial}, нет ${s.byStatus.missing})
          ${s.byStatus.failing ? ` · 🔴 тест падает: ${s.byStatus.failing}` : ''} · ⚠️ не проверено: ${s.byStatus.unverified}
          · ${plural(entries.length, 'история', 'истории', 'историй')}
        </p>
        <p class="prd-muted prd-small">${testsAt ? `Автотесты запущены ${esc(fmtDateTime(testsAt))}` : 'Результатов автотестов нет — маркеры ✅ появятся после npm run prd:tests'}
          · рецензентов: ${c.data.reviewers.email} с почтой, ${c.data.reviewers.anon} анонимно</p>
      </div>
      <div class="prd-summary__side">
        ${c.data.config.exports.reportPdf ? `<a class="prd-btn prd-btn--primary" href="${attr(exportHref('report.pdf'))}" download>Скачать PDF</a>` : ''}
        <a class="prd-btn" href="${attr(exportHref('report.csv'))}" download>CSV для Excel</a>
        <p class="prd-muted prd-small">В файле: ${plural(entries.length, 'история', 'истории', 'историй')} · ${plural(keys.length, 'критерий', 'критерия', 'критериев')}, с оценками всех рецензентов</p>
        ${labels.length ? `<p class="prd-muted prd-small">Фильтры: ${esc(labels.join(' · '))}</p>` : ''}
      </div>
    </section>`;
  }

  function queueHtml() {
    if (!c.me) {
      return `<section class="prd-cta"><div><strong>Помогите проверить реализацию.</strong> Отметьте по каждому критерию, согласны ли вы, что он реализован верно, и оставьте комментарий.</div>
        <button type="button" class="prd-btn prd-btn--primary" data-act="start-review">Начать рецензирование</button></section>`;
    }
    // Числа — те же фасеты, что у фильтра «Рецензия»: клик показывает ровно столько.
    const fc = core.facetCounts(c.index, c.ctx(), ui.filter).review;
    const item = (filter, label) => fc[filter] ? `<button type="button" class="prd-chip${ui.filter.review === filter ? ' is-active' : ''}" data-act="filter" data-name="review" data-value="${filter}">${label}<span class="prd-chip__n"> · ${fc[filter]}</span></button>` : '';
    return `<section class="prd-queue">
      <span class="prd-queue__label">Ваша очередь:</span>
      ${item('todo', 'Осталось оценить')}
      ${item('changed', 'Изменилось после вашей оценки')}
      ${item('answered', 'Есть ответ на ваше замечание')}
      ${item('recheck', 'Просят перепроверить')}
      ${!fc.todo && !fc.changed && !fc.recheck ? '<span class="prd-muted">Здесь всё оценено — спасибо!</span>' : ''}
      <button type="button" class="prd-btn prd-btn--primary prd-queue__go" data-act="focus" title="Один критерий за раз рядом с живым прототипом">Проверять подряд ▸</button>
    </section>`;
  }

  function campaignsHtml() {
    const open = c.openCampaigns();
    if (!open.length) return '';
    return `<section class="prd-campaigns">${open.map((camp) => {
      const active = c.campaign === camp.id;
      return `<div class="prd-campaign${active ? ' is-active' : ''}">
        <div><strong>Раунд: ${esc(camp.title)}</strong> <span class="prd-muted">· ${plural(camp.progress.total, 'критерий', 'критерия', 'критериев')}${camp.deadline ? ` · до ${esc(fmtDate(camp.deadline))}` : ''}</span>
          ${camp.note ? `<div class="prd-muted prd-small">${esc(camp.note)}</div>` : ''}
          <div class="prd-progress"><span style="width:${camp.progress.percent}%"></span></div>
          <div class="prd-muted prd-small">Оценено ${camp.progress.reviewed} из ${camp.progress.total}${camp.progress.reviewers.length ? ` · ${esc(camp.progress.reviewers.map((r) => `${r.name} (${r.done})`).join(', '))}` : ''}</div></div>
        <div class="prd-campaign__act">${active
          ? '<button type="button" class="prd-btn" data-act="campaign-leave">Выйти из раунда</button>'
          : `<button type="button" class="prd-btn prd-btn--outline" data-act="campaign-join" data-value="${attr(camp.id)}">Рецензировать в раунде</button>`}</div>
      </div>`;
    }).join('')}</section>`;
  }

  function filtersHtml() {
    const ctx = c.ctx();
    const f = ui.filter;
    const fc = core.facetCounts(c.index, ctx, f);
    const row = (label, name, items) => `<div class="prd-filter"><div class="prd-filter__label">${label}</div><div class="prd-chips">${items.join('')}</div></div>`;
    const all = (name, count) => chipHtml({ act: 'filter', name, value: '', text: 'Все', count, active: !f[name] });
    const modulesInScope = [...c.index.modules.values()].filter((m) => !f.scope || m.scope === f.scope);
    const epics = [...c.index.epics.values()];
    const origins = Object.keys(core.ORIGIN).filter((o) => fc.origin[o]);
    return `<section class="prd-filters" aria-label="Фильтры">
      <div class="prd-search"><input class="prd-input" type="search" data-act-input="q" placeholder="Поиск по историям и критериям…" value="${attr(f.q ?? '')}" aria-label="Поиск"></div>
      ${row('Статус критерия приёмки', 'status', [all('status', fc.status.all), ...core.STATUS_ORDER.map((s) =>
        chipHtml({ act: 'filter', name: 'status', value: s, text: `${core.STATUS[s].mark} ${esc(core.STATUS[s].chip)}`, count: fc.status[s], active: f.status === s, disabled: !fc.status[s] }))])}
      ${row('Приоритет MoSCoW', 'priority', [all('priority', fc.priority.all), ...core.PRIORITY_ORDER.map((p) =>
        chipHtml({ act: 'filter', name: 'priority', value: p, text: esc(core.PRIORITY[p]), count: fc.priority[p] ?? 0, active: f.priority === p, disabled: !fc.priority[p] }))])}
      ${row('Рецензия цензоров', 'review', [all('review', fc.review.all), ...core.REVIEW_FILTERS.filter((r) => !r.needsMe || c.me).map((r) =>
        chipHtml({ act: 'filter', name: 'review', value: r.id, text: esc(r.label), count: fc.review[r.id], active: f.review === r.id, disabled: !fc.review[r.id] }))])}
      ${row('Модуль', 'module', [chipHtml({ act: 'filter', name: 'module', value: '', text: 'Все модули', active: !f.module }), ...modulesInScope.map((m) =>
        chipHtml({ act: 'filter', name: 'module', value: m.id, text: `${esc(m.title)}${m.boundary ? ` <span class="prd-muted">· ${esc(m.boundary.toLowerCase())}</span>` : ''}`, count: fc.module[m.id] ?? 0, active: f.module === m.id, disabled: !fc.module[m.id] }))])}
      ${epics.length ? row('Эпик', 'epic', [chipHtml({ act: 'filter', name: 'epic', value: '', text: 'Все эпики', active: !f.epic }), ...epics.map((e) =>
        chipHtml({ act: 'filter', name: 'epic', value: e.id, text: `${esc(e.id)} ${esc(e.title)}`, count: fc.epic[e.id] ?? 0, active: f.epic === e.id, disabled: !fc.epic[e.id] }))]) : ''}
      ${origins.length > 1 ? row('Источник требования', 'origin', [all('origin', fc.origin.all), ...origins.map((o) =>
        chipHtml({ act: 'filter', name: 'origin', value: o, text: esc(core.ORIGIN[o]), count: fc.origin[o], active: f.origin === o }))]) : ''}
      <div class="prd-toolbar">
        <span class="prd-muted">Группировать:</span>
        ${chipHtml({ act: 'group', name: 'group', value: 'module', text: 'по модулям', active: ui.group === 'module' })}
        ${chipHtml({ act: 'group', name: 'group', value: 'epic', text: 'по эпикам', active: ui.group === 'epic' })}
        <span class="prd-muted">Вид:</span>
        ${chipHtml({ act: 'view', name: 'view', value: 'list', text: 'Список', active: ui.view === 'list' })}
        ${chipHtml({ act: 'view', name: 'view', value: 'matrix', text: 'Матрица эпик × модуль', active: ui.view === 'matrix' })}
        ${Object.keys(f).some((k) => k !== 'scope') ? '<button type="button" class="prd-link" data-act="reset">Сбросить фильтры</button>' : ''}
      </div>
    </section>`;
  }

  function listHtml(entries) {
    if (!entries.length) return '<p class="prd-empty">Под выбранные фильтры не подошло ни одного требования. <button type="button" class="prd-link" data-act="reset">Сбросить фильтры</button></p>';
    const groups = core.groupEntries(c.index, entries, ui.group, c.statusOf);
    const admin = Boolean(c.me?.isAdmin);
    return groups.map((g) => `<section class="prd-group">
      <h2 class="prd-group__title">${esc(g.title)}${g.item?.boundary ? ` <span class="prd-muted">· ${esc(g.item.boundary)}</span>` : ''}
        ${g.summary ? `<span class="prd-group__sum">${g.summary.implemented}/${g.summary.total} · ${g.summary.percent} %</span>` : ''}</h2>
      ${g.kind === 'epic' && g.item?.goal ? `<p class="prd-muted">Цель: ${esc(g.item.goal)}</p>` : ''}
      ${g.entries.map(({ story, criteria }) => storyHtml(c, story, criteria, { admin })).join('')}
    </section>`).join('');
  }

  function matrixHtml(entries) {
    const m = core.epicModuleMatrix(c.index, entries, c.statusOf);
    if (!m.epics.length) return '<p class="prd-empty">Эпики не заданы — матрица строится по эпикам и модулям.</p>';
    const tone = (p) => (p >= 80 ? 'good' : p >= 40 ? 'warn' : 'bad');
    return `<div class="prd-matrix-wrap"><table class="prd-matrix">
      <thead><tr><th>Эпик \\ Модуль</th>${m.modules.map((mod) => `<th>${esc(mod.title)}</th>`).join('')}</tr></thead>
      <tbody>${m.epics.map((e) => `<tr><th>${esc(e.id === 'none' ? e.title : `${e.id} ${e.title}`)}</th>${m.modules.map((mod) => {
        const cell = m.cells.get(`${e.id}|${mod.id}`);
        return cell?.total
          ? `<td><button type="button" class="prd-cell prd-tone-${tone(cell.percent)}" data-act="cell" data-epic="${attr(e.id)}" data-module="${attr(mod.id)}" title="${cell.stories} ист., реализовано ${cell.implemented} из ${cell.total}">${cell.implemented}/${cell.total}<small>${cell.percent} %</small></button></td>`
          : '<td class="prd-cell--empty">—</td>';
      }).join('')}</tr>`).join('')}</tbody></table></div>`;
  }

  function reqsHtml() {
    const entries = core.selectEntries(c.index, c.ctx(), ui.filter);
    const product = c.data.prd.product ?? {};
    return `<h1 class="prd-h1">${esc(ui.title)}</h1>
      <p class="prd-intro">${esc(ui.intro ?? `Пользовательские истории и критерии приёмки ${product.title ? `«${product.title}»` : ''} с фактическим статусом реализации.`)}
      Маркеры: ✅ подтверждено автотестом, ☑️ проверено вручную, ❌ не реализовано или частично, 🔴 автотест падает, ⚠️ не проверено — «не проверено» честнее молчаливого «реализовано».</p>
      ${summaryHtml(entries)}
      ${queueHtml()}
      ${campaignsHtml()}
      ${filtersHtml()}
      <div class="prd-list">${ui.view === 'matrix' ? matrixHtml(entries) : listHtml(entries)}</div>`;
  }

  function releasesHtml() {
    const rels = c.data.releases ?? [];
    const types = { feature: ['Новое', 'good'], improvement: ['Улучшение', 'accent'], fix: ['Исправление', 'warn'] };
    if (!rels.length) return '<p class="prd-empty">Релизов пока нет. Записи ведутся в prd/releases.js (раздел «Release history» в references/exports.md).</p>';
    return `<div class="prd-section-head"><h1 class="prd-h1">История релизов</h1>
      ${c.data.config.exports.changelogPdf ? `<a class="prd-btn prd-btn--primary" href="${attr(`${c.client.base}/export/changelog.pdf`)}" download>Скачать PDF</a>` : ''}</div>
      ${rels.map((r) => `<article class="prd-release">
        <header><h2><span class="prd-release__v">${esc(r.version)}</span> ${esc(r.title)}</h2><span class="prd-muted">${esc(fmtDate(r.date))}</span></header>
        ${r.summary ? `<p>${esc(r.summary)}</p>` : ''}
        <ul class="prd-changes">${(r.changes ?? []).map((ch) => `<li><span class="prd-badge prd-tone-${types[ch.type]?.[1] ?? 'muted'}">${esc(types[ch.type]?.[0] ?? ch.type)}</span>
          ${ch.area ? `<strong>${esc(ch.area)}.</strong> ` : ''}${esc(ch.text)}
          ${(ch.refs ?? []).filter((ref) => c.crit(ref)).map((ref) => `<a class="prd-tag" href="?story=${attr(ref.split('/')[0])}#${attr(ref)}" data-act="goto" data-value="${attr(ref)}">${esc(ref)}</a>`).join('')}</li>`).join('')}</ul>
      </article>`).join('')}`;
  }

  function productHtml() {
    const p = c.data.prd.product ?? {};
    const all = core.selectEntries(c.index, c.ctx(), {});
    const total = core.summarize(core.entryKeys(all).filter((k) => !c.crit(k).retired), c.statusOf);
    const epics = core.groupEntries(c.index, all, 'epic', c.statusOf).filter((g) => g.item);
    const modules = core.groupEntries(c.index, all, 'module', c.statusOf);
    const ex = c.data.config.exports;
    return `<div class="prd-section-head"><h1 class="prd-h1">${esc(p.title ?? 'Продукт')}</h1>
      ${ex.decks?.length ? '' : `<span>${ex.pitchPdf ? `<a class="prd-btn prd-btn--primary" href="${attr(`${c.client.base}/export/pitch.pdf`)}" download>Презентация PDF</a>` : ''}
      ${ex.pitchPptx ? `<a class="prd-btn" href="${attr(`${c.client.base}/export/pitch.pptx`)}" download>Презентация PPTX</a>` : ''}</span>`}</div>
      ${ex.decks?.length ? `<h2 class="prd-h2">Презентации</h2><div class="prd-cards">${ex.decks.map((d) => `<div class="prd-card">
        <strong>${esc(d.title)}</strong>${d.description ? `<p class="prd-muted">${esc(d.description)}</p>` : ''}
        <p>${d.pdf ? `<a class="prd-btn prd-btn--primary" href="${attr(`${c.client.base}/export/deck/${d.id}.pdf`)}" download>PDF</a>` : ''}
        ${d.pptx ? `<a class="prd-btn" href="${attr(`${c.client.base}/export/deck/${d.id}.pptx`)}" download>PPTX</a>` : ''}</p></div>`).join('')}</div>` : ''}
      ${p.tagline ? `<p class="prd-lead">${esc(p.tagline)}</p>` : ''}
      ${p.summary ? `<p class="prd-intro">${esc(p.summary)}</p>` : ''}
      <p class="prd-muted">Версия ${esc(p.version ?? '—')} · готовность ${total.percent} % (${total.implemented} из ${total.total} критериев)</p>
      ${epics.length ? `<h2 class="prd-h2">Эпики</h2><div class="prd-cards">${epics.map((g) => `<div class="prd-card">
        <strong>${esc(g.item.id)} · ${esc(g.item.title)}</strong>${g.item.goal ? `<p class="prd-muted">${esc(g.item.goal)}</p>` : ''}
        <div class="prd-progress"><span style="width:${g.summary.percent}%"></span></div>
        <p class="prd-small">${g.summary.implemented}/${g.summary.total} критериев · ${g.summary.percent} %</p></div>`).join('')}</div>` : ''}
      <h2 class="prd-h2">Модули</h2><div class="prd-cards">${modules.map((g) => `<div class="prd-card">
        <strong>${esc(g.title)}</strong>${g.item?.summary ? `<p class="prd-muted">${esc(g.item.summary)}</p>` : ''}
        <div class="prd-progress"><span style="width:${g.summary.percent}%"></span></div>
        <p class="prd-small">${g.summary.implemented}/${g.summary.total} критериев · ${g.summary.percent} %</p></div>`).join('')}</div>`;
  }

  async function adminHtml() {
    if (!c.me?.isAdmin) return '<p class="prd-empty">Раздел доступен администратору проекта.</p>';
    const [rv, orph] = await Promise.all([c.client.admin.reviewers().catch(() => ({ reviewers: [] })), c.client.admin.orphans().catch(() => ({ orphans: [] }))]);
    const camps = c.data.campaigns ?? [];
    const disputed = [...c.agg.byKey.entries()].filter(([, e]) => e.disputed).map(([k]) => k);
    const modules = [...c.index.modules.values()], epics = [...c.index.epics.values()], stories = [...c.index.stories.values()];
    const keys = [...c.index.criteria.values()].filter((x) => !x.retired).map((x) => x.key);
    const cfg = c.data.config;
    return `<h1 class="prd-h1">Администрирование</h1>
      <section class="prd-card"><h2 class="prd-h2">Новый раунд рецензирования</h2>
        <form class="prd-form" data-admin="campaign">
          <label class="prd-field"><span>Название</span><input class="prd-input" name="title" required minlength="3" placeholder="Библиотека — приёмка релиза 1"></label>
          <label class="prd-field"><span>Охват</span><select class="prd-input" name="scope">
            <option value="filter">Текущие фильтры страницы требований</option>
            <optgroup label="Модуль">${modules.map((m) => `<option value="module:${attr(m.id)}">${esc(m.title)}</option>`).join('')}</optgroup>
            ${epics.length ? `<optgroup label="Эпик">${epics.map((e) => `<option value="epic:${attr(e.id)}">${esc(e.id)} ${esc(e.title)}</option>`).join('')}</optgroup>` : ''}
            <optgroup label="История">${stories.map((s) => `<option value="story:${attr(s.id)}">${esc(s.id)} ${esc(s.title)}</option>`).join('')}</optgroup>
          </select></label>
          <label class="prd-field"><span>Срок</span><input class="prd-input" type="date" name="deadline"></label>
          <label class="prd-field prd-field--wide"><span>Что важно проверить (видят рецензенты)</span><input class="prd-input" name="note" maxlength="1000"></label>
          <button class="prd-btn prd-btn--primary" type="submit">Запустить раунд</button>
        </form>
        <p class="prd-muted prd-small">Раунд фиксирует набор критериев в момент запуска. Для одного критерия раунд не нужен — используйте «Запросить перепроверку».</p>
        ${camps.length ? `<table class="prd-table"><thead><tr><th>Раунд</th><th>Охват</th><th>Прогресс</th><th>Срок</th><th></th></tr></thead><tbody>${camps.map((camp) => `<tr>
          <td><strong>${esc(camp.title)}</strong><div class="prd-muted prd-small">${esc(fmtDate(camp.createdAt))}${camp.prdVersion ? ` · PRD ${esc(camp.prdVersion)}` : ''}</div></td>
          <td>${esc(core.describeFilter(c.index, camp.scope.filter ?? {}).join(' · ') || 'все критерии')}</td>
          <td>${camp.progress.reviewed}/${camp.progress.total} · ${camp.progress.percent} %</td>
          <td>${esc(camp.deadline ? fmtDate(camp.deadline) : '—')}</td>
          <td><button type="button" class="prd-btn" data-act="campaign-toggle" data-value="${attr(camp.id)}">${camp.closedAt ? 'Открыть снова' : 'Закрыть'}</button>
            ${cfg.exports.reportPdf ? `<a class="prd-btn prd-btn--ghost" href="${attr(`${c.client.base}/export/report.pdf?campaign=${encodeURIComponent(camp.id)}`)}" download>PDF</a>` : ''}</td></tr>`).join('')}</tbody></table>` : ''}
      </section>
      <section class="prd-card"><h2 class="prd-h2">Оспорено: ${disputed.length}</h2>
        ${disputed.length ? `<p class="prd-muted">Разработка считает критерий выполненным, а рецензент с подтверждённой почтой не согласен. Ответьте в карточке критерия.</p>
        <ul class="prd-plain">${disputed.map((k) => `<li><a class="prd-link" href="?story=${attr(k.split('/')[0])}#${attr(k)}" data-act="goto" data-value="${attr(k)}">${esc(k)}</a> — ${esc(c.crit(k)?.ac.text ?? '')}</li>`).join('')}</ul>` : '<p class="prd-muted">Споров нет.</p>'}
      </section>
      <section class="prd-card"><h2 class="prd-h2">Рецензенты</h2>
        ${rv.reviewers.length ? `<table class="prd-table"><thead><tr><th>Имя</th><th>Способ</th><th>Почта</th><th>Оценок</th><th>Последний визит</th></tr></thead><tbody>${rv.reviewers.map((r) => `<tr>
          <td>${esc(r.name)}</td><td>${r.kind === 'anon' ? 'анонимно' : 'почта'}</td><td>${esc(r.email ?? '—')}</td><td>${r.reviews}</td><td>${esc(fmtDateTime(r.lastSeenAt ?? r.createdAt))}</td></tr>`).join('')}</tbody></table>` : '<p class="prd-muted">Пока никого.</p>'}
      </section>
      <section class="prd-card"><h2 class="prd-h2">Потерянные рецензии: ${orph.orphans.length}</h2>
        <p class="prd-muted">Оценки к критериям, которых больше нет в PRD. Если критерий переименовали вопреки правилам, привяжите оценки к новому номеру — рецензенты увидят пометку «устарело» и подтвердят оценку.</p>
        ${orph.orphans.map((o) => `<form class="prd-form prd-form--inline" data-admin="attach" data-from="${attr(o.key)}">
          <code>${esc(o.key)}</code> <span class="prd-muted">${o.count} оц. · ${esc(o.reviewers.join(', '))}</span>
          <select class="prd-input" name="to">${keys.map((k) => `<option>${esc(k)}</option>`).join('')}</select>
          <button class="prd-btn" type="submit">Привязать</button></form>`).join('')}
      </section>
      <section class="prd-card"><h2 class="prd-h2">Доступ и резервная копия</h2>
        <p>Режим доступа: <strong>${{ public: 'открытый', link: 'по ссылке', invite: 'по приглашению' }[cfg.access]}</strong> · анонимное рецензирование: <strong>${cfg.allowAnonymous ? 'разрешено' : 'выключено'}</strong> · «оспорено» считается по ${cfg.disputeFrom === 'any' ? 'всем голосам' : 'голосам с почтой'}.</p>
        <p class="prd-muted prd-small">Настройки меняются в конфигурации сервера (PRD_ACCESS, PRD_ALLOW_ANON, PRD_ADMINS).</p>
        <a class="prd-btn" href="${attr(`${c.client.base}/export/reviews.json`)}" download>Скачать все рецензии (JSON)</a>
      </section>`;
  }

  async function render() {
    if (c.error) {
      root.innerHTML = c.error.data?.needAccess
        ? '<div class="prd-empty"><h1 class="prd-h1">Нужна ссылка доступа</h1><p>Требования этого проекта открыты по ссылке. Попросите её у администратора проекта.</p></div>'
        : `<div class="prd-empty"><p class="prd-error">Не удалось загрузить требования: ${esc(c.error.message)}</p><button type="button" class="prd-btn" data-act="reload">Повторить</button></div>`;
      return;
    }
    if (!c.data) return;
    if (!ui.normalized) {
      ui.filter = core.normalizeFilter(c.index, ui.rawFilter, c.ctx());
      if (!ui.filter.scope && c.index.scopes.size > 1) ui.filter.scope = scopes()[0].id;
      ui.normalized = true;
    }
    let main;
    if (ui.tab === 'releases') main = releasesHtml();
    else if (ui.tab === 'product') main = productHtml();
    else if (ui.tab === 'admin') main = await adminHtml();
    else main = reqsHtml();
    const scrollY = window.scrollY;
    root.innerHTML = `${headerHtml()}<div class="prd-main">${main}</div>`;
    window.scrollTo(0, scrollY);
    if (location.hash && !ui.jumped) {
      ui.jumped = true;
      const el = document.getElementById(decodeURIComponent(location.hash.slice(1)));
      if (el) { el.scrollIntoView({ block: 'center' }); el.classList.add('is-flash'); }
    }
  }

  function setFilter(name, value) {
    if (value) ui.filter[name] = value; else delete ui.filter[name];
    if (name === 'scope') { delete ui.filter.module; }
    writeUrl();
    render();
  }

  // Поиск: перерисовываем список, но не поле ввода — иначе пропадает курсор.
  let searchTimer = null;
  root.addEventListener('input', (e) => {
    if (e.target.dataset?.actInput !== 'q') return;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      const v = e.target.value.trim();
      if (v) ui.filter.q = v; else delete ui.filter.q;
      writeUrl();
      const entries = core.selectEntries(c.index, c.ctx(), ui.filter);
      const list = root.querySelector('.prd-list');
      if (list) list.innerHTML = ui.view === 'matrix' ? matrixHtml(entries) : listHtml(entries);
      const sum = root.querySelector('.prd-summary');
      if (sum) sum.outerHTML = summaryHtml(entries);
    }, 200);
  });

  bindCriterionActions(c, root);
  root.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-act]');
    if (!t) return;
    const v = t.dataset.value || null;
    switch (t.dataset.act) {
      case 'filter': setFilter(t.dataset.name, ui.filter[t.dataset.name] === v ? null : v); break;
      case 'scope': setFilter('scope', v); break;
      case 'tab': ui.tab = v; writeUrl(); render(); break;
      case 'group': ui.group = v; writeUrl(); render(); break;
      case 'view': ui.view = v; writeUrl(); render(); break;
      case 'reset': ui.filter = ui.filter.scope ? { scope: ui.filter.scope } : {}; writeUrl(); render(); break;
      case 'cell': ui.filter.epic = t.dataset.epic === 'none' ? 'none' : t.dataset.epic; ui.filter.module = t.dataset.module; ui.view = 'list'; writeUrl(); render(); break;
      case 'goto': {
        e.preventDefault();
        const key = v;
        const crit = c.crit(key);
        if (!crit) break;
        ui.tab = 'reqs';
        ui.filter = { story: crit.story.id };
        const sc = core.scopeOf(c.index, crit.story);
        if (sc && c.index.scopes.size > 1) ui.filter.scope = sc;
        writeUrl(); await render();
        const el = document.getElementById(key);
        if (el) { el.scrollIntoView({ block: 'center' }); el.classList.add('is-flash'); }
        break;
      }
      case 'start-review': openSessionDialog(c); break;
      case 'logout': await c.client.logout(); await c.load(); break;
      case 'reload': c.load(); break;
      case 'focus': {
        const entries = core.selectEntries(c.index, c.ctx(), ui.filter);
        let keys = core.entryKeys(entries).filter((k) => !c.crit(k).retired);
        const todo = keys.filter((k) => core.matchesReview('todo', k, c.agg, c.ctx()));
        if (todo.length) keys = todo; // сначала то, что ещё не оценено
        openFocus(c, keys);
        break;
      }
      case 'campaign-join': {
        c.setCampaign(v);
        ui.filter = { campaign: v };
        writeUrl(); render();
        break;
      }
      case 'campaign-leave': c.setCampaign(null); delete ui.filter.campaign; writeUrl(); render(); break;
      case 'campaign-toggle': await c.client.admin.toggleCampaign(v); await c.load(); break;
      case 'admin-reply-open': { const box = root.querySelector(`[data-reply="${cssEscape(t.dataset.key)}"]`); if (box) box.hidden = !box.hidden; break; }
      case 'admin-reply': {
        const box = root.querySelector(`[data-reply="${cssEscape(t.dataset.key)}"]`);
        try {
          const res = await c.client.admin.reply({ key: t.dataset.key, text: box.querySelector('textarea').value, resolution: box.querySelector('select').value || null });
          c.toast(res.rechecks ? `Ответ отправлен, запрошено перепроверок: ${res.rechecks}` : 'Ответ отправлен');
          await c.load();
        } catch (err) { c.toast(err.message, true); }
        break;
      }
      case 'admin-recheck':
        try { const r = await c.client.admin.recheck({ key: t.dataset.key }); c.toast(`Запрошено перепроверок: ${r.requested}`); await c.load(); } catch (err) { c.toast(err.message, true); }
        break;
      default:
    }
  });
  root.addEventListener('submit', async (e) => {
    const form = e.target.closest('[data-admin]');
    if (!form) return;
    e.preventDefault();
    const fd = new FormData(form);
    try {
      if (form.dataset.admin === 'campaign') {
        const [kind, id] = String(fd.get('scope')).split(':');
        const scope = kind === 'filter' ? { filter: { ...ui.filter } } : { [kind]: id };
        await c.client.admin.createCampaign({ title: fd.get('title'), scope, deadline: fd.get('deadline') || null, note: fd.get('note') });
        c.toast('Раунд запущен');
      }
      if (form.dataset.admin === 'attach') { await c.client.admin.attach(form.dataset.from, fd.get('to')); c.toast('Рецензии привязаны'); }
      await c.load();
    } catch (err) { c.toast(err.message, true); }
  });

  c.on((what, key) => {
    if (what === 'all') render();
    else if (what === 'need-session') openSessionDialog(c);
    else if (what === 'toast') {
      live.textContent = key.text;
      live.className = `prd-toast is-on${key.isError ? ' is-error' : ''}`;
      clearTimeout(live._t);
      live._t = setTimeout(() => { live.className = 'prd-toast'; }, 2600);
    } else if ((what === 'criterion' || what === 'review-saved') && key) {
      const li = root.querySelector(`.prd-main [data-key="${cssEscape(key)}"]`);
      const crit = c.crit(key);
      if (li && crit) li.outerHTML = criterionHtml(c, crit.story, crit.ac, { admin: Boolean(c.me?.isAdmin) });
      if (what === 'review-saved' && ui.tab === 'reqs') {
        // Счётчики фильтров и очередь меняются после оценки — обновляем их на месте.
        const filters = root.querySelector('.prd-filters');
        const search = filters?.querySelector('input[type=search]');
        const hadFocus = document.activeElement === search;
        if (filters) filters.outerHTML = filtersHtml();
        if (hadFocus) root.querySelector('.prd-filters input[type=search]')?.focus();
        const queue = root.querySelector('.prd-queue');
        if (queue) queue.outerHTML = queueHtml();
      }
    }
  });

  c.load();
  return { controller: c, reload: () => c.load() };
}

// ── Panel inside the prototype ──────────────────────────────
/**
 * Floating panel for reviewing right on the screen being reviewed. Invisible for
 * normal users: it switches on with ?review=1 (kept for the browser tab) or
 * PRDReview.enable(). Lives in a shadow root so the product's CSS and the panel's
 * CSS cannot touch each other; outlines are drawn on an overlay, never on the
 * product's own elements, so layout is not disturbed.
 */
export function mountReviewPanel(opts = {}) {
  const params = new URLSearchParams(location.search);
  const embed = params.get('prd-embed') === '1';
  if (params.get('review') === '1' || params.has('prd-highlight')) store.set('prd-review-mode', true);
  if (params.get('review') === '0') store.set('prd-review-mode', false);
  const api = {
    enable() { store.set('prd-review-mode', true); location.reload(); },
    disable() {
      store.set('prd-review-mode', false);
      // ?review=1 и prd-* в адресе при загрузке снова включили бы режим — убираем их
      const url = new URL(location.href);
      for (const p of [...url.searchParams.keys()]) if (p === 'review' || p.startsWith('prd-')) url.searchParams.delete(p);
      location.replace(url.toString());
    },
    isOn() { return Boolean(store.get('prd-review-mode')); },
    toggle() { return api.isOn() ? api.disable() : api.enable(); },
  };
  window.PRDReview = api;
  if (!store.get('prd-review-mode') && !embed) return api;

  const host = document.createElement('div');
  host.id = 'prd-review-panel';
  host.style.cssText = 'position:fixed;inset:auto 0 0 auto;z-index:2147483600;';
  document.body.appendChild(host);
  const shadow = host.attachShadow({ mode: 'open' });
  // opts.css — темизация панели под продукт: стили страницы в shadow root не проникают
  shadow.innerHTML = `<style>${STYLES}${opts.css ?? ''}</style><div class="prd-root prd-panel-root"></div>`;
  const rootEl = shadow.querySelector('.prd-panel-root');
  const overlay = document.createElement('div');
  overlay.id = 'prd-review-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483500;';
  document.body.appendChild(overlay);

  const c = new Controller(opts);
  const ui = { prio: store.get('prd-panel-prio', []), q: store.get('prd-panel-q', ''), open: !embed && store.get('prd-panel-open', false), xray: store.get('prd-xray', false), picking: null, highlight: params.get('prd-highlight'), pin: params.get('prd-pin') };

  // Список панели совпадает с тем, что видно на экране: только критерии, чей компонент
  // размечен data-ac и сейчас отображается (скрытая вкладка, закрытый диалог — не в счёт).
  // Критерии, привязанные к экрану лишь маршрутом, показываются отдельной сноской.
  const visible = (el) => el.getClientRects().length > 0 && !el.closest('[hidden]');
  const keysOnPage = () => {
    if (!c.index) return [];
    const found = new Set();
    for (const el of document.querySelectorAll('[data-ac]')) {
      if (!visible(el)) continue;
      for (const k of el.getAttribute('data-ac').split(/\s+/)) if (c.index.criteria.has(k) && !c.index.criteria.get(k).retired) found.add(k);
    }
    return [...found];
  };
  const routeOnlyKeys = (onPage) => {
    if (!c.index) return [];
    const path = location.pathname;
    return [...c.index.criteria.values()]
      .filter((crit) => !crit.retired && crit.ac.links?.route?.split('?')[0] === path && !onPage.includes(crit.key))
      .map((crit) => crit.key);
  };
  const elementFor = (key) => [...document.querySelectorAll(anchorSelector(key))].find(visible) ?? null;
  // Фокус на одном критерии: подсветка его компонента, остальное затемняется
  const focusOn = (key) => {
    ui.highlight = ui.highlight === key ? null : key;
    ui.pin = null;
    const el = ui.highlight && elementFor(ui.highlight);
    if (el) {
      el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
      const r = el.getBoundingClientRect();
      const width = Math.min(400, innerWidth);
      // Панель шириной width стоит у правого края; если компонент под ней — переносим влево
      ui.side = r.right > innerWidth - width ? 'left' : 'right';
    }
    render();
    if (ui.highlight) scrollPanelTo(ui.highlight);
  };

  function drawOverlay() {
    overlay.innerHTML = '';
    if (!c.index) return;
    const boxes = [];
    if (ui.xray) {
      for (const el of document.querySelectorAll('[data-ac]')) {
        const keys = el.getAttribute('data-ac').split(/\s+/).filter((k) => c.index.criteria.has(k));
        if (!keys.length) continue;
        const worst = core.worstStatus(keys.map((k) => c.statusOf.get(k)));
        boxes.push({ el, keys, worst, kind: 'xray' });
      }
    }
    const focusKey = ui.highlight;
    if (focusKey) {
      const el = ui.pin ? safeQuery(ui.pin) : elementFor(focusKey);
      if (el) boxes.push({ el, keys: [focusKey], worst: c.statusOf.get(focusKey), kind: 'focus' });
    }
    const colors = { good: '#16a34a', warn: '#d97706', bad: '#dc2626', muted: '#71717a' };
    for (const b of boxes) {
      const r = b.el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      const tone = core.STATUS[b.worst]?.tone ?? 'muted';
      const box = document.createElement('div');
      box.style.cssText = `position:fixed;left:${r.left - 3}px;top:${r.top - 3}px;width:${r.width + 6}px;height:${r.height + 6}px;border:2px ${b.kind === 'focus' ? 'solid' : 'dashed'} ${b.kind === 'focus' ? '#a78bfa' : colors[tone]};border-radius:6px;${b.kind === 'focus' ? 'box-shadow:0 0 0 9999px rgba(10,10,20,.28);' : ''}`;
      if (b.kind === 'xray') {
        const tag = document.createElement('button');
        tag.type = 'button';
        tag.textContent = `${core.STATUS[b.worst].mark} ${b.keys.length > 1 ? b.keys.length : b.keys[0].split('/')[1]}`;
        tag.title = b.keys.join(', ');
        tag.style.cssText = `position:absolute;top:-12px;left:-6px;pointer-events:auto;cursor:pointer;font:600 11px/1 system-ui,sans-serif;padding:3px 6px;border-radius:999px;border:0;background:${colors[tone]};color:#fff;box-shadow:0 1px 4px rgba(0,0,0,.3)`;
        tag.addEventListener('click', () => { ui.open = true; store.set('prd-panel-open', true); ui.highlight = b.keys[0]; ui.pin = null; render(); scrollPanelTo(b.keys[0]); });
        box.appendChild(tag);
      }
      overlay.appendChild(box);
    }
  }
  function safeQuery(sel) { try { return document.querySelector(sel); } catch { return null; } }

  function scrollPanelTo(key) {
    requestAnimationFrame(() => {
      const li = rootEl.querySelector(`[data-key="${cssEscape(key)}"]`);
      if (li) { li.scrollIntoView({ block: 'center' }); li.classList.add('is-flash'); }
    });
  }

  function render() {
    if (embed) { rootEl.innerHTML = ''; drawOverlay(); return; }
    if (!c.data) { rootEl.innerHTML = ''; return; }
    const keys = keysOnPage();
    const todo = keys.filter((k) => core.matchesReview('todo', k, c.agg, c.ctx())).length;
    const launcher = `<div class="prd-launcher">
      <button type="button" class="prd-launcher__main" data-p="toggle" aria-expanded="${ui.open}" title="${ui.open ? 'Свернуть панель' : 'Развернуть панель критериев'}">PRD · ${keys.length}${c.me && todo ? ` <span class="prd-launcher__dot">${todo}</span>` : ''}</button>
      <button type="button" class="prd-launcher__x" data-p="xray" aria-pressed="${ui.xray}" title="Показать критерии на экране">${ui.xray ? '◉' : '◎'}</button>
      <button type="button" class="prd-launcher__x" data-p="exit" title="Выйти из режима рецензирования">✕</button>
    </div>`;
    if (!ui.open) { rootEl.innerHTML = launcher; drawOverlay(); return; }
    const items = keys.map((k) => c.crit(k)).filter(Boolean);
    const routeOnly = routeOnlyKeys(keys);
    const itemTools = (key) => `<div class="prd-pin-row">
      <button type="button" class="prd-btn prd-btn--ghost${ui.highlight === key ? ' is-on' : ''}" data-p="focus" data-key="${attr(key)}" aria-pressed="${ui.highlight === key}">${ui.highlight === key ? '◉ Снять подсветку' : '◎ Показать на экране'}</button>
      ${c.me ? `<button type="button" class="prd-btn prd-btn--ghost" data-p="pin" data-key="${attr(key)}">📍 Приколоть замечание</button>` : ''}</div>`;
    rootEl.innerHTML = `${launcher}<aside class="prd-panel${ui.side === 'left' ? ' prd-panel--left' : ''}" aria-label="Критерии этого экрана">
      <header class="prd-panel__head">
        <div class="prd-panel__bar"><strong>Критерии этого экрана</strong>
          <button type="button" class="prd-icon-btn" data-p="toggle" title="Свернуть панель — открыть рабочую область" aria-label="Свернуть панель">▁</button>
          <button type="button" class="prd-icon-btn" data-p="exit" title="Выйти из режима рецензирования" aria-label="Выйти из режима рецензирования">✕</button>
        </div>
        <span class="prd-muted prd-small">${esc(location.pathname)}</span>
        ${items.length ? `<div class="prd-panel__search"><input type="search" class="prd-input" data-p-search value="${attr(ui.q ?? '')}" placeholder="Поиск по критериям, историям, эпикам…" aria-label="Поиск критериев">
          <div class="prd-panel__prio" role="group" aria-label="Приоритет MoSCoW">${['must', 'should', 'could'].map((pr) => {
            const n = items.filter((it) => it.story.priority === pr).length;
            const on = ui.prio.includes(pr);
            return `<button type="button" class="prd-chip${on ? ' is-active' : ''}" data-p="prio" data-value="${pr}" aria-pressed="${on}" ${n ? '' : 'disabled'}>${esc(core.PRIORITY[pr])} · ${n}</button>`;
          }).join('')}</div>
          <span class="prd-muted prd-small" data-p-found></span></div>` : ''}
        ${c.me ? `<span class="prd-small">${esc(c.me.name)}${c.me.kind === 'anon' ? ' · анонимно' : ''}</span>` : '<button type="button" class="prd-btn prd-btn--primary" data-p="session">Начать рецензирование</button>'}
      </header>
      ${ui.picking ? '<p class="prd-note">Нажмите на элемент страницы, к которому относится замечание. Esc — отмена.</p>' : ''}
      ${items.length ? panelGroupsHtml(c, items, itemTools)
        : '<p class="prd-muted">На этом экране нет размеченных компонентов.</p>'}
      <p class="prd-muted" data-p-empty hidden>Ничего не найдено — уточните запрос.</p>
      ${routeOnly.length ? `<p class="prd-muted prd-small">Ещё ${routeOnly.length} ${routeOnly.length === 1 ? 'критерий относится' : 'критериев относятся'} к этому экрану без отдельного компонента (поведение, сроки, права): ${routeOnly.map((k) => esc(k)).join(', ')}. Они — на странице требований.</p>` : ''}
    </aside>`;
    applySearch();
    drawOverlay();
  }

  function applySearch() {
    const words = String(ui.q ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    const hit = (text) => words.every((w) => text.includes(w));
    const prio = ui.prio;
    const filtering = words.length || prio.length;
    let shown = 0, total = 0;
    for (const sec of rootEl.querySelectorAll('.prd-pgroup')) {
      const epicText = (sec.querySelector('.prd-pgroup__epic')?.textContent ?? '').toLowerCase();
      let secShown = 0;
      for (const st of sec.querySelectorAll('.prd-pstory')) {
        const storyText = epicText + ' ' + (st.querySelector('.prd-pgroup__story')?.textContent ?? '').toLowerCase();
        const prioOk = !prio.length || prio.includes(st.dataset.priority);
        let stShown = 0;
        for (const li of st.querySelectorAll('li.prd-ac')) {
          total += 1;
          const ok = prioOk && (!words.length || hit(`${storyText} ${li.dataset.key.toLowerCase()} ${li.querySelector('.prd-ac__text')?.textContent.toLowerCase() ?? ''}`));
          li.hidden = !ok;
          const tools = li.nextElementSibling?.classList.contains('prd-pin-row') ? li.nextElementSibling : null;
          if (tools) tools.hidden = !ok;
          if (ok) { stShown += 1; shown += 1; }
        }
        st.hidden = !stShown;
        secShown += stShown;
      }
      sec.hidden = !secShown;
    }
    const found = rootEl.querySelector('[data-p-found]');
    if (found) found.textContent = filtering ? `Найдено ${shown} из ${total}` : '';
    const empty = rootEl.querySelector('[data-p-empty]');
    if (empty) empty.hidden = !(filtering && !shown);
    for (const b of rootEl.querySelectorAll('[data-p="prio"]')) {
      const on = prio.includes(b.dataset.value);
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-pressed', String(on));
    }
  }
  rootEl.addEventListener('input', (e) => {
    if (!e.target.matches?.('[data-p-search]')) return;
    ui.q = e.target.value;
    store.set('prd-panel-q', ui.q);
    applySearch();
  });

  rootEl.addEventListener('click', (e) => {
    const p = e.target.closest('[data-p]')?.dataset.p;
    if (!p) return;
    if (p === 'toggle') { ui.open = !ui.open; store.set('prd-panel-open', ui.open); render(); }
    if (p === 'xray') { ui.xray = !ui.xray; store.set('prd-xray', ui.xray); render(); }
    if (p === 'exit') api.disable();
    if (p === 'session') openSessionDialog(c, shadow);
    if (p === 'pin') startPicking(e.target.closest('[data-p]').dataset.key);
    if (p === 'focus') focusOn(e.target.closest('[data-p]').dataset.key);
    if (p === 'prio') {
      const v = e.target.closest('[data-p]').dataset.value;
      ui.prio = ui.prio.includes(v) ? ui.prio.filter((x) => x !== v) : [...ui.prio, v];
      store.set('prd-panel-prio', ui.prio);
      applySearch();
    }
  });
  addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && ui.highlight && !ui.picking) { ui.highlight = null; ui.pin = null; render(); }
  });
  bindCriterionActions(c, rootEl);

  function startPicking(key) {
    ui.picking = key;
    render();
    const hover = document.createElement('div');
    hover.style.cssText = 'position:fixed;pointer-events:none;border:2px solid #a78bfa;border-radius:6px;background:rgba(167,139,250,.12);z-index:2147483550';
    document.body.appendChild(hover);
    const move = (ev) => {
      const el = document.elementFromPoint(ev.clientX, ev.clientY);
      if (!el || host.contains(el)) return;
      const r = el.getBoundingClientRect();
      Object.assign(hover.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    };
    const stop = () => { document.removeEventListener('mousemove', move, true); document.removeEventListener('click', pick, true); document.removeEventListener('keydown', esc_, true); hover.remove(); ui.picking = null; render(); };
    const pick = (ev) => {
      if (host.contains(ev.target)) return;
      ev.preventDefault(); ev.stopPropagation();
      const selector = selectorFor(ev.target);
      const url = new URL(location.href);
      for (const p of [...url.searchParams.keys()]) if (p === 'review' || p.startsWith('prd-')) url.searchParams.delete(p);
      // Замечание пишется в обычном поле комментария критерия — без системного prompt.
      c.drafts.set(key, { comment: c.drafts.get(key)?.comment ?? c.entry(key)?.mine?.comment ?? '', pin: { route: url.pathname + url.search, selector } });
      stop();
      ui.open = true;
      render();
      scrollPanelTo(key);
      requestAnimationFrame(() => rootEl.querySelector(`textarea[data-draft="${cssEscape(key)}"]`)?.focus());
      const btn = rootEl.querySelector(`[data-control="${cssEscape(key)}"] [data-act=save-comment]`);
      if (btn) btn.disabled = false;
    };
    const esc_ = (ev) => { if (ev.key === 'Escape') stop(); };
    document.addEventListener('mousemove', move, true);
    document.addEventListener('click', pick, true);
    document.addEventListener('keydown', esc_, true);
  }

  // Короткий устойчивый селектор: data-ac, id, data-testid или путь по nth-of-type.
  function selectorFor(el) {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.body && parts.length < 6) {
      if (node.dataset?.ac) { parts.unshift(`[data-ac="${cssEscape(node.dataset.ac)}"]`); break; }
      if (node.id && !/\d{4,}/.test(node.id)) { parts.unshift(`#${cssEscape(node.id)}`); break; }
      if (node.dataset?.testid) { parts.unshift(`[data-testid="${cssEscape(node.dataset.testid)}"]`); break; }
      const tag = node.tagName.toLowerCase();
      const sib = [...(node.parentElement?.children ?? [])].filter((s) => s.tagName === node.tagName);
      parts.unshift(sib.length > 1 ? `${tag}:nth-of-type(${sib.indexOf(node) + 1})` : tag);
      node = node.parentElement;
    }
    return parts.join(' > ');
  }

  // Перерисовка при прокрутке, смене размера, изменении DOM и навигации SPA.
  let raf = 0;
  const schedule = (full = false) => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => (full ? render() : drawOverlay()));
  };
  addEventListener('scroll', () => schedule(), true);
  addEventListener('resize', () => schedule());
  // Полная перерисовка панели — только когда меняется набор критериев на экране:
  // иначе анимация в продукте сбивала бы фокус в поле комментария.
  let signature = '';
  new MutationObserver((muts) => {
    if (muts.every((m) => host.contains(m.target) || overlay.contains(m.target) || m.target === overlay)) return;
    const next = keysOnPage().join(' ');
    const full = next !== signature && !ui.picking;
    signature = next;
    schedule(full);
  }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-ac', 'hidden'] });
  for (const fn of ['pushState', 'replaceState']) {
    const orig = history[fn];
    history[fn] = function patched(...args) {
      const r = orig.apply(this, args);
      setTimeout(() => { if (ui.highlight && !elementFor(ui.highlight)) { ui.highlight = null; ui.pin = null; } schedule(true); }, 0);
      return r;
    };
  }
  addEventListener('popstate', () => schedule(true));
  addEventListener('message', (e) => {
    if (e.origin !== location.origin || e.data?.type !== 'prd-highlight') return;
    ui.highlight = e.data.key; ui.pin = null;
    const el = document.querySelector(anchorSelector(e.data.key));
    if (el) el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' });
    schedule();
  });

  c.on((what, key) => {
    if (what === 'all') {
      render();
      if (ui.highlight) {
        const el = ui.pin ? safeQuery(ui.pin) : document.querySelector(anchorSelector(ui.highlight));
        if (el) el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' });
        if (!embed) { ui.open = true; render(); scrollPanelTo(ui.highlight); }
      }
    } else if (what === 'need-session') openSessionDialog(c, shadow);
    else if (what === 'criterion' || what === 'review-saved') {
      const li = rootEl.querySelector(`[data-key="${cssEscape(key)}"]`);
      const crit = c.crit(key);
      if (li && crit) li.outerHTML = criterionHtml(c, crit.story, crit.ac);
    } else if (what === 'toast') {
      let t = rootEl.querySelector('.prd-toast');
      if (!t) { t = document.createElement('div'); t.className = 'prd-toast'; t.setAttribute('role', 'status'); rootEl.appendChild(t); }
      t.textContent = key.text; t.className = `prd-toast is-on${key.isError ? ' is-error' : ''}`;
      clearTimeout(t._t); t._t = setTimeout(() => { t.className = 'prd-toast'; }, 2400);
    }
  });
  c.load();
  return api;
}

// ── Styles ──────────────────────────────────────────────────
function injectStyles(doc) {
  if (doc.getElementById('prd-review-styles')) return;
  const style = doc.createElement('style');
  style.id = 'prd-review-styles';
  style.textContent = STYLES;
  doc.head.appendChild(style);
}

export const STYLES = `
.prd-root{--prd-bg:#ffffff;--prd-card:#ffffff;--prd-surface:#f6f6f8;--prd-text:#17171c;--prd-muted:#6a6a75;--prd-line:#e2e2e8;
--prd-accent:#6d4aff;--prd-accent-soft:#efeaff;--prd-on-accent:#fff;--prd-good:#15803d;--prd-good-soft:#e6f5eb;--prd-warn:#a15c07;--prd-warn-soft:#fdf1df;
--prd-bad:#b91c1c;--prd-bad-soft:#fdeaea;--prd-radius:14px;--prd-font:system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
color:var(--prd-text);font-family:var(--prd-font);font-size:15px;line-height:1.5;-webkit-font-smoothing:antialiased}
@media (prefers-color-scheme:dark){.prd-root{--prd-bg:#111114;--prd-card:#18181c;--prd-surface:#1e1e23;--prd-text:#ececf1;--prd-muted:#9c9ca8;--prd-line:#2c2c33;
--prd-accent:#a78bfa;--prd-accent-soft:#2b2440;--prd-on-accent:#15121f;--prd-good:#4ade80;--prd-good-soft:#15291c;--prd-warn:#fbbf24;--prd-warn-soft:#2e2412;--prd-bad:#f87171;--prd-bad-soft:#341818}}
.prd-root *,.prd-root *::before,.prd-root *::after{box-sizing:border-box}
.prd-root [hidden]{display:none!important}
.prd-page{background:var(--prd-bg);max-width:1180px;margin:0 auto;padding:24px 16px 80px}
.prd-root button{font:inherit;color:inherit}
.prd-h1{font-size:28px;line-height:1.2;margin:18px 0 8px;font-weight:700}.prd-h2{font-size:18px;margin:22px 0 10px}
.prd-intro,.prd-lead{max-width:860px;color:var(--prd-muted);margin:0 0 18px}.prd-lead{font-size:18px;color:var(--prd-text)}
.prd-muted{color:var(--prd-muted)}.prd-small{font-size:13px}.prd-error{color:var(--prd-bad)}
.prd-loading,.prd-empty{padding:40px 0;color:var(--prd-muted)}
.prd-top{display:flex;gap:12px;align-items:flex-start;justify-content:space-between;flex-wrap:wrap}
.prd-scopes{display:flex;gap:10px;flex-wrap:wrap}
.prd-scope{border:1px solid var(--prd-line);background:var(--prd-card);border-radius:12px;padding:10px 16px;cursor:pointer;text-align:left}
.prd-scope.is-active{border-color:var(--prd-accent);background:var(--prd-accent-soft)}
.prd-session{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.prd-tabs{display:flex;gap:4px;border-bottom:1px solid var(--prd-line);margin:16px 0 4px;overflow-x:auto}
.prd-tab{background:none;border:0;border-bottom:2px solid transparent;padding:10px 14px;cursor:pointer;color:var(--prd-muted);white-space:nowrap}
.prd-tab.is-active{color:var(--prd-text);border-bottom-color:var(--prd-accent);font-weight:600}
.prd-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:38px;padding:7px 14px;border-radius:10px;border:1px solid var(--prd-line);background:var(--prd-card);cursor:pointer;text-decoration:none;color:var(--prd-text);font-size:14px;white-space:nowrap}
.prd-btn:hover{border-color:var(--prd-accent)}.prd-btn:disabled{opacity:.45;cursor:default}
.prd-btn:focus-visible,.prd-chip:focus-visible,.prd-tab:focus-visible,.prd-input:focus-visible,.prd-link:focus-visible{outline:2px solid var(--prd-accent);outline-offset:2px}
.prd-btn--primary{background:var(--prd-accent);border-color:var(--prd-accent);color:var(--prd-on-accent);font-weight:600}
.prd-btn--outline{border-color:var(--prd-accent)}.prd-btn--ghost{border-color:transparent;background:transparent}
.prd-btn--verdict.is-agree{background:var(--prd-good-soft);border-color:var(--prd-good);color:var(--prd-good);font-weight:600}
.prd-btn--verdict.is-disagree{background:var(--prd-bad-soft);border-color:var(--prd-bad);color:var(--prd-bad);font-weight:600}
.prd-link{background:none;border:0;padding:0;color:var(--prd-accent);cursor:pointer;text-decoration:underline;text-underline-offset:2px;font-size:14px}
.prd-input{width:100%;font:inherit;color:var(--prd-text);background:var(--prd-bg);border:1px solid var(--prd-line);border-radius:10px;padding:8px 10px;min-height:38px}
.prd-input--code{font-size:28px;letter-spacing:.35em;text-align:center;max-width:260px}
.prd-summary{display:flex;gap:20px;justify-content:space-between;flex-wrap:wrap;border:1px solid var(--prd-line);background:var(--prd-card);border-radius:var(--prd-radius);padding:18px 20px;margin-bottom:14px}
.prd-summary__head{font-size:18px;margin:0 0 10px}.prd-summary__line{margin:10px 0 4px;font-size:14px}
.prd-summary__main{flex:1 1 460px;min-width:0}
.prd-summary__side{flex:0 1 300px;display:flex;flex-direction:column;align-items:flex-end;gap:8px;text-align:right}
.prd-summary__side .prd-btn{min-width:170px}
.prd-bar{display:flex;height:10px;border-radius:99px;overflow:hidden;background:var(--prd-surface);max-width:460px}
.prd-bar__seg{display:block;height:100%}
.prd-bg-verified{background:#16a34a}.prd-bg-manual{background:#4ade80}.prd-bg-partial{background:#f59e0b}.prd-bg-missing{background:#ef4444}.prd-bg-failing{background:#991b1b}.prd-bg-unverified{background:#a1a1aa}
.prd-progress{height:6px;border-radius:99px;background:var(--prd-surface);overflow:hidden;margin:6px 0}.prd-progress span{display:block;height:100%;background:var(--prd-accent);border-radius:99px}
.prd-cta,.prd-queue,.prd-campaign{display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap;border:1px solid var(--prd-line);border-radius:var(--prd-radius);padding:12px 16px;margin-bottom:12px;background:var(--prd-card)}
.prd-cta{border-color:var(--prd-accent);background:var(--prd-accent-soft)}
.prd-queue{justify-content:flex-start}.prd-queue__label{font-weight:600}.prd-queue__go{margin-left:auto}
.prd-campaign.is-active{border-color:var(--prd-accent)}.prd-campaign>div:first-child{flex:1;min-width:240px}
.prd-filters{margin:18px 0 8px}.prd-search{max-width:520px;margin-bottom:12px}
.prd-filter{margin-bottom:10px}.prd-filter__label{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--prd-muted);font-weight:600;margin-bottom:6px}
.prd-chips{display:flex;gap:8px;flex-wrap:wrap}
.prd-chip{border:1px solid var(--prd-line);background:var(--prd-card);border-radius:10px;padding:6px 12px;cursor:pointer;font-size:14px;min-height:36px}
.prd-chip.is-active{border-color:var(--prd-accent);background:var(--prd-accent-soft);color:var(--prd-text)}
.prd-chip.is-empty{opacity:.5}.prd-chip__n{color:var(--prd-muted)}
.prd-chip kbd,.prd-keys kbd{font:600 11px/1 ui-monospace,monospace;border:1px solid var(--prd-line);border-radius:4px;padding:2px 4px;background:var(--prd-surface)}
.prd-toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:12px}
.prd-group{margin-top:26px}.prd-group__title{font-size:14px;letter-spacing:.08em;text-transform:uppercase;color:var(--prd-muted);display:flex;gap:10px;align-items:baseline}
.prd-group__sum{margin-left:auto;font-size:13px;letter-spacing:0;text-transform:none}
.prd-story{border:1px solid var(--prd-line);background:var(--prd-card);border-radius:var(--prd-radius);padding:18px 20px;margin:12px 0}
.prd-story__head{display:flex;gap:12px;justify-content:space-between;align-items:flex-start;flex-wrap:wrap}
.prd-story__title{font-size:18px;margin:0;font-weight:600}.prd-story__id{color:var(--prd-muted);font-weight:500}
.prd-story__badges{display:flex;gap:6px;flex-wrap:wrap}.prd-story__text{margin:8px 0;color:var(--prd-muted)}.prd-story__text strong{color:var(--prd-text);font-weight:500}
.prd-story__chips{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px}
.prd-tag{border:1px solid var(--prd-line);background:var(--prd-surface);border-radius:999px;padding:2px 10px;font-size:12.5px;color:var(--prd-muted);cursor:pointer;text-decoration:none}
.prd-badge{display:inline-flex;align-items:center;gap:4px;border-radius:999px;padding:2px 10px;font-size:12.5px;background:var(--prd-surface);color:var(--prd-muted);border:1px solid var(--prd-line);white-space:nowrap}
.prd-tone-good.prd-badge,.prd-cell.prd-tone-good{background:var(--prd-good-soft);color:var(--prd-good);border-color:transparent}
.prd-tone-warn.prd-badge,.prd-cell.prd-tone-warn{background:var(--prd-warn-soft);color:var(--prd-warn);border-color:transparent}
.prd-tone-bad.prd-badge,.prd-cell.prd-tone-bad{background:var(--prd-bad-soft);color:var(--prd-bad);border-color:transparent}
.prd-tone-accent.prd-badge{background:var(--prd-accent-soft);color:var(--prd-accent);border-color:transparent}
.prd-badge--status{font-weight:600}
.prd-acs{list-style:none;margin:8px 0 0;padding:0}
.prd-ac{padding:10px 0;border-top:1px solid var(--prd-line)}.prd-ac:first-child{border-top:0}
.prd-ac.is-retired{opacity:.55}.prd-ac.is-flash{animation:prdflash 1.6s ease-out}
@keyframes prdflash{0%{background:var(--prd-accent-soft)}100%{background:transparent}}
.prd-ac__main{display:flex;gap:10px}.prd-mark{flex:none;width:22px;font-size:17px;line-height:1.35}
.prd-ac__body{flex:1;min-width:0}.prd-ac__text{font-size:15.5px}.prd-ac__id{color:var(--prd-muted);text-decoration:none;font-size:13px;margin-right:4px}
.prd-ac__note{color:var(--prd-muted);font-size:13.5px;margin-top:2px}.prd-ac__note code{font-size:12px}
.prd-ac__meta{display:flex;gap:12px;flex-wrap:wrap;align-items:center;margin-top:6px;font-size:13.5px}
.prd-review-sum{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.prd-tests{font-size:13px;margin-top:2px}.prd-tests.prd-tone-good{color:var(--prd-good)}.prd-tests.prd-tone-bad{color:var(--prd-bad)}
.prd-note{font-size:13.5px;background:var(--prd-warn-soft);color:var(--prd-text);border-radius:8px;padding:6px 10px;margin:6px 0}
.prd-howto{margin-top:6px;font-size:14px}.prd-howto summary{cursor:pointer;color:var(--prd-accent)}.prd-howto ol{margin:6px 0;padding-left:20px}
.prd-comments{list-style:none;margin:8px 0 0;padding:0 0 0 12px;border-left:2px solid var(--prd-line)}
.prd-comment{margin:6px 0;font-size:14px}.prd-comment.is-stale{opacity:.6}.prd-comment__head{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.prd-comment__text{white-space:pre-wrap;margin-top:2px}.prd-comment--reply{background:var(--prd-accent-soft);border-radius:8px;padding:6px 10px}
.prd-control{margin-top:10px;padding:10px 12px;border-radius:10px;background:var(--prd-surface)}.prd-control.is-busy{opacity:.7}
.prd-control__row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.prd-control__q{font-size:14px;font-weight:600;margin-right:4px}
.prd-control__reasons{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}.prd-control__reasons .prd-chip{min-height:30px;padding:3px 10px;font-size:13px}
.prd-control__comment{display:flex;gap:8px;align-items:flex-start;margin-top:8px}.prd-control__comment textarea{min-height:40px;resize:vertical}
.prd-admin-row{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}.prd-admin-reply{display:grid;gap:6px;width:100%}
.prd-matrix-wrap{overflow-x:auto;margin-top:16px}.prd-matrix{border-collapse:separate;border-spacing:4px;font-size:14px}
.prd-matrix th{text-align:left;font-weight:600;padding:6px;color:var(--prd-muted);min-width:120px}
.prd-cell{width:100%;border-radius:10px;padding:8px;border:1px solid var(--prd-line);cursor:pointer;display:flex;flex-direction:column;align-items:center;font-weight:600}
.prd-cell small{font-weight:400;font-size:12px}.prd-cell--empty{text-align:center;color:var(--prd-muted)}
.prd-section-head{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}.prd-section-head>span{display:flex;gap:8px}
.prd-release{border-left:3px solid var(--prd-accent);padding:4px 0 4px 16px;margin:18px 0}
.prd-release header{display:flex;gap:12px;align-items:baseline;flex-wrap:wrap}.prd-release h2{margin:0;font-size:18px}
.prd-release__v{font-family:ui-monospace,monospace;color:var(--prd-accent)}
.prd-changes{list-style:none;padding:0;margin:8px 0}.prd-changes li{margin:6px 0;display:flex;gap:6px;flex-wrap:wrap;align-items:baseline}
.prd-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:12px}
.prd-card{border:1px solid var(--prd-line);background:var(--prd-card);border-radius:var(--prd-radius);padding:14px 16px;margin-bottom:12px}
.prd-form{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px;align-items:end}
.prd-form--inline{display:flex;flex-wrap:wrap;align-items:center;margin:6px 0}.prd-form--inline .prd-input{width:auto}
.prd-field{display:grid;gap:4px;font-size:14px}.prd-field--wide{grid-column:1/-1}.prd-check{display:flex;gap:8px;font-size:14px;align-items:flex-start}
.prd-table{width:100%;border-collapse:collapse;font-size:14px;margin-top:12px}.prd-table th,.prd-table td{border-bottom:1px solid var(--prd-line);padding:8px;text-align:left;vertical-align:top}
.prd-plain{padding-left:18px}
.prd-dialog{border:1px solid var(--prd-line);border-radius:18px;padding:0;max-width:560px;width:calc(100% - 32px);background:var(--prd-card);color:var(--prd-text)}
.prd-dialog::backdrop{background:rgba(10,10,20,.5)}.prd-dialog__body{padding:22px 24px;display:grid;gap:12px}.prd-dialog h2{margin:0;font-size:20px}
.prd-dialog__foot{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap}
.prd-choice{display:grid;grid-template-columns:1fr 1fr;gap:10px}@media (max-width:520px){.prd-choice{grid-template-columns:1fr}}
.prd-choice__card{display:grid;gap:6px;text-align:left;border:1px solid var(--prd-line);background:var(--prd-bg);border-radius:14px;padding:14px;cursor:pointer}
.prd-choice__card:hover{border-color:var(--prd-accent)}.prd-choice__card span{color:var(--prd-muted);font-size:13.5px}
.prd-toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%) translateY(20px);opacity:0;pointer-events:none;background:#17171c;color:#fff;padding:10px 16px;border-radius:10px;font:14px var(--prd-font,system-ui);transition:all .2s;z-index:2147483647}
.prd-toast.is-on{opacity:1;transform:translateX(-50%) translateY(0)}.prd-toast.is-error{background:#b91c1c}
.prd-noscroll{overflow:hidden}
.prd-focus{position:fixed;inset:0;z-index:2147483000;background:var(--prd-bg);display:grid;grid-template-columns:minmax(360px,440px) 1fr}
.prd-focus__side{overflow-y:auto;padding:16px 18px;border-right:1px solid var(--prd-line)}
.prd-focus__top{display:flex;justify-content:space-between;align-items:center;gap:8px}.prd-focus__story{margin:12px 0 0;font-weight:600}
.prd-focus__frame{position:relative;background:var(--prd-surface)}.prd-focus__frame iframe{width:100%;height:100%;border:0;background:#fff}
.prd-focus__empty{padding:40px;color:var(--prd-muted)}.prd-keys{font-size:12.5px;color:var(--prd-muted);margin-top:14px}
@media (max-width:860px){.prd-focus{grid-template-columns:1fr;grid-template-rows:auto 45vh}.prd-focus__side{border-right:0;border-bottom:1px solid var(--prd-line)}}
.prd-launcher{position:fixed;right:16px;bottom:16px;display:flex;gap:4px;z-index:2}
.prd-launcher button{border:0;background:#17171c;color:#fff;border-radius:999px;padding:9px 14px;font:600 13px/1 var(--prd-font);cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.25)}
.prd-launcher__dot{display:inline-block;min-width:18px;border-radius:9px;background:#a78bfa;color:#15121f;padding:2px 5px;margin-left:4px}
.prd-panel{position:fixed;top:0;right:0;bottom:0;width:min(400px,100vw);background:var(--prd-bg);border-left:1px solid var(--prd-line);overflow-y:auto;padding:16px 16px 80px;box-shadow:-8px 0 24px rgba(0,0,0,.15)}
.prd-panel__head{display:grid;gap:4px;margin-bottom:8px}.prd-panel__bar{display:flex;align-items:center;gap:4px}.prd-panel__bar strong{flex:1}.prd-icon-btn{border:1px solid var(--prd-line);background:var(--prd-card);color:var(--prd-text);border-radius:8px;width:30px;height:30px;cursor:pointer;font:600 13px/1 var(--prd-font)}.prd-icon-btn:hover{background:var(--prd-surface)}.prd-panel__search{display:grid;gap:4px;margin-top:6px}.prd-panel__prio{display:flex;gap:6px;flex-wrap:wrap}.prd-panel__prio .prd-chip:disabled{opacity:.45;cursor:default}.prd-panel [hidden]{display:none!important}
.prd-panel .prd-control__comment,.prd-focus__side .prd-control__comment{flex-direction:column;align-items:stretch}
.prd-panel .prd-control__row .prd-btn--verdict,.prd-focus__side .prd-control__row .prd-btn--verdict{flex:1}.prd-pgroup{margin:0 0 18px}.prd-pgroup__epic{position:sticky;top:-16px;z-index:1;margin:0 -16px 8px;padding:8px 16px;background:var(--prd-surface);border-block:1px solid var(--prd-line);font-weight:700;font-size:13px}.prd-pgroup__story{margin:10px 0 4px;padding-left:10px;border-left:3px solid var(--prd-accent)}.prd-pgroup__story-title{font-weight:600;font-size:13.5px;line-height:1.35}.prd-pgroup__id{font:600 11.5px/1 ui-monospace,Menlo,monospace;color:var(--prd-muted);margin-right:4px}.prd-panel--left{right:auto;left:0;border-left:0;border-right:1px solid var(--prd-line);box-shadow:8px 0 24px rgba(0,0,0,.15)}.prd-pin-row{margin:-4px 0 8px 32px;display:flex;gap:6px;flex-wrap:wrap}.prd-pin-row .prd-btn.is-on{background:var(--prd-accent-soft);color:var(--prd-accent)}
@media (max-width:640px){.prd-summary__side{align-items:flex-start;text-align:left}.prd-story{padding:14px}.prd-control__comment{flex-direction:column;align-items:stretch}}
`;
