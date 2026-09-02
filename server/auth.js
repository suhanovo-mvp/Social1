// Аутентификация, сессии и ролевая модель доступа (RBAC)
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { q } from './db.js';

const SESSION_DAYS = 7;

export const ROLES = {
  employee:          { title: 'Сотрудник учреждения',        short: 'Сотрудник' },
  head:              { title: 'Руководитель учреждения',      short: 'Руководитель' },
  expert:            { title: 'Эксперт ДТСЗН',                short: 'Эксперт' },
  developer:         { title: 'Команда разработки и ЦТ',      short: 'Разработка' },
  supplier:          { title: 'Поставщик технологий и услуг', short: 'Поставщик' },
  pilot_coordinator: { title: 'Координатор пилотных площадок',short: 'Пилот-координатор' },
  dtszn:             { title: 'ДТСЗН (центральный аппарат)',  short: 'ДТСЗН' },
};

// Права: что роль может делать. Проверяются на сервере при каждом запросе.
//
// Модуль «Идеи и решения» добавляет свои права поверх ролей платформы:
//   idea.create      — подавать идеи;
//   idea.propose     — предлагать решения и делиться проверенным опытом (советчик);
//   idea.review      — быстрое ревью чужих предложений карточками (ревьюер);
//   idea.moderate    — проверять идеи, подтверждать опыт, отменять начисления (модератор);
//   idea.incentive   — видеть рекомендации к поощрению и формировать их (руководитель);
//   idea.incentive.decide — согласовывать, утверждать и отклонять поощрения;
//   idea.admin       — правила начисления очков, меры поощрения, настройки модуля.
const PERMISSIONS = {
  employee:          ['initiative.create', 'initiative.read', 'initiative.comment', 'pilot.feedback', 'community', 'survey.answer',
                      'idea.create', 'idea.propose', 'idea.review'],
  head:              ['initiative.create', 'initiative.read', 'initiative.comment', 'gate.1', 'pilot.apply', 'pilot.manage', 'analytics.institution', 'community', 'survey.answer', 'rollout.manage',
                      'idea.create', 'idea.propose', 'idea.review', 'idea.incentive', 'idea.incentive.decide'],
  expert:            ['initiative.create', 'initiative.read', 'initiative.comment', 'gate.2', 'analytics.expert', 'community', 'survey.answer', 'bestpractice.publish',
                      'idea.create', 'idea.propose', 'idea.review', 'idea.moderate', 'idea.incentive'],
  developer:         ['initiative.read', 'initiative.comment', 'gate.3', 'project.manage', 'board.manage', 'docs.manage', 'community', 'survey.answer',
                      'idea.create', 'idea.propose', 'idea.review'],
  supplier:          ['initiative.read', 'initiative.comment', 'community', 'project.contribute',
                      'idea.propose', 'idea.review'],
  pilot_coordinator: ['initiative.read', 'initiative.comment', 'gate.4', 'pilot.manage', 'pilot.feedback', 'survey.manage', 'analytics.pilot', 'community', 'survey.answer',
                      'idea.create', 'idea.propose', 'idea.review'],
  dtszn:             ['initiative.create', 'initiative.read', 'initiative.comment', 'gate.2', 'gate.5', 'analytics.all', 'admin', 'workflow.configure', 'audit.read', 'community', 'rollout.manage', 'bestpractice.publish', 'awards.grant', 'survey.answer', 'pilot.manage',
                      'idea.create', 'idea.propose', 'idea.review', 'idea.moderate', 'idea.incentive', 'idea.incentive.decide', 'idea.admin'],
};

export function can(user, permission) {
  if (!user) return false;
  return (PERMISSIONS[user.role] || []).includes(permission);
}

export function permissionsOf(role) {
  return PERMISSIONS[role] || [];
}

export function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  const hash = scryptSync(password, salt, 64).toString('hex');
  return { hash, salt };
}

export function verifyPassword(password, hash, salt) {
  const attempt = scryptSync(password, salt, 64);
  const stored = Buffer.from(hash, 'hex');
  return stored.length === attempt.length && timingSafeEqual(stored, attempt);
}

export function createSession(userId, ip, userAgent) {
  const token = randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString().slice(0, 19).replace('T', ' ');
  q.run(
    'INSERT INTO sessions (token, user_id, expires_at, ip, user_agent) VALUES (?,?,?,?,?)',
    token, userId, expires, ip || '', (userAgent || '').slice(0, 200)
  );
  q.run("UPDATE users SET last_login_at = datetime('now') WHERE id = ?", userId);
  return token;
}

export function userFromToken(token) {
  if (!token) return null;
  const row = q.get(`
    SELECT u.*, i.name AS institution_name, i.short_name AS institution_short, i.kind AS institution_kind
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    LEFT JOIN institutions i ON i.id = u.institution_id
    WHERE s.token = ? AND s.expires_at > datetime('now') AND u.is_active = 1
  `, token);
  if (!row) return null;
  delete row.password_hash;
  delete row.password_salt;
  return row;
}

export function destroySession(token) {
  q.run('DELETE FROM sessions WHERE token = ?', token);
}

export function publicUser(u) {
  if (!u) return null;
  const { password_hash, password_salt, ...rest } = u;
  return { ...rest, role_title: ROLES[u.role]?.title || u.role, permissions: permissionsOf(u.role) };
}
