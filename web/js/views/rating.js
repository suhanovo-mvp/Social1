// Модуль «Идеи и решения»: рейтинг советчиков, страница модерации,
// рекомендации к поощрению и вклад участника в профиле.
import { api, esc, html, avatar, can, navigate, toast, modal, confirmDialog,
         nl2br, num, fmtDate, fmtAgo, plural } from '../core.js';
import { IDEA_STATUS, statusChip } from './ideas.js';

const PERIODS = [['month', 'Месяц'], ['quarter', 'Квартал'], ['year', 'Год'], ['all', 'Всё время']];

const INCENTIVE_STATUS = {
  proposed:    { title: 'Предложено',  tone: 'info' },
  agreed:      { title: 'Согласовано', tone: 'accent' },
  approved:    { title: 'Утверждено',  tone: 'ok' },
  implemented: { title: 'Реализовано', tone: 'ok' },
  rejected:    { title: 'Отклонено',   tone: 'muted' },
};

const CATEGORY_TITLES = {
  time: 'Время и режим работы', recognition: 'Признание',
  development: 'Развитие и карьера', material: 'Материальные меры', social: 'Социальные программы',
};

const ICON_MEDAL = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="15" r="6"/><path d="M8.2 10L5 2h5l2.5 6M15.8 10L19 2h-5l-1.2 3"/></svg>';

// ══════════════════════════════════════════════════════════════
// Рейтинг советчиков
// ══════════════════════════════════════════════════════════════
export async function ratingView(view, query) {
  const period = query.get('period') || 'month';
  const scope = query.get('scope') || '';
  view.innerHTML = '<div class="card"><div class="card__body"><div class="skeleton" style="height:320px"></div></div></div>';

  let data;
  try {
    data = await api.get(`/api/rating?period=${period}${scope ? '&scope=' + scope : ''}`);
  } catch (err) {
    view.innerHTML = html`<div class="card"><div class="empty">
      <h4>Рейтинг недоступен</h4><p>${esc(err.message)}</p></div></div>`;
    return;
  }

  const top = data.items.slice(0, 3);
  const rest = data.items.slice(3);
  const totalPoints = data.items.reduce((s, i) => s + i.points, 0);

  view.innerHTML = html`
    <div class="page-head">
      <div class="page-head__row">
        <div style="flex:1;min-width:260px">
          <h2>Рейтинг советчиков</h2>
          <p>Вклад сотрудников в решение проблем коллег: очки начисляются за предложенные решения,
             подтверждённый опыт и внедрённые улучшения. Рейтинг — основание для рекомендаций
             к поощрению, а не автоматическая выдача мер.</p>
        </div>
        <div class="row">
          ${data.can_export
            ? `<a class="btn" data-native download href="/api/rating/export?period=${esc(period)}${scope ? '&scope=' + esc(scope) : ''}">Выгрузить (CSV)</a>` : ''}
          ${can('idea.incentive') ? '<a href="/incentives" class="btn btn--primary">Рекомендации к поощрению</a>' : ''}
        </div>
      </div>
    </div>

    <div class="idea-toolbar">
      <div class="seg" id="periods">
        ${PERIODS.map(([k, t]) => `<button data-period="${k}" class="${period === k ? 'is-on' : ''}">${t}</button>`)}
      </div>
      ${can('analytics.institution') || can('analytics.all') ? html`
        <div class="seg" id="scopes">
          <button data-scope="institution" class="${data.scope === 'institution' ? 'is-on' : ''}">Моё учреждение</button>
          <button data-scope="all" class="${data.scope === 'all' ? 'is-on' : ''}">Вся экосистема</button>
        </div>` : ''}
      <span class="spacer fs-12 text-3">${esc(data.label)} · ${data.items.length}
        ${plural(data.items.length, 'участник', 'участника', 'участников')} · ${num(totalPoints)} очков</span>
    </div>

    ${data.items.length ? html`
      ${top.length ? html`<div class="podium">
        ${top.map((p) => html`
          <div class="podium__item podium__item--${p.rank}" data-goto="/profile/${p.id}">
            <div class="podium__rank">${p.rank}</div>
            ${avatar(p.full_name, 'avatar--lg')}
            <div class="podium__name">${esc(p.full_name)}</div>
            <div class="podium__meta">${esc(p.institution || '')}</div>
            <div class="podium__points">${num(p.points)}<span> очков</span></div>
            <div class="podium__badges">
              ${p.badges.slice(0, 3).map((b) => `<span class="badge badge--outline">${esc(b.title)}</span>`)}
            </div>
          </div>`)}
      </div>` : ''}

      ${rest.length ? html`
      <div class="card">
        <div class="card__head"><h3>Все советчики</h3>
          <span class="card__hint spacer">Период: ${esc(data.label)}</span></div>
        <div class="table-wrap"><table class="table">
          <thead><tr>
            <th style="width:56px">Место</th><th>Сотрудник</th><th>Учреждение</th>
            <th class="num">Очки</th><th class="num">Решений</th><th class="num">Опыт</th>
            <th class="num">Внедрено</th><th>Знаки отличия</th>
          </tr></thead>
          <tbody>${rest.map((p) => html`
            <tr class="is-clickable" data-goto="/profile/${p.id}">
              <td class="mono text-3">${p.rank}</td>
              <td><div class="row" style="gap:9px">${avatar(p.full_name, 'avatar--sm')}
                <div><div class="fw-600 fs-13">${esc(p.full_name)}</div>
                  <div class="fs-12 text-3">${esc(p.position || '')}</div></div></div></td>
              <td class="fs-13">${esc(p.institution || '—')}</td>
              <td class="num fw-600">${num(p.points)}</td>
              <td class="num fs-13">${p.proposals}</td>
              <td class="num fs-13">${p.verified}</td>
              <td class="num fs-13">${p.implemented}</td>
              <td>${p.badges.map((b) => `<span class="badge badge--outline">${esc(b.title)}</span>`).join(' ') || '<span class="text-3">—</span>'}</td>
            </tr>`)}
          </tbody>
        </table></div>
      </div>` : ''}
    ` : html`
      <div class="card"><div class="empty">
        <h4>За период «${esc(data.label)}» начислений нет</h4>
        <p>Очки появляются, когда сотрудники предлагают решения по идеям коллег
           и делятся проверенным опытом. Возможно, вклад был раньше — посмотрите
           более длинный период.</p>
        <div class="row" style="justify-content:center;margin-top:14px">
          ${period !== 'all' ? '<button class="btn" data-period="all">Показать за всё время</button>' : ''}
          <a href="/ideas" class="btn btn--primary">Перейти к идеям</a>
        </div>
      </div></div>`}

    <div class="card" style="margin-top:16px">
      <div class="card__head"><h3>Знаки отличия</h3>
        <span class="card__hint spacer">Присваиваются автоматически по фактическому вкладу</span></div>
      <div class="card__body">
        <div class="grid grid--3">
          ${data.badges.map((b) => html`
            <div class="badge-card">
              <div class="badge-card__icon">${ICON_MEDAL}</div>
              <div><b>${esc(b.title)}</b><span>${esc(b.hint)}</span></div>
            </div>`)}
        </div>
      </div>
    </div>`;

  view.querySelectorAll('[data-period]').forEach((b) => b.onclick = () =>
    navigate(`/rating?period=${b.dataset.period}${scope ? '&scope=' + scope : ''}`));
  view.querySelectorAll('[data-scope]').forEach((b) => b.onclick = () =>
    navigate(`/rating?period=${period}&scope=${b.dataset.scope}`));
  view.querySelectorAll('[data-goto]').forEach((el) => el.onclick = () => navigate(el.dataset.goto));
}

