// Рабочий стол — состав виджетов зависит от роли участника.
import { api, state, esc, html, avatar, can, navigate, toast, num, fmtDate, fmtShort, fmtAgo,
         fmtHours, slaChip, STATUS_META, ROLE_TITLES, plural, donut, barList } from '../core.js';
import { pipeline } from './initiatives.js';

export async function dashboard(view) {
  view.innerHTML = '<div class="grid grid--kpi">' + '<div class="skeleton" style="height:106px"></div>'.repeat(4) + '</div>';

  const scope = can('analytics.all') ? 'all' : (can('analytics.institution') ? 'institution' : 'mine');
  const [overview, tasks, mine, recent] = await Promise.all([
    api.get(`/api/analytics/overview?scope=${scope}`),
    api.get('/api/tasks?status=open'),
    api.get('/api/initiatives?mine=1&limit=5'),
    api.get('/api/initiatives?limit=6&sort=new'),
  ]);

  const g1 = overview.group1, g2 = overview.group2, g3 = overview.group3;
  const counts = Object.fromEntries(overview.funnel.map((f) => [f.stage_no, f.current]));
  const hour = new Date().getHours();
  const greeting = hour < 6 ? 'Доброй ночи' : hour < 12 ? 'Доброе утро' : hour < 18 ? 'Добрый день' : 'Добрый вечер';

  const scopeLabel = { all: 'по всей экосистеме', institution: 'по вашему учреждению', mine: 'по вашим инициативам' }[scope];

  view.innerHTML = html`
    <div class="page-head">
      <h2>${greeting}, ${esc(state.user.full_name.split(' ')[1] || state.user.full_name)}</h2>
      <p>${esc(ROLE_TITLES[state.user.role])}${state.user.institution_name ? ' · ' + esc(state.user.institution_name) : ''}.
         Показатели ${scopeLabel}.</p>
    </div>

    ${tasks.length ? html`
    <div class="card" style="margin-bottom:16px;border-left:3px solid var(--brand-600)" data-ac="US-HOME-001/AC6">
      <div class="card__head">
        <h3>Требуют вашего решения</h3>
        <span class="badge badge--${tasks.some((t) => t.overdue) ? 'danger' : 'info'} spacer">
          ${tasks.length} ${plural(tasks.length, 'задача', 'задачи', 'задач')}</span>
      </div>
      <div class="card__body--flush"><div class="list">
        ${tasks.slice(0, 5).map((t) => html`
          <div class="list__item is-clickable" data-goto="/initiatives/${t.initiative_id}">
            <div class="list__main">
              <div class="list__title">${esc(t.title)}</div>
              <div class="list__meta">
                <span class="mono">${esc(t.number || '')}</span>
                ${t.due_at ? `<span class="${t.overdue ? 'badge badge--danger' : ''}">${t.overdue ? 'Просрочено' : 'Срок'}: ${fmtDate(t.due_at)}</span>` : ''}
                ${t.status === 'escalated' ? '<span class="badge badge--danger">Эскалировано</span>' : ''}
              </div>
            </div>
            <span class="btn btn--sm">Открыть</span>
          </div>`)}
      </div></div>
      ${tasks.length > 5 ? '<div class="card__foot"><a href="/tasks" class="btn btn--sm">Все задачи</a></div>' : ''}
    </div>` : ''}

    <div class="grid grid--kpi" style="margin-bottom:16px">
      ${kpi('Инициатив всего', g1.total_initiatives, { meta: `${g1.scaled_initiatives} масштабировано` })}
      ${kpi('Внедрено улучшений', g1.scaled_initiatives, { tone: 'ok',
        meta: 'Конечный продукт экосистемы — поток внедрённых улучшений' })}
      ${kpi('Полный цикл', g2.cycle_median_days ?? '—', { unit: 'дн.',
        meta: g2.cycle_samples ? `медиана по ${g2.cycle_samples} ${plural(g2.cycle_samples, 'инициативе', 'инициативам', 'инициативам')}` : 'нет завершённых циклов' })}
      ${kpi('Соблюдение SLA', g2.sla_compliance_overall ?? '—', { unit: '%',
        tone: g2.sla_compliance_overall >= 80 ? 'ok' : g2.sla_compliance_overall >= 60 ? 'warn' : 'danger',
        bar: g2.sla_compliance_overall, meta: `${g3.frozen_count} ${plural(g3.frozen_count, 'инициатива вышла', 'инициативы вышли', 'инициатив вышли')} за срок` })}
    </div>

    <div class="card" style="margin-bottom:16px" data-ac="US-HOME-001/AC5">
      <div class="card__head">
        <h3>Конвейер Stage-Gate</h3>
        <span class="card__hint spacer">Инициатив на каждом этапе прямо сейчас</span>
      </div>
      <div class="card__body">${pipeline(state.stages, -1, null, counts)}</div>
    </div>

    <div class="grid grid--2" style="align-items:start">
      ${roleWidget(overview)}

      <div class="card">
        <div class="card__head"><h3>Последние инициативы</h3>
          <a href="/initiatives" class="btn btn--sm spacer">Все</a></div>
        <div class="card__body--flush"><div class="list">
          ${recent.items.map((i) => html`
            <div class="list__item is-clickable" data-goto="/initiatives/${i.id}">
              <div class="list__main">
                <div class="list__title">${esc(i.title)}</div>
                <div class="list__meta">
                  <span class="mono">${esc(i.number)}</span>
                  <span>${esc(i.institution_short)}</span>
                  <span class="badge badge--${STATUS_META[i.status]?.badge}">${STATUS_META[i.status]?.title}</span>
                  <span>Этап ${i.tz_stage}</span>
                </div>
              </div>
            </div>`)}
        </div></div>
      </div>

      ${can('initiative.create') ? html`
      <div class="card" data-ac="US-HOME-001/AC1">
        <div class="card__head"><h3>Мои инициативы</h3>
          <a href="/initiatives/new" class="btn btn--sm btn--primary spacer">Подать</a></div>
        <div class="card__body--flush">
          ${mine.items.length ? html`<div class="list">
            ${mine.items.map((i) => html`
              <div class="list__item is-clickable" data-goto="/initiatives/${i.id}">
                <div class="list__main">
                  <div class="list__title">${esc(i.title)}</div>
                  <div class="list__meta">
                    <span>Этап ${i.tz_stage}. ${esc(i.stage_name)}</span>
                    <span class="badge badge--${STATUS_META[i.status]?.badge}">${STATUS_META[i.status]?.title}</span>
                    ${slaChip(i.sla)}
                  </div>
                </div>
              </div>`)}
          </div>` : html`
          <div class="empty" style="padding:30px">
            <h4>Вы ещё не подавали инициатив</h4>
            <p>Каждый сотрудник — источник улучшений. Если вы видите проблему в ежедневной работе,
               опишите её: платформа проведёт инициативу от идеи до внедрения.</p>
            <a href="/initiatives/new" class="btn btn--primary" style="margin-top:14px">Подать первую инициативу</a>
          </div>`}
        </div>
      </div>` : ''}
    </div>`;

  view.querySelectorAll('[data-goto]').forEach((el) => el.onclick = () => navigate(el.dataset.goto));
}

