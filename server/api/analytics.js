// Модуль аналитики и КПЭ. Реализует три группы показателей из ТЗ:
// 1) процесс, вовлечённость, культура; 2) эффективность и скорость; 3) качество и риски.
import { route, HttpError } from '../http.js';
import { q } from '../db.js';
import { can } from '../auth.js';
import { stages } from '../workflow.js';

const median = (arr) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const round = (n, d = 1) => (n === null || n === undefined ? null : Math.round(n * 10 ** d) / 10 ** d);

function scopeClause(scope, user) {
  if (scope === 'institution') return { sql: ' AND i.institution_id = ?', args: [user.institution_id] };
  if (scope === 'mine') return { sql: ' AND i.author_id = ?', args: [user.id] };
  return { sql: '', args: [] };
}

// ── Группа 1: процесс, вовлечённость, культура ───────────────
function group1(scope, args) {
  const total = q.get(`SELECT COUNT(*) AS c FROM initiatives i WHERE 1=1${scope}`, ...args).c;
  const scaled = q.get(`SELECT COUNT(*) AS c FROM initiatives i WHERE i.status='scaled'${scope}`, ...args).c;

  // Прохождение каждого Gate — выявляет узкие места конвейера
  const gatePassage = q.all(`
    SELECT g.gate_no,
           SUM(CASE WHEN g.decision='go' THEN 1 ELSE 0 END) AS go,
           SUM(CASE WHEN g.decision='kill' THEN 1 ELSE 0 END) AS kill,
           SUM(CASE WHEN g.decision='hold' THEN 1 ELSE 0 END) AS hold,
           SUM(CASE WHEN g.decision='redirect' THEN 1 ELSE 0 END) AS redirect,
           COUNT(*) AS total
    FROM gate_decisions g JOIN initiatives i ON i.id = g.initiative_id
    WHERE 1=1${scope} GROUP BY g.gate_no ORDER BY g.gate_no`, ...args);

  // Вовлечённость: доля сотрудников, подавших хотя бы одну инициативу
  const staffTotal = q.get(`SELECT COALESCE(SUM(staff_count),0) AS c FROM institutions WHERE kind='institution'`).c;
  const authors = q.get(`SELECT COUNT(DISTINCT i.author_id) AS c FROM initiatives i WHERE 1=1${scope}`, ...args).c;
  const activeUsers = q.get(`SELECT COUNT(*) AS c FROM users WHERE is_active=1 AND role IN ('employee','head')`).c;

  const pilotParticipants = q.get(`
    SELECT COALESCE(SUM(p.participants_count),0) AS c FROM pilots p
    JOIN initiatives i ON i.id = p.initiative_id WHERE 1=1${scope}`, ...args).c;

  // Масштабирование «снизу» — признак зрелости экосистемы
  const rolloutTotal = q.get(`SELECT COUNT(*) AS c FROM rollouts r JOIN initiatives i ON i.id=r.initiative_id WHERE 1=1${scope}`, ...args).c;
  const rolloutBottomUp = q.get(`SELECT COUNT(*) AS c FROM rollouts r JOIN initiatives i ON i.id=r.initiative_id WHERE r.bottom_up=1${scope}`, ...args).c;

  // Валоризация: суммарный измеренный эффект внедрённых инициатив
  const valorisation = q.all(`
    SELECT i.effect_type, i.effect_unit, SUM(i.effect_value) AS total, COUNT(*) AS n
    FROM initiatives i WHERE i.status='scaled' AND i.effect_value IS NOT NULL${scope}
    GROUP BY i.effect_type, i.effect_unit`, ...args);

  // Голосование как канал вовлечённости: участвовать может каждый, не только автор
  // Голосовать может любой участник экосистемы, а не только сотрудник учреждения
  const allActive = q.get('SELECT COUNT(*) AS c FROM users WHERE is_active=1').c;
  const voters = q.get(`SELECT COUNT(DISTINCT v.user_id) AS c FROM votes v
                        JOIN initiatives i ON i.id = v.initiative_id WHERE 1=1${scope}`, ...args).c;
  const votesTotal = q.get(`SELECT COUNT(*) AS c FROM votes v
                            JOIN initiatives i ON i.id = v.initiative_id WHERE 1=1${scope}`, ...args).c;
  const topVoted = q.all(`SELECT i.id, i.number, i.title, i.stage, i.status,
                                 COALESCE(SUM(v.value),0) AS score, COUNT(v.id) AS votes
                          FROM initiatives i JOIN votes v ON v.initiative_id = i.id
                          WHERE 1=1${scope} GROUP BY i.id ORDER BY score DESC LIMIT 5`, ...args);

  return {
    total_initiatives: total,
    scaled_initiatives: scaled,
    voters_count: voters,
    votes_total: votesTotal,
    voting_engagement: allActive ? round((voters / allActive) * 100) : 0,
    potential_voters: allActive,
    top_voted: topVoted,
    gate_passage: gatePassage,
    engagement_rate: activeUsers ? round((authors / activeUsers) * 100) : 0,
    authors_count: authors,
    potential_authors: activeUsers,
    staff_total: staffTotal,
    pilot_participants: pilotParticipants,
    bottom_up_share: rolloutTotal ? round((rolloutBottomUp / rolloutTotal) * 100) : 0,
    rollouts_total: rolloutTotal,
    valorisation,
  };
}