// ══════════════════════════════════════════════════════════════
// Модерация модуля
// ══════════════════════════════════════════════════════════════
export async function moderationView(view, query) {
  const tab = query.get('tab') || 'ideas';
  view.innerHTML = html`
    <div class="page-head">
      <h2>Модерация идей и решений</h2>
      <p>Проверка новых идей, подтверждение проверенного опыта, разбор обращений и контроль
         начислений. Каждое действие фиксируется в журнале аудита платформы.</p>
    </div>
    <div class="tabs">
      ${[['ideas', 'Идеи на проверке'], ['experience', 'Проверенный опыт'],
         ['top', 'Топ предложений'], ['reports', 'Обращения и сигналы'],
         ['points', 'Журнал начислений']]
        .map(([k, t]) => `<button class="tab ${tab === k ? 'is-active' : ''}" data-tab="${k}">${t}</button>`)}
    </div>
    <div id="mod-panel"><div class="skeleton" style="height:280px"></div></div>`;

  view.querySelectorAll('.tab').forEach((t) => t.onclick = () => navigate(`/moderation?tab=${t.dataset.tab}`));
  const panel = view.querySelector('#mod-panel');
  const reload = () => moderationView(view, query);

  if (tab === 'points') return pointsPanel(panel);
  if (tab === 'top') return topProposalsPanel(panel);

  const [data, flags] = await Promise.all([
    api.get('/api/ideas/moderation'),
    api.get('/api/review/flags').catch(() => []),
  ]);
  const counts = {
    ideas: data.pending.length, experience: data.experience.length,
    reports: data.reports.length + flags.length,
  };
  view.querySelectorAll('.tab').forEach((t) => {
    const n = counts[t.dataset.tab];
    if (n) t.insertAdjacentHTML('beforeend', `<span class="tab__count">${n}</span>`);
  });

  if (tab === 'ideas') return ideasQueue(panel, data.pending, reload);
  if (tab === 'experience') return experienceQueue(panel, data.experience, reload);
  return reportsQueue(panel, data.reports, flags, reload);
}