function kpi(label, value, { unit = '', meta = '', tone = '', bar = null } = {}) {
  return html`<div class="kpi ${tone ? 'kpi--' + tone : ''}">
    <div class="kpi__label">${esc(label)}</div>
    <div class="kpi__value">${typeof value === 'number' ? num(value, value % 1 ? 1 : 0) : esc(String(value))}${unit ? `<span class="kpi__unit">${esc(unit)}</span>` : ''}</div>
    ${bar !== null && bar !== undefined ? `<div class="kpi__bar"><i style="width:${Math.min(100, bar)}%"></i></div>` : ''}
    ${meta ? `<div class="kpi__meta">${esc(meta)}</div>` : ''}
  </div>`;
}
export { kpi };

// Виджет, специфичный для роли
function roleWidget(o) {
  const role = state.user.role;
  if (role === 'employee') {
    return html`<div class="card">
      <div class="card__head"><h3>Как работает Social1</h3></div>
      <div class="card__body prose">
        <p><b>Вы — источник инноваций.</b> Именно вы первыми сталкиваетесь с неэффективностью,
        избыточными операциями и новыми потребностями, потому что работаете с гражданами каждый день.</p>
        <p>Social1 — не электронная книга предложений. Это конвейер превращения инициатив
        в работающие изменения: вы проводите проблему по полному пути от формулировки
        до масштабирования решения на другие учреждения.</p>
        <p class="fs-13 text-3">Неудачная, но хорошо продуманная инициатива — часть учебного процесса,
        а не повод для санкций. Участие в Social1 не влияет на аттестацию.</p>
      </div>
      <div class="card__foot"><a href="/process" class="btn btn--sm">Как устроен процесс</a></div>
    </div>`;
  }
  if (role === 'head') {
    return html`<div class="card">
      <div class="card__head"><h3>Ваша роль в экосистеме</h3></div>
      <div class="card__body">
        <p class="prose" style="margin-bottom:14px">Вы владелец процессов и первый уровень принятия решений.
          На <b>Gate 1</b> вы оцениваете инициативы своих сотрудников — соответствие регламентам,
          бюджетным ограничениям и потенциал локального улучшения. Срок решения — 3 рабочих дня.</p>
        <dl class="def">
          <dt>Инициатив учреждения</dt><dd>${num(o.group1.total_initiatives)}</dd>
          <dt>Авторов среди сотрудников</dt><dd>${num(o.group1.authors_count)}</dd>
          <dt>Вовлечённость</dt><dd>${num(o.group1.engagement_rate, 1)}%</dd>
          <dt>Инициатив в работе</dt><dd>${num(o.group3.active_count)}</dd>
        </dl>
      </div>
      <div class="card__foot"><a href="/analytics" class="btn btn--sm">Аналитика учреждения</a></div>
    </div>`;
  }
  if (role === 'expert') {
    const passage = o.group1.gate_passage.find((g) => g.gate_no === 2);
    return html`<div data-ac="US-HOME-001/AC3" class="card">
      <div class="card__head"><h3>Поток инициатив на экспертизу</h3></div>
      <div class="card__body">
        <p class="prose" style="margin-bottom:14px">На <b>Gate 2</b> вы оцениваете стратегическую значимость,
          масштабируемость и ожидаемый эффект. Срок вердикта — 5 рабочих дней.</p>
        ${passage ? html`
          ${barList([
            { label: 'Go — продолжить', value: passage.go, color: 'var(--ok)' },
            { label: 'Kill — остановить', value: passage.kill, color: 'var(--danger)' },
            { label: 'Hold — приостановить', value: passage.hold, color: 'var(--warn)' },
            { label: 'Redirect — на доработку', value: passage.redirect, color: 'var(--purple)' },
          ])}
          <p class="fs-12 text-3" style="margin-top:10px">Решения Kill — признак здоровой системы:
             она отсеивает нежизнеспособные проекты и экономит ресурсы.</p>` :
          '<p class="text-3 fs-13">Решений на Gate 2 пока не принималось.</p>'}
      </div>
    </div>`;
  }
  if (role === 'developer' || role === 'supplier') {
    return html`<div data-ac="US-HOME-001/AC4" class="card">
      <div class="card__head"><h3>Разработка прототипов</h3>
        <a href="/projects" class="btn btn--sm spacer">Проекты</a></div>
      <div class="card__body">
        <p class="prose" style="margin-bottom:14px">Инициативы, прошедшие Gate 2, превращаются в MVP
          по Agile: 4 спринта по 2 недели. Приоритеты каждого спринта утверждает продакт-менеджер ДТСЗН.</p>
        <dl class="def">
          <dt>В разработке</dt><dd>${num(o.funnel.find((f) => f.stage_no === 4)?.current || 0)}</dd>
          <dt>На пилотировании</dt><dd>${num(o.funnel.find((f) => f.stage_no === 5)?.current || 0)}</dd>
        </dl>
      </div>
    </div>`;
  }
  if (role === 'pilot_coordinator') {
    return html`<div data-ac="US-HOME-001/AC4" class="card">
      <div class="card__head"><h3>Пилотирование</h3>
        <a href="/pilots" class="btn btn--sm spacer">Все пилоты</a></div>
      <div class="card__body">
        <p class="prose" style="margin-bottom:14px">На <b>Gate 4</b> вы оцениваете результаты пилота:
          доказанность эффекта, удовлетворённость пользователей, отсутствие критических проблем.
          Срок пилота — 1 месяц, анализ обратной связи — 1 неделя после завершения.</p>
        <dl class="def">
          <dt>Коэффициент успешности пилотов</dt><dd>${o.group2.pilot_success_rate ?? '—'}%</dd>
          <dt>Участников в пилотах</dt><dd>${num(o.group1.pilot_participants)}</dd>
        </dl>
      </div>
    </div>`;
  }
  // ДТСЗН
  return html`<div data-ac="US-HOME-001/AC5" class="card">
    <div class="card__head"><h3>Портфель инициатив</h3>
      <a href="/analytics" class="btn btn--sm spacer">Подробно</a></div>
    <div class="card__body">
      <div class="row" style="gap:22px;align-items:center">
        ${donut([
          { label: 'В работе', value: o.group3.active_count, color: 'var(--brand-600)' },
          { label: 'Масштабировано', value: o.group1.scaled_initiatives, color: 'var(--ok)' },
          { label: 'Остановлено', value: o.group3.kill_total, color: 'var(--danger)' },
          { label: 'Приостановлено', value: o.group3.on_hold_count, color: 'var(--warn)' },
        ], { center: { value: o.group1.total_initiatives, label: 'инициатив' } })}
        <div style="flex:1;min-width:150px">
          ${[['В работе', o.group3.active_count, 'var(--brand-600)'],
             ['Масштабировано', o.group1.scaled_initiatives, 'var(--ok)'],
             ['Остановлено (Kill)', o.group3.kill_total, 'var(--danger)'],
             ['Приостановлено', o.group3.on_hold_count, 'var(--warn)']].map(([l, v, c]) => html`
            <div class="row fs-13" style="justify-content:space-between;padding:3px 0">
              <span class="row" style="gap:7px"><i style="width:9px;height:9px;border-radius:2px;background:${c};display:inline-block"></i>${esc(l)}</span>
              <b>${num(v)}</b>
            </div>`)}
        </div>
      </div>
    </div>
  </div>`;
}

