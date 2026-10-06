// Каталог разработчиков ИИ-решений: внешние вендоры, внутренние команды и команды ДИТ.
//
// Реальных данных пока нет, поэтому раздел в первую очередь — удобный ввод: у
// карточки видно, чего в ней не хватает, а у каталога — какие компетенции не
// закрыты никем. Подбор под задачу идёт двумя путями: от разработчика (фильтры
// каталога) и от потребности (сквозной каталог решений).
import { api, state, esc, html, can, navigate, toast, modal, confirmDialog,
         avatar, fmtAgo, fmtDate, fmtShort, num, plural, debounce, currentRoute } from '../core.js';

const KIND_BADGE = { external: 'badge--purple', internal: 'badge--info', dit: 'badge--ok' };
const AVAIL_BADGE = { available: 'badge--ok', limited: 'badge--warn', busy: 'badge--danger', unknown: 'badge--outline' };
const MATURITY_BADGE = { production: 'badge--ok', pilot: 'badge--info', prototype: 'badge--outline' };
const PRICE = { 1: '₽', 2: '₽₽', 3: '₽₽₽' };
const PRICE_TITLE = { 1: 'Бюджетный уровень', 2: 'Средний уровень', 3: 'Высокий уровень' };

const kindBadge = (dict, kind) =>
  html`<span class="badge ${KIND_BADGE[kind] || 'badge--outline'}">${esc(dict.kinds[kind]?.title || kind)}</span>`;
const statusBadge = (dict, status) => {
  const s = dict.statuses[status];
  return html`<span class="badge badge--${s?.badge || 'outline'}">${esc(s?.title || status)}</span>`;
};
const chips = (codes, dictPart, limit = Infinity) => {
  const shown = codes.slice(0, limit);
  const rest = codes.length - shown.length;
  return shown.map((c) => `<span class="pv-tag">${esc(dictPart[c] || c)}</span>`).join('')
    + (rest > 0 ? `<span class="pv-tag pv-tag--more">+${rest}</span>` : '');
};
const demoBadge = (p) => p.is_demo
  ? ' <span class="badge badge--outline" title="Вымышленный разработчик для демонстрации раздела">демо</span>' : '';
const tagList = (tags) => tags.map((t) => `<span class="pv-tag pv-tag--tech">${esc(t)}</span>`).join('');
const stars = (v) => v === null || v === undefined ? '<span class="text-3">—</span>'
  : html`<span class="pv-stars" title="${num(v, 1)} из 5">★ ${num(v, 1)}</span>`;
const fillBar = (pct) => html`
  <div class="pv-fill" title="Карточка заполнена на ${pct}%">
    <div class="progress ${pct >= 80 ? 'progress--ok' : pct < 50 ? 'progress--danger' : ''}"><i style="width:${pct}%"></i></div>
    <span>${pct}%</span>
  </div>`;
const options = (dictPart, selected, empty) =>
  (empty !== undefined ? `<option value="">${esc(empty)}</option>` : '')
  + Object.entries(dictPart).map(([k, v]) =>
    `<option value="${esc(k)}" ${String(selected) === k ? 'selected' : ''}>${esc(typeof v === 'string' ? v : v.title)}</option>`).join('');

function noAccess(view) {
  view.innerHTML = html`
    <div class="card"><div class="empty">
      <h4>Каталог разработчиков доступен по отдельному допуску</h4>
      <p>Сведения о подрядчиках и командах — коммерчески чувствительные. Доступ выдаёт
         администратор каталога конкретному сотруднику.</p>
    </div></div>`;
}

// ─────────────────────────────────────────────────────────────
// Раздел: вкладки
// ─────────────────────────────────────────────────────────────
export async function providersView(view, query) {
  if (!can('provider.read') && can('provider.self')) return myCompanies(view);
  if (!can('provider.read')) return noAccess(view);
  const tab = query.get('tab') || 'list';
  const tabs = [['list', 'Разработчики'], ['solutions', 'Решения и технологии'],
    ...(can('provider.admin') ? [['access', 'Доступ к каталогу']] : [])];

  view.innerHTML = html`
    <div class="page-head">
      <div class="page-head__row">
        <div style="flex:1;min-width:280px">
          <h2>Каталог разработчиков ИИ-решений</h2>
          <p>Кому можно поручить разработку и внедрение: внешние вендоры, внутренние команды
             и команды, которые может выделить ДИТ. Портфолио, каталог готовых решений и
             опыт совместной работы — в одной карточке, чтобы сравнивать разработчиков между собой.</p>
        </div>
        <div class="row" data-tour="pv-guide">
          <a class="btn" href="/api/providers/guide/user.pdf" download data-native>Инструкция пользователя (PDF)</a>
          ${can('provider.edit') ? '<a class="btn" href="/api/providers/guide/moderator.pdf" download data-native>Инструкция модератора (PDF)</a>' : ''}
          <a class="btn btn--ghost" href="/processes?s=providers">Схемы процессов</a>
          ${can('provider.edit') ? '<a class="btn btn--primary" href="/providers/new" data-tour="pv-add">Добавить разработчика</a>' : ''}
        </div>
      </div>
    </div>
    <div class="tabs" data-tour="pv-tabs">
      ${tabs.map(([k, t]) => `<button class="tab ${tab === k ? 'is-active' : ''}" data-tab="${k}">${t}</button>`)}
    </div>
    <div id="pv-panel"><div class="skeleton" style="height:320px"></div></div>`;

  view.querySelectorAll('[data-tab]').forEach((t) => t.onclick = () => navigate(`/providers?tab=${t.dataset.tab}`));
  const panel = view.querySelector('#pv-panel');
  if (tab === 'solutions') return solutionsPanel(panel, query);
  if (tab === 'access' && can('provider.admin')) return accessPanel(panel);
  return listPanel(panel, query);
}

// ─────────────────────────────────────────────────────────────
// Представитель разработчика: только свои карточки
// ─────────────────────────────────────────────────────────────
async function myCompanies(view) {
  const mine = await api.get('/api/providers/mine');
  if (mine.length === 1) { navigate(`/providers/${mine[0].id}`, true); return; }
  view.innerHTML = html`
    <div class="page-head"><h2>Моя компания в каталоге</h2>
      <p>Каталог разработчиков ИИ-решений помогает ДТСЗН выбирать исполнителей. Здесь вы ведёте
         сведения о технологиях, проектах и решениях своей компании.</p>
      <div class="row" style="margin-top:10px"><a class="btn" href="/api/providers/guide/representative.pdf" download data-native>Инструкция представителя (PDF)</a></div></div>
    ${mine.length ? html`<div class="stack">${mine.map((m) => html`
      <a class="card" href="/providers/${m.id}"><div class="card__body row">
        <b>${esc(m.name)}</b>${m.profile_status === 'pending' ? ' <span class="badge badge--warn">ожидает проверки</span>' : ''}
      </div></a>`)}</div>`
    : html`<div class="card"><div class="empty"><h4>Учётная запись пока не привязана к компании</h4>
        <p>Карточку компании заводит модератор каталога и привязывает к ней представителя.
           Сообщите вашему контакту в ДТСЗН адрес почты, под которым вы входите на платформу.</p></div></div>`}`;
}

// ─────────────────────────────────────────────────────────────
// Каталог разработчиков
// ─────────────────────────────────────────────────────────────
const FILTER_KEYS = ['kind', 'q', 'competencies', 'compliance', 'domain', 'availability', 'status',
  'public_sector', 'stale', 'pending', 'sort', 'dir', 'tag'];