// ── Топ предложений по итогам ревью ──────────────────────────
async function topProposalsPanel(panel) {
  const d = await api.get('/api/review/top');
  const inTop = d.items.filter((i) => i.in_top).length;

  panel.innerHTML = d.items.length ? html`
    <div class="card">
      <div class="card__head">
        <div>
          <h3>Топ предложений</h3>
          <div class="card__hint">Порядок задают оценки коллег в быстром ревью: лайк — единица,
            избранное — две. Предложение попадает в топ с ${d.threshold}
            ${plural(d.threshold, 'лайка', 'лайков', 'лайков')}. Очки автору лайки не начисляют —
            они лишь показывают, что стоит рассмотреть первым.</div>
        </div>
        <span class="badge badge--ok spacer">В топе: ${inTop}</span>
      </div>
      <div>
        ${d.items.map((p, i) => html`
          <div class="top-prop ${p.in_top ? 'top-prop--top' : ''}">
            <div class="top-prop__rank">${i + 1}</div>
            <div class="top-prop__main">
              <div class="row" style="gap:7px;margin-bottom:5px">
                <span class="badge ${p.kind === 'experience' ? 'badge--purple' : 'badge--info'}">${esc(p.kind_title)}</span>
                <span class="st st--${p.status_tone}"><i></i>${esc(p.status_title)}</span>
                ${p.in_top ? '<span class="badge badge--ok">В топе</span>' : ''}
              </div>
              <div class="fs-13" style="line-height:1.5;margin-bottom:5px">${esc(p.summary.slice(0, 220))}</div>
              <div class="list__meta">
                <a class="mono" href="/ideas/${p.idea_id}">${esc(p.idea_number)}</a>
                <span>${esc(p.idea_title.slice(0, 60))}</span>
                <span>${esc(p.author_name)}</span>
                <span>${fmtAgo(p.created_at)}</span>
              </div>
              ${p.skip_reasons.length ? html`
                <div class="row" style="gap:6px;margin-top:7px">
                  <span class="fs-12 text-3">Что смущает коллег:</span>
                  ${p.skip_reasons.map((r) => `<span class="score-pill score-pill--skip">${esc(r.title)} · ${r.count}</span>`)}
                </div>` : ''}
            </div>
            <div class="top-prop__score">
              <span class="score-pill score-pill--like" title="Полезно">${p.likes}</span>
              ${p.favorites ? `<span class="score-pill score-pill--fav" title="В избранном">${p.favorites}</span>` : ''}
              ${p.skips ? `<span class="score-pill score-pill--skip" title="Пропущено">${p.skips}</span>` : ''}
              <a class="btn btn--sm" href="/ideas/${p.idea_id}">Разобрать</a>
            </div>
          </div>`)}
      </div>
    </div>` : emptyCard('Оценок пока нет',
      'Топ формируется по итогам быстрого ревью. Как только коллеги начнут листать карточки, предложения выстроятся по полезности.');
}

function ideasQueue(panel, items, reload) {
  panel.innerHTML = items.length ? html`
    <div class="stack">
      ${items.map((i) => html`
        <div class="card">
          <div class="card__head">
            <div style="min-width:0">
              <h3>${esc(i.title)}</h3>
              <div class="card__hint"><span class="mono">${esc(i.number)}</span> ·
                ${esc(i.author_name)}${i.institution_short ? ' · ' + esc(i.institution_short) : ''} ·
                ${fmtAgo(i.created_at)}</div>
            </div>
            ${statusChip(i.status)}
          </div>
          <div class="card__body">
            <div class="fs-12 fw-600 text-3" style="text-transform:uppercase;letter-spacing:.05em;margin-bottom:5px">Проблема</div>
            <div class="prose" style="margin-bottom:12px">${nl2br(i.problem)}</div>
            <div class="fs-12 fw-600 text-3" style="text-transform:uppercase;letter-spacing:.05em;margin-bottom:5px">Желаемый результат</div>
            <div class="prose">${nl2br(i.desired_result)}</div>
          </div>
          <div class="card__foot row">
            <span class="fs-12 text-3">${i.support_total} ${plural(i.support_total, 'отметка', 'отметки', 'отметок')} поддержки</span>
            <div class="row spacer">
              <a class="btn btn--sm" href="/ideas/${i.id}">Открыть карточку</a>
              <button class="btn btn--sm" data-act="clarify" data-id="${i.id}">Уточнить</button>
              <button class="btn btn--sm btn--danger" data-act="reject" data-id="${i.id}">Отклонить</button>
              <button class="btn btn--sm btn--ok" data-act="approve" data-id="${i.id}">Принять</button>
            </div>
          </div>
        </div>`)}
    </div>` : emptyCard('Очередь пуста', 'Все поступившие идеи проверены.');

  panel.querySelectorAll('[data-act]').forEach((b) => b.onclick = () =>
    quickModerate(b.dataset.id, b.dataset.act, reload));
}

function quickModerate(ideaId, action, onDone) {
  const needsNote = ['reject', 'clarify'].includes(action);
  const TITLES = { approve: 'Принять идею к обсуждению', reject: 'Отклонить идею', clarify: 'Запросить уточнение' };
  modal({
    title: TITLES[action] || 'Решение модератора',
    body: html`
      <p class="prose" style="margin-bottom:14px">${action === 'approve'
        ? 'Идея откроется для предложений, автору начислятся очки за прохождение модерации.'
        : 'Комментарий увидит автор идеи.'}</p>
      <div class="field">
        <label class="field__label" for="qm-note">Комментарий${needsNote ? ' <span class="req">*</span>' : ''}</label>
        <textarea class="textarea" id="qm-note" style="min-height:88px"></textarea>
      </div>`,
    footer: '<button class="btn" data-close>Отмена</button><button class="btn btn--primary" data-ok>Применить</button>',
    onMount: (el, close) => {
      el.querySelector('[data-ok]').onclick = async () => {
        try {
          await api.post(`/api/ideas/${ideaId}/moderate`,
            { action, note: el.querySelector('#qm-note').value.trim() });
          toast('Решение сохранено', 'ok'); close(); onDone();
        } catch (err) { toast(err.message, 'error'); }
      };
    },
  });
}

