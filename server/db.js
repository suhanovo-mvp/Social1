// Social1 — слой данных. Встроенный node:sqlite, без внешних зависимостей.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = join(ROOT, 'data');
mkdirSync(DATA_DIR, { recursive: true });

// Путь к файлу БД переопределяется переменной окружения — этим пользуются тесты,
// чтобы не трогать рабочую базу.
export const DB_FILE = process.env.SOCIAL1_DB || join(DATA_DIR, 'social1.db');

export const db = new DatabaseSync(DB_FILE);

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

// ─────────────────────────────────────────────────────────────
// Схема
// ─────────────────────────────────────────────────────────────
db.exec(`
-- Учреждения ДТСЗН, центральный аппарат, поставщики
CREATE TABLE IF NOT EXISTS institutions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  short_name   TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'institution', -- institution | dtszn | vendor
  district     TEXT,
  address      TEXT,
  staff_count  INTEGER NOT NULL DEFAULT 0,
  is_pilot_site INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Пользователи. role: employee|head|expert|developer|supplier|pilot_coordinator|dtszn
CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  email          TEXT NOT NULL UNIQUE,
  full_name      TEXT NOT NULL,
  password_hash  TEXT NOT NULL,
  password_salt  TEXT NOT NULL,
  role           TEXT NOT NULL,
  institution_id INTEGER REFERENCES institutions(id),
  position       TEXT,
  expertise      TEXT,
  phone          TEXT,
  is_active      INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_users_inst ON users(institution_id);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  ip         TEXT,
  user_agent TEXT
);

-- Конфигурация Stage-Gate (настраивается администратором без изменения кода)
CREATE TABLE IF NOT EXISTS workflow_config (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  stage_no      INTEGER NOT NULL UNIQUE,  -- позиция в конвейере 1..6
  stage_name    TEXT NOT NULL,
  tz_stage      INTEGER NOT NULL,         -- номер этапа по ТЗ 1..5
  tz_stage_name TEXT NOT NULL,
  description   TEXT,
  trigger_text  TEXT,
  participants  TEXT,                     -- JSON-массив ролей-участников
  gate_no       INTEGER,                  -- NULL = этап без точки принятия решения
  gate_name     TEXT,
  role_required TEXT,                     -- роль, принимающая решение на Gate
  sla_value     REAL,                     -- значение SLA
  sla_unit      TEXT,                     -- workdays | calendardays
  sla_text      TEXT,                     -- человекочитаемая формулировка SLA
  criteria      TEXT,                     -- JSON-массив критериев Gate
  decisions     TEXT,                     -- JSON-массив допустимых решений
  is_active     INTEGER NOT NULL DEFAULT 1,
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Инициативы — ядро системы
CREATE TABLE IF NOT EXISTS initiatives (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  number          TEXT NOT NULL UNIQUE,     -- SOC-2026-0001
  title           TEXT NOT NULL,
  problem         TEXT NOT NULL,
  solution        TEXT NOT NULL,
  expected_effect TEXT NOT NULL,
  effect_type     TEXT,      -- time | cost | quality | satisfaction | other
  effect_value    REAL,
  effect_unit     TEXT,
  category        TEXT,
  tags            TEXT,      -- JSON-массив
  author_id       INTEGER NOT NULL REFERENCES users(id),
  institution_id  INTEGER NOT NULL REFERENCES institutions(id),
  stage           INTEGER NOT NULL DEFAULT 1,   -- 1..5
  status          TEXT NOT NULL DEFAULT 'active', -- active|killed|hold|scaled
  priority        TEXT NOT NULL DEFAULT 'normal',
  stage_entered_at TEXT NOT NULL DEFAULT (datetime('now')),
  sla_due_at      TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at       TEXT,
  scaled_at       TEXT,
  first_decision_at TEXT,
  ai_category     TEXT,
  ai_score        REAL,
  ai_rationale    TEXT
);
CREATE INDEX IF NOT EXISTS idx_init_stage ON initiatives(stage, status);
CREATE INDEX IF NOT EXISTS idx_init_author ON initiatives(author_id);
CREATE INDEX IF NOT EXISTS idx_init_inst ON initiatives(institution_id);

CREATE TABLE IF NOT EXISTS attachments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  initiative_id INTEGER NOT NULL REFERENCES initiatives(id) ON DELETE CASCADE,
  filename      TEXT NOT NULL,
  mime          TEXT,
  size          INTEGER,
  kind          TEXT NOT NULL DEFAULT 'file',  -- file | link
  url           TEXT,
  content       BLOB,
  uploaded_by   INTEGER NOT NULL REFERENCES users(id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Решения на Gate — документируются с аргументацией (архив знаний)
CREATE TABLE IF NOT EXISTS gate_decisions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  initiative_id  INTEGER NOT NULL REFERENCES initiatives(id) ON DELETE CASCADE,
  gate_no        INTEGER NOT NULL,
  stage_no       INTEGER NOT NULL,
  decision       TEXT NOT NULL,   -- go | kill | hold | redirect
  rationale      TEXT NOT NULL,
  criteria_scores TEXT,           -- JSON {критерий: балл}
  decided_by     INTEGER NOT NULL REFERENCES users(id),
  decided_at     TEXT NOT NULL DEFAULT (datetime('now')),
  sla_due_at     TEXT,
  sla_met        INTEGER,
  duration_hours REAL
);
CREATE INDEX IF NOT EXISTS idx_gd_init ON gate_decisions(initiative_id);

-- История переходов между этапами (для расчёта скорости цикла)
CREATE TABLE IF NOT EXISTS stage_transitions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  initiative_id INTEGER NOT NULL REFERENCES initiatives(id) ON DELETE CASCADE,
  from_stage    INTEGER,
  to_stage      INTEGER NOT NULL,
  at            TEXT NOT NULL DEFAULT (datetime('now')),
  by_user       INTEGER REFERENCES users(id),
  reason        TEXT,
  hours_in_stage REAL
);
CREATE INDEX IF NOT EXISTS idx_st_init ON stage_transitions(initiative_id);

CREATE TABLE IF NOT EXISTS comments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  initiative_id INTEGER NOT NULL REFERENCES initiatives(id) ON DELETE CASCADE,
  author_id     INTEGER NOT NULL REFERENCES users(id),
  body          TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Задачи в личных кабинетах ответственных
CREATE TABLE IF NOT EXISTS tasks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER REFERENCES users(id),
  role_target   TEXT,        -- задача на роль (если не на конкретного пользователя)
  institution_id INTEGER REFERENCES institutions(id),
  initiative_id INTEGER REFERENCES initiatives(id) ON DELETE CASCADE,
  type          TEXT NOT NULL,
  title         TEXT NOT NULL,
  due_at        TEXT,
  status        TEXT NOT NULL DEFAULT 'open', -- open | done | escalated
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_user ON tasks(user_id, status);

CREATE TABLE IF NOT EXISTS notifications (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  initiative_id INTEGER REFERENCES initiatives(id) ON DELETE CASCADE,
  type          TEXT NOT NULL,
  title         TEXT NOT NULL,
  body          TEXT,
  is_read       INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, is_read);

-- ── Модуль разработки (Agile) ────────────────────────────────
CREATE TABLE IF NOT EXISTS projects (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  initiative_id INTEGER NOT NULL REFERENCES initiatives(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  product_owner_id INTEGER REFERENCES users(id),
  team_lead_id  INTEGER REFERENCES users(id),
  status        TEXT NOT NULL DEFAULT 'active',
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sprints (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  number     INTEGER NOT NULL,
  name       TEXT NOT NULL,
  goal       TEXT,
  starts_at  TEXT,
  ends_at    TEXT,
  status     TEXT NOT NULL DEFAULT 'planned' -- planned | active | closed
);

CREATE TABLE IF NOT EXISTS board_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  sprint_id   INTEGER REFERENCES sprints(id) ON DELETE SET NULL,
  title       TEXT NOT NULL,
  description TEXT,
  type        TEXT NOT NULL DEFAULT 'task',   -- story | task | bug
  status      TEXT NOT NULL DEFAULT 'backlog',-- backlog|todo|in_progress|review|done
  priority    TEXT NOT NULL DEFAULT 'normal',
  estimate    INTEGER NOT NULL DEFAULT 0,
  assignee_id INTEGER REFERENCES users(id),
  order_idx   INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_bi_proj ON board_items(project_id, status);

CREATE TABLE IF NOT EXISTS documents (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  initiative_id INTEGER REFERENCES initiatives(id) ON DELETE CASCADE,
  project_id    INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'doc', -- doc | arch | test | manual
  body          TEXT,
  created_by    INTEGER NOT NULL REFERENCES users(id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Модуль пилотирования ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS pilot_applications (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  initiative_id  INTEGER NOT NULL REFERENCES initiatives(id) ON DELETE CASCADE,
  institution_id INTEGER NOT NULL REFERENCES institutions(id),
  applicant_id   INTEGER NOT NULL REFERENCES users(id),
  message        TEXT,
  status         TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS pilots (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  initiative_id  INTEGER NOT NULL REFERENCES initiatives(id) ON DELETE CASCADE,
  institution_id INTEGER NOT NULL REFERENCES institutions(id),
  coordinator_id INTEGER REFERENCES users(id),
  plan           TEXT,
  status         TEXT NOT NULL DEFAULT 'planned', -- planned|running|analysis|finished
  starts_at      TEXT,
  ends_at        TEXT,
  participants_count INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS pilot_kpis (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  pilot_id   INTEGER NOT NULL REFERENCES pilots(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  unit       TEXT,
  baseline   REAL,
  target     REAL,
  actual     REAL,
  direction  TEXT NOT NULL DEFAULT 'up', -- up | down (куда улучшение)
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS surveys (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  pilot_id   INTEGER REFERENCES pilots(id) ON DELETE CASCADE,
  initiative_id INTEGER REFERENCES initiatives(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  audience   TEXT NOT NULL DEFAULT 'staff', -- staff | citizen
  is_open    INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS survey_questions (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  survey_id INTEGER NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
  text      TEXT NOT NULL,
  type      TEXT NOT NULL DEFAULT 'scale', -- scale | choice | text
  options   TEXT,
  order_idx INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS survey_responses (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  survey_id    INTEGER NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
  respondent_id INTEGER REFERENCES users(id),
  submitted_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS survey_answers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  response_id INTEGER NOT NULL REFERENCES survey_responses(id) ON DELETE CASCADE,
  question_id INTEGER NOT NULL REFERENCES survey_questions(id) ON DELETE CASCADE,
  value_num   REAL,
  value_text  TEXT
);

-- ── Масштабирование и лучшие практики ────────────────────────
CREATE TABLE IF NOT EXISTS rollouts (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  initiative_id  INTEGER NOT NULL REFERENCES initiatives(id) ON DELETE CASCADE,
  institution_id INTEGER NOT NULL REFERENCES institutions(id),
  status         TEXT NOT NULL DEFAULT 'planned', -- planned|training|deployed
  bottom_up      INTEGER NOT NULL DEFAULT 0,      -- инициативное внедрение снизу
  started_at     TEXT,
  completed_at   TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS best_practices (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  initiative_id INTEGER NOT NULL REFERENCES initiatives(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  summary       TEXT NOT NULL,
  materials     TEXT,
  effect_text   TEXT,
  published_by  INTEGER REFERENCES users(id),
  published_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Сообщество ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS forum_topics (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  title         TEXT NOT NULL,
  category      TEXT NOT NULL DEFAULT 'general',
  author_id     INTEGER NOT NULL REFERENCES users(id),
  initiative_id INTEGER REFERENCES initiatives(id) ON DELETE SET NULL,
  is_pinned     INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS forum_posts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  topic_id   INTEGER NOT NULL REFERENCES forum_topics(id) ON DELETE CASCADE,
  author_id  INTEGER NOT NULL REFERENCES users(id),
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Признание и мотивация
CREATE TABLE IF NOT EXISTS awards (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  initiative_id INTEGER REFERENCES initiatives(id) ON DELETE SET NULL,
  type          TEXT NOT NULL,   -- author | pilot | scaled | expert
  title         TEXT NOT NULL,
  granted_by    INTEGER REFERENCES users(id),
  granted_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Голоса за инициативы: поддержка коллег как сигнал приоритета
CREATE TABLE IF NOT EXISTS votes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  initiative_id INTEGER NOT NULL REFERENCES initiatives(id) ON DELETE CASCADE,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  value         INTEGER NOT NULL DEFAULT 1,   -- 1 = поддерживаю, -1 = не поддерживаю
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(initiative_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_votes_init ON votes(initiative_id);

-- Подписки на обновления инициативы
CREATE TABLE IF NOT EXISTS follows (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  initiative_id INTEGER NOT NULL REFERENCES initiatives(id) ON DELETE CASCADE,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(initiative_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_follows_init ON follows(initiative_id);

-- Неизменяемый журнал аудита (цепочка хэшей)
CREATE TABLE IF NOT EXISTS audit_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  at        TEXT NOT NULL DEFAULT (datetime('now')),
  user_id   INTEGER REFERENCES users(id),
  action    TEXT NOT NULL,
  entity    TEXT,
  entity_id INTEGER,
  details   TEXT,
  ip        TEXT,
  prev_hash TEXT,
  hash      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity, entity_id);
`);