async function listPanel(panel, query) {
  const f = Object.fromEntries(FILTER_KEYS.map((k) => [k, query.get(k) || '']));
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v) params.set(k, v);
  const { providers, counts, dict, summary } = await api.get(`/api/providers?${params}`);

  // Ссылка на тот же список с изменёнными фильтрами: состояние живёт в адресе,
  // поэтому подборку можно переслать коллеге
  const link = (over = {}) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...f, ...over })) if (v) p.set(k, v);
    return `/providers?${p}`;
  };
  const exportParams = new URLSearchParams(params);
  exportParams.delete('dir');
  const anyFilter = FILTER_KEYS.some((k) => !['kind', 'sort', 'dir'].includes(k) && f[k]);

  panel.innerHTML = html`
    ${summaryBlock(summary, dict)}

    <div class="chip-row" style="margin-bottom:12px" data-tour="pv-kinds">
      ${[['', 'Все', counts.all], ...Object.entries(dict.kinds).map(([k, v]) => [k, v.plural, counts[k]])]
        .map(([k, t, n]) => html`<button class="chip ${f.kind === k ? 'is-on' : ''}" data-go="${esc(link({ kind: k }))}">
          ${esc(t)} <b style="margin-left:4px">${n}</b></button>`)}
    </div>

    <div class="filters" data-tour="pv-filters">
      <input class="input" id="pv-q" type="search" value="${esc(f.q)}" placeholder="Название, ИНН, технология…" style="min-width:230px">
      <select class="select" data-filter="competencies">${options(dict.competencies, f.competencies, 'Любая компетенция')}</select>
      <select class="select" data-filter="compliance">${options(dict.compliance, f.compliance, 'Любые требования')}</select>
      <select class="select" data-filter="domain">${options(dict.domains, f.domain, 'Любой отраслевой опыт')}</select>
      <select class="select" data-filter="availability">${options(dict.availability, f.availability, 'Любая загрузка')}</select>
      <select class="select" data-filter="status">${options(dict.statuses, f.status, 'Все, кроме архива')}</select>
      <label class="checkbox"><input type="checkbox" data-flag="public_sector" ${f.public_sector ? 'checked' : ''}> Опыт в госсекторе</label>
      <label class="checkbox"><input type="checkbox" data-flag="stale" ${f.stale ? 'checked' : ''}> Требуют сверки</label>
      <label class="checkbox"><input type="checkbox" data-flag="pending" ${f.pending ? 'checked' : ''}> Ожидают проверки</label>
      ${f.tag ? html`<button class="chip is-on" data-go="${esc(link({ tag: '' }))}" title="Снять фильтр">${esc(f.tag)} ✕</button>` : ''}
      ${anyFilter ? `<button class="btn btn--ghost btn--sm" data-go="${esc(link(Object.fromEntries(FILTER_KEYS.filter((k) => !['kind', 'sort', 'dir'].includes(k)).map((k) => [k, '']))))}">Сбросить</button>` : ''}
    </div>

    <div class="card">
      <div class="card__head">
        <h3>${providers.length} ${plural(providers.length, 'разработчик', 'разработчика', 'разработчиков')}</h3>
        <div class="row spacer" data-tour="pv-tools">
          <button class="btn btn--sm" data-compare disabled>Сравнить</button>
          <select class="select btn--sm" id="pv-sort" style="width:auto;padding:5px 30px 5px 10px;font-size:12.5px">
            ${options(dict.sorts, f.sort || 'updated')}</select>
          <button class="btn btn--sm btn--ghost" data-dir title="Обратный порядок">${f.dir === 'asc' ? '↑' : '↓'}</button>
          <a class="btn btn--sm" href="/api/providers/export.csv?${esc(exportParams.toString())}" download data-native>Выгрузить CSV</a>
        </div>
      </div>
      <div class="card__body--flush">
        ${providers.length ? html`
        <div class="table-wrap"><table class="table pv-table">
          <thead><tr>
            <th style="width:34px"></th><th>Разработчик</th><th>Компетенции</th><th>Статус</th>
            <th class="num">Проекты</th><th class="num">Решения</th><th class="num">Оценка</th><th>Заполненность</th>
          </tr></thead>
          <tbody>
            ${providers.map((p) => html`
              <tr class="is-clickable" data-open="${p.id}">
                <td data-stop><input type="checkbox" class="pv-pick" value="${p.id}" aria-label="Выбрать для сравнения"></td>
                <td>
                  <div class="pv-name"><b>${esc(p.name)}</b>${demoBadge(p)}${p.profile_status === 'pending' ? ' <span class="badge badge--warn" title="Представитель компании изменил сведения, модератор ещё не подтвердил">ожидает проверки</span>' : ''}${p.stale ? ' <span class="badge badge--warn" title="Сведения давно не обновлялись">сверить</span>' : ''}</div>
                  <div class="row" style="gap:6px;margin-top:3px">
                    ${kindBadge(dict, p.kind)}
                    <span class="fs-12 text-3">${esc(p.kind === 'external' ? (p.city || '') : (p.org_unit || ''))}</span>
                  </div>
                </td>
                <td><div class="pv-tags">${chips(p.competencies, dict.competencies, 3) || '<span class="text-3 fs-12">не указаны</span>'}</div></td>
                <td>
                  ${statusBadge(dict, p.status)}
                  <div class="fs-12 text-3" style="margin-top:3px">${esc(dict.availability[p.availability])}</div>
                </td>
                <td class="num">${p.cases_count}${p.public_cases ? `<div class="fs-12 text-3">гос: ${p.public_cases}</div>` : ''}</td>
                <td class="num">${p.solutions_count}</td>
                <td class="num">${stars(p.rating)}</td>
                <td>${fillBar(p.completeness)}</td>
              </tr>`)}
          </tbody>
        </table></div>`
        : emptyList(anyFilter || f.kind)}
      </div>
    </div>`;

  panel.querySelectorAll('[data-go]').forEach((b) => b.onclick = () => navigate(b.dataset.go));
  panel.querySelectorAll('[data-open]').forEach((r) => r.onclick = (e) => {
    if (e.target.closest('[data-stop]')) return;
    navigate(`/providers/${r.dataset.open}`);
  });
  panel.querySelectorAll('[data-filter]').forEach((s) => s.onchange = () => navigate(link({ [s.dataset.filter]: s.value })));
  panel.querySelectorAll('[data-flag]').forEach((c) => c.onchange = () => navigate(link({ [c.dataset.flag]: c.checked ? '1' : '' })));
  panel.querySelector('#pv-sort').onchange = (e) => navigate(link({ sort: e.target.value, dir: '' }));
  panel.querySelector('[data-dir]').onclick = () => navigate(link({ dir: f.dir === 'asc' ? '' : 'asc' }));
  const input = panel.querySelector('#pv-q');
  input.addEventListener('input', debounce(() => {
    const pos = input.selectionStart;
    navigate(link({ q: input.value.trim() }), true);
    // Список перерисован — возвращаем курсор, чтобы набор не прерывался
    requestAnimationFrame(() => {
      const again = document.getElementById('pv-q');
      if (again) { again.focus(); again.setSelectionRange(pos, pos); }
    });
  }, 350));

  const compareBtn = panel.querySelector('[data-compare]');
  const picked = () => [...panel.querySelectorAll('.pv-pick:checked')].map((c) => Number(c.value));
  panel.querySelectorAll('.pv-pick').forEach((c) => c.onchange = () => {
    const n = picked().length;
    compareBtn.disabled = n < 2 || n > 4;
    compareBtn.textContent = n ? `Сравнить (${n})` : 'Сравнить';
    compareBtn.title = n > 4 ? 'Сравнить можно до четырёх разработчиков' : '';
  });
  compareBtn.onclick = () => compareModal(picked(), dict);
}

function summaryBlock(s, dict) {
  return html`
    <div class="grid grid--kpi" style="margin-bottom:16px" data-tour="pv-summary">
      <div class="kpi"><div class="kpi__label">Разработчиков в каталоге</div><div class="kpi__value">${num(s.total)}</div>
        <div class="kpi__meta">${Object.entries(s.by_kind).map(([k, n]) => `${esc(dict.kinds[k].plural)}: ${n}`).join(' · ')}</div></div>
      <div class="kpi kpi--ok"><div class="kpi__label">Привлечены к работе</div><div class="kpi__value">${num(s.engaged)}</div></div>
      <div class="kpi"><div class="kpi__label">Решений в каталоге</div><div class="kpi__value">${num(s.solutions)}</div></div>
      <div class="kpi ${s.incomplete || s.stale ? 'kpi--warn' : ''}"><div class="kpi__label">Нужно дозаполнить</div>
        <div class="kpi__value">${num(s.incomplete)}</div>
        <div class="kpi__meta">Заполнены меньше чем на 60%${s.stale ? ` · требуют сверки: ${s.stale}` : ''}${s.pending ? ` · ожидают проверки: ${s.pending}` : ''}</div></div>
    </div>
    ${s.total && s.gaps.length ? html`
      <div class="hint-box pv-gaps" style="margin-bottom:16px">
        <b>Не закрыты ни одним разработчиком:</b>
        ${s.gaps.map((c) => `<span class="pv-tag pv-tag--gap">${esc(dict.competencies[c])}</span>`)}
      </div>` : ''}`;
}

function emptyList(filtered) {
  if (filtered) {
    return html`<div class="empty"><h4>Под эти условия никто не подходит</h4>
      <p>Ослабьте фильтры или загляните во вкладку «Решения и технологии» — нужная технология может быть у разработчика с другой специализацией.</p></div>`;
  }
  return html`<div class="empty">
    <h4>Каталог пока пуст</h4>
    <p>Начните с тех, с кем уже работали или вели переговоры: внешних вендоров,
       команд своих учреждений и команд, которые может выделить ДИТ.</p>
    ${can('provider.edit') ? '<a class="btn btn--primary" href="/providers/new" style="margin-top:14px">Добавить первого разработчика</a>' : ''}
  </div>`;
}

// ─────────────────────────────────────────────────────────────
// Сравнение
// ─────────────────────────────────────────────────────────────
async function compareModal(ids, dict) {
  const items = (await Promise.all(ids.map((id) => api.get(`/api/providers/${id}`)))).map((r) => r.provider);
  const row = (label, fn) => html`<tr><th>${esc(label)}</th>${items.map((p) => `<td>${fn(p)}</td>`)}</tr>`;
  // Строка компетенций подсвечивает то, что есть у одного и нет у другого
  const allComp = [...new Set(items.flatMap((p) => p.competencies))];
  modal({
    title: 'Сравнение разработчиков',
    wide: true,
    body: html`
      <div class="table-wrap"><table class="table pv-compare">
        <thead><tr><th></th>${items.map((p) => html`<th><a href="/providers/${p.id}" data-close>${esc(p.name)}</a></th>`)}</tr></thead>
        <tbody>
          ${row('Вид', (p) => kindBadge(dict, p.kind))}
          ${row('Статус', (p) => statusBadge(dict, p.status))}
          ${row('Загрузка', (p) => esc(dict.availability[p.availability]))}
          ${row('Команда', (p) => p.team_size ? `${num(p.team_size)} чел.` : '—')}
          ${row('Стоимость', (p) => p.price_band ? `<span title="${PRICE_TITLE[p.price_band]}">${PRICE[p.price_band]}</span>` : '—')}
          ${row('Оценка', (p) => `${stars(p.rating)} <span class="fs-12 text-3">${p.reviews_count ? `(${p.reviews_count})` : ''}</span>`)}
          ${row('Проектов / в госсекторе', (p) => `${p.cases_count} / ${p.public_cases}`)}
          ${row('Решений в каталоге', (p) => String(p.solutions_count))}
          <tr><th>Компетенции</th>${items.map((p) => `<td>${allComp.map((c) =>
            `<div class="pv-cmp ${p.competencies.includes(c) ? 'is-yes' : 'is-no'}">${p.competencies.includes(c) ? '✓' : '—'} ${esc(dict.competencies[c])}</div>`).join('')}</td>`)}</tr>
          ${row('Соответствие требованиям', (p) => Object.keys(dict.compliance).map((c) =>
            `<div class="pv-cmp ${p.compliance.includes(c) ? 'is-yes' : 'is-no'}">${p.compliance.includes(c) ? '✓' : '—'} ${esc(dict.compliance[c])}</div>`).join(''))}
          ${row('Технологии', (p) => `<div class="pv-tags">${tagList(p.tags) || '—'}</div>`)}
          ${row('Заполненность', (p) => fillBar(p.completeness))}
        </tbody>
      </table></div>`,
  });
}