function experienceQueue(panel, items, reload) {
  panel.innerHTML = items.length ? html`
    <div class="stack">
      ${items.map((p) => html`
        <div class="card">
          <div class="card__head">
            <div style="min-width:0">
              <h3>Опыт от: ${esc(p.author_name)}</h3>
              <div class="card__hint">По идее <span class="mono">${esc(p.idea_number)}</span> —
                ${esc(p.idea_title)} · ${fmtAgo(p.created_at)}</div>
            </div>
            <span class="badge badge--purple spacer">Ожидает подтверждения</span>
          </div>
          <div class="card__body">
            <div class="prose" style="margin-bottom:12px">${nl2br(p.summary)}</div>
            ${p.how_to_apply ? `<div class="prop__field"><span>Как применить</span><div class="prose">${nl2br(p.how_to_apply)}</div></div>` : ''}
            ${p.expected_effect ? `<div class="prop__field"><span>Достигнутый результат</span><div class="prose">${nl2br(p.expected_effect)}</div></div>` : ''}
            ${p.risks ? `<div class="prop__field"><span>Риски и ограничения</span><div class="prose">${nl2br(p.risks)}</div></div>` : ''}
          </div>
          <div class="card__foot row">
            <span class="fs-12 text-3">Подтверждение даёт советчику очки и знак отличия «Проверенный опыт»</span>
            <div class="row spacer">
              <a class="btn btn--sm" href="/ideas/${p.idea_id}">Открыть идею</a>
              <button class="btn btn--sm btn--danger" data-decide="${p.id}" data-action="reject">Отклонить</button>
              <button class="btn btn--sm btn--ok" data-decide="${p.id}" data-action="verify">Подтвердить опыт</button>
            </div>
          </div>
        </div>`)}
    </div>` : emptyCard('Опыт подтверждён', 'Новых описаний проверенного опыта нет.');

  panel.querySelectorAll('[data-decide]').forEach((b) => b.onclick = () => modal({
    title: b.dataset.action === 'verify' ? 'Подтвердить проверенный опыт' : 'Отклонить описание опыта',
    body: html`
      <p class="prose" style="margin-bottom:14px">${b.dataset.action === 'verify'
        ? 'Подтверждаю, что решение применялось и дало результат. Советчику начисляются очки за проверенный опыт.'
        : 'Комментарий увидит автор. Очки за проверенный опыт не начисляются.'}</p>
      <div class="field">
        <label class="field__label" for="ex-note">Комментарий${b.dataset.action === 'reject' ? ' <span class="req">*</span>' : ''}</label>
        <textarea class="textarea" id="ex-note" style="min-height:84px"></textarea>
      </div>`,
    footer: '<button class="btn" data-close>Отмена</button><button class="btn btn--primary" data-ok>Подтвердить</button>',
    onMount: (el, close) => {
      el.querySelector('[data-ok]').onclick = async () => {
        try {
          await api.post(`/api/proposals/${b.dataset.decide}/decide`,
            { action: b.dataset.action, note: el.querySelector('#ex-note').value.trim() });
          toast('Решение сохранено', 'ok'); close(); reload();
        } catch (err) { toast(err.message, 'error'); }
      };
    },
  }));
}

