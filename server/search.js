// Поиск по базе знаний и всему, что платформа накопила.
//
// Ищут не по названию документа, а по тому, как проблему формулируют своими
// словами: «возврат заявления», «вернули заявление», «возвраты заявлений». Поэтому
// перед индексацией слова приводятся к основе — иначе поиск находил бы только тех,
// кто угадал форму слова.
//
// Это лексический поиск с ранжированием BM25, а не семантический: без внешней
// модели эмбеддингов связь по смыслу честно не построить, и называть его
// семантическим было бы обманом. Зато он не требует ни одной зависимости.
import { db, q, tx } from './db.js';
import { on } from './events.js';

// unicode61 разбирает кириллицу и убирает диакритику; ранжирование BM25 встроено
db.exec(`
CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
  title, body, stems,
  entity_type UNINDEXED, entity_id UNINDEXED, subtitle UNINDEXED, url UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2'
);
`);

// ─────────────────────────────────────────────────────────────
// Приведение слов к основе
// ─────────────────────────────────────────────────────────────
// Нормализация идёт в два шага, и порядок здесь принципиален: сначала слово
// обрезается до основы, и только потом снимается окончание. Обратный порядок —
// снять окончание, потом обрезать — давал расхождение у слов одного гнезда:
// «решений» превращалось в «решен», а «решения» в «решени», и они переставали
// находить друг друга. Русский изменяет слово с конца, поэтому обрезание первым
// сводит все формы к общему началу по построению.
//
// Плата за простоту — редкие ложные слияния однокоренных слов («пилот» и
// «пилотаж»). Для базы знаний департамента это дешевле, чем пропущенный документ.
const STEM_LEN = 6;
const PAIR_ENDINGS = ['ом','ем','ой','ей','ов','ев','ам','ям','ах','ях','ми','ый','ий','ая','ое','ые','ие'];
const VOWEL_ENDINGS = ['а','е','и','й','о','у','ы','ь','я','ю'];

/** Основа слова для поиска: одна и та же у всех его форм. */
export function stem(word) {
  let w = String(word).toLowerCase().replace(/ё/g, 'е');
  if (w.length > STEM_LEN) w = w.slice(0, STEM_LEN);
  if (w.length > 4) {
    for (const e of PAIR_ENDINGS) if (w.endsWith(e)) return w.slice(0, -e.length);
  }
  if (w.length > 3 && VOWEL_ENDINGS.includes(w.at(-1))) return w.slice(0, -1);
  return w;
}

export const stemsOf = (text) =>
  String(text ?? '').toLowerCase().split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 2).map(stem);

// ─────────────────────────────────────────────────────────────
// Индекс
// ─────────────────────────────────────────────────────────────
export function indexEntity({ type, id, title, subtitle = null, text = '', url = null }) {
  removeEntity(type, id);
  const body = String(text ?? '');
  q.run(`INSERT INTO search_index (title, body, stems, entity_type, entity_id, subtitle, url)
         VALUES (?,?,?,?,?,?,?)`,
    String(title ?? ''), body,
    [...stemsOf(title), ...stemsOf(body)].join(' '),
    type, Number(id), subtitle, url);
}

export const removeEntity = (type, id) =>
  q.run('DELETE FROM search_index WHERE entity_type = ? AND entity_id = ?', type, Number(id));

/** Экранирование для FTS5: кавычки в запросе ломают его разбор. */
const term = (t) => `"${t.replace(/"/g, '""')}"`;

/**
 * Поиск. Запрос приводится к основам и ищется по ним же — так «возвраты заявлений»
 * находят документ, где написано «вернули заявление».
 */
export function search(query, { types = null, limit = 20 } = {}) {
  const stems = [...new Set(stemsOf(query))];
  if (!stems.length) return [];

  // Ищем и по основам, и по исходным словам: основы дают охват словоформ,
  // исходные слова — точное совпадение, которое можно подсветить в выдержке
  const words = [...new Set(String(query).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2))];
  const clauses = [
    ...stems.map((x) => `stems: ${term(x)}`),
    ...words.map((x) => `title: ${term(x)}`),
    ...words.map((x) => `body: ${term(x)}`),
  ];
  const where = ['search_index MATCH ?'];
  const args = [clauses.join(' OR ')];
  if (types?.length) {
    where.push(`entity_type IN (${types.map(() => '?').join(',')})`);
    args.push(...types);
  }
  return q.all(`SELECT entity_type, entity_id, title, subtitle, url,
                       snippet(search_index, 1, '⟪', '⟫', '…', 18) AS excerpt,
                       bm25(search_index, 6.0, 1.0, 2.0) AS score
                FROM search_index
                WHERE ${where.join(' AND ')}
                ORDER BY score LIMIT ?`, ...args, limit)
    .map((r) => ({ ...r, score: -r.score }));   // bm25 отдаёт тем меньше, чем релевантнее
}

