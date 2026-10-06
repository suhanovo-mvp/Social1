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

-- ── События платформы ────────────────────────────────────────
-- Что произошло, а не кто что сделал: журнал аудита отвечает на второй вопрос и
-- защищён цепочкой хэшей — разбавлять его системными переходами нельзя. Здесь же
-- лежат и переходы, сделанные платформой самостоятельно, и по этой таблице
-- считается, сколько предмет пробыл в каждом состоянии.
CREATE TABLE IF NOT EXISTS events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  type         TEXT NOT NULL,      -- doc.accepted, task.completed, idea.status.changed
  subject_type TEXT NOT NULL,      -- idea | initiative | process_change | knowledge_doc | task
  subject_id   INTEGER,
  actor_id     INTEGER REFERENCES users(id),
  from_state   TEXT,               -- заполняется у событий смены состояния
  to_state     TEXT,
  payload      TEXT,               -- JSON с подробностями
  at           TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_subject ON events(subject_type, subject_id, at);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type, at);

-- Сбой обработчика не отменяет исходное действие, но и не теряется молча
CREATE TABLE IF NOT EXISTS event_failures (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id   INTEGER REFERENCES events(id) ON DELETE CASCADE,
  handler    TEXT NOT NULL,
  message    TEXT NOT NULL,
  at         TEXT NOT NULL DEFAULT (datetime('now'))
);

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
// предлагают решения и делятся проверенным опытом, вклад социальных советников измеряется
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

-- Знаки отличия социальных советников
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
// Гибкая ролевая модель
// Роли и права были постоянной в коде: добавить роль или передать право означало
// править исходники и выкладывать сборку. Теперь это данные — администратор меняет
// их в интерфейсе, а участник может держать несколько ролей сразу.
// ─────────────────────────────────────────────────────────────
db.exec(`
CREATE TABLE IF NOT EXISTS roles (
  code       TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  short      TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'system',   -- system | custom
  description TEXT,
  is_active  INTEGER NOT NULL DEFAULT 1,
  order_idx  INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_code  TEXT NOT NULL REFERENCES roles(code) ON DELETE CASCADE,
  permission TEXT NOT NULL,
  PRIMARY KEY (role_code, permission)
);

-- Справочник прав: расшифровка для интерфейса администратора
CREATE TABLE IF NOT EXISTS permissions_catalog (
  code        TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  group_title TEXT NOT NULL DEFAULT 'Прочее',
  order_idx   INTEGER NOT NULL DEFAULT 0
);

-- Дополнительные роли участника сверх основной в users.role.
-- institution_id ограничивает роль одним учреждением: например, согласующий
-- по своему центру, но не по соседнему.
CREATE TABLE IF NOT EXISTS user_roles (
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_code      TEXT NOT NULL REFERENCES roles(code) ON DELETE CASCADE,
  institution_id INTEGER REFERENCES institutions(id),
  granted_by     INTEGER REFERENCES users(id),
  granted_at     TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, role_code)
);
CREATE INDEX IF NOT EXISTS idx_user_roles_role ON user_roles(role_code);
`);

