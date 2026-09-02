// Модуль ИИ-поддержки. Все алгоритмы объяснимые: система возвращает не только
// результат, но и факторы, которые к нему привели. ИИ поддерживает человека,
// но не принимает решения на Gate — это требование ТЗ.
import { q } from './db.js';

export const CATEGORIES = {
  'Обработка заявлений и документооборот': ['заявлен', 'документ', 'справк', 'бумаг', 'анкет', 'бланк', 'подпис', 'архив', 'реестр', 'дело', 'копи', 'выписк'],
  'Взаимодействие с гражданами': ['гражданин', 'граждан', 'посетител', 'получател', 'клиент', 'очеред', 'запись', 'приём', 'прием', 'консультац', 'обращен', 'жалоб'],
  'Внутренние процессы и регламенты': ['регламент', 'процесс', 'процедур', 'инструкц', 'согласован', 'отчёт', 'отчет', 'дублиров', 'рутин', 'бюрократ', 'норматив'],
  'Цифровые сервисы и автоматизация': ['цифров', 'автоматиз', 'систем', 'приложен', 'сервис', 'портал', 'онлайн', 'электрон', 'интеграц', 'база данных', 'бот', 'смс', 'уведомлен'],
  'Социальные услуги и обслуживание': ['услуг', 'обслуживан', 'надомн', 'патронаж', 'социальн работник', 'помощ', 'выплат', 'пособи', 'льгот', 'адресн'],
  'Доступная среда и реабилитация': ['инвалид', 'реабилитац', 'доступн среда', 'тсp', 'протез', 'колясk', 'маломобильн', 'абилитац', 'адаптац'],
  'Кадры, обучение и наставничество': ['сотрудник', 'обучен', 'наставник', 'кадр', 'персонал', 'адаптац новичк', 'стажир', 'компетенц', 'выгоран', 'текучест'],
  'Межведомственное взаимодействие': ['межведомствен', 'смэв', 'пфр', 'сфр', 'мфц', 'поликлиник', 'ведомств', 'запрос в'],
  'Аналитика и отчётность': ['аналитик', 'статистик', 'показател', 'мониторинг', 'дашборд', 'kpi', 'кпэ', 'сводк'],
};

// Упрощённая нормализация русского текста: приведение к нижнему регистру и
// отсечение частотных окончаний. Достаточно для сопоставления по темам.
const STOP = new Set(['и','в','во','не','что','он','на','я','с','со','как','а','то','все','она','так','его','но','да','ты','к','у','же','вы','за','бы','по','только','ее','мне','было','вот','от','меня','еще','нет','о','из','ему','теперь','когда','даже','ну','вдруг','ли','если','уже','или','ни','быть','был','него','до','вас','нибудь','опять','уж','вам','ведь','там','потом','себя','ничего','ей','может','они','тут','где','есть','надо','ней','для','мы','тебя','их','чем','была','сам','чтоб','без','будто','чего','раз','тоже','себе','под','будет','ж','тогда','кто','этот','того','потому','этого','какой','совсем','ним','здесь','этом','один','почти','мой','тем','чтобы','нее','сейчас','были','куда','зачем','всех','никогда','можно','при','наконец','два','об','другой','хоть','после','над','больше','тот','через','эти','нас','про','всего','них','какая','много','разве','три','эту','моя','впрочем','хорошо','свою','этой','перед','иногда','лучше','чуть','том','нельзя','такой','им','более','всегда','конечно','всю','между']);