// ══ Задачи ═══════════════════════════════════════════════════
export async function tasksView(view) {
  const tasks = await api.get('/api/tasks?status=open');
  view.innerHTML = html`
    <div class="page-head">
      <h2>Мои задачи</h2>
      <p>Задачи создаются автоматически движком бизнес-процессов, когда от вас требуется решение
         или действие. Просроченные задачи эскалируются координатору экосистемы.</p>
    </div>
    <div class="card">
      ${tasks.length ? html`<div class="list">
        ${tasks.map((t) => html`
          <div data-ac="US-HOME-002/AC1 US-HOME-002/AC2 US-SG-001/AC3" class="list__item is-clickable" data-goto="/initiatives/${t.initiative_id}">
            <div class="list__main">
              <div class="list__title">${esc(t.title)}</div>
              <div class="list__meta">
                <span class="mono">${esc(t.number || '')}</span>
                ${t.due_at ? `<span class="${t.overdue ? 'badge badge--danger' : 'badge badge--outline'}">
                  ${t.overdue ? 'Просрочено с' : 'Срок'}: ${fmtDate(t.due_at)}</span>` : ''}
                ${t.status === 'escalated' ? '<span class="badge badge--danger">Эскалировано в ДТСЗН</span>' : ''}
                <span>Создана ${fmtAgo(t.created_at)}</span>
              </div>
            </div>
            <span class="btn btn--sm btn--primary">Рассмотреть</span>
          </div>`)}
      </div>` : html`
      <div class="empty">
        <h4>Открытых задач нет</h4>
        <p>Когда инициатива дойдёт до этапа, где требуется ваше решение, задача появится здесь
           автоматически — вместе с уведомлением и сроком по SLA.</p>
      </div>`}
    </div>`;
  view.querySelectorAll('[data-goto]').forEach((el) => el.onclick = () => navigate(el.dataset.goto));
}