// ─────────────────────────────────────────────────────────────
// Сквозной каталог решений
// ─────────────────────────────────────────────────────────────
async function solutionsPanel(panel, query) {
  const keys = ['q', 'competency', 'kind', 'maturity', 'provider_kind', 'registry', 'tag'];
  const f = Object.fromEntries(keys.map((k) => [k, query.get(k) || '']));
  const params = new URLSearchParams({ tab: 'solutions' });
  for (const [k, v] of Object.entries(f)) if (v) params.set(k, v);
  const { solutions, dict } = await api.get(`/api/providers/solutions?${params}`);
  const link = (over = {}) => {
    const p = new URLSearchParams({ tab: 'solutions' });
    for (const [k, v] of Object.entries({ ...f, ...over })) if (v) p.set(k, v);
    return `/providers?${p}`;
  };

  panel.innerHTML = html`
    <p class="text-2" style="margin-bottom:12px">Поиск от потребности: какие готовые решения и технологии
      уже есть у разработчиков из каталога. Зрелые решения показаны первыми — их можно брать в работу без разработки.</p>
    <div class="filters" data-tour="pv-sol-filters">
      <input class="input" id="sol-q" type="search" value="${esc(f.q)}" placeholder="Что нужно сделать или какая технология" style="min-width:260px">
      <select class="select" data-filter="competency">${options(dict.competencies, f.competency, 'Любая задача')}</select>
      <select class="select" data-filter="kind">${options(dict.solution_kinds, f.kind, 'Любой тип')}</select>
      <select class="select" data-filter="maturity">${options(dict.maturity, f.maturity, 'Любая зрелость')}</select>
      <select class="select" data-filter="provider_kind">${options(dict.kinds, f.provider_kind, 'Любой разработчик')}</select>
      <label class="checkbox"><input type="checkbox" data-flag="registry" ${f.registry ? 'checked' : ''}> В реестре отечественного ПО</label>
      ${f.tag ? html`<button class="chip is-on" data-go="${esc(link({ tag: '' }))}">${esc(f.tag)} ✕</button>` : ''}
    </div>
    ${solutions.length ? html`
      <div class="grid grid--2">${solutions.map((s) => solutionCard(s, dict, { withProvider: true }))}</div>`
    : html`<div class="card"><div class="empty"><h4>Решений не найдено</h4>
        <p>Каталог пополняется из карточек разработчиков: откройте разработчика и добавьте его решения.</p></div></div>`}`;

  panel.querySelectorAll('[data-go]').forEach((b) => b.onclick = () => navigate(b.dataset.go));
  panel.querySelectorAll('[data-filter]').forEach((s) => s.onchange = () => navigate(link({ [s.dataset.filter]: s.value })));
  panel.querySelectorAll('[data-flag]').forEach((c) => c.onchange = () => navigate(link({ [c.dataset.flag]: c.checked ? '1' : '' })));
  panel.querySelectorAll('[data-tag]').forEach((t) => t.onclick = () => navigate(link({ tag: t.dataset.tag })));
  const input = panel.querySelector('#sol-q');
  input.addEventListener('input', debounce(() => {
    const pos = input.selectionStart;
    navigate(link({ q: input.value.trim() }), true);
    requestAnimationFrame(() => {
      const again = document.getElementById('sol-q');
      if (again) { again.focus(); again.setSelectionRange(pos, pos); }
    });
  }, 350));
}

function solutionCard(s, dict, { withProvider = false, editable = false } = {}) {
  return html`
    <div class="card pv-sol">
      <div class="card__body">
        <div class="row" style="gap:6px;margin-bottom:6px">
          <span class="badge ${MATURITY_BADGE[s.maturity]}">${esc(dict.maturity[s.maturity])}</span>
          <span class="badge badge--outline">${esc(dict.solution_kinds[s.kind])}</span>
          ${s.in_registry ? '<span class="badge badge--info" title="Внесено в реестр отечественного ПО">Реестр ПО</span>' : ''}
          ${s.license ? `<span class="fs-12 text-3">${esc(dict.licenses[s.license])}</span>` : ''}
          ${editable ? html`<span class="spacer"></span>
            <button class="btn btn--ghost btn--sm" data-edit-sol="${s.id}">Изменить</button>
            <button class="btn btn--ghost btn--sm" data-del-sol="${s.id}" aria-label="Удалить">✕</button>` : ''}
        </div>
        <h3 class="pv-sol__title">${s.link ? html`<a href="${esc(s.link)}" target="_blank" rel="noopener noreferrer">${esc(s.name)}</a>` : esc(s.name)}</h3>
        ${withProvider ? html`<div class="fs-12" style="margin-bottom:6px">
          <a href="/providers/${s.provider_id}">${esc(s.provider_name)}</a> · <span class="text-3">${esc(dict.kinds[s.provider_kind]?.title)}</span></div>` : ''}
        ${s.description ? `<p class="text-2 clamp-3">${esc(s.description)}</p>` : ''}
        <div class="pv-tags" style="margin-top:8px">
          ${chips(s.competencies, dict.competencies)}
          ${s.tags.map((t) => withProvider
            ? `<button class="pv-tag pv-tag--tech" data-tag="${esc(t)}">${esc(t)}</button>`
            : `<span class="pv-tag pv-tag--tech">${esc(t)}</span>`).join('')}
        </div>
        ${s.price_note ? `<div class="fs-12 text-3" style="margin-top:8px">Стоимость: ${esc(s.price_note)}</div>` : ''}
      </div>
    </div>`;
}

// ─────────────────────────────────────────────────────────────
// Доступ к каталогу
// ─────────────────────────────────────────────────────────────
async function accessPanel(panel) {
  const data = await api.get('/api/providers/access');
  const DESCR = {
    provider_viewer: 'Смотрит карточки, портфолио, решения и технологии, выгружает подборки',
    provider_editor: 'Добавляет разработчиков и правит сведения, ведёт журнал, оценивает работу',
    provider_manager: 'Всё то же и выдаёт доступ другим, удаляет карточки',
  };
  const roleSelect = (current, attr) => html`
    <select class="select" ${attr} style="width:auto;padding:5px 30px 5px 10px;font-size:12.5px">
      ${data.roles.map((r) => `<option value="${r.code}" ${r.code === current ? 'selected' : ''}>${esc(r.title)}</option>`)}
    </select>`;

  panel.innerHTML = html`
    <div class="grid grid--3" style="margin-bottom:16px" data-tour="pv-roles">
      ${data.roles.map((r) => html`<div class="card"><div class="card__body">
        <b>${esc(r.title)}</b><div class="fs-12 text-3" style="margin-top:4px">${esc(DESCR[r.code] || '')}</div>
      </div></div>`)}
    </div>

    <div class="card" style="margin-bottom:16px">
      <div class="card__head"><div><h3>Выдать доступ</h3>
        <div class="card__hint">Найдите сотрудника по имени или почте. Выдача новой роли заменяет прежнюю роль каталога.</div></div></div>
      <div class="card__body">
        <div class="row">
          <input class="input" id="acc-q" type="search" placeholder="Фамилия или адрес почты" style="flex:1;min-width:240px">
          ${roleSelect('provider_editor', 'id="acc-role"')}
        </div>
        <div id="acc-found" class="list" style="margin-top:10px"></div>
      </div>
    </div>

    <div class="card" style="margin-bottom:16px" data-tour="pv-granted">
      <div class="card__head"><h3>Доступ выдан</h3><span class="card__hint spacer">${data.granted.length}</span></div>
      <div class="card__body--flush">
        ${data.granted.length ? html`
        <div class="table-wrap"><table class="table">
          <thead><tr><th>Сотрудник</th><th>Основная роль</th><th>Роль в каталоге</th><th>Выдал</th><th></th></tr></thead>
          <tbody>${data.granted.map((g) => html`
            <tr>
              <td><div class="row" style="gap:8px">${avatar(g.full_name, 'avatar--sm')}<div><b>${esc(g.full_name)}</b>
                <div class="fs-12 text-3">${esc(g.email)}${g.institution ? ' · ' + esc(g.institution) : ''}</div></div></div></td>
              <td class="fs-12">${esc(g.main_role_title)}</td>
              <td>${roleSelect(g.role_code, `data-change="${g.user_id}"`)}</td>
              <td class="fs-12 text-3">${esc(g.granted_by_name || '—')}<div>${esc(fmtShort(g.granted_at))}</div></td>
              <td><button class="btn btn--sm btn--ghost" data-revoke="${g.user_id}" data-name="${esc(g.full_name)}">Отозвать</button></td>
            </tr>`)}</tbody>
        </table></div>`
        : '<div class="empty"><p>Отдельно доступ пока никому не выдан.</p></div>'}
      </div>
    </div>

    <div class="card">
      <div class="card__head"><div><h3>Доступ по основной роли</h3>
        <div class="card__hint">Эти роли видят каталог целиком по настройке платформы. Изменить это можно
          в разделе «Настройки платформы → Роли и права».</div></div></div>
      <div class="card__body">
        ${data.by_role.length ? data.by_role.map((r) => html`<div class="row" style="justify-content:space-between;padding:4px 0">
          <span>${esc(r.title)}</span><span class="text-3 fs-12">${r.users} ${plural(r.users, 'участник', 'участника', 'участников')}</span></div>`)
          : '<p class="text-3">Ни одна роль платформы не видит каталог по умолчанию.</p>'}
      </div>
    </div>`;

  const reload = () => accessPanel(panel);
  const found = panel.querySelector('#acc-found');
  panel.querySelector('#acc-q').addEventListener('input', debounce(async (e) => {
    const text = e.target.value.trim();
    if (text.length < 2) { found.innerHTML = ''; return; }
    const list = await api.get(`/api/providers/access/candidates?q=${encodeURIComponent(text)}`);
    const has = new Map(data.granted.map((g) => [g.user_id, g.role_title]));
    found.innerHTML = list.length ? list.map((u) => html`
      <div class="list__item">
        ${avatar(u.full_name, 'avatar--sm')}
        <div class="list__main"><div class="list__title">${esc(u.full_name)}</div>
          <div class="list__meta">${esc(u.email)} · ${esc(u.role_title)}${u.institution ? ' · ' + esc(u.institution) : ''}
            ${has.has(u.id) ? ` · <b>сейчас: ${esc(has.get(u.id))}</b>` : ''}</div></div>
        <button class="btn btn--sm btn--primary" data-grant="${u.id}">Выдать</button>
      </div>`).join('') : '<p class="text-3 fs-12">Никого не нашлось</p>';
    found.querySelectorAll('[data-grant]').forEach((b) => b.onclick = async () => {
      try {
        await api.post('/api/providers/access', { user_id: Number(b.dataset.grant), role_code: panel.querySelector('#acc-role').value });
        toast('Доступ выдан', 'ok');
        reload();
      } catch (err) { toast(err.message, 'danger'); }
    });
  }, 250));

  panel.querySelectorAll('[data-change]').forEach((s) => s.onchange = async () => {
    try {
      await api.post('/api/providers/access', { user_id: Number(s.dataset.change), role_code: s.value });
      toast('Роль изменена', 'ok');
      reload();
    } catch (err) { toast(err.message, 'danger'); reload(); }
  });
  panel.querySelectorAll('[data-revoke]').forEach((b) => b.onclick = async () => {
    if (!await confirmDialog('Отозвать доступ', `${b.dataset.name} перестанет видеть каталог разработчиков.`, 'Отозвать')) return;
    try {
      await api.del(`/api/providers/access/${b.dataset.revoke}`);
      toast('Доступ отозван', 'ok');
      reload();
    } catch (err) { toast(err.message, 'danger'); }
  });
}