function tokens(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .split(/[^a-zа-я0-9]+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
}

function stem(w) {
  return w.replace(/(ами|ями|ов|ев|ий|ая|ое|ые|ыми|ому|ему|ого|его|ать|ять|ить|ена|ение|ения|ений|ует|ают|ляет|ность|ности|ам|ям|ах|ях|ой|ей|у|ю|а|я|ы|и|е|о)$/u, '');
}

/** Автоматическая классификация инициативы по тематическим направлениям. */
export function classify(text) {
  const t = String(text || '').toLowerCase().replace(/ё/g, 'е');
  const scored = [];
  for (const [category, keys] of Object.entries(CATEGORIES)) {
    const matched = keys.filter((k) => t.includes(k));
    if (matched.length) scored.push({ category, hits: matched.length, matched });
  }
  scored.sort((a, b) => b.hits - a.hits);
  if (!scored.length) {
    return { category: 'Внутренние процессы и регламенты', confidence: 0.2, matched: [], alternatives: [],
      rationale: 'Явных тематических признаков не найдено — присвоена категория по умолчанию. Рекомендуется уточнение экспертом.' };
  }
  const total = scored.reduce((s, x) => s + x.hits, 0);
  const top = scored[0];
  return {
    category: top.category,
    confidence: Math.min(0.95, top.hits / total + 0.15),
    matched: top.matched,
    alternatives: scored.slice(1, 3).map((x) => ({ category: x.category, hits: x.hits })),
    rationale: `Отнесено к направлению «${top.category}» по ключевым признакам: ${top.matched.join(', ')}.`,
  };
}

/** Поиск похожих инициатив — предотвращает дублирование усилий. */
export function findSimilar(text, excludeId = null, limit = 5) {
  const queryTokens = new Set(tokens(text).map(stem));
  if (!queryTokens.size) return [];
  const rows = q.all(`SELECT id, number, title, problem, solution, stage, status, category
                      FROM initiatives ${excludeId ? 'WHERE id != ?' : ''}`, ...(excludeId ? [excludeId] : []));

  // IDF по корпусу инициатив: редкие слова весят больше частотных
  const docTokens = rows.map((r) => new Set(tokens(`${r.title} ${r.problem} ${r.solution}`).map(stem)));
  const df = new Map();
  for (const set of docTokens) for (const w of set) df.set(w, (df.get(w) || 0) + 1);
  const N = Math.max(1, rows.length);

  const scored = rows.map((r, i) => {
    const set = docTokens[i];
    let num = 0, common = [];
    for (const w of queryTokens) {
      if (set.has(w)) {
        num += Math.log(1 + N / (1 + (df.get(w) || 0)));
        common.push(w);
      }
    }
    const denom = Math.sqrt(queryTokens.size) * Math.sqrt(set.size || 1);
    return { ...r, score: denom ? num / denom : 0, common: common.slice(0, 8) };
  });

  return scored
    .filter((r) => r.score > 0.08)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((r) => ({
      id: r.id, number: r.number, title: r.title, stage: r.stage, status: r.status, category: r.category,
      similarity: Math.round(Math.min(0.99, r.score) * 100),
      rationale: `Совпадающие смысловые признаки: ${r.common.join(', ')}.`,
    }));
}

const POSITIVE = ['удобн','быстр','проще','понятн','нравится','отличн','хорош','экономи','полезн','сократ','улучш','эффективн','довол','рекоменду','спасибо','помога'];
const NEGATIVE = ['неудобн','медленн','сложн','непонятн','ошибк','сбой','зависа','проблем','плох','дольше','мешает','не работает','раздража','путан','лишн','трудно'];

/** NLP-анализ обратной связи: тональность, темы, проблемные сигналы. */
export function analyzeFeedback(texts) {
  const list = (texts || []).map((t) => String(t || '')).filter(Boolean);
  if (!list.length) return { count: 0, sentiment: 0, positive: 0, negative: 0, neutral: 0, themes: [], signals: [] };

  let pos = 0, neg = 0, neu = 0;
  const signals = [];
  const freq = new Map();

  for (const raw of list) {
    const t = raw.toLowerCase().replace(/ё/g, 'е');
    const p = POSITIVE.filter((k) => t.includes(k)).length;
    const n = NEGATIVE.filter((k) => t.includes(k)).length;
    if (p > n) pos += 1; else if (n > p) { neg += 1; signals.push(raw.slice(0, 160)); } else neu += 1;
    for (const w of tokens(t).map(stem)) freq.set(w, (freq.get(w) || 0) + 1);
  }

  const themes = [...freq.entries()]
    .filter(([w, c]) => c >= 2 && w.length > 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([word, count]) => ({ word, count }));

  const sentiment = Math.round(((pos - neg) / list.length) * 100) / 100;
  return {
    count: list.length, sentiment, positive: pos, negative: neg, neutral: neu, themes,
    signals: signals.slice(0, 5),
    rationale: `Проанализировано ${list.length} откликов по словарям тональности. Положительных — ${pos}, отрицательных — ${neg}, нейтральных — ${neu}.`,
  };
}

/**
 * Прогноз вероятности успешного прохождения цикла.
 * Модель прозрачная: каждый фактор виден пользователю с его вкладом в оценку.
 * Носит рекомендательный характер и не заменяет решение человека на Gate.
 */
export function predictSuccess(initiative) {
  const factors = [];
  let score = 0.35;

  const textLen = `${initiative.problem || ''} ${initiative.solution || ''}`.length;
  if (textLen > 600) { score += 0.12; factors.push({ name: 'Детальная проработка описания', impact: +0.12 }); }
  else if (textLen < 200) { score -= 0.10; factors.push({ name: 'Слишком краткое описание проблемы и решения', impact: -0.10 }); }

  if (initiative.effect_value && initiative.effect_value > 0) {
    score += 0.14; factors.push({ name: 'Эффект выражен количественно', impact: +0.14 });
  } else {
    score -= 0.08; factors.push({ name: 'Эффект не измерен количественно', impact: -0.08 });
  }

  const catStats = q.get(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN status='scaled' THEN 1 ELSE 0 END) AS scaled
    FROM initiatives WHERE category = ? AND id != ?`, initiative.category || '', initiative.id || 0);
  if (catStats && catStats.total >= 3) {
    const rate = (catStats.scaled || 0) / catStats.total;
    const impact = Math.round((rate - 0.3) * 40) / 100;
    score += impact;
    factors.push({ name: `Историческая успешность направления «${initiative.category}» — ${Math.round(rate * 100)}%`, impact });
  }

  const support = q.get(`SELECT COALESCE(SUM(value),0) AS score,
                                SUM(CASE WHEN value=1 THEN 1 ELSE 0 END) AS up
                         FROM votes WHERE initiative_id = ?`, initiative.id || 0);
  if (support && support.up > 0) {
    // Поддержка коллег — независимый сигнал востребованности решения
    const impact = Math.max(-0.10, Math.min(0.16, (support.score || 0) * 0.02));
    score += impact;
    factors.push({
      name: impact >= 0
        ? `Инициативу поддержали коллеги: ${support.score} ${support.score === 1 ? 'голос' : 'голосов'}`
        : `Преобладают голоса против: ${support.score}`,
      impact: Math.round(impact * 100) / 100,
    });
  }

  const similar = findSimilar(`${initiative.title} ${initiative.problem}`, initiative.id, 3);
  if (similar.length && similar[0].similarity > 45) {
    score -= 0.12;
    factors.push({ name: `Есть похожая инициатива ${similar[0].number} (${similar[0].similarity}%) — риск дублирования`, impact: -0.12 });
  }

  const authorStats = q.get(`
    SELECT COUNT(*) AS total, SUM(CASE WHEN stage >= 4 THEN 1 ELSE 0 END) AS advanced
    FROM initiatives WHERE author_id = ? AND id != ?`, initiative.author_id || 0, initiative.id || 0);
  if (authorStats && authorStats.total > 0 && authorStats.advanced > 0) {
    score += 0.08;
    factors.push({ name: 'У автора есть инициативы, дошедшие до разработки', impact: +0.08 });
  }

  const probability = Math.max(0.05, Math.min(0.95, score));
  return {
    probability: Math.round(probability * 100),
    factors: factors.sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact)),
    disclaimer: 'Оценка носит рекомендательный характер. Решение на Gate принимает уполномоченный участник, а не алгоритм.',
    similar,
  };
}