function reportsQueue(panel, items, flags, reload) {
  const antifraud = flags.length ? html`
    <div class="card" style="margin-bottom:16px;border-left:3px solid var(--warn)">
      <div class="card__head">
        <div>
          <h3>Сигналы антифрода</h3>
          <div class="card__hint">Система отслеживает механическое пролистывание карточек ревью.
            Сигнал — повод посмотреть на активность участника, а не обвинение: оценки могли быть
            быстрыми и по делу.</div>
        </div>
        <span class="badge badge--warn spacer">${flags.length}</span>
      </div>
      <div class="list">
        ${flags.map((f) => html`
          <div class="list__item">
            ${avatar(f.user_name)}
            <div class="list__main">
              <div class="list__title">${esc(f.kind_title)}</div>
              <div class="list__body">
                ${esc(f.user_name)}${f.institution ? ' · ' + esc(f.institution) : ''} ·
                всего оценок: ${num(f.total_reviews)}
                ${f.details?.count ? ` · подряд быстрых: ${f.details.count}` : ''}
                ${f.details?.accounts ? ` · учётных записей с устройства: ${f.details.accounts}` : ''}
              </div>
              <div class="list__meta"><span>${fmtAgo(f.created_at)}</span></div>
            </div>
            <div class="row">
              <a class="btn btn--sm" href="/profile/${f.user_id}">Профиль</a>
              <button class="btn btn--sm" data-flag="${f.id}" data-status="dismissed">Всё в порядке</button>
              <button class="btn btn--sm btn--primary" data-flag="${f.id}" data-status="reviewed">Проверено</button>
            </div>
          </div>`)}
      </div>
    </div>` : '';

  panel.innerHTML = antifraud + (items.length ? html`
    <div class="card">
      <div class="card__head"><h3>Обращения о нарушениях</h3>
        <span class="card__hint spacer">${items.length} ${plural(items.length, 'обращение', 'обращения', 'обращений')}</span></div>
      <div class="list">
        ${items.map((r) => html`
          <div class="list__item">
            <div class="list__main">
              <div class="list__title">${esc(r.reason)}</div>
              <div class="list__body">
                ${r.target_type === 'idea'
                  ? `Идея <a href="/ideas/${r.target?.id}" class="mono">${esc(r.target?.number || '')}</a> — ${esc(r.target?.title || 'удалена')}`
                  : `Предложение по идее <a href="/ideas/${r.target?.idea_id}" class="mono">${esc(r.target?.number || '')}</a>: ${esc((r.target?.summary || '').slice(0, 120))}`}
              </div>
              <div class="list__meta"><span>${esc(r.reporter_name)}</span><span>${fmtAgo(r.created_at)}</span></div>
            </div>
            <div class="row">
              <button class="btn btn--sm" data-resolve="${r.id}" data-status="dismissed">Нарушения нет</button>
              <button class="btn btn--sm btn--primary" data-resolve="${r.id}" data-status="resolved">Меры приняты</button>
            </div>
          </div>`)}
      </div>
    </div>` : (flags.length ? '' : emptyCard('Обращений и сигналов нет',
      'Участники не сообщали о нарушениях, подозрительной активности в ревью не зафиксировано.')));

  panel.querySelectorAll('[data-resolve]').forEach((b) => b.onclick = async () => {
    try {
      await api.post(`/api/reports/${b.dataset.resolve}/resolve`, { status: b.dataset.status });
      toast('Обращение закрыто', 'ok');
      reload();
    } catch (err) { toast(err.message, 'error'); }
  });
  panel.querySelectorAll('[data-flag]').forEach((b) => b.onclick = async () => {
    try {
      await api.post(`/api/review/flags/${b.dataset.flag}/resolve`, { status: b.dataset.status });
      toast('Сигнал закрыт', 'ok');
      reload();
    } catch (err) { toast(err.message, 'error'); }
  });
}

async function pointsPanel(panel) {
  const log = await api.get('/api/points/ledger?limit=200');
  panel.innerHTML = html`
    <div class="card">
      <div class="card__head">
        <div><h3>Журнал начислений</h3>
          <div class="card__hint">Кто, когда и за что получил очки. Повторное начисление за одно
            и то же действие невозможно на уровне базы данных.</div></div>
        <span class="badge badge--outline spacer">${num(log.total)} записей</span>
      </div>
      <div class="table-wrap"><table class="table">
        <thead><tr>
          <th style="width:140px">Время</th><th>Получатель</th><th>Основание</th>
          <th>Идея</th><th class="num">Очки</th><th style="width:150px"></th>
        </tr></thead>
        <tbody>${log.entries.map((e) => html`
          <tr class="${e.status === 'revoked' ? 'is-revoked' : ''}">
            <td class="fs-12 nowrap">${fmtDate(e.created_at, true)}</td>
            <td><div class="fw-600 fs-13">${esc(e.user_name)}</div>
              <div class="fs-12 text-3">${esc(e.institution || '')}</div></td>
            <td class="fs-13">${esc(e.rule_title || e.rule_code)}
              ${e.source_name ? `<div class="fs-12 text-3">от: ${esc(e.source_name)}</div>` : ''}
              ${e.revoke_reason ? `<div class="fs-12" style="color:var(--danger)">Отменено: ${esc(e.revoke_reason)}</div>` : ''}</td>
            <td class="fs-12">${e.idea_number ? `<a href="/ideas/${e.idea_id}" class="mono">${esc(e.idea_number)}</a>` : '—'}</td>
            <td class="num fw-600">${e.status === 'revoked' ? `<s>${e.points}</s>` : '+' + e.points}</td>
            <td>${e.status === 'revoked'
              ? '<span class="badge">Отменено</span>'
              : (log.can_revoke ? `<button class="btn btn--sm" data-revoke="${e.id}">Отменить</button>` : '')}</td>
          </tr>`)}
        </tbody>
      </table></div>
    </div>`;

  panel.querySelectorAll('[data-revoke]').forEach((b) => b.onclick = () => modal({
    title: 'Отменить начисление',
    body: html`
      <p class="prose" style="margin-bottom:14px">Отмена применяется при нарушении правил:
         накрутка, дубль решения или начисление по ошибке. Запись остаётся в журнале
         с указанием причины.</p>
      <div class="field"><label class="field__label" for="rv-reason">Причина <span class="req">*</span></label>
        <textarea class="textarea" id="rv-reason" style="min-height:80px"></textarea></div>`,
    footer: '<button class="btn" data-close>Отмена</button><button class="btn btn--danger" data-ok>Отменить начисление</button>',
    onMount: (el, close) => {
      el.querySelector('[data-ok]').onclick = async () => {
        try {
          await api.post(`/api/points/${b.dataset.revoke}/revoke`,
            { reason: el.querySelector('#rv-reason').value.trim() });
          toast('Начисление отменено', 'ok'); close(); pointsPanel(panel);
        } catch (err) { toast(err.message, 'error'); }
      };
    },
  }));
}

