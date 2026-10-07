// Аналитика и КПЭ: три группы показателей, воронка, сравнение учреждений, контроль SLA.
import { api, state, esc, html, can, navigate, num, fmtDate, fmtHours, plural,
         lineChart, barList, donut, avatar } from '../core.js';
import { kpi } from './dashboard.js';
import { pipeline } from './initiatives.js';

export async function analyticsView(view, query) {
  const allowed = can('analytics.all');
  const scope = query.get('scope') || (allowed ? 'all' : (can('analytics.institution') ? 'institution' : 'mine'));
  view.innerHTML = '<div class="grid grid--kpi">' + '<div class="skeleton" style="height:106px"></div>'.repeat(4) + '</div>';

  const [o, contributors, institutions] = await Promise.all([
    api.get(`/api/analytics/overview?scope=${scope}`),
    api.get('/api/analytics/contributors').catch(() => []),
    (can('analytics.all') || can('analytics.institution'))
      ? api.get('/api/analytics/institutions').catch(() => []) : Promise.resolve([]),
  ]);
  const g1 = o.group1, g2 = o.group2, g3 = o.group3;

  const monthly = o.monthly.map((m) => {
    const [y, mo] = m.month.split('-');
    return { label: `${mo}.${y.slice(2)}`, created: m.created, scaled: m.scaled || 0 };
  });

  view.innerHTML = html`
    <div class="page-head">
      <div class="page-head__row">
        <div style="flex:1;min-width:250px">
          <h2>Аналитика и КПЭ</h2>
          <p>Система показателей отражает и количественные результаты, и качество самого
             инновационного процесса. Три группы: вовлечённость, скорость, качество и риски.</p>
        </div>
        <div class="row">
          ${allowed ? html`
          <select data-ac="US-ANL-004/AC1" class="select" id="scope" style="width:auto">
            <option value="all" ${scope === 'all' ? 'selected' : ''}>Вся экосистема</option>
            <option value="institution" ${scope === 'institution' ? 'selected' : ''}>Моё учреждение</option>
            <option value="mine" ${scope === 'mine' ? 'selected' : ''}>Мои инициативы</option>
          </select>` : ''}
          ${can('analytics.all') || can('analytics.institution')
            ? '<a data-ac="US-ANL-004/AC4" href="/api/analytics/export" class="btn" data-native download>Выгрузить отчёт (CSV)</a>' : ''}
        </div>
      </div>
    </div>

    <div class="tabs" id="tabs">
      <button class="tab is-active" data-tab="g1">Вовлечённость и культура</button>
      <button class="tab" data-tab="g2">Скорость и эффективность</button>
      <button class="tab" data-tab="g3">Качество и риски</button>
      ${institutions.length ? '<button class="tab" data-tab="inst">Учреждения</button>' : ''}
      <button class="tab" data-tab="people">Участники</button>
    </div>

    <!-- ГРУППА 1 -->
    <section data-panel="g1">
      <div class="grid grid--kpi" style="margin-bottom:16px" data-ac="US-ANL-001/AC1 US-ANL-001/AC3 US-ANL-001/AC4 US-ANL-001/AC5">
        ${kpi('Зарегистрировано инициатив', g1.total_initiatives, { meta: 'Базовый показатель активности экосистемы' })}
        ${kpi('Внедрено инициатив', g1.scaled_initiatives, { tone: 'ok',
          meta: 'Прошли все этапы и получили решение о масштабировании' })}
        ${kpi('Вовлечённость сотрудников', g1.engagement_rate, { unit: '%', bar: g1.engagement_rate,
          meta: `${g1.authors_count} из ${g1.potential_authors} подали хотя бы одну инициативу` })}
        ${kpi('Участников пилотов', g1.pilot_participants, { meta: 'Готовность учреждений к экспериментам' })}
        ${kpi('Масштабирование «снизу»', g1.bottom_up_share, { unit: '%', tone: 'ok', bar: g1.bottom_up_share,
          meta: 'Доля внедрений по инициативе учреждений без директив сверху' })}
        ${kpi('Всего внедрений в учреждениях', g1.rollouts_total, { meta: 'Суммарно по всем масштабированным решениям' })}
      </div>

      <div class="grid grid--2" style="align-items:start">
        <div class="card" data-ac="US-ANL-004/AC2">
          <div class="card__head"><h3>Динамика подачи и внедрения</h3></div>
          <div class="card__body">
            ${lineChart(monthly, { series: [
              { key: 'created', color: 'var(--brand-600)', fill: true },
              { key: 'scaled', color: 'var(--ok)' },
            ]})}
            <div class="row fs-12 text-3" style="gap:16px;margin-top:6px">
              <span class="row" style="gap:6px"><i style="width:11px;height:3px;background:var(--brand-600);display:inline-block;border-radius:2px"></i>Подано</span>
              <span class="row" style="gap:6px"><i style="width:11px;height:3px;background:var(--ok);display:inline-block;border-radius:2px"></i>Масштабировано</span>
            </div>
          </div>
        </div>

        <div class="card" data-ac="US-ANL-001/AC2">
          <div class="card__head"><h3>Прохождение точек принятия решений</h3>
            <span class="card__hint spacer">Выявляет узкие места конвейера</span></div>
          <div class="card__body">
            ${g1.gate_passage.length ? g1.gate_passage.map((g) => html`
              <div style="margin-bottom:14px">
                <div class="row fs-13 fw-600" style="margin-bottom:5px">
                  <span>Gate ${g.gate_no} — ${esc(state.stages.find((s) => s.gate_no === g.gate_no)?.stage_name || '')}</span>
                  <span class="spacer text-3 fs-12">${g.total} ${plural(g.total, 'решение', 'решения', 'решений')}</span>
                </div>
                <div class="bar-row__track" style="height:16px">
                  ${[['go', g.go, 'var(--ok)'], ['redirect', g.redirect, 'var(--purple)'],
                     ['hold', g.hold, 'var(--warn)'], ['kill', g.kill, 'var(--danger)']]
                    .filter(([, v]) => v > 0)
                    .map(([k, v, c]) => `<div class="bar-row__fill" style="width:${(v / g.total) * 100}%;background:${c}" title="${k}: ${v}"></div>`)}
                </div>
              </div>`).join('') : '<div class="empty"><p>Решений на Gate пока не принималось</p></div>'}
            <div class="row fs-12 text-3" style="gap:14px;margin-top:4px;flex-wrap:wrap">
              ${[['Go', 'var(--ok)'], ['Redirect', 'var(--purple)'], ['Hold', 'var(--warn)'], ['Kill', 'var(--danger)']]
                .map(([l, c]) => `<span class="row" style="gap:5px"><i style="width:9px;height:9px;border-radius:2px;background:${c};display:inline-block"></i>${l}</span>`)}
            </div>
          </div>
        </div>

        <div data-ac="US-ANL-004/AC2" class="card">
          <div class="card__head"><h3>Инициативы по направлениям</h3></div>
          <div class="card__body">
            ${o.by_category.length ? barList(o.by_category.map((c) => ({
              label: c.name, value: c.total, display: `${c.total}${c.scaled ? ` (${c.scaled}★)` : ''}`,
            }))) : '<div class="empty"><p>Нет данных</p></div>'}
            <p class="fs-12 text-3" style="margin-top:10px">★ — число масштабированных инициатив направления</p>
          </div>
        </div>

        <div data-ac="US-ANL-001/AC6" class="card">
          <div class="card__head"><h3>Валоризация эффекта</h3>
            <span class="card__hint spacer">Измеренный эффект внедрённых решений</span></div>
          <div class="card__body">
            ${g1.valorisation.length ? html`
              <table class="table">
                <thead><tr><th>Тип эффекта</th><th class="num">Значение</th><th>Единица</th><th class="num">Инициатив</th></tr></thead>
                <tbody>${g1.valorisation.map((v) => html`
                  <tr>
                    <td>${esc({ time: 'Экономия времени', cost: 'Снижение затрат', quality: 'Качество услуги',
                                satisfaction: 'Удовлетворённость', other: 'Иное' }[v.effect_type] || v.effect_type || '—')}</td>
                    <td class="num fw-600">${num(v.total, 1)}</td>
                    <td class="fs-12 text-3">${esc(v.effect_unit || '—')}</td>
                    <td class="num">${v.n}</td>
                  </tr>`)}
                </tbody>
              </table>` : html`<div class="empty" style="padding:30px">
                <p>Эффект будет рассчитан после первых масштабирований — на основе данных,
                   собранных во время пилотирования.</p></div>`}
          </div>
        </div>
      </div>
    </section>

    <!-- ГРУППА 2 -->
    <section data-panel="g2" hidden>
      <div data-ac="US-ANL-002/AC1 US-ANL-002/AC3 US-ANL-002/AC4" class="grid grid--kpi" style="margin-bottom:16px">
        ${kpi('Полный цикл (медиана)', g2.cycle_median_days ?? '—', { unit: 'дн.',
          meta: 'От подачи инициативы до решения о масштабировании' })}
        ${kpi('Полный цикл (среднее)', g2.cycle_avg_days ?? '—', { unit: 'дн.',
          meta: g2.cycle_samples ? `по ${g2.cycle_samples} завершённым циклам` : 'нет завершённых циклов' })}
        ${kpi('Время до первого решения', g2.ttfd_median_hours ? Math.round(g2.ttfd_median_hours / 24 * 10) / 10 : '—',
          { unit: 'дн.', meta: 'Медиана. Влияет на мотивацию авторов инициатив' })}
        ${kpi('Соблюдение SLA', g2.sla_compliance_overall ?? '—', { unit: '%', bar: g2.sla_compliance_overall,
          tone: g2.sla_compliance_overall >= 80 ? 'ok' : g2.sla_compliance_overall >= 60 ? 'warn' : 'danger',
          meta: 'Доля решений, принятых в установленный срок' })}
        ${kpi('Успешность пилотирования', g2.pilot_success_rate ?? '—', { unit: '%',
          tone: 'ok', bar: g2.pilot_success_rate,
          meta: `Go на Gate 4 (${g2.pilot_go_g4}) к прошедшим Gate 3 (${g2.pilot_passed_g3})` })}
      </div>

      <div class="card" data-ac="US-ANL-002/AC2">
        <div class="card__head"><h3>Время прохождения этапов и соблюдение SLA</h3>
          <span class="card__hint spacer">Сравнение фактического времени со стандартом обслуживания</span></div>
        <div class="table-wrap">
          <table class="table">
            <thead><tr>
              <th>Этап</th><th>Точка решения</th><th>Стандарт (SLA)</th>
              <th class="num">Решений</th><th class="num">Факт (среднее)</th><th class="num">Медиана</th><th style="width:150px">Соблюдение SLA</th>
            </tr></thead>
            <tbody>
              ${g2.per_stage.map((s) => html`
                <tr>
                  <td><b>Этап ${s.tz_stage}.</b> ${esc(s.stage_name)}</td>
                  <td class="nowrap">Gate ${s.gate_no}</td>
                  <td class="fs-12 text-3">${esc(s.sla_text || '—')}</td>
                  <td class="num">${s.decisions}</td>
                  <td class="num">${fmtHours(s.avg_hours)}</td>
                  <td class="num">${fmtHours(s.median_hours)}</td>
                  <td>
                    ${s.sla_compliance !== null ? html`
                      <div class="row" style="gap:8px">
                        <div class="progress ${s.sla_compliance >= 80 ? 'progress--ok' : s.sla_compliance >= 60 ? 'progress--warn' : 'progress--danger'}"
                             style="flex:1"><i style="width:${s.sla_compliance}%"></i></div>
                        <b class="fs-12">${s.sla_compliance}%</b>
                      </div>` : '<span class="text-3">—</span>'}
                  </td>
                </tr>`)}
            </tbody>
          </table>
        </div>
      </div>
    </section>

    <!-- ГРУППА 3 -->
    <section data-panel="g3" hidden>
      <div data-ac="US-ANL-003/AC2" class="grid grid--kpi" style="margin-bottom:16px">
        ${kpi('Решений Kill', g3.kill_total, {
          meta: 'Не негативный показатель: система отсеивает нежизнеспособные проекты и экономит ресурсы' })}
        ${kpi('Решений Redirect', g3.redirect_total, { meta: 'Как часто инициативы требуют доработки' })}
        ${kpi('Решений Hold', g3.hold_total, { meta: 'Требуется дополнительная информация или ресурсы' })}
        ${kpi('Риск «заморозки»', g3.freeze_risk_rate, { unit: '%', bar: g3.freeze_risk_rate,
          tone: g3.freeze_risk_rate > 25 ? 'danger' : g3.freeze_risk_rate > 10 ? 'warn' : 'ok',
          meta: `${g3.frozen_count} из ${g3.active_count} активных застряли дольше SLA` })}
      </div>

      <div class="grid grid--2" style="align-items:start">
        <div class="card" data-ac="US-ANL-003/AC1">
          <div class="card__head"><h3>Структура решений на Gate</h3></div>
          <div class="card__body">
            <div class="row" style="gap:22px;align-items:center;flex-wrap:wrap">
              ${donut([
                { label: 'Go', value: g3.go_total, color: 'var(--ok)' },
                { label: 'Redirect', value: g3.redirect_total, color: 'var(--purple)' },
                { label: 'Hold', value: g3.hold_total, color: 'var(--warn)' },
                { label: 'Kill', value: g3.kill_total, color: 'var(--danger)' },
              ], { center: { value: g3.go_total + g3.redirect_total + g3.hold_total + g3.kill_total, label: 'решений' } })}
              <div style="flex:1;min-width:160px">
                ${[['Go — продолжить', g3.go_total, 'var(--ok)'], ['Redirect — доработка', g3.redirect_total, 'var(--purple)'],
                   ['Hold — приостановка', g3.hold_total, 'var(--warn)'], ['Kill — остановка', g3.kill_total, 'var(--danger)']]
                  .map(([l, v, c]) => html`
                  <div class="row fs-13" style="justify-content:space-between;padding:3px 0">
                    <span class="row" style="gap:7px"><i style="width:9px;height:9px;border-radius:2px;background:${c};display:inline-block"></i>${esc(l)}</span>
                    <b>${num(v)}</b>
                  </div>`)}
              </div>
            </div>
          </div>
        </div>

        <div data-ac="US-ANL-003/AC3" class="card">
          <div class="card__head"><h3>На каком этапе останавливаются инициативы</h3></div>
          <div class="card__body">
            ${g3.kill_by_stage.length ? barList(g3.kill_by_stage.map((k) => ({
              label: `Этап ${state.stages.find((s) => s.stage_no === k.stage_no)?.tz_stage || k.stage_no}. ` +
                     (state.stages.find((s) => s.stage_no === k.stage_no)?.stage_name || ''),
              value: k.n, color: 'var(--danger)',
            }))) : '<div class="empty"><p>Остановленных инициатив нет</p></div>'}
            <p class="fs-12 text-3" style="margin-top:12px">Если большинство инициатив останавливается
              на одном Gate, это указывает на нехватку экспертизы или ресурсов на этом этапе.</p>
          </div>
        </div>
      </div>
    </section>

    <!-- УЧРЕЖДЕНИЯ -->
    ${institutions.length ? html`
    <section data-panel="inst" hidden>
      <div class="card" data-ac="US-ANL-004/AC3">
        <div class="card__head"><h3>Сравнение учреждений</h3>
          <span class="card__hint spacer">Активность, вовлечённость и результативность</span></div>
        <div class="table-wrap">
          <table class="table">
            <thead><tr>
              <th>Учреждение</th><th>Округ</th><th class="num">Штат</th><th class="num">Инициатив</th>
              <th class="num">Авторов</th><th class="num">Вовлечённость</th><th class="num">Внедрено</th>
              <th class="num">Пилотов</th><th class="num">SLA</th>
            </tr></thead>
            <tbody>
              ${institutions.map((i) => html`
                <tr>
                  <td><b>${esc(i.short_name)}</b>${i.is_pilot_site ? ' <span class="badge badge--purple">пилотная площадка</span>' : ''}</td>
                  <td class="fs-12 text-3">${esc(i.district || '—')}</td>
                  <td class="num">${num(i.staff_count)}</td>
                  <td class="num fw-600">${num(i.initiatives)}</td>
                  <td class="num">${num(i.authors)}</td>
                  <td class="num">${num(i.engagement, 1)}%</td>
                  <td class="num">${num(i.scaled)}</td>
                  <td class="num">${num(i.pilots)}</td>
                  <td class="num">${i.sla_rate === null ? '—' : i.sla_rate + '%'}</td>
                </tr>`)}
            </tbody>
          </table>
        </div>
      </div>
    </section>` : ''}

    <!-- УЧАСТНИКИ -->
    <section data-panel="people" hidden>
      <div data-ac="US-ANL-001/AC7" class="card">
        <div class="card__head"><h3>Вклад участников</h3>
          <span class="card__hint spacer">Публичное признание — часть системы мотивации</span></div>
        <div class="card__body--flush">
          ${contributors.length ? html`<div class="list">
            ${contributors.map((c, idx) => html`
              <div class="list__item is-clickable" data-goto="/profile/${c.id}">
                <div class="fw-600 text-3" style="width:22px;text-align:center;font-size:13px">${idx + 1}</div>
                ${avatar(c.full_name)}
                <div class="list__main">
                  <div class="list__title">${esc(c.full_name)}</div>
                  <div class="list__meta">
                    <span>${esc(c.position || '')}</span>
                    <span>${esc(c.institution || '')}</span>
                  </div>
                </div>
                <div class="row" style="gap:7px">
                  ${c.scaled ? `<span class="badge badge--ok">${c.scaled} внедрено</span>` : ''}
                  ${c.reached_dev ? `<span class="badge badge--info">${c.reached_dev} до разработки</span>` : ''}
                  <span class="badge badge--outline">${c.initiatives} ${plural(c.initiatives, 'инициатива', 'инициативы', 'инициатив')}</span>
                  ${c.awards ? `<span class="badge badge--purple">${c.awards} ★</span>` : ''}
                </div>
              </div>`)}
          </div>` : '<div class="empty"><p>Нет данных</p></div>'}
        </div>
      </div>
    </section>`;

  // Вкладки
  view.querySelectorAll('.tab').forEach((t) => t.onclick = () => {
    view.querySelectorAll('.tab').forEach((x) => x.classList.toggle('is-active', x === t));
    view.querySelectorAll('[data-panel]').forEach((p) => p.hidden = p.dataset.panel !== t.dataset.tab);
  });
  view.querySelector('#scope')?.addEventListener('change', (e) => navigate(`/analytics?scope=${e.target.value}`));
  view.querySelectorAll('[data-goto]').forEach((el) => el.onclick = () => navigate(el.dataset.goto));
}