// ─────────────────────────────────────────────────────────────
// Карточка разработчика
// ─────────────────────────────────────────────────────────────
export async function providerDetail(view, id, query) {
  if (!can('provider.read') && !can('provider.self')) return noAccess(view);
  const { provider: p, dict, tags, access } = await api.get(`/api/providers/${id}`);
  const tab = query?.get('tab') || 'overview';
  const isRep = access === 'rep';
  const edit = access === 'edit';
  // Портфолио и решения правит и модератор, и представитель своей компании
  const content = edit || isRep;
  const myReview = p.reviews?.find((r) => r.author_id === state.user.id);

  const tabs = [
    ['overview', 'Обзор'],
    ['cases', `Портфолио · ${p.cases.length}`],
    ['solutions', `Решения и технологии · ${p.solutions.length}`],
    // Оценки коллег и журнал контактов — внутренние сведения каталога
    ...(isRep ? [] : [['reviews', `Оценки · ${p.reviews.length}`], ['notes', `Журнал · ${p.notes.length}`]]),
  ];

  view.innerHTML = html`
    <div class="crumb"><a href="/providers">${isRep ? 'Моя компания в каталоге' : 'Каталог разработчиков ИИ-решений'}</a> / ${esc(p.name)}</div>
    <div class="page-head">
      <div class="page-head__row">
        <div style="flex:1;min-width:280px">
          <div class="row" style="gap:6px;margin-bottom:6px">
            ${kindBadge(dict, p.kind)}
            <span class="badge ${AVAIL_BADGE[p.availability]}">${esc(dict.availability[p.availability])}</span>
            ${p.profile_status === 'pending' ? '<span class="badge badge--warn">ожидает проверки</span>' : ''}
            ${p.price_band ? `<span class="badge badge--outline" title="${PRICE_TITLE[p.price_band]}">${PRICE[p.price_band]}</span>` : ''}
            ${p.rating != null ? stars(p.rating) : ''}
          </div>
          <h2>${esc(p.name)} ${demoBadge(p)}</h2>
          <p>${esc(p.kind === 'external' ? (p.legal_name || '') : (p.org_unit || ''))}</p>
        </div>
        <div class="row">
          ${edit ? html`<select class="select" id="pv-status" style="width:auto" aria-label="Статус">${options(dict.statuses, p.status)}</select>`
                 : isRep ? '' : statusBadge(dict, p.status)}
          ${edit ? `<a class="btn" href="/providers/${p.id}/edit">Редактировать</a>` : ''}
          ${isRep ? `<a class="btn" href="/api/providers/guide/representative.pdf" download data-native>Инструкция (PDF)</a>
            <a class="btn btn--primary" href="/providers/${p.id}/edit" data-tour="pv-rep-edit">Заполнить профиль компании</a>` : ''}
          ${can('provider.admin') ? '<button class="btn btn--ghost" data-delete>Удалить</button>' : ''}
        </div>
      </div>
    </div>

    ${isRep ? html`<div class="hint-box pv-rep-note" style="margin-bottom:14px;border-left-color:var(--info);background:var(--info-bg)">
      Вы — представитель компании в каталоге разработчиков ИИ-решений. Технологический профиль, портфолио
      и решения заполняете вы; реквизиты, контакты и статус отбора ведёт модератор каталога. Ваши
      изменения видны сразу, с пометкой «ожидает проверки», пока модератор их не подтвердит.</div>` : ''}

    ${p.profile_status === 'pending' && !isRep ? html`<div class="hint-box pv-pending" style="margin-bottom:14px">
      <div class="row">
        <div style="flex:1;min-width:240px"><b>Сведения изменены представителем компании и ждут проверки.</b>
          <div class="fs-12">${esc(p.profile_changed_by_name || '')}${p.profile_changed_at ? ', ' + esc(fmtAgo(p.profile_changed_at)) : ''}${p.profile_note ? ': ' + esc(p.profile_note) : ''}</div></div>
        ${edit ? '<button class="btn btn--sm btn--primary" data-confirm>Подтвердить сведения</button>' : ''}
      </div></div>` : ''}

    ${p.stale ? html`<div class="hint-box" style="margin-bottom:14px">Сведения не обновлялись больше ${dict.stale_days} дней —
      проверьте, актуальны ли контакты, загрузка и решения.</div>` : ''}

    <div class="tabs" data-tour="pv-card-tabs">
      ${tabs.map(([k, t]) => `<button class="tab ${tab === k ? 'is-active' : ''}" data-tab="${k}">${esc(t)}</button>`)}
    </div>
    <div id="pv-tab"></div>`;

  const reload = (t = tab) => navigate(`/providers/${p.id}${t === 'overview' ? '' : `?tab=${t}`}`, true);
  view.querySelectorAll('[data-tab]').forEach((b) => b.onclick = () => reload(b.dataset.tab));
  view.querySelector('#pv-status')?.addEventListener('change', async (e) => {
    try { await api.post(`/api/providers/${p.id}/status`, { status: e.target.value }); toast('Статус изменён', 'ok'); reload(); }
    catch (err) { toast(err.message, 'danger'); }
  });
  view.querySelector('[data-confirm]')?.addEventListener('click', async () => {
    try { await api.post(`/api/providers/${p.id}/confirm`); toast('Сведения подтверждены', 'ok'); reload(); }
    catch (err) { toast(err.message, 'danger'); }
  });
  view.querySelector('[data-delete]')?.addEventListener('click', async () => {
    if (!await confirmDialog('Удалить разработчика',
      `Карточка «${p.name}» будет удалена вместе с портфолио, решениями, оценками и журналом. Если разработчик просто неактуален — переведите его в архив.`,
      'Удалить')) return;
    await api.del(`/api/providers/${p.id}`);
    toast('Карточка удалена', 'ok');
    navigate('/providers');
  });

  const box = view.querySelector('#pv-tab');
  const renderers = {
    overview: () => overviewTab(box, p, dict, { isRep, edit, reload }),
    cases: () => casesTab(box, p, dict, tags, content, reload),
    solutions: () => solutionsTab(box, p, dict, tags, content, reload),
    reviews: () => reviewsTab(box, p, myReview, edit, reload),
    notes: () => notesTab(box, p, dict, edit, reload),
  };
  (renderers[isRep && !['cases', 'solutions'].includes(tab) ? 'overview' : tab] || renderers.overview)();
}

