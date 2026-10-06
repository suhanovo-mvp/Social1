import { route, readJson, HttpError } from '../http.js';
import { q } from '../db.js';
import { roleMap, roleTitle, createSession, destroySession, verifyPassword, publicUser, permissionsOf } from '../auth.js';
import { logAction } from '../audit.js';

route.post('/api/auth/login', async ({ req, res, ip, sendJson }) => {
  const { email, password } = await readJson(req);
  if (!email || !password) throw new HttpError(400, 'Укажите e-mail и пароль');
  const user = q.get('SELECT * FROM users WHERE lower(email) = lower(?)', String(email).trim());
  if (!user || !user.is_active || !verifyPassword(password, user.password_hash, user.password_salt)) {
    logAction(user?.id ?? null, 'auth.failed', 'user', user?.id ?? null, { email }, ip);
    throw new HttpError(401, 'Неверный e-mail или пароль');
  }
  const token = createSession(user.id, ip, req.headers['user-agent']);
  logAction(user.id, 'auth.login', 'user', user.id, null, ip);
  res.setHeader('Set-Cookie', `s1=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${7 * 86400}`);
  const full = q.get(`SELECT u.*, i.name AS institution_name, i.short_name AS institution_short, i.kind AS institution_kind
                      FROM users u LEFT JOIN institutions i ON i.id = u.institution_id WHERE u.id = ?`, user.id);
  sendJson(200, { user: publicUser(full), token });
}, { public: true });

route.post('/api/auth/logout', async ({ res, token, user, ip, sendJson }) => {
  if (token) destroySession(token);
  if (user) logAction(user.id, 'auth.logout', 'user', user.id, null, ip);
  res.setHeader('Set-Cookie', 's1=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
  sendJson(200, { ok: true });
}, { public: true });

route.get('/api/auth/me', async ({ user, sendJson }) => {
  if (!user) throw new HttpError(401, 'Требуется вход в систему');
  const counts = {
    tasks: q.get(`SELECT COUNT(*) AS c FROM tasks WHERE status IN ('open','escalated')
                  AND (user_id = ? OR (role_target = ? AND (institution_id IS NULL OR institution_id = ?)))`,
      user.id, user.role, user.institution_id).c,
    notifications: q.get('SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND is_read = 0', user.id).c,
  };
  sendJson(200, { user: publicUser(user), counts });
}, { public: true });

route.get('/api/auth/roles', async ({ sendJson }) => {
  sendJson(200, Object.entries(roleMap()).map(([key, v]) => ({ key, ...v, permissions: permissionsOf(key) })));
}, { public: true });

// Демонстрационные учётные записи для быстрого входа под разными ролями
route.get('/api/auth/demo-accounts', async ({ sendJson }) => {
  const rows = q.all(`SELECT u.email, u.full_name, u.role, u.position, i.short_name AS institution
                      FROM users u LEFT JOIN institutions i ON i.id = u.institution_id
                      WHERE u.is_active = 1 ORDER BY
                      CASE u.role WHEN 'employee' THEN 1 WHEN 'head' THEN 2 WHEN 'expert' THEN 3
                      WHEN 'developer' THEN 4 WHEN 'pilot_coordinator' THEN 5 WHEN 'supplier' THEN 6
                      ELSE 7 END, u.id`);
  const seen = new Set();
  const picked = rows.filter((r) => (seen.has(r.role) ? false : seen.add(r.role)));
  sendJson(200, picked.map((r) => ({ ...r, role_title: roleTitle(r.role), password: 'social1' })));
}, { public: true });
