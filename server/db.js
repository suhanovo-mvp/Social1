// Social1 — слой данных. Встроенный node:sqlite, без внешних зависимостей.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = join(ROOT, 'data');
mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(join(DATA_DIR, 'social1.db'));

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