// ─────────────────────────────────────────────────────────────
// Репозиторий процессов
// Схемы перестают быть текстом в исходниках и становятся данными с историей версий.
// Опубликованная версия — источник истины: из неё собирается конфигурация конвейера,
// поэтому принятое сообществом изменение схемы меняет работу платформы, а не только
// картинку в справочнике.
// ─────────────────────────────────────────────────────────────
db.exec(`
CREATE TABLE IF NOT EXISTS process_defs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  key           TEXT NOT NULL UNIQUE,          -- 'e2e', 'emp-submit'
  title         TEXT NOT NULL,
  description   TEXT,
  scenario      TEXT,                          -- пользовательский путь: initiative | ideas
  group_title   TEXT,                          -- владелец процесса в оглавлении альбома
  role_owner    TEXT,                          -- роль, чей это процесс ('all' — сквозной)
  sla_text      TEXT,
  order_idx     INTEGER NOT NULL DEFAULT 0,    -- место в альбоме: нумерация разделов сквозная
  -- Конвейер инициатив: из его опубликованной версии собирается workflow_config
  is_pipeline   INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'published', -- draft | published | deprecated | archived
  current_version_id INTEGER,
  owner_id      INTEGER REFERENCES users(id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pdef_scenario ON process_defs(scenario, order_idx);

-- Версия схемы. Опубликованная версия неизменяема: правка идёт через новый черновик,
-- иначе ссылка из регламента на шаг «3.5» перестала бы что-либо значить.
CREATE TABLE IF NOT EXISTS process_versions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  def_id        INTEGER NOT NULL REFERENCES process_defs(id) ON DELETE CASCADE,
  version       INTEGER NOT NULL,
  model         TEXT NOT NULL,                 -- JSON: дорожки, шаги, переходы, разбор
  notes         TEXT,
  status        TEXT NOT NULL DEFAULT 'draft', -- draft | review | published | superseded
  based_on_version_id INTEGER REFERENCES process_versions(id),
  created_by    INTEGER REFERENCES users(id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  published_at  TEXT,
  published_by  INTEGER REFERENCES users(id),
  UNIQUE(def_id, version)
);
CREATE INDEX IF NOT EXISTS idx_pver_def ON process_versions(def_id, status);
`);