/**
 * Похожее на текст — проактивная подсказка «это уже разбирали».
 * Тот же поиск, но запросом служит сам текст идеи или проекта решения.
 */
export function similarTo(text, { types = null, limit = 5, exclude = null } = {}) {
  return search(text, { types, limit: limit + 3 })
    .filter((r) => !(exclude && r.entity_type === exclude.type && r.entity_id === exclude.id))
    .slice(0, limit);
}

// ─────────────────────────────────────────────────────────────
// Что попадает в индекс
// ─────────────────────────────────────────────────────────────
const SOURCES = {
  knowledge_doc: () => q.all(`SELECT d.id, d.number, d.kind, d.title, v.body
                              FROM knowledge_docs d
                              LEFT JOIN knowledge_versions v ON v.id = d.current_version_id
                              WHERE d.status IN ('published','accepted')`)
    .map((r) => ({ id: r.id, title: r.title, subtitle: `${r.number}`, text: r.body ?? '',
                   url: `/knowledge/${r.id}` })),

  idea: () => q.all("SELECT id, number, title, problem, desired_result FROM ideas WHERE status != 'archived'")
    .map((r) => ({ id: r.id, title: r.title, subtitle: r.number,
                   text: `${r.problem} ${r.desired_result}`, url: `/ideas/${r.id}` })),

  proposal: () => q.all(`SELECT p.id, p.summary, p.how_to_apply, p.expected_effect, i.title AS idea_title
                         FROM proposals p JOIN ideas i ON i.id = p.idea_id
                         WHERE p.status != 'rejected'`)
    .map((r) => ({ id: r.id, title: r.summary, subtitle: `Решение по идее «${r.idea_title}»`,
                   text: `${r.how_to_apply ?? ''} ${r.expected_effect ?? ''}` })),

  practice: () => q.all('SELECT id, title, summary, effect_text FROM best_practices')
    .map((r) => ({ id: r.id, title: r.title, subtitle: 'Лучшая практика',
                   text: `${r.summary} ${r.effect_text ?? ''}`, url: '/practices' })),

  process: () => q.all(`SELECT d.id, d.key, d.title, d.description, v.model
                        FROM process_defs d
                        LEFT JOIN process_versions v ON v.id = d.current_version_id`)
    .map((r) => {
      // В схему входят подписи шагов: по ним её и ищут — «где согласование заявки»
      let labels = '';
      try { labels = JSON.parse(r.model ?? '{}').nodes?.map((n) => n.label).join(' ') ?? ''; } catch {}
      return { id: r.id, title: r.title, subtitle: 'Схема процесса',
               text: `${r.description ?? ''} ${labels}`, url: `/processes?d=${r.key}` };
    }),
};

export const SEARCHABLE = Object.keys(SOURCES);

/** Полная пересборка индекса — при первом запуске и по требованию администратора. */
export function reindexAll() {
  return tx(() => {
    q.run('DELETE FROM search_index');
    let n = 0;
    for (const [type, load] of Object.entries(SOURCES)) {
      for (const row of load()) { indexEntity({ type, ...row }); n += 1; }
    }
    return n;
  });
}

export function ensureSearchIndex() {
  if (q.get('SELECT COUNT(*) AS c FROM search_index').c > 0) return 0;
  return reindexAll();
}

/** Переиндексировать один документ базы знаний. */
export function reindexDoc(docId) {
  const d = q.get(`SELECT d.id, d.number, d.title, d.status, v.body FROM knowledge_docs d
                   LEFT JOIN knowledge_versions v ON v.id = d.current_version_id
                   WHERE d.id = ?`, Number(docId));
  if (!d) return;
  if (!['published', 'accepted'].includes(d.status)) return removeEntity('knowledge_doc', docId);
  indexEntity({ type: 'knowledge_doc', id: d.id, title: d.title, subtitle: d.number,
                text: d.body ?? '', url: `/knowledge/${d.id}` });
}

// Индекс поддерживается событиями, а не расписанием: опубликованное решение
// должно находиться сразу, иначе следующий автор его не увидит
on('doc.published', 'поиск: индексация опубликованного решения', (e) => reindexDoc(e.subjectId));
on('doc.accepted', 'поиск: индексация согласованного решения', (e) => reindexDoc(e.subjectId));
on('doc.superseded', 'поиск: снятие заменённого решения', (e) => reindexDoc(e.subjectId));
on('process_change.published', 'поиск: переиндексация изменённой схемы', () => {
  for (const row of SOURCES.process()) indexEntity({ type: 'process', ...row });
});
