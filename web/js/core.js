// Ядро клиента: HTTP, состояние, маршрутизация, вспомогательные функции разметки.

// ── API ──────────────────────────────────────────────────────
async function request(method, path, body) {
  const opts = { method, headers: {}, credentials: 'same-origin' };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  if (res.status === 204) return null;
  const type = res.headers.get('content-type') || '';
  if (!type.includes('application/json')) {
    if (!res.ok) throw new Error(`Ошибка ${res.status}`);
    return res;
  }
  const data = await res.json();
  if (!res.ok) throw Object.assign(new Error(data.error || `Ошибка ${res.status}`), { status: res.status, data });
  return data;
}
export const api = {
  get: (p) => request('GET', p),
  post: (p, b) => request('POST', p, b ?? {}),
  patch: (p, b) => request('PATCH', p, b),
  put: (p, b) => request('PUT', p, b),
  del: (p) => request('DELETE', p),
};

// ── Состояние ────────────────────────────────────────────────
export const state = {
  user: null, counts: { tasks: 0, notifications: 0 }, stages: [], institutions: [],
};

export async function refreshMe() {
  try {
    const d = await api.get('/api/auth/me');
    state.user = d.user; state.counts = d.counts;
    return d.user;
  } catch { state.user = null; return null; }
}

export const can = (perm) => !!state.user?.permissions?.includes(perm);

// ── Маршрутизация ────────────────────────────────────────────
const listeners = [];
export function onRoute(fn) { listeners.push(fn); }
export function navigate(path, replace = false) {
  if (replace) history.replaceState({}, '', path); else history.pushState({}, '', path);
  emit();
}
export function currentRoute() {
  const [path, queryString] = (location.pathname + location.search).split('?');
  return { path: path.replace(/\/+$/, '') || '/', query: new URLSearchParams(queryString || '') };
}
function emit() { const r = currentRoute(); listeners.forEach((fn) => fn(r)); }
addEventListener('popstate', emit);
export function startRouter() { emit(); }

// Делегирование кликов по внутренним ссылкам
addEventListener('click', (e) => {
  const a = e.target.closest('a[href^="/"]');
  if (!a || a.target === '_blank' || e.metaKey || e.ctrlKey || e.shiftKey) return;
  if (a.hasAttribute('download') || a.dataset.native) return;
  e.preventDefault();
  navigate(a.getAttribute('href'));
});

// ── Разметка ─────────────────────────────────────────────────
export const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export const html = (strings, ...values) => strings.reduce((acc, s, i) => {
  const v = values[i - 1];
  const rendered = Array.isArray(v) ? v.join('') : (v ?? '');
  return acc + rendered + s;
});

export function nl2br(s) { return esc(s).replace(/\n/g, '<br>'); }

// ── Форматирование ───────────────────────────────────────────
const MONTHS = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];