// ─────────────────────────────────────────────────────────────
// Совместная работа над процессами
// Обсуждение привязано к шагу схемы, а не к процессу целиком: «здесь теряется два
// дня» — замечание к конкретной фигуре, и разговор о ней не тонет в общей ленте.
// Предложение об изменении несёт черновую версию, а не текст пожеланий: то, что
// обсуждают и согласовывают, и есть то, что будет опубликовано.
// ─────────────────────────────────────────────────────────────
db.exec(`
-- Обсуждение любой сущности платформы. Замечание привязывается к якорю внутри неё:
-- шаг схемы, переход между шагами, раздел документа. Разговор о конкретном месте
-- не тонет в общей ленте — это оказалось верно и для схем, и для документов,
-- поэтому таблица одна на всё, а не своя у каждого модуля.
CREATE TABLE IF NOT EXISTS discussions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  target_type TEXT NOT NULL,      -- process | process_change | knowledge_doc | idea
  target_id   INTEGER NOT NULL,
  context_id  INTEGER,            -- версия схемы или документа, к которой оставлено
  anchor_kind TEXT,               -- node | flow | section
  anchor_id   TEXT,
  parent_id   INTEGER REFERENCES discussions(id) ON DELETE CASCADE,
  author_id   INTEGER NOT NULL REFERENCES users(id),
  body        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open',   -- open | resolved
  resolved_by INTEGER REFERENCES users(id),
  resolved_at TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_disc_target ON discussions(target_type, target_id, status);
CREATE INDEX IF NOT EXISTS idx_disc_anchor ON discussions(target_type, target_id, anchor_id);

-- Отметка полезности замечания: поднимает содержательное наверх
CREATE TABLE IF NOT EXISTS discussion_votes (
  discussion_id INTEGER NOT NULL REFERENCES discussions(id) ON DELETE CASCADE,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (discussion_id, user_id)
);

-- Лист согласования. Состав не задаётся списком должностей, а выводится из самого
-- предмета: для правки схемы — из затронутых дорожек, для проекта решения — из его
-- предмета и ролей, которых оно касается. Поле reason хранит основание попадания
-- в лист, чтобы согласующий видел, почему спрашивают именно его.
CREATE TABLE IF NOT EXISTS approvals (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  target_type    TEXT NOT NULL,   -- process_change | knowledge_doc
  target_id      INTEGER NOT NULL,
  step_no        INTEGER NOT NULL DEFAULT 1,
  reason         TEXT,
  role_code      TEXT,            -- согласует роль целиком
  user_id        INTEGER REFERENCES users(id),   -- либо поимённо
  institution_id INTEGER REFERENCES institutions(id),
  required       INTEGER NOT NULL DEFAULT 1,
  verdict        TEXT,            -- agree | reject | remarks
  comment        TEXT,
  due_at         TEXT,
  decided_by     INTEGER REFERENCES users(id),
  decided_at     TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_appr_target ON approvals(target_type, target_id, verdict);

-- Предложение об изменении процесса
CREATE TABLE IF NOT EXISTS process_changes (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  number           TEXT NOT NULL UNIQUE,     -- PRC-2026-0001
  def_id           INTEGER NOT NULL REFERENCES process_defs(id) ON DELETE CASCADE,
  base_version_id  INTEGER NOT NULL REFERENCES process_versions(id),
  draft_version_id INTEGER NOT NULL REFERENCES process_versions(id) ON DELETE CASCADE,
  title            TEXT NOT NULL,
  rationale        TEXT NOT NULL,            -- зачем менять: обязательное обоснование
  expected_effect  TEXT,
  author_id        INTEGER NOT NULL REFERENCES users(id),
  institution_id   INTEGER REFERENCES institutions(id),
  -- draft: автор ещё правит; discussion: обсуждается коллегами;
  -- approval: на согласовании; accepted: согласовано; published: вошло в действующую
  -- версию; rejected | withdrawn: закрыто
  status           TEXT NOT NULL DEFAULT 'draft',
  decision_note    TEXT,
  idea_id          INTEGER REFERENCES ideas(id) ON DELETE SET NULL,
  initiative_id    INTEGER REFERENCES initiatives(id) ON DELETE SET NULL,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
  submitted_at     TEXT,
  decided_at       TEXT,
  published_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_pchange_def ON process_changes(def_id, status);
CREATE INDEX IF NOT EXISTS idx_pchange_author ON process_changes(author_id);

-- Поддержка предложения коллегами: сигнал приоритета для согласующих
CREATE TABLE IF NOT EXISTS process_change_votes (
  change_id  INTEGER NOT NULL REFERENCES process_changes(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  value      INTEGER NOT NULL DEFAULT 1,     -- 1 поддерживаю, -1 возражаю
  comment    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (change_id, user_id)
);

-- Лист согласования. Шаги выводятся из затронутых дорожек, поэтому изменение
-- согласуют те, чью работу оно меняет, а не заранее заданный список должностей.
-- Настройка маршрута: кто согласует сверх выведенных из схемы и в какой срок
CREATE TABLE IF NOT EXISTS process_approval_routes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  def_id     INTEGER REFERENCES process_defs(id) ON DELETE CASCADE,
  scenario   TEXT,                            -- маршрут на весь пользовательский путь
  always     TEXT NOT NULL DEFAULT '[]',      -- JSON: роли, согласующие любое изменение
  sla_value  REAL,
  sla_unit   TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// ─────────────────────────────────────────────────────────────
// База знаний: проекты решений и зафиксированные решения
// Платформа умеет доводить решение до внедрения, но не превращает его в знание:
// следующий автор не найдёт, что похожее уже разбирали и какие варианты отклонили.
// Документ закрывает именно это — он хранит не только решение, но и контекст,
// рассмотренные альтернативы и последствия.
// ─────────────────────────────────────────────────────────────
db.exec(`
CREATE TABLE IF NOT EXISTS knowledge_docs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  number        TEXT NOT NULL UNIQUE,   -- РД-2026-0001 (проект) / ЗР-2026-0001 (решение)
  kind          TEXT NOT NULL,          -- rfc | adr | spec | guide
  title         TEXT NOT NULL,
  -- draft: автор пишет; review: на рецензировании; accepted: согласовано;
  -- published: в базе знаний; rejected | superseded: закрыто
  status        TEXT NOT NULL DEFAULT 'draft',
  current_version_id INTEGER,
  author_id     INTEGER NOT NULL REFERENCES users(id),
  institution_id INTEGER REFERENCES institutions(id),
  -- Документ относится к чему угодно: идее, инициативе, процессу, пилоту, проекту
  subject_type  TEXT,
  subject_id    INTEGER,
  -- Решение, которое этот документ заменяет: история не теряется
  supersedes_id INTEGER REFERENCES knowledge_docs(id) ON DELETE SET NULL,
  -- Проект решения, из которого вырос ADR, и задача, которая его реализовала
  source_doc_id INTEGER REFERENCES knowledge_docs(id) ON DELETE SET NULL,
  task_id       INTEGER REFERENCES board_items(id) ON DELETE SET NULL,
  decision_note TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at    TEXT,
  published_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_kdoc_kind ON knowledge_docs(kind, status);
CREATE INDEX IF NOT EXISTS idx_kdoc_subject ON knowledge_docs(subject_type, subject_id);
CREATE INDEX IF NOT EXISTS idx_kdoc_author ON knowledge_docs(author_id);

-- Версия документа. Опубликованная неизменяема: ссылка из регламента на решение
-- должна означать то же самое и через год.
CREATE TABLE IF NOT EXISTS knowledge_versions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_id        INTEGER NOT NULL REFERENCES knowledge_docs(id) ON DELETE CASCADE,
  version       INTEGER NOT NULL,
  sections      TEXT NOT NULL DEFAULT '{}',  -- JSON: раздел → текст, источник истины
  body          TEXT,                        -- собранный Markdown: выгрузка и поиск
  notes         TEXT,
  status        TEXT NOT NULL DEFAULT 'draft', -- draft | published | superseded
  based_on_version_id INTEGER REFERENCES knowledge_versions(id),
  created_by    INTEGER REFERENCES users(id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  published_at  TEXT,
  published_by  INTEGER REFERENCES users(id),
  UNIQUE(doc_id, version)
);
CREATE INDEX IF NOT EXISTS idx_kver_doc ON knowledge_versions(doc_id, status);

-- Состав разделов документа — данные, а не код: администратор меняет шаблон,
-- не трогая исходники. Именно на раздел вешается замечание при рецензировании.
CREATE TABLE IF NOT EXISTS knowledge_sections (
  kind        TEXT NOT NULL,
  key         TEXT NOT NULL,
  title       TEXT NOT NULL,
  hint        TEXT,
  required    INTEGER NOT NULL DEFAULT 1,
  order_idx   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (kind, key)
);
`);

// ─────────────────────────────────────────────────────────────
// Конструктор форм: опросы и анкеты
// Опрос по итогам пилота платформа умела и раньше, но только его: три типа
// вопросов, заданных в коде. Собрать анкету под свою задачу — оценить спрос на
// решение, собрать заявки, провести обследование учреждений — было нельзя.
// Здесь форма становится данными: состав вопросов, условия показа и правила
// проверки задаются в конструкторе, а не правкой исходников.
// ─────────────────────────────────────────────────────────────
db.exec(`
CREATE TABLE IF NOT EXISTS forms (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  slug          TEXT NOT NULL UNIQUE,   -- адрес публичной ссылки: /f/<slug>
  title         TEXT NOT NULL,
  description   TEXT,                   -- вступительный текст перед первым вопросом
  status        TEXT NOT NULL DEFAULT 'draft',    -- draft | published | closed
  -- internal: только участникам платформы; link: любому по ссылке, без входа
  access        TEXT NOT NULL DEFAULT 'internal',
  is_anonymous  INTEGER NOT NULL DEFAULT 0,  -- не связывать ответ с автором
  one_per_user  INTEGER NOT NULL DEFAULT 1,
  show_progress INTEGER NOT NULL DEFAULT 1,
  closing_text  TEXT,                   -- что человек видит после отправки
  closes_at     TEXT,                   -- срок сбора ответов
  created_by    INTEGER REFERENCES users(id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  published_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_forms_status ON forms(status);
CREATE INDEX IF NOT EXISTS idx_forms_author ON forms(created_by);

-- Вопрос формы. key устойчив: на него ссылаются условия показа и выгрузка,
-- поэтому правка текста вопроса не рвёт ни то, ни другое.
CREATE TABLE IF NOT EXISTS form_questions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  form_id    INTEGER NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  type       TEXT NOT NULL,   -- см. QUESTION_TYPES в shared/forms/schema.js
  title      TEXT NOT NULL,
  hint       TEXT,
  required   INTEGER NOT NULL DEFAULT 0,
  options    TEXT NOT NULL DEFAULT '[]',  -- JSON: [{code,label}]
  settings   TEXT NOT NULL DEFAULT '{}',  -- JSON: шкала, единицы, «свой ответ»
  visible_if TEXT,                        -- JSON: условие показа, ссылки только назад
  order_idx  INTEGER NOT NULL DEFAULT 0,
  UNIQUE (form_id, key)
);
CREATE INDEX IF NOT EXISTS idx_fq_form ON form_questions(form_id, order_idx);

CREATE TABLE IF NOT EXISTS form_responses (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  form_id        INTEGER NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
  -- У анонимной формы и у ответа по ссылке автора нет: связать ответ с человеком
  -- нечем по замыслу, а не по недосмотру
  respondent_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  institution_id INTEGER REFERENCES institutions(id),
  status         TEXT NOT NULL DEFAULT 'submitted',  -- draft | submitted
  source         TEXT NOT NULL DEFAULT 'portal',     -- portal | link
  started_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
  submitted_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_fresp_form ON form_responses(form_id, status);
CREATE INDEX IF NOT EXISTS idx_fresp_user ON form_responses(respondent_id);

-- Ответ хранится трижды: нормализованным значением (истина), числом (сводка) и
-- текстом (выгрузка и чтение). Иначе каждая из трёх задач разбирала бы JSON
-- по-своему, и расхождение обнаружилось бы в отчёте.
CREATE TABLE IF NOT EXISTS form_answers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  response_id INTEGER NOT NULL REFERENCES form_responses(id) ON DELETE CASCADE,
  question_id INTEGER NOT NULL REFERENCES form_questions(id) ON DELETE CASCADE,
  value       TEXT,
  value_num   REAL,
  value_text  TEXT,
  UNIQUE (response_id, question_id)
);
CREATE INDEX IF NOT EXISTS idx_fans_question ON form_answers(question_id);
`);

// ─────────────────────────────────────────────────────────────
// Каталог разработчиков ИИ-решений
// Кому можно поручить разработку и внедрение: внешние вендоры, внутренние команды
// ДТСЗН и команды, которые может выделить ДИТ. Сведения о них — коммерчески
// чувствительные, поэтому реестр виден только тем, кому доступ выдан явно.
// ─────────────────────────────────────────────────────────────
db.exec(`
CREATE TABLE IF NOT EXISTS providers (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kind          TEXT NOT NULL,              -- external | internal | dit
  name          TEXT NOT NULL,
  legal_name    TEXT,                       -- полное наименование юрлица
  inn           TEXT,                       -- только у внешних вендоров
  org_unit      TEXT,                       -- подразделение у внутренних команд и ДИТ
  description   TEXT,
  website       TEXT,
  city          TEXT,
  team_size     INTEGER,
  founded_year  INTEGER,
  contact_name  TEXT,
  contact_role  TEXT,
  contact_email TEXT,
  contact_phone TEXT,
  status        TEXT NOT NULL DEFAULT 'new',          -- см. PROVIDER_STATUS
  availability  TEXT NOT NULL DEFAULT 'unknown',      -- свободен / загружен
  price_band    INTEGER,                              -- 1..3, ориентир стоимости
  competencies  TEXT NOT NULL DEFAULT '[]',           -- JSON: коды компетенций
  domains       TEXT NOT NULL DEFAULT '[]',           -- JSON: отраслевой опыт
  compliance    TEXT NOT NULL DEFAULT '[]',           -- JSON: соответствие требованиям
  tags          TEXT NOT NULL DEFAULT '[]',           -- JSON: технологии свободным списком
  owner_id      INTEGER REFERENCES users(id) ON DELETE SET NULL, -- кто ведёт контакт
  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_providers_kind ON providers(kind, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_providers_inn ON providers(inn) WHERE inn IS NOT NULL;

-- Портфолио: выполненные проекты
CREATE TABLE IF NOT EXISTS provider_cases (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_id  INTEGER NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  customer     TEXT,
  year         INTEGER,
  description  TEXT,
  result       TEXT,                        -- измеримый эффект
  tags         TEXT NOT NULL DEFAULT '[]',
  link         TEXT,
  public_sector INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pcases_provider ON provider_cases(provider_id);

-- Каталог доступных решений и технологий
CREATE TABLE IF NOT EXISTS provider_solutions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_id  INTEGER NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'product',    -- см. SOLUTION_KINDS
  maturity     TEXT NOT NULL DEFAULT 'production', -- prototype | pilot | production
  license      TEXT,                               -- proprietary | open_source | saas
  description  TEXT,
  competencies TEXT NOT NULL DEFAULT '[]',
  tags         TEXT NOT NULL DEFAULT '[]',
  in_registry  INTEGER NOT NULL DEFAULT 0,         -- в реестре отечественного ПО
  price_note   TEXT,
  link         TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_psol_provider ON provider_solutions(provider_id);

-- Оценка по итогам совместной работы: одна от участника, её можно уточнять
CREATE TABLE IF NOT EXISTS provider_reviews (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_id   INTEGER NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  author_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  quality       INTEGER NOT NULL,
  deadlines     INTEGER NOT NULL,
  communication INTEGER NOT NULL,
  context       TEXT,                       -- по какому проекту
  comment       TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (provider_id, author_id)
);

-- Журнал взаимодействий: встречи, запросы, письма
CREATE TABLE IF NOT EXISTS provider_notes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_id INTEGER NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  author_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  kind        TEXT NOT NULL DEFAULT 'note',  -- см. NOTE_KINDS
  body        TEXT NOT NULL,
  happened_at TEXT NOT NULL DEFAULT (date('now')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pnotes_provider ON provider_notes(provider_id, happened_at);
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

// Предложения об изменении процессов пользуются теми же задачами, уведомлениями и
// очками, что и остальная работа: согласование приходит в «Мои задачи», а вклад
// автора попадает в общий рейтинг социальных советников. Отдельных механизмов для этого нет.
addColumn('notifications', 'process_change_id', 'INTEGER REFERENCES process_changes(id) ON DELETE CASCADE');
addColumn('tasks', 'process_change_id', 'INTEGER REFERENCES process_changes(id) ON DELETE CASCADE');
addColumn('points_ledger', 'process_change_id', 'INTEGER REFERENCES process_changes(id) ON DELETE CASCADE');

// Документы базы знаний пользуются теми же задачами и уведомлениями
addColumn('tasks', 'knowledge_doc_id', 'INTEGER REFERENCES knowledge_docs(id) ON DELETE CASCADE');
addColumn('notifications', 'knowledge_doc_id', 'INTEGER REFERENCES knowledge_docs(id) ON DELETE CASCADE');
addColumn('board_items', 'knowledge_doc_id', 'INTEGER REFERENCES knowledge_docs(id) ON DELETE SET NULL');

// Синтетические разработчики для демонстрации помечаются, чтобы их не приняли за
// реальных подрядчиков и могли убрать одной командой, не задев введённое вручную
addColumn('providers', 'is_demo', 'INTEGER NOT NULL DEFAULT 0');

// Представитель разработчика — учётная запись поставщика, привязанная к карточке
// своей компании. Базовые сведения ведёт модератор каталога, технологический профиль,
// портфолио и решения — представитель; его правки ждут подтверждения модератором.
db.exec(`
CREATE TABLE IF NOT EXISTS provider_members (
  provider_id INTEGER NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  added_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  added_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (provider_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_pmembers_user ON provider_members(user_id);
`);
addColumn('providers', 'profile_status', "TEXT NOT NULL DEFAULT 'confirmed'");  // confirmed | pending
addColumn('providers', 'profile_changed_at', 'TEXT');
addColumn('providers', 'profile_changed_by', 'INTEGER REFERENCES users(id) ON DELETE SET NULL');
addColumn('providers', 'profile_note', 'TEXT');   // что изменил представитель, коротко
addColumn('notifications', 'provider_id', 'INTEGER REFERENCES providers(id) ON DELETE CASCADE');


// Обсуждения и согласования отвязаны от процессов и стали общими для всей
// платформы. Прежние таблицы переносятся строка в строку и удаляются: SQLite не
// меняет внешние ключи на месте, поэтому пересоздание — единственный путь.
//
// Транзакция открывается напрямую: помощник tx() объявлен ниже по файлу и на
// момент миграции ещё недоступен.
function tableExists(name) {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

if (tableExists('process_comments')) {
  db.exec('BEGIN');
  try {
    // Замечание к схеме и реплика внутри предложения различались полем change_id —
    // теперь это разные типы цели
    db.exec(`INSERT INTO discussions
      (id, target_type, target_id, context_id, anchor_kind, anchor_id, parent_id,
       author_id, body, status, resolved_by, resolved_at, created_at)
      SELECT id,
             CASE WHEN change_id IS NOT NULL THEN 'process_change' ELSE 'process' END,
             COALESCE(change_id, def_id),
             version_id,
             CASE WHEN node_id IS NOT NULL THEN 'node'
                  WHEN flow_id IS NOT NULL THEN 'flow' ELSE NULL END,
             COALESCE(node_id, flow_id),
             parent_id, author_id, body, status, resolved_by, resolved_at, created_at
      FROM process_comments`);
    if (tableExists('process_comment_votes')) {
      db.exec(`INSERT INTO discussion_votes (discussion_id, user_id, created_at)
               SELECT comment_id, user_id, created_at FROM process_comment_votes`);
      db.exec('DROP TABLE process_comment_votes');
    }
    db.exec('DROP TABLE process_comments');
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

if (tableExists('process_approvals')) {
  db.exec('BEGIN');
  try {
    db.exec(`INSERT INTO approvals
      (id, target_type, target_id, step_no, reason, role_code, user_id, institution_id,
       required, verdict, comment, due_at, decided_by, decided_at, created_at)
      SELECT id, 'process_change', change_id, step_no, NULL, role_code, user_id,
             institution_id, required, verdict, comment, due_at, decided_by,
             decided_at, created_at
      FROM process_approvals`);
    db.exec('DROP TABLE process_approvals');
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

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

// Вложенный вызов не открывает свою транзакцию, а продолжает внешнюю: SQLite
// вложенных транзакций не поддерживает, а составные операции у нас складываются из
// более мелких — публикация версии процесса внутри себя пересобирает конвейер.
//
// Границей отката остаётся самый внешний вызов: сбой в любой части отменяет всё.
// Поэтому исключение внутри tx нельзя гасить и продолжать работу — оно должно
// дойти до внешнего вызова, иначе будет зафиксирована половина изменений.
let txDepth = 0;

export function tx(fn) {
  if (txDepth > 0) return fn();
  txDepth = 1;
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
  finally { txDepth = 0; }
}