// ══ Контроль SLA ═════════════════════════════════════════════
export async function slaView(view) {
  const d = await api.get('/api/admin/sla');
  view.innerHTML = html`
    <div class="page-head">
      <div class="page-head__row">
        <div style="flex:1;min-width:250px">
          <h2>Контроль SLA</h2>
          <p>Таймеры сроков — неотъемлемая часть каждого этапа. Система предупреждает о риске
             превышения лимита и автоматически эскалирует задачу, если решение не принято вовремя.</p>
        </div>
        ${can('admin') ? '<button class="btn" data-sweep>Запустить проверку и эскалацию</button>' : ''}
      </div>
    </div>

    <div class="grid grid--kpi" style="margin-bottom:16px">
      ${kpi('Просрочено', d.overdue.length, { tone: d.overdue.length ? 'danger' : 'ok',
        meta: 'Решение не принято в установленный срок' })}
      ${kpi('Риск нарушения', d.at_risk.length, { tone: d.at_risk.length ? 'warn' : 'ok',
        meta: 'До истечения срока менее суток' })}
    </div>

    <div data-ac="US-SG-003/AC4 US-SG-003/AC5" class="card" style="margin-bottom:16px">
      <div class="card__head"><h3>Нарушенные сроки</h3>
        ${d.overdue.length ? `<span class="badge badge--danger spacer">${d.overdue.length}</span>` : ''}</div>
      ${d.overdue.length ? html`
      <div class="table-wrap"><table class="table">
        <thead><tr><th>Номер</th><th>Инициатива</th><th>Этап</th><th>Ответственная роль</th>
          <th>Срок</th><th class="num">Просрочка</th></tr></thead>
        <tbody>${d.overdue.map((r) => html`
          <tr class="is-clickable" data-goto="/initiatives/${r.id}">
            <td class="mono nowrap">${esc(r.number)}</td>
            <td class="clamp-2">${esc(r.title)}</td>
            <td class="fs-12">${esc(r.stage_name || '')}</td>
            <td class="fs-12">${esc({ head: 'Руководитель учреждения', expert: 'Эксперт ДТСЗН',
              developer: 'Команда разработки', pilot_coordinator: 'Координатор пилотов', dtszn: 'ДТСЗН' }[r.role_required] || '—')}</td>
            <td class="fs-12 nowrap">${fmtDate(r.sla_due_at)}</td>
            <td class="num"><span class="badge badge--danger">${num(r.days_overdue, 1)} ${plural(Math.round(r.days_overdue), 'день', 'дня', 'дней')}</span></td>
          </tr>`)}
        </tbody>
      </table></div>` : '<div class="empty"><h4>Нарушений нет</h4><p>Все решения принимаются в установленные сроки.</p></div>'}
    </div>

    <div data-ac="US-SG-003/AC3" class="card">
      <div class="card__head"><h3>Риск нарушения — менее суток до срока</h3></div>
      ${d.at_risk.length ? html`
      <div class="table-wrap"><table class="table">
        <thead><tr><th>Номер</th><th>Инициатива</th><th>Этап</th><th>Срок</th><th class="num">Осталось</th></tr></thead>
        <tbody>${d.at_risk.map((r) => html`
          <tr class="is-clickable" data-goto="/initiatives/${r.id}">
            <td class="mono nowrap">${esc(r.number)}</td>
            <td class="clamp-2">${esc(r.title)}</td>
            <td class="fs-12">${esc(r.stage_name || '')}</td>
            <td class="fs-12 nowrap">${fmtDate(r.sla_due_at, true)}</td>
            <td class="num"><span class="badge badge--warn">${r.hours_left} ч</span></td>
          </tr>`)}
        </tbody>
      </table></div>` : '<div class="empty"><p>Инициатив с приближающимся сроком нет</p></div>'}
    </div>`;

  view.querySelectorAll('[data-goto]').forEach((el) => el.onclick = () => navigate(el.dataset.goto));
  view.querySelector('[data-sweep]')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    const { toast } = await import('../core.js');
    try {
      const r = await api.post('/api/admin/sla/sweep');
      toast(`Проверено просроченных: ${r.overdue}. Эскалировано задач: ${r.escalated}`, 'ok');
      slaView(view);
    } catch (err) { toast(err.message, 'error'); e.target.disabled = false; }
  });
}