// ── Группа 2: эффективность и скорость ───────────────────────
function group2(scope, args) {
  // Полный цикл «проблема → масштабирование»
  const cycles = q.all(`
    SELECT (julianday(i.scaled_at) - julianday(i.created_at)) AS days
    FROM initiatives i WHERE i.status='scaled' AND i.scaled_at IS NOT NULL${scope}`, ...args)
    .map((r) => r.days).filter((d) => d !== null);

  // Время до первого решения
  const ttfd = q.all(`
    SELECT (julianday(i.first_decision_at) - julianday(i.created_at)) * 24 AS hours
    FROM initiatives i WHERE i.first_decision_at IS NOT NULL${scope}`, ...args)
    .map((r) => r.hours).filter((h) => h !== null);

  // Фактическое время на каждом этапе и соблюдение SLA
  const perStage = stages().map((s) => {
    const rows = q.all(`
      SELECT g.duration_hours, g.sla_met FROM gate_decisions g
      JOIN initiatives i ON i.id = g.initiative_id
      WHERE g.stage_no = ?${scope}`, s.stage_no, ...args);
    const durations = rows.map((r) => r.duration_hours).filter((d) => d !== null);
    const withSla = rows.filter((r) => r.sla_met !== null);
    return {
      stage_no: s.stage_no,
      stage_name: s.stage_name,
      tz_stage: s.tz_stage,
      gate_no: s.gate_no,
      sla_text: s.sla_text,
      decisions: rows.length,
      avg_hours: round(durations.reduce((a, b) => a + b, 0) / (durations.length || 1)),
      avg_days: round((durations.reduce((a, b) => a + b, 0) / (durations.length || 1)) / 24),
      median_hours: round(median(durations)),
      sla_compliance: withSla.length ? round((withSla.filter((r) => r.sla_met === 1).length / withSla.length) * 100) : null,
    };
  }).filter((s) => s.gate_no);

  // Коэффициент успешности пилотирования: Go на Gate 4 / прошедшие Gate 3
  const passedG3 = q.get(`SELECT COUNT(DISTINCT g.initiative_id) AS c FROM gate_decisions g
                          JOIN initiatives i ON i.id=g.initiative_id
                          WHERE g.gate_no=3 AND g.decision='go'${scope}`, ...args).c;
  const goG4 = q.get(`SELECT COUNT(DISTINCT g.initiative_id) AS c FROM gate_decisions g
                      JOIN initiatives i ON i.id=g.initiative_id
                      WHERE g.gate_no=4 AND g.decision='go'${scope}`, ...args).c;

  const allSla = q.all(`SELECT g.sla_met FROM gate_decisions g JOIN initiatives i ON i.id=g.initiative_id
                        WHERE g.sla_met IS NOT NULL${scope}`, ...args);

  return {
    cycle_avg_days: round(cycles.reduce((a, b) => a + b, 0) / (cycles.length || 1)),
    cycle_median_days: round(median(cycles)),
    cycle_samples: cycles.length,
    ttfd_avg_hours: round(ttfd.reduce((a, b) => a + b, 0) / (ttfd.length || 1)),
    ttfd_median_hours: round(median(ttfd)),
    per_stage: perStage,
    pilot_success_rate: passedG3 ? round((goG4 / passedG3) * 100) : null,
    pilot_passed_g3: passedG3,
    pilot_go_g4: goG4,
    sla_compliance_overall: allSla.length ? round((allSla.filter((r) => r.sla_met === 1).length / allSla.length) * 100) : null,
  };
}