const emptyCard = (title, text) =>
  `<div class="card"><div class="empty"><h4>${esc(title)}</h4><p>${esc(text)}</p></div></div>`;

// ══════════════════════════════════════════════════════════════
// Рекомендации к поощрению
// ══════════════════════════════════════════════════════════════
export async function incentivesView(view, query) {
  const status = query.get('status') || '';
  view.innerHTML = '<div class="card"><div class="card__body"><div class="skeleton" style="height:300px"></div></div></div>';

  const [data, types] = await Promise.all([
    api.get(`/api/incentives${status ? '?status=' + status : ''}`),
    api.get('/api/incentive-types'),
  ]);
  const byStatus = {};
  for (const i of data.items) byStatus[i.status] = (byStatus[i.status] || 0) + 1;

  view.innerHTML = html`
    <div class="page-head">
      <div class="page-head__row">
        <div style="flex:1;min-width:260px">
          <h2>Рекомендации к поощрению</h2>
          <p>Система фиксирует рекомендацию, а не выдаёт поощрение: итоговое решение принимает
             руководитель или уполномоченное лицо. Все меры применяются в рамках трудового
             законодательства, внутренних регламентов и правил государственной службы.</p>
        </div>
        <div class="row">
          ${data.can_propose ? '<button class="btn" data-build>Сформировать по итогам месяца</button>' : ''}
          ${data.can_propose ? '<button class="btn btn--primary" data-new>Предложить поощрение</button>' : ''}
        </div>
      </div>
    </div>

    <div class="chip-row" style="margin-bottom:16px">
      <button class="chip ${!status ? 'is-on' : ''}" data-status="">Все</button>
      ${Object.entries(INCENTIVE_STATUS).map(([k, m]) =>
        `<button class="chip ${status === k ? 'is-on' : ''}" data-status="${k}">${esc(m.title)}${byStatus[k] ? ` (${byStatus[k]})` : ''}</button>`)}
    </div>

    ${data.items.length ? html`
      <div class="stack">
        ${data.items.map((i) => html`
          <div class="card incentive">
            <div class="card__head">
              <div class="row" style="gap:11px;min-width:0;flex:1">
                ${avatar(i.full_name)}
                <div style="min-width:0">
                  <h3>${esc(i.full_name)}</h3>
                  <div class="card__hint">${esc(i.position || '')}${i.institution ? ' · ' + esc(i.institution) : ''}</div>
                </div>
              </div>
              <span class="st st--${INCENTIVE_STATUS[i.status]?.tone}"><i></i>${esc(INCENTIVE_STATUS[i.status]?.title)}</span>
            </div>
            <div class="card__body">
              <div class="incentive__measure">
                <span class="badge badge--info">${esc(CATEGORY_TITLES[i.type_category] || i.type_category)}</span>
                <b>${esc(i.type_title)}</b>
              </div>
              ${i.legal_note ? `<div class="incentive__legal">${esc(i.legal_note)}</div>` : ''}
              <dl class="def" style="margin-top:14px">
                <dt>Период</dt><dd>${esc(i.period_label)}</dd>
                <dt>Очки за период</dt><dd>${num(i.points_at_creation)}${i.rank_at_creation ? ` · ${i.rank_at_creation} место` : ''}</dd>
                ${i.note ? `<dt>Основание</dt><dd class="fs-13">${esc(i.note)}</dd>` : ''}
                ${i.proposed_by_name ? `<dt>Предложил</dt><dd class="fs-13">${esc(i.proposed_by_name)}</dd>` : ''}
                ${i.decision_note ? `<dt>Решение</dt><dd class="fs-13">${esc(i.decision_note)}</dd>` : ''}
                ${i.decided_by_name ? `<dt>Принял решение</dt><dd class="fs-13">${esc(i.decided_by_name)}, ${fmtDate(i.decided_at)}</dd>` : ''}
              </dl>
            </div>
            ${data.can_decide ? html`
              <div class="card__foot row">
                <a class="btn btn--sm" href="/profile/${i.user_id}">Профиль сотрудника</a>
                <div class="row spacer">
                  ${i.status === 'proposed' ? `<button class="btn btn--sm" data-set="${i.id}" data-status="agreed">Согласовать</button>` : ''}
                  ${['proposed', 'agreed'].includes(i.status) ? `<button class="btn btn--sm btn--ok" data-set="${i.id}" data-status="approved">Утвердить</button>` : ''}
                  ${i.status === 'approved' ? `<button class="btn btn--sm btn--ok" data-set="${i.id}" data-status="implemented">Реализовано</button>` : ''}
                  ${!['rejected', 'implemented'].includes(i.status) ? `<button class="btn btn--sm btn--danger" data-set="${i.id}" data-status="rejected">Отклонить</button>` : ''}
                </div>
              </div>` : ''}
          </div>`)}
      </div>` : html`
      <div class="card"><div class="empty">
        <h4>Рекомендаций нет</h4>
        <p>Рекомендации формируются по итогам периода на основании рейтинга советчиков
           или добавляются руководителем вручную.</p>
      </div></div>`}`;

  const reload = () => incentivesView(view, query);
  view.querySelectorAll('[data-status]').forEach((b) => b.onclick = () =>
    navigate(`/incentives${b.dataset.status ? '?status=' + b.dataset.status : ''}`));
  view.querySelector('[data-build]')?.addEventListener('click', () => buildIncentives(reload));
  view.querySelector('[data-new]')?.addEventListener('click', () => newIncentiveModal(types, reload));
  view.querySelectorAll('[data-set]').forEach((b) => b.onclick = () =>
    decideIncentive(b.dataset.set, b.dataset.status, reload));
}