export function parseDate(v) {
  if (!v) return null;
  return new Date(String(v).includes('T') ? v : v.replace(' ', 'T') + 'Z');
}
export function fmtDate(v, withTime = false) {
  const d = parseDate(v); if (!d || isNaN(d)) return '—';
  const s = `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  return withTime ? `${s}, ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : s;
}
export function fmtShort(v) {
  const d = parseDate(v); if (!d || isNaN(d)) return '—';
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
}
export function fmtAgo(v) {
  const d = parseDate(v); if (!d || isNaN(d)) return '—';
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return 'только что';
  if (mins < 60) return `${mins} ${plural(mins, 'минуту', 'минуты', 'минут')} назад`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h} ${plural(h, 'час', 'часа', 'часов')} назад`;
  const days = Math.round(h / 24);
  if (days < 31) return `${days} ${plural(days, 'день', 'дня', 'дней')} назад`;
  return fmtDate(v);
}
export function plural(n, one, few, many) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}
export const num = (v, d = 0) => (v === null || v === undefined || isNaN(v)) ? '—'
  : Number(v).toLocaleString('ru-RU', { minimumFractionDigits: d, maximumFractionDigits: d });
export function fmtHours(h) {
  if (h === null || h === undefined) return '—';
  if (h < 24) return `${num(h, 1)} ч`;
  const d = h / 24;
  return `${num(d, 1)} ${plural(Math.round(d), 'день', 'дня', 'дней')}`;
}
export function initials(name) {
  const parts = String(name || '').trim().split(/\s+/);
  return ((parts[0]?.[0] || '') + (parts[1]?.[0] || '')).toUpperCase();
}
const AVATAR_COLORS = ['#2f66b5','#1a7f52','#a8620a','#6b3fa0','#b32b2b','#0e7490','#9d3d6f','#4d6b1f'];
export function avatarColor(seed) {
  const s = String(seed || '');
  let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}
export function avatar(name, cls = '') {
  return html`<div class="avatar ${cls}" style="background:${avatarColor(name)}" title="${esc(name || '')}">${esc(initials(name))}</div>`;
}

// ── Словари отображения ──────────────────────────────────────
export const ROLE_TITLES = {
  employee: 'Сотрудник учреждения', head: 'Руководитель учреждения', expert: 'Эксперт ДТСЗН',
  developer: 'Команда разработки и ЦТ', supplier: 'Поставщик технологий и услуг',
  pilot_coordinator: 'Координатор пилотных площадок', dtszn: 'ДТСЗН (центральный аппарат)',
};
export const ROLE_SHORT = {
  employee: 'Сотрудник', head: 'Руководитель', expert: 'Эксперт', developer: 'Разработка',
  supplier: 'Поставщик', pilot_coordinator: 'Пилоты', dtszn: 'ДТСЗН',
};
export const DECISION_META = {
  go: { title: 'Go — продолжить', badge: 'ok', verb: 'принял решение продолжить' },
  kill: { title: 'Kill — остановить', badge: 'danger', verb: 'остановил инициативу' },
  hold: { title: 'Hold — приостановить', badge: 'warn', verb: 'приостановил инициативу' },
  redirect: { title: 'Redirect — перенаправить', badge: 'purple', verb: 'направил на доработку' },
};
export const STATUS_META = {
  active: { title: 'В работе', badge: 'info' },
  hold: { title: 'Приостановлена', badge: 'warn' },
  killed: { title: 'Остановлена', badge: 'danger' },
  scaled: { title: 'Масштабирована', badge: 'ok' },
};
export const ITEM_STATUS = {
  backlog: 'Бэклог', todo: 'К работе', in_progress: 'В работе', review: 'На проверке', done: 'Готово',
};
export const PILOT_STATUS = {
  planned: 'Запланирован', running: 'Идёт', analysis: 'Анализ результатов', finished: 'Завершён',
};

export function slaChip(sla) {
  if (!sla || sla.code === 'none') return '';
  const map = { ok: ['ok', 'В рамках SLA'], risk: ['risk', 'Риск нарушения SLA'], breached: ['breached', 'SLA нарушен'] };
  const [cls, label] = map[sla.code] || map.ok;
  const left = sla.hoursLeft !== undefined
    ? (sla.hoursLeft < 0 ? `просрочено на ${fmtHours(-sla.hoursLeft)}` : `осталось ${fmtHours(sla.hoursLeft)}`)
    : '';
  return html`<span class="sla-chip sla-chip--${cls}" title="${esc(left)}">${label}</span>`;
}

// ── Уведомления и модальные окна ─────────────────────────────
export function toast(message, kind = '', title = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind ? 'toast--' + kind : ''}`;
  el.innerHTML = (title ? `<b>${esc(title)}</b>` : '') + `<span>${esc(message)}</span>`;
  document.getElementById('toasts').append(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transform = 'translateX(20px)';
    el.style.transition = 'all .25s'; setTimeout(() => el.remove(), 260); }, 4200);
}

export function modal({ title, body, footer, wide = false, onMount }) {
  const root = document.getElementById('modal-root');
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = html`
    <div class="modal ${wide ? 'modal--wide' : ''}" role="dialog" aria-modal="true">
      <div class="modal__head">
        <h3>${esc(title)}</h3>
        <button class="icon-btn spacer" data-close aria-label="Закрыть">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>
      </div>
      <div class="modal__body">${body}</div>
      ${footer ? `<div class="modal__foot">${footer}</div>` : ''}
    </div>`;
  root.append(backdrop);
  const close = () => { backdrop.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop || e.target.closest('[data-close]')) close();
  });
  onMount?.(backdrop, close);
  backdrop.querySelector('input,textarea,select')?.focus();
  return close;
}

export function confirmDialog(title, message, confirmLabel = 'Подтвердить') {
  return new Promise((resolve) => {
    const close = modal({
      title,
      body: `<p class="prose">${esc(message)}</p>`,
      footer: html`<button class="btn" data-close>Отмена</button>
                   <button class="btn btn--primary" data-ok>${esc(confirmLabel)}</button>`,
      onMount: (el, done) => {
        el.querySelector('[data-ok]').onclick = () => { done(); resolve(true); };
        el.addEventListener('click', (e) => {
          if (e.target === el || e.target.closest('[data-close]')) resolve(false);
        });
      },
    });
  });
}