// ── Группа 3: качество и риски ───────────────────────────────
function group3(scope, args) {
  const byDecision = q.all(`
    SELECT g.decision, COUNT(*) AS n FROM gate_decisions g JOIN initiatives i ON i.id=g.initiative_id
    WHERE 1=1${scope} GROUP BY g.decision`, ...args);
  const killByStage = q.all(`
    SELECT g.stage_no, COUNT(*) AS n FROM gate_decisions g JOIN initiatives i ON i.id=g.initiative_id
    WHERE g.decision='kill'${scope} GROUP BY g.stage_no ORDER BY g.stage_no`, ...args);

  const active = q.get(`SELECT COUNT(*) AS c FROM initiatives i WHERE i.status='active'${scope}`, ...args).c;
  const frozen = q.get(`SELECT COUNT(*) AS c FROM initiatives i
                        WHERE i.status='active' AND i.sla_due_at IS NOT NULL
                        AND i.sla_due_at < datetime('now')${scope}`, ...args).c;
  const onHold = q.get(`SELECT COUNT(*) AS c FROM initiatives i WHERE i.status='hold'${scope}`, ...args).c;

  const map = Object.fromEntries(byDecision.map((r) => [r.decision, r.n]));
  return {
    kill_total: map.kill || 0,
    redirect_total: map.redirect || 0,
    hold_total: map.hold || 0,
    go_total: map.go || 0,
    kill_by_stage: killByStage,
    freeze_risk_rate: active ? round((frozen / active) * 100) : 0,
    frozen_count: frozen,
    active_count: active,
    on_hold_count: onHold,
  };
}

// ── Сводный дашборд ──────────────────────────────────────────
route.get('/api/analytics/overview', async ({ user, url, sendJson }) => {
  let scopeKey = url.searchParams.get('scope') || 'all';
  if (scopeKey === 'all' && !can(user, 'analytics.all')) {
    scopeKey = can(user, 'analytics.institution') ? 'institution' : 'mine';
  }
  const { sql, args } = scopeClause(scopeKey, user);

  const funnel = stages().map((s) => ({
    stage_no: s.stage_no,
    stage_name: s.stage_name,
    tz_stage: s.tz_stage,
    gate_name: s.gate_name,
    current: q.get(`SELECT COUNT(*) AS c FROM initiatives i WHERE i.stage=? AND i.status IN ('active','hold')${sql}`, s.stage_no, ...args).c,
    ever_reached: q.get(`SELECT COUNT(DISTINCT t.initiative_id) AS c FROM stage_transitions t
                         JOIN initiatives i ON i.id=t.initiative_id WHERE t.to_stage >= ?${sql}`, s.stage_no, ...args).c,
  }));

  const monthly = q.all(`
    SELECT strftime('%Y-%m', i.created_at) AS month, COUNT(*) AS created,
           SUM(CASE WHEN i.status='scaled' THEN 1 ELSE 0 END) AS scaled
    FROM initiatives i WHERE 1=1${sql}
    GROUP BY month ORDER BY month`, ...args);

  const byCategory = q.all(`
    SELECT i.category AS name, COUNT(*) AS total,
           SUM(CASE WHEN i.status='scaled' THEN 1 ELSE 0 END) AS scaled,
           SUM(CASE WHEN i.status='killed' THEN 1 ELSE 0 END) AS killed
    FROM initiatives i WHERE i.category IS NOT NULL${sql}
    GROUP BY i.category ORDER BY total DESC`, ...args);

  sendJson(200, {
    scope: scopeKey,
    group1: group1(sql, args),
    group2: group2(sql, args),
    group3: group3(sql, args),
    funnel, monthly, by_category: byCategory,
  });
});

