// Движок бизнес-процессов Stage-Gate: маршруты, SLA, задачи, эскалация.
// Конфигурация этапов и Gate хранится в БД и меняется без правки кода.
import { q, tx } from './db.js';
import { logAction } from './audit.js';

export const DECISIONS = {
  go:       { title: 'Go — продолжить',        tone: 'ok' },
  kill:     { title: 'Kill — остановить',      tone: 'stop' },
  hold:     { title: 'Hold — приостановить',   tone: 'wait' },
  redirect: { title: 'Redirect — перенаправить',tone: 'back' },
};

// Конфигурация конвейера по ТЗ. Записывается при первом запуске, далее правится администратором.
export const DEFAULT_WORKFLOW = [
  {
    stage_no: 1, tz_stage: 1,
    tz_stage_name: 'Фиксация проблемы и формулирование инициативы',
    stage_name: 'Фиксация проблемы',
    description: 'Сотрудник заполняет стандартизированную форму: проблема, предлагаемое решение, прогнозируемый эффект, вспомогательные материалы.',
    trigger_text: 'Сотрудник учреждения обнаруживает проблему в существующем процессе или услуге.',
    participants: ['employee'],
    gate_no: null, gate_name: null, role_required: null,
    sla_value: null, sla_unit: null,
    sla_text: 'Точка принятия решения отсутствует — инициатива переходит на следующий этап автоматически.',
    criteria: [], decisions: [],
  },
  {
    stage_no: 2, tz_stage: 2,
    tz_stage_name: 'Оценка и экспертиза инициативы',
    stage_name: 'Оценка руководителем учреждения',
    description: 'Руководитель учреждения оценивает инициативу на соответствие внутренним регламентам, бюджетным ограничениям и потенциал локального улучшения.',
    trigger_text: 'Инициатива успешно создана и отправлена на платформе.',
    participants: ['head'],
    gate_no: 1, gate_name: 'Gate 1 — Решение руководителя учреждения', role_required: 'head',
    sla_value: 3, sla_unit: 'workdays',
    sla_text: 'Руководитель учреждения принимает решение в течение 3 рабочих дней.',
    criteria: [
      'Соответствие внутренним политикам и регламентам',
      'Наличие потенциала для локального улучшения',
      'Реалистичность в рамках бюджетных ограничений',
    ],
    decisions: ['go', 'kill', 'hold', 'redirect'],
  },
  {
    stage_no: 3, tz_stage: 2,
    tz_stage_name: 'Оценка и экспертиза инициативы',
    stage_name: 'Экспертиза ДТСЗН',
    description: 'Комитет экспертов ДТСЗН проводит глубокую оценку стратегической значимости, масштабируемости и рисков.',
    trigger_text: 'Положительное решение Gate 1.',
    participants: ['expert', 'dtszn'],
    gate_no: 2, gate_name: 'Gate 2 — Вердикт комитета экспертов ДТСЗН', role_required: 'expert',
    sla_value: 5, sla_unit: 'workdays',
    sla_text: 'Эксперты ДТСЗН выносят вердикт в течение 5 рабочих дней с момента получения инициативы.',
    criteria: [
      'Стратегическая совместимость с целями Департамента',
      'Потенциал для масштабирования',
      'Ожидаемый эффект',
      'Техническая осуществимость на уровне идеи',
    ],
    decisions: ['go', 'kill', 'hold', 'redirect'],
  },
  {
    stage_no: 4, tz_stage: 3,
    tz_stage_name: 'Разработка прототипа',
    stage_name: 'Разработка прототипа (MVP)',
    description: 'Команда разработки создаёт минимально жизнеспособный продукт по Agile: спринты, доска задач, техническая документация.',
    trigger_text: 'Положительное решение Gate 2 («Принять»).',
    participants: ['developer', 'supplier'],
    gate_no: 3, gate_name: 'Gate 3 — Готовность прототипа к пилоту', role_required: 'developer',
    sla_value: 56, sla_unit: 'calendardays',
    sla_text: 'План разработки: 4 спринта по 2 недели. Приоритеты каждого спринта утверждает продакт-менеджер ДТСЗН.',
    criteria: [
      'Достигнутые цели спринтов',
      'Наличие рабочего MVP',
      'Положительная обратная связь на промежуточных демонстрациях',
    ],
    decisions: ['go', 'kill', 'redirect'],
  },
  {
    stage_no: 5, tz_stage: 4,
    tz_stage_name: 'Пилотирование и сбор обратной связи',
    stage_name: 'Пилотирование',
    description: 'Пилотное учреждение внедряет прототип в реальную работу. Собирается обратная связь от сотрудников и граждан, отслеживаются KPI пилота.',
    trigger_text: 'Готовность прототипа.',
    participants: ['pilot_coordinator', 'head', 'employee', 'developer'],
    gate_no: 4, gate_name: 'Gate 4 — Результаты пилотирования', role_required: 'pilot_coordinator',
    sla_value: 37, sla_unit: 'calendardays',
    sla_text: 'Срок пилота — 1 месяц. Сбор и анализ обратной связи завершается в течение 1 недели после окончания пилота.',
    criteria: [
      'Доказанность заявленного эффекта',
      'Высокий уровень удовлетворённости пользователей',
      'Отсутствие критических технических и организационных проблем',
      'Соответствие требованиям безопасности и конфиденциальности',
    ],
    decisions: ['go', 'kill', 'redirect'],
  },
  {
    stage_no: 6, tz_stage: 5,
    tz_stage_name: 'Масштабирование',
    stage_name: 'Масштабирование',
    description: 'Центральный аппарат ДТСЗН распространяет решение: методические материалы, обучение сотрудников других учреждений, мониторинг внедрения.',
    trigger_text: 'Успешное завершение пилотирования и положительное решение Gate 4.',
    participants: ['dtszn', 'head', 'developer', 'supplier'],
    gate_no: 5, gate_name: 'Gate 5 — Решение о масштабировании', role_required: 'dtszn',
    sla_value: 14, sla_unit: 'calendardays',
    sla_text: 'Начало масштабирования — в течение 2 недель после принятия решения.',
    criteria: [
      'Подтверждённый положительный эффект пилота',
      'Готовность других учреждений к внедрению',
      'Наличие ресурсов для масштабирования',
    ],
    decisions: ['go', 'kill'],
  },
];