// ─────────────────────────────────────────────────────────────
// Модуль «Идеи и решения»
// Быстрый вход в экосистему: сотрудник фиксирует проблему за минуту, коллеги
// предлагают решения и делятся проверенным опытом, вклад советчиков измеряется
// очками и превращается в рекомендации к поощрению. Идея, принятая в работу,
// поднимается в инициативу и уходит в конвейер Stage-Gate.
// ─────────────────────────────────────────────────────────────
db.exec(`
-- Идея: короткая запись о проблеме и желаемом результате
CREATE TABLE IF NOT EXISTS ideas (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  number          TEXT NOT NULL UNIQUE,          -- IDEA-2026-0001
  title           TEXT NOT NULL,
  problem         TEXT NOT NULL,
  desired_result  TEXT NOT NULL,
  category        TEXT,
  priority        TEXT NOT NULL DEFAULT 'normal', -- low | normal | high
  template        TEXT,                           -- быстрый шаблон подачи
  source_link     TEXT,                           -- место в системе, где возникает проблема
  author_id       INTEGER NOT NULL REFERENCES users(id),
  institution_id  INTEGER REFERENCES institutions(id),
  -- new | review | accepted | rejected | in_progress | done | archived
  status          TEXT NOT NULL DEFAULT 'new',
  moderation_note TEXT,
  moderated_by    INTEGER REFERENCES users(id),
  moderated_at    TEXT,
  duplicate_of_id INTEGER REFERENCES ideas(id) ON DELETE SET NULL,
  initiative_id   INTEGER REFERENCES initiatives(id) ON DELETE SET NULL,
  accepted_proposal_id INTEGER,                   -- предложение, принятое в работу
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_ideas_status ON ideas(status, created_at);
CREATE INDEX IF NOT EXISTS idx_ideas_author ON ideas(author_id);
CREATE INDEX IF NOT EXISTS idx_ideas_category ON ideas(category);

-- Черновик формы: сохраняется автоматически, по одному на пользователя
CREATE TABLE IF NOT EXISTS idea_drafts (
  user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  payload    TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Предложение решения или проверенный опыт
CREATE TABLE IF NOT EXISTS proposals (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  idea_id         INTEGER NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
  author_id       INTEGER NOT NULL REFERENCES users(id),
  summary         TEXT NOT NULL,                  -- краткое описание решения
  how_to_apply    TEXT,
  expected_effect TEXT,
  risks           TEXT,
  needs_approval  INTEGER NOT NULL DEFAULT 0,     -- требуется одобрение руководителя
  kind            TEXT NOT NULL DEFAULT 'proposal', -- proposal | experience
  -- published | useful | verified | rejected | implemented
  status          TEXT NOT NULL DEFAULT 'published',
  verified_by     INTEGER REFERENCES users(id),
  verified_at     TEXT,
  useful_marked_at TEXT,
  moderation_note TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_prop_idea ON proposals(idea_id, status);
CREATE INDEX IF NOT EXISTS idx_prop_author ON proposals(author_id);

-- Файлы и ссылки идей и предложений
CREATE TABLE IF NOT EXISTS idea_attachments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  idea_id     INTEGER REFERENCES ideas(id) ON DELETE CASCADE,
  proposal_id INTEGER REFERENCES proposals(id) ON DELETE CASCADE,
  filename    TEXT NOT NULL,
  mime        TEXT,
  size        INTEGER,
  kind        TEXT NOT NULL DEFAULT 'link',       -- file | link
  url         TEXT,
  content     BLOB,
  uploaded_by INTEGER NOT NULL REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_iatt_idea ON idea_attachments(idea_id);

-- Быстрая поддержка идеи: «полезно», «поддерживаю», «готов участвовать»
CREATE TABLE IF NOT EXISTS idea_reactions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  idea_id    INTEGER NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  kind       TEXT NOT NULL,                       -- useful | support | join
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(idea_id, user_id, kind)
);
CREATE INDEX IF NOT EXISTS idx_ireact_idea ON idea_reactions(idea_id);

-- Подтверждение предложения другими сотрудниками
CREATE TABLE IF NOT EXISTS proposal_endorsements (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  proposal_id INTEGER NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(proposal_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_pend_prop ON proposal_endorsements(proposal_id);

-- Обсуждение идеи и отдельных предложений
CREATE TABLE IF NOT EXISTS idea_comments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  idea_id     INTEGER NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
  proposal_id INTEGER REFERENCES proposals(id) ON DELETE CASCADE,
  author_id   INTEGER NOT NULL REFERENCES users(id),
  body        TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_icomm_idea ON idea_comments(idea_id);

-- Правила начисления очков: администратор меняет их без изменения кода
CREATE TABLE IF NOT EXISTS points_rules (
  code         TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  points       INTEGER NOT NULL,
  cap_per_target INTEGER,                         -- предел очков по одному объекту
  description  TEXT,
  is_active    INTEGER NOT NULL DEFAULT 1,
  order_idx    INTEGER NOT NULL DEFAULT 0,
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Журнал начислений: кто, когда, за что и сколько получил
CREATE TABLE IF NOT EXISTS points_ledger (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  rule_code    TEXT NOT NULL,
  points       INTEGER NOT NULL,
  idea_id      INTEGER REFERENCES ideas(id) ON DELETE CASCADE,
  proposal_id  INTEGER REFERENCES proposals(id) ON DELETE CASCADE,
  source_user_id INTEGER REFERENCES users(id),    -- кто своим действием вызвал начисление
  reason       TEXT,
  status       TEXT NOT NULL DEFAULT 'approved',  -- approved | revoked
  awarded_by   INTEGER REFERENCES users(id),
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at   TEXT,
  revoked_by   INTEGER REFERENCES users(id),
  revoke_reason TEXT,
  -- Защита от повторного начисления за одно и то же действие. Собирается в коде:
  -- в SQL значения NULL не равны друг другу, поэтому составной UNIQUE тут не работает.
  dedup_key    TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_ledger_user ON points_ledger(user_id, status);
CREATE INDEX IF NOT EXISTS idx_ledger_created ON points_ledger(created_at);

-- Знаки отличия советчиков
CREATE TABLE IF NOT EXISTS advisor_badges (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  code       TEXT NOT NULL,
  title      TEXT NOT NULL,
  granted_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, code)
);

-- Справочник допустимых мер поощрения (настраивается администратором)
CREATE TABLE IF NOT EXISTS incentive_types (
  code        TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  description TEXT,
  category    TEXT NOT NULL DEFAULT 'recognition', -- time | recognition | development | material | social
  legal_note  TEXT,
  is_active   INTEGER NOT NULL DEFAULT 1,
  order_idx   INTEGER NOT NULL DEFAULT 0
);

-- Рекомендация к поощрению: система предлагает, решение принимает руководитель
CREATE TABLE IF NOT EXISTS incentives (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  type_code    TEXT NOT NULL REFERENCES incentive_types(code),
  period       TEXT NOT NULL,                     -- month | quarter | year
  period_label TEXT NOT NULL,
  points_at_creation INTEGER NOT NULL DEFAULT 0,
  rank_at_creation   INTEGER,
  -- proposed | agreed | approved | rejected | implemented
  status       TEXT NOT NULL DEFAULT 'proposed',
  note         TEXT,
  decision_note TEXT,
  proposed_by  INTEGER REFERENCES users(id),
  decided_by   INTEGER REFERENCES users(id),
  decided_at   TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_incent_user ON incentives(user_id, status);

-- Жалобы на некорректные идеи и предложения
CREATE TABLE IF NOT EXISTS idea_reports (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  target_type TEXT NOT NULL,                      -- idea | proposal
  target_id   INTEGER NOT NULL,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  reason      TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open',       -- open | resolved | dismissed
  resolved_by INTEGER REFERENCES users(id),
  resolved_at TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(target_type, target_id, user_id)
);

-- Быстрое ревью предложений: одна оценка одного человека по одному предложению.
-- Лайк не начисляет очки автору — он влияет только на полезность и порядок показа,
-- поэтому массовое пролистывание нельзя превратить в накрутку рейтинга.
CREATE TABLE IF NOT EXISTS proposal_reviews (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  proposal_id INTEGER NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  verdict     TEXT NOT NULL,        -- like | skip | favorite
  reason      TEXT,                 -- причина пропуска: unclear|costly|risky|duplicate|irrelevant|against_rules
  dwell_ms    INTEGER,              -- сколько карточка была на экране — признак осмысленности оценки
  device      TEXT,                 -- метка устройства для выявления оценок с одного устройства
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(proposal_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_review_prop ON proposal_reviews(proposal_id, verdict);
CREATE INDEX IF NOT EXISTS idx_review_user ON proposal_reviews(user_id, created_at);

-- Сигналы антифрода: серийные быстрые оценки, превышение частоты, одно устройство
CREATE TABLE IF NOT EXISTS review_flags (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  kind        TEXT NOT NULL,        -- burst | rate_limit | shared_device
  details     TEXT,
  status      TEXT NOT NULL DEFAULT 'open',  -- open | reviewed | dismissed
  resolved_by INTEGER REFERENCES users(id),
  resolved_at TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_rflag_status ON review_flags(status, created_at);

-- Настройки модуля: обязательность модерации, видимость рейтинга и прочее
CREATE TABLE IF NOT EXISTS ideahub_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// ─────────────────────────────────────────────────────────────
// Миграции существующих баз
// ─────────────────────────────────────────────────────────────
function addColumn(table, column, ddl) {
  const exists = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
  if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

// Уведомления модуля привязываются к идее так же, как остальные — к инициативе
addColumn('notifications', 'idea_id', 'INTEGER REFERENCES ideas(id) ON DELETE CASCADE');
addColumn('tasks', 'idea_id', 'INTEGER REFERENCES ideas(id) ON DELETE CASCADE');

// Защита журнала аудита от изменения и удаления на уровне БД
db.exec(`
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'Журнал аудита неизменяем'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'Журнал аудита неизменяем'); END;
`);

// ─────────────────────────────────────────────────────────────
// Хелперы запросов
// ─────────────────────────────────────────────────────────────
const plain = (row) => (row ? { ...row } : row);

export const q = {
  all(sql, ...params) { return db.prepare(sql).all(...params).map(plain); },
  get(sql, ...params) { return plain(db.prepare(sql).get(...params)); },
  run(sql, ...params) { return db.prepare(sql).run(...params); },
  insert(sql, ...params) { return Number(db.prepare(sql).run(...params).lastInsertRowid); },
};

export function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}