// ── Сравнение учреждений (для ДТСЗН) ─────────────────────────
route.get('/api/analytics/institutions', async ({ user, sendJson }) => {
  if (!can(user, 'analytics.all') && !can(user, 'analytics.institution')) throw new HttpError(403, 'Недостаточно прав');
  sendJson(200, q.all(`
    SELECT inst.id, inst.name, inst.short_name, inst.district, inst.staff_count, inst.is_pilot_site,
      (SELECT COUNT(*) FROM initiatives i WHERE i.institution_id = inst.id) AS initiatives,
      (SELECT COUNT(*) FROM initiatives i WHERE i.institution_id = inst.id AND i.status='scaled') AS scaled,
      (SELECT COUNT(*) FROM initiatives i WHERE i.institution_id = inst.id AND i.status='active') AS active,
      (SELECT COUNT(DISTINCT i.author_id) FROM initiatives i WHERE i.institution_id = inst.id) AS authors,
      (SELECT COUNT(*) FROM pilots p WHERE p.institution_id = inst.id) AS pilots,
      (SELECT COUNT(*) FROM rollouts r WHERE r.institution_id = inst.id AND r.status='deployed') AS adopted,
      (SELECT AVG(g.sla_met) FROM gate_decisions g JOIN initiatives i ON i.id=g.initiative_id
         WHERE i.institution_id = inst.id AND g.sla_met IS NOT NULL) AS sla_rate
    FROM institutions inst WHERE inst.kind='institution'
    ORDER BY initiatives DESC`).map((r) => ({
      ...r,
      sla_rate: r.sla_rate === null ? null : Math.round(r.sla_rate * 100),
      engagement: r.staff_count ? Math.round((r.authors / r.staff_count) * 1000) / 10 : 0,
    })));
});

// ── Рейтинг участников (мотивация и признание) ───────────────
route.get('/api/analytics/contributors', async ({ sendJson }) => {
  sendJson(200, q.all(`
    SELECT u.id, u.full_name, u.role, u.position, inst.short_name AS institution,
      COUNT(i.id) AS initiatives,
      SUM(CASE WHEN i.status='scaled' THEN 1 ELSE 0 END) AS scaled,
      SUM(CASE WHEN i.stage >= 4 THEN 1 ELSE 0 END) AS reached_dev,
      (SELECT COUNT(*) FROM awards a WHERE a.user_id = u.id) AS awards
    FROM users u LEFT JOIN initiatives i ON i.author_id = u.id
    LEFT JOIN institutions inst ON inst.id = u.institution_id
    GROUP BY u.id HAVING initiatives > 0
    ORDER BY scaled DESC, reached_dev DESC, initiatives DESC LIMIT 20`));
});

// ── Экспорт отчёта (CSV) ─────────────────────────────────────
route.get('/api/analytics/export', async ({ user, url, res }) => {
  if (!can(user, 'analytics.all') && !can(user, 'analytics.institution')) throw new HttpError(403, 'Недостаточно прав');
  const rows = q.all(`
    SELECT i.number, i.title, i.category, i.stage, i.status, inst.short_name AS institution,
           u.full_name AS author, i.created_at, i.scaled_at, i.effect_value, i.effect_unit,
           (julianday(COALESCE(i.scaled_at, 'now')) - julianday(i.created_at)) AS days_in_system
    FROM initiatives i JOIN users u ON u.id=i.author_id JOIN institutions inst ON inst.id=i.institution_id
    ORDER BY i.created_at DESC`);
  const head = ['Номер', 'Название', 'Направление', 'Этап', 'Статус', 'Учреждение', 'Автор', 'Создана', 'Масштабирована', 'Эффект', 'Ед.изм.', 'Дней в системе'];
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = '﻿' + [head.join(';'), ...rows.map((r) => Object.values(r).map(esc).join(';'))].join('\n');
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="social1-initiatives-${new Date().toISOString().slice(0, 10)}.csv"`,
  });
  res.end(csv);
});