async function buildIncentives(onDone) {
  if (!await confirmDialog('Сформировать рекомендации',
    'Система отберёт сотрудников с наибольшим вкладом за текущий месяц и подготовит рекомендации ' +
    'к поощрению. Решение по каждой из них принимает руководитель.', 'Сформировать')) return;
  try {
    const r = await api.post('/api/incentives/build', { period: 'month' });
    toast(r.created.length
      ? `Подготовлено рекомендаций: ${r.created.length} за период «${r.label}»`
      : 'Новых рекомендаций нет: порог по очкам не достигнут либо они уже сформированы', 'ok');
    onDone();
  } catch (err) { toast(err.message, 'error'); }
}

function newIncentiveModal(types, onDone) {
  const grouped = {};
  for (const t of types.filter((x) => x.is_active)) (grouped[t.category] ||= []).push(t);
  modal({
    title: 'Предложить поощрение', wide: true,
    body: html`
      <div class="field">
        <label class="field__label" for="i-user">Сотрудник <span class="req">*</span></label>
        <select class="select" id="i-user"><option value="">Загрузка…</option></select>
      </div>
      <div class="field">
        <label class="field__label" for="i-type">Мера поощрения <span class="req">*</span></label>
        <select class="select" id="i-type">
          ${Object.entries(grouped).map(([cat, list]) => html`
            <optgroup label="${esc(CATEGORY_TITLES[cat] || cat)}">
              ${list.map((t) => `<option value="${esc(t.code)}">${esc(t.title)}</option>`)}
            </optgroup>`)}
        </select>
        <div class="field__hint" id="i-legal"></div>
      </div>
      <div class="field">
        <label class="field__label" for="i-period">Период вклада</label>
        <select class="select" id="i-period">
          ${PERIODS.map(([k, t]) => `<option value="${k}" ${k === 'month' ? 'selected' : ''}>${t}</option>`)}
        </select>
      </div>
      <div class="field">
        <label class="field__label" for="i-note">Основание</label>
        <textarea class="textarea" id="i-note" style="min-height:74px"
          placeholder="За какой вклад предлагается поощрение"></textarea>
      </div>
      <div class="field__hint">Рекомендация не является распоряжением. Решение принимает руководитель
        или уполномоченное лицо в порядке, установленном внутренними актами.</div>`,
    onMount: async (el, close) => {
      const sel = el.querySelector('#i-user');
      const legal = el.querySelector('#i-legal');
      const showLegal = () => {
        const t = types.find((x) => x.code === el.querySelector('#i-type').value);
        legal.textContent = t?.legal_note || '';
      };
      el.querySelector('#i-type').onchange = showLegal;
      showLegal();
      try {
        const users = await api.get('/api/users');
        sel.innerHTML = users.map((u) =>
          `<option value="${u.id}">${esc(u.full_name)}${u.institution ? ' — ' + esc(u.institution) : ''}</option>`).join('');
      } catch { sel.innerHTML = '<option value="">Не удалось загрузить список</option>'; }
      el.querySelector('[data-ok]').onclick = async () => {
        try {
          await api.post('/api/incentives', {
            user_id: Number(sel.value), type_code: el.querySelector('#i-type').value,
            period: el.querySelector('#i-period').value, note: el.querySelector('#i-note').value.trim(),
          });
          toast('Рекомендация оформлена', 'ok'); close(); onDone();
        } catch (err) { toast(err.message, 'error'); }
      };
    },
    footer: '<button class="btn" data-close>Отмена</button><button class="btn btn--primary" data-ok>Оформить</button>',
  });
}