function overviewTab(box, p, dict, { isRep, edit, reload }) {
  const contact = [p.contact_email && html`<a href="mailto:${esc(p.contact_email)}">${esc(p.contact_email)}</a>`,
                   p.contact_phone && esc(p.contact_phone)].filter(Boolean).join(' · ');
  box.innerHTML = html`
    <div class="pv-layout">
      <div class="stack">
        <div class="card"><div class="card__head"><h3>О разработчике</h3></div>
          <div class="card__body">
            ${p.description ? `<div class="prose">${esc(p.description).replace(/\n/g, '<br>')}</div>` : '<p class="text-3">Описание не заполнено.</p>'}
          </div></div>
        <div class="card"><div class="card__head"><h3>Компетенции и опыт</h3></div>
          <div class="card__body stack" style="gap:12px">
            <div><div class="field__label">Компетенции в ИИ</div><div class="pv-tags">${chips(p.competencies, dict.competencies) || '<span class="text-3">не указаны</span>'}</div></div>
            <div><div class="field__label">Отраслевой опыт</div><div class="pv-tags">${chips(p.domains, dict.domains) || '<span class="text-3">не указан</span>'}</div></div>
            <div><div class="field__label">Технологии</div><div class="pv-tags">${tagList(p.tags) || '<span class="text-3">не указаны</span>'}</div></div>
            <div><div class="field__label">Соответствие требованиям</div>
              ${Object.entries(dict.compliance).filter(([c]) => p.kind === 'external' || c !== 'msp').map(([c, t]) =>
                `<div class="pv-cmp ${p.compliance.includes(c) ? 'is-yes' : 'is-no'}">${p.compliance.includes(c) ? '✓' : '—'} ${esc(t)}</div>`).join('')}
            </div>
          </div></div>
      </div>
      <div class="stack">
        <div class="card" data-tour="pv-fill"><div class="card__head"><h3>Заполненность карточки</h3></div>
          <div class="card__body">
            ${fillBar(p.completeness)}
            ${p.missing.length ? html`<div class="fs-12 text-3" style="margin-top:8px">Не хватает: ${esc(p.missing.join(', '))}</div>`
              : '<div class="fs-12 text-3" style="margin-top:8px">Все основные сведения внесены.</div>'}
          </div></div>
        <div class="card"><div class="card__head"><h3>Сведения</h3></div>
          <div class="card__body"><dl class="def">
            ${p.kind === 'external' ? html`<dt>ИНН</dt><dd class="mono">${esc(p.inn || '—')}</dd>` : html`<dt>Подразделение</dt><dd>${esc(p.org_unit || '—')}</dd>`}
            <dt>Город</dt><dd>${esc(p.city || '—')}</dd>
            <dt>Команда</dt><dd>${p.team_size ? `${num(p.team_size)} чел.` : '—'}</dd>
            ${p.founded_year ? html`<dt>Год основания</dt><dd>${p.founded_year}</dd>` : ''}
            ${isRep ? '' : html`<dt>Стоимость</dt><dd>${p.price_band ? esc(PRICE_TITLE[p.price_band]) : '—'}</dd>`}
            <dt>Сайт</dt><dd>${p.website ? html`<a href="${esc(p.website)}" target="_blank" rel="noopener noreferrer">${esc(p.website.replace(/^https?:\/\//, ''))}</a>` : '—'}</dd>
          </dl></div></div>
        <div class="card"><div class="card__head"><h3>Контакты</h3></div>
          <div class="card__body"><dl class="def">
            <dt>Контактное лицо</dt><dd>${esc(p.contact_name || '—')}${p.contact_role ? `<div class="fs-12 text-3">${esc(p.contact_role)}</div>` : ''}</dd>
            <dt>Связь</dt><dd>${contact || '—'}</dd>
            ${isRep ? '' : html`<dt>Ведёт контакт</dt><dd>${esc(p.owner_name || '—')}</dd>
            <dt>Последний контакт</dt><dd>${p.last_contact ? esc(fmtDate(p.last_contact)) : '—'}</dd>`}
          </dl>
          ${isRep ? '<div class="fs-12 text-3" style="margin-top:8px">Реквизиты и контакты ведёт модератор каталога — сообщите ему, если они изменились.</div>' : ''}
          </div></div>
        ${edit ? membersCard(p) : ''}
        <div class="fs-12 text-3">Внесён ${esc(fmtDate(p.created_at))}${p.created_by_name ? ` — ${esc(p.created_by_name)}` : ''}.
          Обновлён ${esc(fmtAgo(p.updated_at))}${p.updated_by_name ? ` — ${esc(p.updated_by_name)}` : ''}.</div>
      </div>
    </div>`;
  if (edit) bindMembers(box, p, reload);
}

// ── Представители разработчика ───────────────────────────────
// Учётная запись поставщика, привязанная к карточке, может вести технологический
// профиль, портфолио и решения своей компании. Привязывает модератор.
function membersCard(p) {
  return html`
    <div class="card" data-tour="pv-members"><div class="card__head"><div><h3>Представители компании</h3>
      <div class="card__hint">Заполняют технологии, портфолио и решения. Их правки ждут вашего подтверждения.</div></div></div>
      <div class="card__body">
        ${p.members.length ? html`<div class="stack" style="gap:8px;margin-bottom:10px">${p.members.map((m) => html`
          <div class="row" style="gap:8px">${avatar(m.full_name, 'avatar--sm')}
            <div style="flex:1;min-width:0"><b>${esc(m.full_name)}</b><div class="fs-12 text-3">${esc(m.email)}</div></div>
            <button class="btn btn--ghost btn--sm" data-unlink="${m.user_id}" aria-label="Отвязать">✕</button></div>`)}</div>`
        : '<p class="fs-12 text-3" style="margin-bottom:10px">Представителей пока нет.</p>'}
        <input class="input" id="mem-q" type="search" placeholder="Привязать: фамилия или почта">
        <div id="mem-found" class="stack" style="gap:6px;margin-top:8px"></div>
      </div></div>`;
}

function bindMembers(box, p, reload) {
  const found = box.querySelector('#mem-found');
  box.querySelector('#mem-q')?.addEventListener('input', debounce(async (e) => {
    const text = e.target.value.trim();
    if (text.length < 2) { found.innerHTML = ''; return; }
    const list = await api.get(`/api/providers/members/candidates?q=${encodeURIComponent(text)}`);
    found.innerHTML = list.length ? list.map((u) => html`
      <div class="row" style="gap:8px"><div style="flex:1;min-width:0"><b class="fs-12">${esc(u.full_name)}</b>
        <div class="fs-12 text-3">${esc(u.role_title)}${u.institution ? ' · ' + esc(u.institution) : ''}</div></div>
        <button class="btn btn--sm" data-link="${u.id}">Привязать</button></div>`).join('')
      : '<p class="fs-12 text-3">Никого не нашлось</p>';
    found.querySelectorAll('[data-link]').forEach((b) => b.onclick = async () => {
      try { await api.post(`/api/providers/${p.id}/members`, { user_id: Number(b.dataset.link) }); toast('Представитель привязан', 'ok'); reload('overview'); }
      catch (err) { toast(err.message, 'danger'); }
    });
  }, 250));
  box.querySelectorAll('[data-unlink]').forEach((b) => b.onclick = async () => {
    if (!await confirmDialog('Отвязать представителя', 'Он перестанет видеть карточку компании и не сможет её править.', 'Отвязать')) return;
    await api.del(`/api/providers/${p.id}/members/${b.dataset.unlink}`);
    reload('overview');
  });
}

// ── Портфолио ────────────────────────────────────────────────
function casesTab(box, p, dict, knownTags, edit, reload) {
  box.innerHTML = html`
    ${edit ? '<div class="row" style="margin-bottom:12px"><button class="btn btn--primary btn--sm" data-add>Добавить проект</button></div>' : ''}
    ${p.cases.length ? html`<div class="stack">${p.cases.map((c) => html`
      <div class="card"><div class="card__body">
        <div class="row" style="gap:6px;margin-bottom:4px">
          ${c.year ? `<span class="mono fs-12 text-3">${c.year}</span>` : ''}
          ${c.public_sector ? '<span class="badge badge--info">Госсектор</span>' : ''}
          ${c.customer ? `<span class="fs-12 text-2">${esc(c.customer)}</span>` : ''}
          ${edit ? html`<span class="spacer"></span>
            <button class="btn btn--ghost btn--sm" data-edit="${c.id}">Изменить</button>
            <button class="btn btn--ghost btn--sm" data-del="${c.id}" aria-label="Удалить">✕</button>` : ''}
        </div>
        <h3 class="pv-sol__title">${c.link ? html`<a href="${esc(c.link)}" target="_blank" rel="noopener noreferrer">${esc(c.title)}</a>` : esc(c.title)}</h3>
        ${c.description ? `<p class="text-2">${esc(c.description)}</p>` : ''}
        ${c.result ? html`<div class="pv-result"><b>Результат:</b> ${esc(c.result)}</div>` : ''}
        ${c.tags.length ? `<div class="pv-tags" style="margin-top:8px">${tagList(c.tags)}</div>` : ''}
      </div></div>`)}</div>`
    : html`<div class="card"><div class="empty"><h4>Портфолио пусто</h4>
        <p>Добавьте выполненные проекты — особенно для госзаказчиков и с измеримым результатом.</p></div></div>`}`;

  box.querySelector('[data-add]')?.addEventListener('click', () => caseModal(p, null, knownTags, reload));
  box.querySelectorAll('[data-edit]').forEach((b) => b.onclick = () =>
    caseModal(p, p.cases.find((c) => c.id === Number(b.dataset.edit)), knownTags, reload));
  box.querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => {
    if (!await confirmDialog('Удалить проект', 'Проект будет удалён из портфолио.', 'Удалить')) return;
    await api.del(`/api/providers/${p.id}/cases/${b.dataset.del}`);
    reload('cases');
  });
}

function caseModal(p, c, knownTags, reload) {
  const v = c || { public_sector: 0, tags: [] };
  modal({
    title: c ? 'Проект портфолио' : 'Новый проект портфолио',
    wide: true,
    body: html`
      <form id="case-form" class="stack" style="gap:12px">
        <div class="field"><label class="field__label" for="c-title">Название проекта *</label>
          <input class="input" id="c-title" name="title" value="${esc(v.title || '')}" required></div>
        <div class="grid grid--2" style="gap:12px">
          <div class="field"><label class="field__label" for="c-customer">Заказчик</label>
            <input class="input" id="c-customer" name="customer" value="${esc(v.customer || '')}"></div>
          <div class="field"><label class="field__label" for="c-year">Год</label>
            <input class="input" id="c-year" name="year" type="number" min="1990" max="2100" value="${esc(v.year || '')}"></div>
        </div>
        <label class="checkbox"><input type="checkbox" name="public_sector" ${v.public_sector ? 'checked' : ''}> Заказчик из госсектора</label>
        <div class="field"><label class="field__label" for="c-desc">Что сделано</label>
          <textarea class="textarea" id="c-desc" name="description" rows="3">${esc(v.description || '')}</textarea></div>
        <div class="field"><label class="field__label" for="c-result">Результат</label>
          <textarea class="textarea" id="c-result" name="result" rows="2" placeholder="Измеримый эффект: время обработки, точность, экономия">${esc(v.result || '')}</textarea></div>
        ${tagsField('c-tags', v.tags, knownTags)}
        <div class="field"><label class="field__label" for="c-link">Ссылка на описание</label>
          <input class="input" id="c-link" name="link" value="${esc(v.link || '')}" placeholder="https://"></div>
      </form>`,
    footer: '<button class="btn" data-close>Отмена</button><button class="btn btn--primary" data-save>Сохранить</button>',
    onMount: (el, close) => {
      el.querySelector('[data-save]').onclick = async () => {
        const form = el.querySelector('#case-form');
        if (!form.reportValidity()) return;
        const d = formData(form);
        d.public_sector = form.public_sector.checked;
        try {
          if (c) await api.put(`/api/providers/${p.id}/cases/${c.id}`, d);
          else await api.post(`/api/providers/${p.id}/cases`, d);
          close(); toast('Портфолио обновлено', 'ok'); reload('cases');
        } catch (err) { toast(err.message, 'danger'); }
      };
    },
  });
}

// ── Решения и технологии ─────────────────────────────────────
function solutionsTab(box, p, dict, knownTags, edit, reload) {
  box.innerHTML = html`
    ${edit ? '<div class="row" style="margin-bottom:12px"><button class="btn btn--primary btn--sm" data-add>Добавить решение</button></div>' : ''}
    ${p.solutions.length ? html`<div class="grid grid--2">${p.solutions.map((s) => solutionCard(s, dict, { editable: edit }))}</div>`
    : html`<div class="card"><div class="empty"><h4>Решений пока нет</h4>
        <p>Добавьте готовые продукты, модели и технологии разработчика — они появятся во вкладке «Решения и технологии» всего каталога.</p></div></div>`}`;

  box.querySelector('[data-add]')?.addEventListener('click', () => solutionModal(p, null, dict, knownTags, reload));
  box.querySelectorAll('[data-edit-sol]').forEach((b) => b.onclick = () =>
    solutionModal(p, p.solutions.find((s) => s.id === Number(b.dataset.editSol)), dict, knownTags, reload));
  box.querySelectorAll('[data-del-sol]').forEach((b) => b.onclick = async () => {
    if (!await confirmDialog('Удалить решение', 'Решение будет удалено из каталога.', 'Удалить')) return;
    await api.del(`/api/providers/${p.id}/solutions/${b.dataset.delSol}`);
    reload('solutions');
  });
}

function solutionModal(p, s, dict, knownTags, reload) {
  const v = s || { kind: 'product', maturity: 'production', competencies: [], tags: [], in_registry: 0 };
  modal({
    title: s ? 'Решение' : 'Новое решение в каталоге',
    wide: true,
    body: html`
      <form id="sol-form" class="stack" style="gap:12px">
        <div class="field"><label class="field__label" for="s-name">Название *</label>
          <input class="input" id="s-name" name="name" value="${esc(v.name || '')}" required></div>
        <div class="grid grid--3" style="gap:12px">
          <div class="field"><label class="field__label" for="s-kind">Тип</label>
            <select class="select" id="s-kind" name="kind">${options(dict.solution_kinds, v.kind)}</select></div>
          <div class="field"><label class="field__label" for="s-mat">Зрелость</label>
            <select class="select" id="s-mat" name="maturity">${options(dict.maturity, v.maturity)}</select></div>
          <div class="field"><label class="field__label" for="s-lic">Лицензия</label>
            <select class="select" id="s-lic" name="license">${options(dict.licenses, v.license || '', 'Не указана')}</select></div>
        </div>
        <label class="checkbox"><input type="checkbox" name="in_registry" ${v.in_registry ? 'checked' : ''}> Внесено в реестр отечественного ПО</label>
        <div class="field"><label class="field__label" for="s-desc">Описание: какую задачу решает</label>
          <textarea class="textarea" id="s-desc" name="description" rows="3">${esc(v.description || '')}</textarea></div>
        <div class="field"><div class="field__label">Какие задачи закрывает</div>
          ${checkGrid('competencies', dict.competencies, v.competencies)}</div>
        ${tagsField('s-tags', v.tags, knownTags)}
        <div class="grid grid--2" style="gap:12px">
          <div class="field"><label class="field__label" for="s-price">Стоимость, условия</label>
            <input class="input" id="s-price" name="price_note" value="${esc(v.price_note || '')}" placeholder="Например: лицензия на рабочее место"></div>
          <div class="field"><label class="field__label" for="s-link">Ссылка</label>
            <input class="input" id="s-link" name="link" value="${esc(v.link || '')}" placeholder="https://"></div>
        </div>
      </form>`,
    footer: '<button class="btn" data-close>Отмена</button><button class="btn btn--primary" data-save>Сохранить</button>',
    onMount: (el, close) => {
      el.querySelector('[data-save]').onclick = async () => {
        const form = el.querySelector('#sol-form');
        if (!form.reportValidity()) return;
        const d = formData(form);
        d.in_registry = form.in_registry.checked;
        d.competencies = checked(form, 'competencies');
        try {
          if (s) await api.put(`/api/providers/${p.id}/solutions/${s.id}`, d);
          else await api.post(`/api/providers/${p.id}/solutions`, d);
          close(); toast('Каталог обновлён', 'ok'); reload('solutions');
        } catch (err) { toast(err.message, 'danger'); }
      };
    },
  });
}

// ── Оценки ───────────────────────────────────────────────────
const CRITERIA = [['quality', 'Качество результата'], ['deadlines', 'Соблюдение сроков'], ['communication', 'Взаимодействие']];

function reviewsTab(box, p, mine, edit, reload) {
  const avg = (k) => p.reviews.length ? p.reviews.reduce((s, r) => s + r[k], 0) / p.reviews.length : null;
  box.innerHTML = html`
    <div class="pv-layout">
      <div class="stack">
        ${p.reviews.length ? p.reviews.map((r) => html`
          <div class="card"><div class="card__body">
            <div class="row" style="gap:8px;margin-bottom:6px">${avatar(r.author_name, 'avatar--sm')}<b>${esc(r.author_name)}</b>
              <span class="fs-12 text-3">${esc(fmtAgo(r.updated_at))}</span>
              <span class="spacer"></span>${stars((r.quality + r.deadlines + r.communication) / 3)}</div>
            ${r.context ? `<div class="fs-12 text-3" style="margin-bottom:4px">Проект: ${esc(r.context)}</div>` : ''}
            <div class="row fs-12 text-2" style="gap:14px">${CRITERIA.map(([k, t]) => `<span>${esc(t)}: <b>${r[k]}</b></span>`)}</div>
            ${r.comment ? `<p style="margin-top:8px">${esc(r.comment)}</p>` : ''}
          </div></div>`)
        : '<div class="card"><div class="empty"><h4>Оценок пока нет</h4><p>Оценку ставят по итогам совместной работы — пилота, проекта или демонстрации.</p></div></div>'}
      </div>
      <div class="stack">
        ${p.reviews.length ? html`<div class="card"><div class="card__head"><h3>Средняя оценка</h3></div><div class="card__body">
          ${CRITERIA.map(([k, t]) => html`<div class="bar-row"><div class="bar-row__label">${esc(t)}</div>
            <div class="bar-row__track"><div class="bar-row__fill" style="width:${(avg(k) / 5) * 100}%"></div></div>
            <div class="bar-row__value">${num(avg(k), 1)}</div></div>`)}
        </div></div>` : ''}
        ${edit ? html`<div class="card"><div class="card__head"><h3>${mine ? 'Ваша оценка' : 'Оценить работу'}</h3></div>
          <div class="card__body"><form id="rv-form" class="stack" style="gap:10px">
            ${CRITERIA.map(([k, t]) => html`<div class="field"><div class="field__label">${esc(t)}</div>
              <div class="seg">${[1, 2, 3, 4, 5].map((n) => `<button type="button" data-score="${k}" data-v="${n}" class="${mine?.[k] === n ? 'is-on' : ''}">${n}</button>`)}</div></div>`)}
            <input class="input" name="context" placeholder="По какому проекту" value="${esc(mine?.context || '')}">
            <textarea class="textarea" name="comment" rows="3" placeholder="Что получилось, что нет">${esc(mine?.comment || '')}</textarea>
            <div class="row"><button class="btn btn--primary btn--sm" type="submit">Сохранить оценку</button>
              ${mine ? '<button class="btn btn--ghost btn--sm" type="button" data-remove>Убрать мою оценку</button>' : ''}</div>
          </form></div></div>` : ''}
      </div>
    </div>`;

  const form = box.querySelector('#rv-form');
  if (!form) return;
  const scores = { quality: mine?.quality, deadlines: mine?.deadlines, communication: mine?.communication };
  form.querySelectorAll('[data-score]').forEach((b) => b.onclick = () => {
    scores[b.dataset.score] = Number(b.dataset.v);
    form.querySelectorAll(`[data-score="${b.dataset.score}"]`).forEach((x) => x.classList.toggle('is-on', x === b));
  });
  form.onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api.put(`/api/providers/${p.id}/review`, { ...scores, context: form.context.value, comment: form.comment.value });
      toast('Оценка сохранена', 'ok'); reload('reviews');
    } catch (err) { toast(err.message, 'danger'); }
  };
  form.querySelector('[data-remove]')?.addEventListener('click', async () => {
    await api.del(`/api/providers/${p.id}/review`);
    reload('reviews');
  });
}

// ── Журнал взаимодействий ────────────────────────────────────
function notesTab(box, p, dict, edit, reload) {
  const today = new Date().toISOString().slice(0, 10);
  box.innerHTML = html`
    <div class="pv-layout">
      <div>
        ${p.notes.length ? html`<div class="card"><div class="card__body--flush"><div class="list">
          ${p.notes.map((n) => html`<div class="list__item">
            <div class="list__main">
              <div class="list__meta"><span class="badge badge--outline">${esc(dict.note_kinds[n.kind])}</span>
                <b>${esc(fmtDate(n.happened_at))}</b> · ${esc(n.author_name || '—')}</div>
              <div style="margin-top:4px;white-space:pre-wrap">${esc(n.body)}</div>
            </div>
            ${edit && (n.author_id === state.user.id || can('provider.admin'))
              ? `<button class="btn btn--ghost btn--sm" data-del="${n.id}" aria-label="Удалить запись">✕</button>` : ''}
          </div>`)}
        </div></div></div>`
        : '<div class="card"><div class="empty"><h4>Журнал пуст</h4><p>Фиксируйте встречи, запросы и демонстрации — так видно, кто и когда общался с разработчиком и о чём договорились.</p></div></div>'}
      </div>
      ${edit ? html`<div class="card"><div class="card__head"><h3>Новая запись</h3></div><div class="card__body">
        <form id="note-form" class="stack" style="gap:10px">
          <div class="grid grid--2" style="gap:10px">
            <select class="select" name="kind">${options(dict.note_kinds, 'meeting')}</select>
            <input class="input" type="date" name="happened_at" value="${today}" max="${today}">
          </div>
          <textarea class="textarea" name="body" rows="4" required placeholder="О чём договорились, следующие шаги"></textarea>
          <button class="btn btn--primary btn--sm" type="submit">Добавить</button>
        </form></div></div>` : ''}
    </div>`;

  const form = box.querySelector('#note-form');
  if (form) form.onsubmit = async (e) => {
    e.preventDefault();
    try { await api.post(`/api/providers/${p.id}/notes`, formData(form)); reload('notes'); }
    catch (err) { toast(err.message, 'danger'); }
  };
  box.querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => {
    if (!await confirmDialog('Удалить запись', 'Запись журнала будет удалена.', 'Удалить')) return;
    await api.del(`/api/providers/${p.id}/notes/${b.dataset.del}`);
    reload('notes');
  });
}

// ─────────────────────────────────────────────────────────────
// Форма разработчика
// ─────────────────────────────────────────────────────────────
export async function providerEditor(view, id) {
  if (!can('provider.edit') && !can('provider.self')) return noAccess(view);
  const [{ dict, tags: knownTags }, card] = await Promise.all([
    api.get('/api/providers/dictionaries'),
    id ? api.get(`/api/providers/${id}`) : null,
  ]);
  if (card?.access === 'rep') return profileEditor(view, card.provider, dict, knownTags);
  if (!can('provider.edit')) return noAccess(view);
  const existing = card?.provider ?? null;
  const kindFromUrl = currentRoute().query.get('kind');
  const p = existing || { kind: dict.kinds[kindFromUrl] ? kindFromUrl : 'external', status: 'new', availability: 'unknown',
    competencies: [], domains: [], compliance: [], tags: [] };

  view.innerHTML = html`
    <div class="crumb"><a href="/providers">Каталог разработчиков ИИ-решений</a> /
      ${existing ? html`<a href="/providers/${p.id}">${esc(p.name)}</a> / Редактирование` : 'Новый разработчик'}</div>
    <div class="page-head"><h2>${existing ? 'Редактирование разработчика' : 'Новый разработчик'}</h2>
      <p>Обязательно только название — остальное можно дополнить позже. Чем полнее карточка, тем проще сравнивать разработчиков.</p></div>

    <form id="pv-form" class="pv-form stack">
      <div class="card"><div class="card__head"><h3>Кто это</h3></div><div class="card__body stack" style="gap:12px">
        <div class="seg" id="pv-kind">
          ${Object.entries(dict.kinds).map(([k, v]) => `<button type="button" data-kind="${k}" class="${p.kind === k ? 'is-on' : ''}">${esc(v.title)}</button>`)}
        </div>
        <div class="field"><label class="field__label" for="f-name">Название *</label>
          <input class="input" id="f-name" name="name" value="${esc(p.name || '')}" required maxlength="200"
            placeholder="Как разработчика называют в работе"></div>
        <div id="pv-dups"></div>
        <div class="grid grid--2" style="gap:12px" data-for="external">
          <div class="field"><label class="field__label" for="f-legal">Полное наименование юрлица</label>
            <input class="input" id="f-legal" name="legal_name" value="${esc(p.legal_name || '')}"></div>
          <div class="field"><label class="field__label" for="f-inn">ИНН</label>
            <input class="input mono" id="f-inn" name="inn" value="${esc(p.inn || '')}" inputmode="numeric" pattern="\\d{10}|\\d{12}"
              title="10 цифр у организации или 12 у предпринимателя"></div>
        </div>
        <div class="field" data-for="internal dit"><label class="field__label" for="f-unit">Подразделение</label>
          <input class="input" id="f-unit" name="org_unit" value="${esc(p.org_unit || '')}" placeholder="Учреждение, управление или отдел"></div>
        <div class="grid grid--3" style="gap:12px">
          <div class="field"><label class="field__label" for="f-city">Город</label>
            <input class="input" id="f-city" name="city" value="${esc(p.city || '')}"></div>
          <div class="field"><label class="field__label" for="f-team">Размер команды, чел.</label>
            <input class="input" id="f-team" name="team_size" type="number" min="1" value="${esc(p.team_size || '')}"></div>
          <div class="field" data-for="external"><label class="field__label" for="f-year">Год основания</label>
            <input class="input" id="f-year" name="founded_year" type="number" min="1900" max="${new Date().getFullYear()}" value="${esc(p.founded_year || '')}"></div>
        </div>
        <div class="field"><label class="field__label" for="f-web">Сайт</label>
          <input class="input" id="f-web" name="website" value="${esc(p.website || '')}" placeholder="https://"></div>
        <div class="field"><label class="field__label" for="f-desc">Описание</label>
          <textarea class="textarea" id="f-desc" name="description" rows="4"
            placeholder="Чем занимается, в чём сильны, с какими заказчиками работали">${esc(p.description || '')}</textarea></div>
      </div></div>

      <div class="card" data-tour="pv-f-comp"><div class="card__head"><h3>Компетенции и технологии</h3></div><div class="card__body stack" style="gap:14px">
        <div class="field"><div class="field__label">Компетенции в ИИ</div>${checkGrid('competencies', dict.competencies, p.competencies)}</div>
        <div class="field"><div class="field__label">Отраслевой опыт</div>${checkGrid('domains', dict.domains, p.domains)}</div>
        ${tagsField('f-tags', p.tags, knownTags)}
      </div></div>

      <div class="card" data-tour="pv-f-compliance"><div class="card__head"><div><h3>Соответствие требованиям</h3>
        <div class="card__hint">То, без чего разработчика в госсекторе обычно не привлечь</div></div></div>
        <div class="card__body">${checkGrid('compliance', dict.compliance, p.compliance)}</div></div>

      <div class="card" data-tour="pv-f-status"><div class="card__head"><h3>Статус и условия</h3></div><div class="card__body">
        <div class="grid grid--3" style="gap:12px">
          <div class="field"><label class="field__label" for="f-status">Статус</label>
            <select class="select" id="f-status" name="status">${options(dict.statuses, p.status)}</select></div>
          <div class="field"><label class="field__label" for="f-avail">Загрузка</label>
            <select class="select" id="f-avail" name="availability">${options(dict.availability, p.availability)}</select></div>
          <div class="field"><label class="field__label" for="f-price">Уровень стоимости</label>
            <select class="select" id="f-price" name="price_band">
              <option value="">Не оценён</option>
              ${[1, 2, 3].map((n) => `<option value="${n}" ${p.price_band === n ? 'selected' : ''}>${PRICE[n]} — ${PRICE_TITLE[n]}</option>`)}
            </select></div>
        </div>
      </div></div>

      <div class="card"><div class="card__head"><h3>Контакты</h3></div><div class="card__body">
        <div class="grid grid--2" style="gap:12px">
          <div class="field"><label class="field__label" for="f-cname">Контактное лицо</label>
            <input class="input" id="f-cname" name="contact_name" value="${esc(p.contact_name || '')}"></div>
          <div class="field"><label class="field__label" for="f-crole">Должность</label>
            <input class="input" id="f-crole" name="contact_role" value="${esc(p.contact_role || '')}"></div>
          <div class="field"><label class="field__label" for="f-cmail">Электронная почта</label>
            <input class="input" id="f-cmail" name="contact_email" type="email" value="${esc(p.contact_email || '')}"></div>
          <div class="field"><label class="field__label" for="f-cphone">Телефон</label>
            <input class="input" id="f-cphone" name="contact_phone" type="tel" value="${esc(p.contact_phone || '')}"></div>
        </div>
        <label class="checkbox" style="margin-top:10px"><input type="checkbox" name="owner_me" ${!existing || p.owner_id === state.user.id ? 'checked' : ''}>
          Контакт с разработчиком веду я${existing && p.owner_id && p.owner_id !== state.user.id ? ` (сейчас: ${esc(p.owner_name)})` : ''}</label>
      </div></div>

      <div class="row">
        <button class="btn btn--primary" type="submit">${existing ? 'Сохранить' : 'Добавить в каталог'}</button>
        <a class="btn btn--ghost" href="${existing ? `/providers/${p.id}` : '/providers'}">Отмена</a>
      </div>
    </form>`;

  const form = view.querySelector('#pv-form');
  let kind = p.kind;
  const applyKind = () => {
    view.querySelectorAll('[data-kind]').forEach((b) => b.classList.toggle('is-on', b.dataset.kind === kind));
    // Скрытые поля отключаются: иначе неверный ИНН в спрятанном поле молча
    // остановил бы отправку формы
    view.querySelectorAll('[data-for]').forEach((el) => {
      el.hidden = !el.dataset.for.split(' ').includes(kind);
      el.querySelectorAll('input').forEach((i) => { i.disabled = el.hidden; });
    });
    // Признак МСП есть только у организаций
    const msp = form.querySelector('input[name="compliance"][value="msp"]')?.closest('label');
    if (msp) msp.hidden = kind !== 'external';
  };
  view.querySelectorAll('[data-kind]').forEach((b) => b.onclick = () => { kind = b.dataset.kind; applyKind(); checkDups(); });
  applyKind();

  // Дубли проверяются по мере ввода: один и тот же вендор, заведённый дважды,
  // раздвоит портфолио и оценки
  const dupBox = view.querySelector('#pv-dups');
  const nameInput = view.querySelector('#f-name');
  const innInput = view.querySelector('#f-inn');
  const checkDups = debounce(async () => {
    const name = nameInput.value.trim();
    const inn = kind === 'external' ? innInput.value.trim() : '';
    if (name.length < 3 && !inn) { dupBox.innerHTML = ''; return; }
    const dups = await api.post('/api/providers/duplicates', { name, inn, exclude_id: existing?.id ?? null });
    dupBox.innerHTML = dups.length ? html`<div class="hint-box">
      ${dups.map((d) => html`<div>${d.reason === 'inn' ? 'Тот же ИНН' : 'Похожее название'}:
        <a href="/providers/${d.id}" target="_blank">${esc(d.name)}</a></div>`)}
    </div>` : '';
  }, 400);
  nameInput.addEventListener('input', checkDups);
  innInput.addEventListener('input', checkDups);

  form.onsubmit = async (e) => {
    e.preventDefault();
    const d = formData(form);
    d.kind = kind;
    for (const k of ['competencies', 'domains', 'compliance']) d[k] = checked(form, k);
    d.owner_id = form.owner_me.checked ? state.user.id : (existing?.owner_id ?? null);
    delete d.owner_me;
    try {
      const saved = existing ? await api.put(`/api/providers/${p.id}`, d) : await api.post('/api/providers', d);
      toast(existing ? 'Изменения сохранены' : 'Разработчик добавлен', 'ok');
      navigate(`/providers/${saved.id}`, true);
    } catch (err) { toast(err.message, 'danger'); }
  };
}

// ── Профиль компании глазами представителя ───────────────────
// Только то, что компания знает о себе лучше модератора. Реквизиты, контакты и
// статус отбора в форме не показываются: их ведёт модератор каталога.
function profileEditor(view, p, dict, knownTags) {
  view.innerHTML = html`
    <div class="crumb"><a href="/providers">Моя компания в каталоге</a> / <a href="/providers/${p.id}">${esc(p.name)}</a> / Профиль</div>
    <div class="page-head"><h2>Технологический профиль компании</h2>
      <p>Опишите, что умеет ваша команда. После сохранения карточка получит пометку «ожидает проверки»,
         а модератор каталога получит уведомление. Портфолио и решения добавляются во вкладках карточки.</p></div>
    <form id="pv-form" class="pv-form stack">
      <div class="card"><div class="card__head"><h3>О компании</h3></div><div class="card__body stack" style="gap:12px">
        <div class="field"><label class="field__label" for="f-desc">Описание</label>
          <textarea class="textarea" id="f-desc" name="description" rows="5"
            placeholder="Чем занимаетесь, в чём сильны, с какими заказчиками работали">${esc(p.description || '')}</textarea></div>
        <div class="grid grid--2" style="gap:12px">
          <div class="field"><label class="field__label" for="f-team">Размер команды, чел.</label>
            <input class="input" id="f-team" name="team_size" type="number" min="1" value="${esc(p.team_size || '')}"></div>
          <div class="field"><label class="field__label" for="f-avail">Загрузка сейчас</label>
            <select class="select" id="f-avail" name="availability">${options(dict.availability, p.availability)}</select></div>
        </div>
      </div></div>
      <div class="card" data-tour="pv-f-comp"><div class="card__head"><h3>Компетенции и технологии</h3></div><div class="card__body stack" style="gap:14px">
        <div class="field"><div class="field__label">Компетенции в ИИ</div>${checkGrid('competencies', dict.competencies, p.competencies)}</div>
        <div class="field"><div class="field__label">Отраслевой опыт</div>${checkGrid('domains', dict.domains, p.domains)}</div>
        ${tagsField('f-tags', p.tags, knownTags)}
      </div></div>
      <div class="card" data-tour="pv-f-compliance"><div class="card__head"><div><h3>Соответствие требованиям</h3>
        <div class="card__hint">Отмечайте только то, что сможете подтвердить документами по запросу модератора</div></div></div>
        <div class="card__body">${checkGrid('compliance', Object.fromEntries(Object.entries(dict.compliance)
          .filter(([c]) => p.kind === 'external' || c !== 'msp')), p.compliance)}</div></div>
      <div class="row">
        <button class="btn btn--primary" type="submit">Сохранить и отправить на проверку</button>
        <a class="btn btn--ghost" href="/providers/${p.id}">Отмена</a>
      </div>
    </form>`;

  const form = view.querySelector('#pv-form');
  form.onsubmit = async (e) => {
    e.preventDefault();
    const d = formData(form);
    for (const k of ['competencies', 'domains', 'compliance']) d[k] = checked(form, k);
    try {
      await api.put(`/api/providers/${p.id}`, d);
      toast('Профиль сохранён и отправлен модератору на проверку', 'ok');
      navigate(`/providers/${p.id}`, true);
    } catch (err) { toast(err.message, 'danger'); }
  };
}

// ── Помощники форм ───────────────────────────────────────────
function checkGrid(name, dictPart, selected) {
  return html`<div class="pv-checks">${Object.entries(dictPart).map(([k, t]) => html`
    <label class="checkbox"><input type="checkbox" name="${name}" value="${esc(k)}" ${selected.includes(k) ? 'checked' : ''}> ${esc(t)}</label>`)}</div>`;
}

// Подсказки — кнопками, а не datalist: выбор из datalist заменил бы весь уже
// набранный через запятую список одним значением
function tagsField(id, value, knownTags) {
  const suggest = knownTags.slice(0, 24);
  return html`<div class="field"><label class="field__label" for="${id}">Технологии и инструменты</label>
    <input class="input" id="${id}" name="tags" value="${esc(value.join(', '))}"
      placeholder="Через запятую: Python, GigaChat, YandexGPT, PyTorch">
    ${suggest.length ? html`<div class="pv-tags" style="margin-top:6px">
      <span class="fs-12 text-3">Уже встречались:</span>
      ${suggest.map((t) => `<button type="button" class="pv-tag pv-tag--tech" data-tag-add="${esc(id)}" data-v="${esc(t.tag)}">+ ${esc(t.tag)}</button>`)}
    </div>` : ''}
    <div class="field__hint">Свободный список — по нему работает фильтр разработчиков и решений.</div></div>`;
}

addEventListener('click', (e) => {
  const b = e.target.closest('[data-tag-add]');
  if (!b) return;
  const input = document.getElementById(b.dataset.tagAdd);
  if (!input) return;
  const list = input.value.split(',').map((t) => t.trim()).filter(Boolean);
  if (!list.some((t) => t.toLowerCase() === b.dataset.v.toLowerCase())) list.push(b.dataset.v);
  input.value = list.join(', ');
  b.hidden = true;
});

const checked = (form, name) => [...form.querySelectorAll(`input[name="${name}"]:checked`)].map((c) => c.value);

function formData(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name || el.disabled || el.type === 'checkbox' || el.type === 'submit' || el.type === 'button') continue;
    out[el.name] = el.value;
  }
  return out;
}