export function ensureWorkflow() {
  const count = q.get('SELECT COUNT(*) AS c FROM workflow_config').c;
  if (count > 0) return;
  for (const s of DEFAULT_WORKFLOW) {
    q.run(`INSERT INTO workflow_config
      (stage_no, stage_name, tz_stage, tz_stage_name, description, trigger_text, participants,
       gate_no, gate_name, role_required, sla_value, sla_unit, sla_text, criteria, decisions)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      s.stage_no, s.stage_name, s.tz_stage, s.tz_stage_name, s.description, s.trigger_text,
      JSON.stringify(s.participants), s.gate_no, s.gate_name, s.role_required,
      s.sla_value, s.sla_unit, s.sla_text, JSON.stringify(s.criteria), JSON.stringify(s.decisions));
  }
}

export function stages() {
  return q.all('SELECT * FROM workflow_config ORDER BY stage_no').map((s) => ({
    ...s,
    participants: JSON.parse(s.participants || '[]'),
    criteria: JSON.parse(s.criteria || '[]'),
    decisions: JSON.parse(s.decisions || '[]'),
  }));
}

export function stageConfig(n) {
  return stages().find((s) => s.stage_no === n) || null;
}

export const LAST_STAGE = 6;

// ── Расчёт SLA ───────────────────────────────────────────────
const iso = (d) => d.toISOString().slice(0, 19).replace('T', ' ');

export function addWorkdays(from, days) {
  const d = new Date(from);
  let left = days;
  while (left > 0) {
    d.setDate(d.getDate() + 1);
    const wd = d.getDay();
    if (wd !== 0 && wd !== 6) left -= 1;
  }
  return d;
}

export function dueDate(fromISO, value, unit) {
  if (!value || !unit) return null;
  const from = new Date((fromISO || iso(new Date())).replace(' ', 'T') + 'Z');
  const d = unit === 'workdays' ? addWorkdays(from, value) : new Date(from.getTime() + value * 864e5);
  return iso(d);
}

export function slaState(initiative) {
  if (!initiative.sla_due_at || initiative.status !== 'active') return { code: 'none', label: '—' };
  const due = new Date(initiative.sla_due_at.replace(' ', 'T') + 'Z').getTime();
  const now = Date.now();
  const hoursLeft = (due - now) / 36e5;
  if (hoursLeft < 0) return { code: 'breached', label: 'SLA нарушен', hoursLeft };
  if (hoursLeft < 24) return { code: 'risk', label: 'Риск нарушения SLA', hoursLeft };
  return { code: 'ok', label: 'В рамках SLA', hoursLeft };
}

// ── Задачи и уведомления ─────────────────────────────────────
export function notify(userId, initiativeId, type, title, body) {
  if (!userId) return;
  q.run('INSERT INTO notifications (user_id, initiative_id, type, title, body) VALUES (?,?,?,?,?)',
    userId, initiativeId ?? null, type, title, body ?? null);
}

export function notifyRole(role, institutionId, initiativeId, type, title, body) {
  const users = institutionId
    ? q.all('SELECT id FROM users WHERE role = ? AND institution_id = ? AND is_active = 1', role, institutionId)
    : q.all('SELECT id FROM users WHERE role = ? AND is_active = 1', role);
  for (const u of users) notify(u.id, initiativeId, type, title, body);
  return users.length;
}

function createGateTask(initiative, cfg) {
  if (!cfg?.gate_no) return;
  // Gate 1 — руководитель того же учреждения; остальные — общая очередь роли
  const scopedToInstitution = cfg.gate_no === 1;
  q.run(`INSERT INTO tasks (user_id, role_target, institution_id, initiative_id, type, title, due_at)
         VALUES (NULL, ?, ?, ?, 'gate', ?, ?)`,
    cfg.role_required, scopedToInstitution ? initiative.institution_id : null,
    initiative.id, `${cfg.gate_name}: ${initiative.title}`, initiative.sla_due_at);

  notifyRole(cfg.role_required, scopedToInstitution ? initiative.institution_id : null,
    initiative.id, 'gate_pending',
    `Требуется решение: ${cfg.gate_name}`,
    `Инициатива ${initiative.number} «${initiative.title}» ожидает вашего решения. Срок: ${cfg.sla_text}`);
}

function closeGateTasks(initiativeId, gateNo) {
  q.run(`UPDATE tasks SET status='done', completed_at=datetime('now')
         WHERE initiative_id = ? AND type='gate' AND status='open'`, initiativeId);
}

// ── Переходы ─────────────────────────────────────────────────
export function enterStage(initiative, toStage, byUser, reason) {
  const cfg = stageConfig(toStage);
  const now = iso(new Date());
  const prevEntered = initiative.stage_entered_at;
  const hoursInStage = prevEntered
    ? (Date.now() - new Date(prevEntered.replace(' ', 'T') + 'Z').getTime()) / 36e5
    : null;

  const due = cfg ? dueDate(now, cfg.sla_value, cfg.sla_unit) : null;
  q.run(`UPDATE initiatives SET stage=?, stage_entered_at=?, sla_due_at=?, updated_at=datetime('now'),
         status = CASE WHEN status='hold' THEN 'active' ELSE status END WHERE id=?`,
    toStage, now, due, initiative.id);
  q.run(`INSERT INTO stage_transitions (initiative_id, from_stage, to_stage, by_user, reason, hours_in_stage)
         VALUES (?,?,?,?,?,?)`,
    initiative.id, initiative.stage, toStage, byUser ?? null, reason ?? null, hoursInStage);

  const fresh = q.get('SELECT * FROM initiatives WHERE id=?', initiative.id);
  createGateTask(fresh, cfg);
  return fresh;
}

/** Подача инициативы: этап 1 не имеет Gate — автоматически переходит на этап 2. */
export function submitInitiative(initiativeId, userId) {
  const init = q.get('SELECT * FROM initiatives WHERE id=?', initiativeId);
  enterStage(init, 2, userId, 'Автоматический переход: этап 1 не содержит точки принятия решения');
  notify(init.author_id, init.id, 'submitted', `Инициатива ${init.number} принята`,
    'Инициатива направлена руководителю вашего учреждения на первичную оценку.');
  return q.get('SELECT * FROM initiatives WHERE id=?', initiativeId);
}

/** Проверка права принимать решение на текущем Gate. */
export function canDecide(user, initiative) {
  const cfg = stageConfig(initiative.stage);
  if (!cfg?.gate_no) return { ok: false, reason: 'На текущем этапе нет точки принятия решения' };
  if (initiative.status === 'killed') return { ok: false, reason: 'Инициатива остановлена' };
  if (initiative.status === 'scaled') return { ok: false, reason: 'Цикл завершён — инициатива масштабирована' };
  if (initiative.status === 'hold') return { ok: false, reason: 'Инициатива приостановлена — требуется возобновление' };
  if (user.role === 'dtszn') return { ok: true, cfg };          // координатор экосистемы
  if (user.role !== cfg.role_required) return { ok: false, reason: `Решение принимает роль «${cfg.role_required}»` };
  if (cfg.gate_no === 1 && user.institution_id !== initiative.institution_id) {
    return { ok: false, reason: 'Gate 1 принимает руководитель учреждения-автора' };
  }
  return { ok: true, cfg };
}

/**
 * Решение на Gate. Фиксируется с аргументацией, соблюдением SLA и записью в аудит.
 * go — следующий этап (или завершение цикла), kill — остановка,
 * hold — приостановка, redirect — возврат на доработку.
 */
export function decideGate({ user, initiativeId, decision, rationale, criteriaScores, redirectTo, ip }) {
  return tx(() => {
    const init = q.get('SELECT * FROM initiatives WHERE id=?', initiativeId);
    if (!init) throw Object.assign(new Error('Инициатива не найдена'), { status: 404 });
    const check = canDecide(user, init);
    if (!check.ok) throw Object.assign(new Error(check.reason), { status: 403 });
    const cfg = check.cfg;
    if (!cfg.decisions.includes(decision)) {
      throw Object.assign(new Error(`Решение «${decision}» недопустимо на ${cfg.gate_name}`), { status: 400 });
    }
    if (!rationale || rationale.trim().length < 10) {
      throw Object.assign(new Error('Аргументация обязательна (не менее 10 символов) — решения на Gate документируются'), { status: 400 });
    }

    const enteredMs = new Date(init.stage_entered_at.replace(' ', 'T') + 'Z').getTime();
    const durationHours = (Date.now() - enteredMs) / 36e5;
    const slaMet = init.sla_due_at ? (Date.now() <= new Date(init.sla_due_at.replace(' ', 'T') + 'Z').getTime() ? 1 : 0) : null;

    q.run(`INSERT INTO gate_decisions
      (initiative_id, gate_no, stage_no, decision, rationale, criteria_scores, decided_by, sla_due_at, sla_met, duration_hours)
      VALUES (?,?,?,?,?,?,?,?,?,?)`,
      init.id, cfg.gate_no, cfg.stage_no, decision, rationale.trim(),
      JSON.stringify(criteriaScores || {}), user.id, init.sla_due_at, slaMet, durationHours);

    closeGateTasks(init.id, cfg.gate_no);
    if (!init.first_decision_at) {
      q.run("UPDATE initiatives SET first_decision_at = datetime('now') WHERE id=?", init.id);
    }

    let result;
    if (decision === 'go') {
      if (cfg.stage_no === LAST_STAGE) {
        q.run(`UPDATE initiatives SET status='scaled', scaled_at=datetime('now'), closed_at=datetime('now'),
               sla_due_at=NULL, updated_at=datetime('now') WHERE id=?`, init.id);
        q.run(`INSERT INTO stage_transitions (initiative_id, from_stage, to_stage, by_user, reason)
               VALUES (?,?,?,?,?)`, init.id, cfg.stage_no, LAST_STAGE, user.id, 'Масштабирование утверждено');
        notify(init.author_id, init.id, 'scaled', `Инициатива ${init.number} масштабирована`,
          'Ваша инициатива прошла полный цикл и утверждена к тиражированию в других учреждениях.');
        grantAward(init.author_id, init.id, 'scaled', 'Автор масштабированной инициативы', user.id);
      } else {
        result = enterStage(init, cfg.stage_no + 1, user.id, `Go на ${cfg.gate_name}`);
        notify(init.author_id, init.id, 'gate_go', `Инициатива ${init.number}: решение Go`,
          `${cfg.gate_name}: инициатива переведена на этап «${stageConfig(cfg.stage_no + 1).stage_name}».`);
      }
    } else if (decision === 'kill') {
      q.run(`UPDATE initiatives SET status='killed', closed_at=datetime('now'), sla_due_at=NULL,
             updated_at=datetime('now') WHERE id=?`, init.id);
      notify(init.author_id, init.id, 'gate_kill', `Инициатива ${init.number}: решение Kill`,
        `${cfg.gate_name}. Обоснование: ${rationale.trim()}`);
    } else if (decision === 'hold') {
      q.run(`UPDATE initiatives SET status='hold', updated_at=datetime('now') WHERE id=?`, init.id);
      notify(init.author_id, init.id, 'gate_hold', `Инициатива ${init.number}: приостановлена`,
        `Требуется дополнительная информация. ${rationale.trim()}`);
    } else if (decision === 'redirect') {
      const target = Math.max(1, Number(redirectTo) || cfg.stage_no - 1);
      result = enterStage(init, target, user.id, `Redirect с ${cfg.gate_name}: ${rationale.trim()}`);
      notify(init.author_id, init.id, 'gate_redirect', `Инициатива ${init.number}: направлена на доработку`,
        `${cfg.gate_name}. ${rationale.trim()}`);
    }

    logAction(user.id, `gate.${decision}`, 'initiative', init.id,
      { gate: cfg.gate_no, stage: cfg.stage_no, rationale, slaMet, durationHours }, ip);

    return q.get('SELECT * FROM initiatives WHERE id=?', init.id);
  });
}

export function grantAward(userId, initiativeId, type, title, byUser) {
  if (!userId) return;
  const exists = q.get('SELECT id FROM awards WHERE user_id=? AND initiative_id=? AND type=?', userId, initiativeId ?? null, type);
  if (exists) return;
  q.run('INSERT INTO awards (user_id, initiative_id, type, title, granted_by) VALUES (?,?,?,?,?)',
    userId, initiativeId ?? null, type, title, byUser ?? null);
}

/** Периодическая проверка SLA: помечает просрочки и эскалирует их координатору. */
export function sweepSla() {
  const overdue = q.all(`SELECT * FROM initiatives
     WHERE status='active' AND sla_due_at IS NOT NULL AND sla_due_at < datetime('now')`);
  let escalated = 0;
  for (const init of overdue) {
    const open = q.all(`SELECT * FROM tasks WHERE initiative_id=? AND status='open' AND type='gate'`, init.id);
    for (const t of open) {
      q.run("UPDATE tasks SET status='escalated' WHERE id=?", t.id);
      escalated += 1;
      notifyRole('dtszn', null, init.id, 'sla_breach',
        `Эскалация: нарушен SLA по инициативе ${init.number}`,
        `Этап «${stageConfig(init.stage)?.stage_name}». Решение не принято в установленный срок.`);
      logAction(null, 'sla.escalated', 'initiative', init.id, { stage: init.stage, due: init.sla_due_at }, 'system');
    }
  }
  return { overdue: overdue.length, escalated };
}