function decideIncentive(id, status, onDone) {
  const TITLES = {
    agreed: ['Согласовать рекомендацию', 'Рекомендация переходит на утверждение.'],
    approved: ['Утвердить поощрение', 'Мера утверждена и передаётся к исполнению в установленном порядке.'],
    implemented: ['Отметить реализованным', 'Поощрение применено. Сотрудник получит уведомление.'],
    rejected: ['Отклонить рекомендацию', 'Укажите основание отказа — оно будет видно сотруднику.'],
  };
  const [title, hint] = TITLES[status];
  modal({
    title,
    body: html`
      <p class="prose" style="margin-bottom:14px">${esc(hint)}</p>
      <div class="field">
        <label class="field__label" for="di-note">Комментарий${status === 'rejected' ? ' <span class="req">*</span>' : ''}</label>
        <textarea class="textarea" id="di-note" style="min-height:84px"></textarea>
      </div>`,
    footer: '<button class="btn" data-close>Отмена</button><button class="btn btn--primary" data-ok>Подтвердить</button>',
    onMount: (el, close) => {
      el.querySelector('[data-ok]').onclick = async () => {
        try {
          await api.patch(`/api/incentives/${id}`,
            { status, decision_note: el.querySelector('#di-note').value.trim() });
          toast('Решение сохранено', 'ok'); close(); onDone();
        } catch (err) { toast(err.message, 'error'); }
      };
    },
  });
}

// ══════════════════════════════════════════════════════════════
// Вклад участника — блок профиля
// ══════════════════════════════════════════════════════════════
export async function advisorPanel(userId) {
  let d;
  try { d = await api.get(`/api/ideas/contribution/${userId}`); } catch { return ''; }
  const s = d.stats;
  if (!s.ideas && !s.proposals && !s.points) return '';

  return html`
    <div class="grid grid--kpi" style="margin-bottom:16px">
      <div class="kpi kpi--ok">
        <div class="kpi__label">Очки советчика</div>
        <div class="kpi__value">${num(s.points)}</div>
        <div class="kpi__meta">За весь период участия</div>
      </div>
      <div class="kpi"><div class="kpi__label">Подано идей</div><div class="kpi__value">${s.ideas}</div></div>
      <div class="kpi"><div class="kpi__label">Предложено решений</div><div class="kpi__value">${s.proposals}</div>
        <div class="kpi__meta">${s.useful} признано полезными</div></div>
      <div class="kpi"><div class="kpi__label">Подтверждений коллег</div><div class="kpi__value">${s.endorsements}</div></div>
    </div>

    ${d.badges.length ? html`
      <div class="card" style="margin-bottom:16px">
        <div class="card__head"><h3>Знаки отличия</h3></div>
        <div class="card__body"><div class="chip-row">
          ${d.badges.map((b) => `<span class="chip" style="cursor:default">${ICON_MEDAL} ${esc(b.title)}</span>`)}
        </div></div>
      </div>` : ''}

    <div class="grid grid--2" style="align-items:start;margin-bottom:16px">
      <div class="card">
        <div class="card__head"><h3>Идеи участника</h3></div>
        <div class="card__body--flush">
          ${d.ideas.length ? html`<div class="list">
            ${d.ideas.map((i) => html`
              <a class="list__item is-clickable" href="/ideas/${i.id}" style="text-decoration:none;color:inherit">
                <div class="list__main">
                  <div class="list__title">${esc(i.title)}</div>
                  <div class="list__meta"><span class="mono">${esc(i.number)}</span>
                    <span>${esc(IDEA_STATUS[i.status]?.title || '')}</span>
                    <span>${fmtDate(i.created_at)}</span></div>
                </div>
              </a>`)}
          </div>` : '<div class="empty" style="padding:26px"><p>Идей пока нет</p></div>'}
        </div>
      </div>

      <div class="card">
        <div class="card__head"><h3>Решения для коллег</h3></div>
        <div class="card__body--flush">
          ${d.proposals.length ? html`<div class="list">
            ${d.proposals.map((p) => html`
              <a class="list__item is-clickable" href="/ideas/${p.idea_id}" style="text-decoration:none;color:inherit">
                <div class="list__main">
                  <div class="list__title">${esc(p.summary.slice(0, 110))}</div>
                  <div class="list__meta"><span class="mono">${esc(p.idea_number)}</span>
                    ${p.kind === 'experience' ? '<span class="badge badge--purple">Проверенный опыт</span>' : ''}
                    <span>${fmtDate(p.created_at)}</span></div>
                </div>
              </a>`)}
          </div>` : '<div class="empty" style="padding:26px"><p>Предложений пока нет</p></div>'}
        </div>
      </div>
    </div>

    ${d.history.length ? html`
      <div class="card" style="margin-bottom:16px">
        <div class="card__head"><h3>История начислений</h3>
          <span class="card__hint spacer">Последние ${d.history.length} записей</span></div>
        <div class="table-wrap"><table class="table">
          <thead><tr><th style="width:140px">Дата</th><th>Основание</th><th>Идея</th><th class="num">Очки</th></tr></thead>
          <tbody>${d.history.map((h) => html`
            <tr class="${h.status === 'revoked' ? 'is-revoked' : ''}">
              <td class="fs-12 nowrap">${fmtDate(h.created_at)}</td>
              <td class="fs-13">${esc(h.rule_title || h.rule_code)}</td>
              <td class="fs-12">${h.idea_number ? `<a href="/ideas/${h.idea_id}" class="mono">${esc(h.idea_number)}</a>` : '—'}</td>
              <td class="num fw-600">${h.status === 'revoked' ? `<s>${h.points}</s>` : '+' + h.points}</td>
            </tr>`)}
          </tbody>
        </table></div>
      </div>` : ''}`;
}
