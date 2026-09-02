// Неизменяемый журнал аудита: каждая запись связана хэшем с предыдущей.
// Подмена или удаление записи задним числом ломает цепочку и выявляется проверкой.
import { createHash } from 'node:crypto';
import { q } from './db.js';

export function logAction(userId, action, entity, entityId, details, ip) {
  const prev = q.get('SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1');
  const prevHash = prev?.hash || 'GENESIS';
  const at = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const payload = JSON.stringify(details ?? null);
  const hash = createHash('sha256')
    .update([prevHash, at, userId ?? '', action, entity ?? '', entityId ?? '', payload].join('|'))
    .digest('hex');
  q.run(
    'INSERT INTO audit_log (at, user_id, action, entity, entity_id, details, ip, prev_hash, hash) VALUES (?,?,?,?,?,?,?,?,?)',
    at, userId ?? null, action, entity ?? null, entityId ?? null, payload, ip || '', prevHash, hash
  );
  return hash;
}

// Проверка целостности цепочки — доступна ДТСЗН в разделе аудита
export function verifyChain() {
  const rows = q.all('SELECT * FROM audit_log ORDER BY id ASC');
  let prevHash = 'GENESIS';
  for (const r of rows) {
    const expected = createHash('sha256')
      .update([prevHash, r.at, r.user_id ?? '', r.action, r.entity ?? '', r.entity_id ?? '', r.details].join('|'))
      .digest('hex');
    if (r.prev_hash !== prevHash || r.hash !== expected) {
      return { valid: false, brokenAt: r.id, checked: rows.length };
    }
    prevHash = r.hash;
  }
  return { valid: true, checked: rows.length, head: prevHash };
}