// ── Диаграммы (инлайновый SVG, без внешних библиотек) ────────
export function barList(items, { color = 'var(--brand-600)', suffix = '', max } = {}) {
  const peak = max ?? Math.max(1, ...items.map((i) => Math.abs(i.value)));
  return items.map((i) => html`
    <div class="bar-row">
      <div class="bar-row__label" title="${esc(i.label)}">${esc(i.label)}</div>
      <div class="bar-row__track">
        <div class="bar-row__fill" style="width:${Math.max(1.5, (Math.abs(i.value) / peak) * 100)}%;background:${i.color || color}"></div>
      </div>
      <div class="bar-row__value">${i.display ?? num(i.value)}${suffix}</div>
    </div>`).join('');
}

export function lineChart(points, { height = 170, series = [] } = {}) {
  if (!points.length) return '<div class="empty"><p>Недостаточно данных для построения графика</p></div>';
  const W = 660, H = height, padL = 34, padR = 12, padT = 12, padB = 26;
  const maxY = Math.max(1, ...points.flatMap((p) => series.map((s) => p[s.key] || 0)));
  const stepX = (W - padL - padR) / Math.max(1, points.length - 1);
  const y = (v) => padT + (H - padT - padB) * (1 - v / maxY);
  const ticks = 4;
  const gridLines = Array.from({ length: ticks + 1 }, (_, i) => {
    const val = (maxY / ticks) * i;
    return html`<line class="grid-line" x1="${padL}" y1="${y(val)}" x2="${W - padR}" y2="${y(val)}"/>
                <text x="${padL - 7}" y="${y(val) + 3.5}" text-anchor="end">${num(val)}</text>`;
  }).join('');
  const paths = series.map((s) => {
    const d = points.map((p, i) => `${i ? 'L' : 'M'}${padL + i * stepX} ${y(p[s.key] || 0)}`).join(' ');
    const area = `${d} L${padL + (points.length - 1) * stepX} ${H - padB} L${padL} ${H - padB} Z`;
    return html`${s.fill ? `<path d="${area}" fill="${s.color}" opacity=".1"/>` : ''}
      <path d="${d}" fill="none" stroke="${s.color}" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>
      ${points.map((p, i) => `<circle cx="${padL + i * stepX}" cy="${y(p[s.key] || 0)}" r="3" fill="${s.color}"><title>${esc(p.label)}: ${p[s.key] || 0}</title></circle>`).join('')}`;
  }).join('');
  const labels = points.map((p, i) => {
    const show = points.length <= 8 || i % Math.ceil(points.length / 7) === 0 || i === points.length - 1;
    return show ? `<text x="${padL + i * stepX}" y="${H - 8}" text-anchor="middle">${esc(p.label)}</text>` : '';
  }).join('');
  return html`<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img">
    ${gridLines}<line class="axis" x1="${padL}" y1="${H - padB}" x2="${W - padR}" y2="${H - padB}"/>
    ${paths}${labels}</svg>`;
}

export function donut(segments, { size = 128, thickness = 17, center } = {}) {
  const total = segments.reduce((s, x) => s + x.value, 0) || 1;
  const r = (size - thickness) / 2, C = 2 * Math.PI * r;
  let offset = 0;
  const arcs = segments.map((s) => {
    const len = (s.value / total) * C;
    const el = html`<circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${s.color}"
      stroke-width="${thickness}" stroke-dasharray="${len} ${C - len}" stroke-dashoffset="${-offset}"
      transform="rotate(-90 ${size / 2} ${size / 2})"><title>${esc(s.label)}: ${s.value}</title></circle>`;
    offset += len;
    return el;
  }).join('');
  return html`<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img">
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="var(--surface-3)" stroke-width="${thickness}"/>
    ${arcs}
    ${center ? `<text x="${size / 2}" y="${size / 2 - 2}" text-anchor="middle" font-size="21" font-weight="700" fill="var(--text)">${esc(center.value)}</text>
      <text x="${size / 2}" y="${size / 2 + 15}" text-anchor="middle" font-size="10.5" fill="var(--text-3)">${esc(center.label)}</text>` : ''}
  </svg>`;
}

// ── Прочее ───────────────────────────────────────────────────
export function debounce(fn, ms = 300) {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
export const THEME_KEY = 's1-theme';
export function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem(THEME_KEY, theme); } catch {}
}
export function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem(THEME_KEY); } catch {}
  applyTheme(saved || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
}
