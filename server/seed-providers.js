// Демонстрационный набор каталога разработчиков ИИ-решений: по три разработчика
// каждого вида.
//
// Все организации, ИНН, адреса и контакты вымышлены: домены — из зарезервированной
// зоны .example, ИНН не проходят проверку контрольной суммы. Записи помечены
// признаком is_demo — в интерфейсе они подписаны «демо» и убираются одной
// командой, не задевая введённых вручную.
//
// Набор подобран так, чтобы показать все возможности раздела: разные статусы и
// загрузку, разработчика без портфолио (низкая заполненность), давно не
// обновлявшуюся карточку (метка «сверить») и компетенцию, которой нет ни у кого
// (рекомендательные системы), — она появится в подсказке о пробелах.
//
// При запуске сервера набор не заводится: удалённые демо-данные не должны
// возвращаться сами. Он входит в `npm run seed` и отдельно ставится командой
// `npm run seed:providers`.
import { fileURLToPath } from 'node:url';
import { q, tx } from './db.js';
import { ensureRoles, grantRole } from './auth.js';
import * as pr from './providers.js';

const daysAgo = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);

export const SAMPLE_PROVIDERS = [
  // ── Внешние вендоры ────────────────────────────────────────
  {
    kind: 'external', name: 'ООО «Нейросоциум»',
    legal_name: 'Общество с ограниченной ответственностью «Нейросоциум»', inn: '7700000011',
    city: 'Москва', team_size: 60, founded_year: 2016, website: 'https://neurosocium.example',
    description: 'Разрабатывают виртуальных консультантов и поиск по нормативной базе для органов '
      + 'социальной защиты. Своя платформа диалоговых ассистентов, работа в закрытом контуре заказчика.',
    contact_name: 'Орлова Мария Сергеевна', contact_role: 'Директор по работе с госсектором',
    contact_email: 'm.orlova@neurosocium.example', contact_phone: '+7 495 000-11-01',
    status: 'engaged', availability: 'limited', price_band: 2,
    competencies: ['llm', 'rag', 'chatbot', 'nlp'], domains: ['social', 'gov'],
    compliance: ['ru_registry', 'pdn', 'on_prem', 'gov_contracts', 'msp'],
    tags: ['Python', 'GigaChat', 'YandexGPT', 'PostgreSQL', 'Elasticsearch'],
    cases: [
      { title: 'Виртуальный консультант по мерам социальной поддержки', customer: 'Региональный орган соцзащиты',
        year: 2024, public_sector: true, tags: ['GigaChat', 'RAG'],
        description: 'Ассистент на портале и в мессенджере отвечает на вопросы о пособиях и льготах, '
          + 'проверяет право на меру по ответам заявителя и ведёт к подаче заявления.',
        result: '62% обращений закрываются без оператора, время ответа — с 2 дней до минуты' },
      { title: 'Поиск по нормативной базе для специалистов', customer: 'Центр социального обслуживания',
        year: 2025, public_sector: true, tags: ['Elasticsearch', 'YandexGPT'],
        description: 'Специалист задаёт вопрос обычным языком и получает ответ со ссылкой на пункт регламента.',
        result: 'Время поиска нормы сократилось с 20 до 3 минут' },
    ],
    solutions: [
      { name: 'Социум.Ассистент', kind: 'platform', maturity: 'production', license: 'proprietary', in_registry: true,
        competencies: ['llm', 'chatbot', 'rag'], tags: ['GigaChat', 'YandexGPT'],
        description: 'Платформа диалоговых ассистентов для граждан и сотрудников: сценарии, база знаний, '
          + 'передача оператору, журнал диалогов.', price_note: 'Лицензия на инсталляцию плюс сопровождение' },
      { name: 'Социум.Поиск', kind: 'product', maturity: 'pilot', license: 'proprietary',
        competencies: ['rag', 'nlp'], tags: ['Elasticsearch'],
        description: 'Смысловой поиск по регламентам и приказам с цитированием источника.' },
    ],
    reviews: [
      { email: 'director@social1.mos.ru', quality: 5, deadlines: 4, communication: 5,
        context: 'Пилот консультанта в ТЦСО «Ярославский»', comment: 'Сильная команда, сдвинули срок на неделю из-за интеграции.' },
      { email: 'lebedeva@social1.mos.ru', quality: 4, deadlines: 4, communication: 5,
        context: 'Экспертиза решения', comment: 'Ответы точные, но требуется регулярное обновление базы знаний.' },
    ],
    notes: [
      { kind: 'demo', days: 95, body: 'Показали консультанта на реальных вопросах о пособиях. Договорились о пилоте.' },
      { kind: 'meeting', days: 40, body: 'Промежуточные итоги пилота: 58% обращений без оператора. Согласовали расширение базы знаний.' },
      { kind: 'rfi', days: 6, body: 'Запросили оценку стоимости тиражирования на 10 учреждений.' },
    ],
  },
  {
    kind: 'external', name: 'АО «Зоркий Код»',
    legal_name: 'Акционерное общество «Зоркий Код»', inn: '7800000022',
    city: 'Санкт-Петербург', team_size: 180, founded_year: 2011, website: 'https://zorkiy-kod.example',
    description: 'Компьютерное зрение и распознавание документов. Аттестованные решения для работы '
      + 'с персональными данными, большой опыт государственных закупок.',
    contact_name: 'Ким Денис Олегович', contact_role: 'Руководитель направления госсектора',
    contact_email: 'd.kim@zorkiy-kod.example', contact_phone: '+7 812 000-22-02',
    status: 'qualified', availability: 'available', price_band: 3,
    competencies: ['cv', 'ocr', 'data'], domains: ['gov', 'city', 'health'],
    compliance: ['ru_registry', 'fstec', 'pdn', 'on_prem', 'gov_contracts'],
    tags: ['PyTorch', 'OpenCV', 'Kubernetes', 'ClickHouse'],
    cases: [
      { title: 'Распознавание документов заявителей в центрах госуслуг', customer: 'Региональная сеть центров госуслуг',
        year: 2023, public_sector: true, tags: ['OCR', 'PyTorch'],
        description: 'Автоматическое заполнение заявления по скану паспорта, СНИЛС и справок.',
        result: 'Ввод одного заявления — с 9 до 2 минут, ошибки ввода снизились в 4 раза' },
      { title: 'Учёт посещаемости социальных объектов', customer: 'Городская служба',
        year: 2025, public_sector: true, tags: ['OpenCV'],
        description: 'Обезличенный подсчёт посетителей по видеопотоку без хранения изображений лиц.',
        result: 'График работы персонала перестроен под фактическую нагрузку' },
    ],
    solutions: [
      { name: 'Зоркий.Документ', kind: 'product', maturity: 'production', license: 'proprietary', in_registry: true,
        competencies: ['ocr', 'cv'], tags: ['OCR', 'PyTorch'],
        description: 'Распознавание 120 типов документов с проверкой полей и выгрузкой в учётную систему.',
        price_note: 'Годовая лицензия по числу рабочих мест' },
      { name: 'Зоркий.Поток', kind: 'product', maturity: 'pilot', license: 'proprietary',
        competencies: ['cv'], tags: ['OpenCV'],
        description: 'Обезличенная видеоаналитика: подсчёт посетителей, очереди, заполненность помещений.' },
    ],
    reviews: [
      { email: 'grigoriev@social1.mos.ru', quality: 4, deadlines: 3, communication: 4,
        context: 'Демонстрация на документах получателей', comment: 'Распознавание отличное, но интеграция с нашей учётной системой требует доработки.' },
    ],
    notes: [
      { kind: 'rfi', days: 30, body: 'Направили запрос о развёртывании в закрытом контуре и аттестации ФСТЭК.' },
      { kind: 'letter', days: 18, body: 'Получили ответ: аттестат есть, развёртывание на наших серверах возможно, срок — 6 недель.' },
    ],
  },
  {
    // Давно не обновлялся и без контактов — показывает метку «сверить» и низкую заполненность
    kind: 'external', name: 'ООО «Тембр Лаб»',
    inn: '1600000033', city: 'Казань', team_size: 18, founded_year: 2020,
    description: 'Небольшая команда: голосовые роботы для записи и напоминаний.',
    status: 'screening', availability: 'unknown', price_band: 1,
    competencies: ['speech', 'chatbot'], domains: ['health'],
    compliance: ['msp'],
    tags: ['Whisper', 'Asterisk'],
    stale_days: 240,
    cases: [
      { title: 'Голосовой робот записи к врачу', customer: 'Сеть частных клиник', year: 2023, public_sector: false,
        tags: ['Asterisk'], description: 'Робот принимает звонки, записывает на приём и напоминает о визите.',
        result: 'Пропущенных звонков стало меньше на 40%' },
    ],
    solutions: [
      { name: 'ТембрБот', kind: 'product', maturity: 'pilot', license: 'saas',
        competencies: ['speech', 'chatbot'], tags: ['Whisper'],
        description: 'Облачный голосовой робот для входящих и исходящих звонков.',
        price_note: 'Помесячная оплата за минуты разговоров' },
    ],
    reviews: [],
    notes: [
      { kind: 'call', days: 245, body: 'Первичный звонок. Опыта работы с госсектором нет, данные хранят в облаке.' },
    ],
  },

  // ── Внутренние команды ─────────────────────────────────────
  {
    kind: 'internal', name: 'Команда цифровизации ТЦСО «Ярославский»',
    org_unit: 'ТЦСО «Ярославский», отдел информационных технологий', city: 'Москва', team_size: 5,
    description: 'Сотрудники центра, которые автоматизируют рутинные операции специалистов своими силами: '
      + 'роботы сверки списков, выгрузки, заполнение типовых форм.',
    contact_name: 'Никитин Павел Андреевич', contact_role: 'Начальник отдела ИТ',
    contact_email: 'nikitin@social1.mos.ru', contact_phone: '+7 495 000-33-03',
    status: 'engaged', availability: 'available',
    competencies: ['rpa', 'data'], domains: ['social'],
    compliance: ['pdn'],
    tags: ['PIX RPA', 'Python', 'Excel'],
    cases: [
      { title: 'Робот сверки списков получателей', customer: 'ТЦСО «Ярославский»', year: 2025, public_sector: true,
        tags: ['PIX RPA'], description: 'Робот сверяет списки получателей услуг с данными учётной системы и готовит расхождения.',
        result: 'Ежемесячная сверка — с 4 часов до 15 минут' },
      { title: 'Автоматическая подготовка отчёта для ДТСЗН', customer: 'ТЦСО «Ярославский»', year: 2024, public_sector: true,
        tags: ['Python'], description: 'Сбор показателей из трёх систем в единую форму отчётности.',
        result: 'Отчёт готов в первый рабочий день месяца вместо пятого' },
    ],
    solutions: [
      { name: 'Роботизация рутинных операций', kind: 'service', maturity: 'production',
        competencies: ['rpa'], tags: ['PIX RPA'],
        description: 'Разработка программных роботов под операции специалиста: от описания до запуска за 2–3 недели.' },
    ],
    reviews: [
      { email: 'volkov@social1.mos.ru', quality: 5, deadlines: 5, communication: 4,
        context: 'Робот сверки списков', comment: 'Сделали быстро и без внешнего подрядчика. Готовы тиражировать.' },
    ],
    notes: [
      { kind: 'meeting', days: 12, body: 'Обсудили тиражирование робота сверки в ТЦСО «Бибирево». Нужна неделя на адаптацию.' },
    ],
  },
  {
    kind: 'internal', name: 'Аналитическая группа ГБУ «Моя карьера»',
    org_unit: 'ГБУ «Моя карьера», отдел аналитики рынка труда', city: 'Москва', team_size: 4,
    description: 'Аналитики и разработчик моделей: прогнозы спроса на профессии, подбор программ переобучения.',
    contact_name: 'Егорова Светлана Игоревна', contact_role: 'Руководитель группы',
    contact_email: 'egorova@social1.mos.ru',
    status: 'qualified', availability: 'limited',
    competencies: ['predict', 'data', 'nlp'], domains: ['employment', 'social'],
    compliance: ['pdn'],
    tags: ['Python', 'CatBoost', 'PostgreSQL'],
    cases: [
      { title: 'Прогноз востребованности профессий', customer: 'ГБУ «Моя карьера»', year: 2024, public_sector: true,
        tags: ['CatBoost'], description: 'Модель прогнозирует спрос на профессии на полгода вперёд по данным вакансий.',
        result: 'Состав программ переобучения пересобран, трудоустройство выпускников выросло на 11%' },
    ],
    solutions: [
      { name: 'Модель сопоставления резюме и вакансий', kind: 'model', maturity: 'prototype',
        competencies: ['nlp', 'predict'], tags: ['Python'],
        description: 'Оценивает соответствие резюме вакансии и объясняет, каких навыков не хватает.' },
    ],
    reviews: [],
    notes: [
      { kind: 'note', days: 50, body: 'Загружены отчётностью до конца квартала, свободны со следующего месяца.' },
    ],
  },
  {
    // Молодая команда без портфолио — показывает низкую заполненность карточки
    kind: 'internal', name: 'Проектный офис ИИ ДТСЗН',
    org_unit: 'Управление цифровой трансформации ДТСЗН',
    description: 'Создан в этом году: прототипирует ассистентов для специалистов на открытых моделях.',
    status: 'new', availability: 'available',
    competencies: ['llm', 'rag'], domains: ['social'],
    compliance: [],
    tags: ['Python', 'Qwen', 'LangChain'],
    cases: [],
    solutions: [
      { name: 'Ассистент специалиста по регламентам', kind: 'model', maturity: 'prototype', license: 'open_source',
        competencies: ['llm', 'rag'], tags: ['Qwen', 'LangChain'],
        description: 'Отвечает на вопросы о порядке предоставления услуг по внутренним регламентам, работает без выхода в интернет.' },
    ],
    reviews: [],
    notes: [],
  },

  // ── Команды ДИТ ────────────────────────────────────────────
  {
    kind: 'dit', name: 'ДИТ: центр компетенций по ИИ',
    org_unit: 'Департамент информационных технологий, управление развития ИИ', city: 'Москва', team_size: 40,
    description: 'Городская команда, которая ведёт общую платформу языковых моделей и помогает ведомствам '
      + 'строить ассистентов на ней, не разворачивая свою инфраструктуру.',
    contact_name: 'Фролов Игорь Николаевич', contact_role: 'Руководитель центра компетенций',
    contact_email: 'frolov@dit.example', contact_phone: '+7 495 000-44-04',
    status: 'qualified', availability: 'limited',
    competencies: ['llm', 'rag', 'nlp', 'mlops'], domains: ['gov', 'city', 'social'],
    compliance: ['ru_registry', 'pdn', 'fstec', 'on_prem'],
    tags: ['GigaChat', 'YandexGPT', 'Kubernetes', 'Python'],
    cases: [
      { title: 'Суммаризация обращений граждан', customer: 'Городские ведомства', year: 2025, public_sector: true,
        tags: ['YandexGPT'], description: 'Краткая выжимка и классификация обращения до того, как его откроет разработчик.',
        result: 'Распределение обращений по разработчикам — с 1 дня до 10 минут' },
      { title: 'Ассистент операторов городской справочной', customer: 'Городская справочная служба', year: 2024,
        public_sector: true, tags: ['GigaChat', 'RAG'],
        description: 'Подсказывает оператору ответ по базе знаний прямо во время разговора.',
        result: 'Средняя длительность разговора сократилась на 18%' },
    ],
    solutions: [
      { name: 'Городская платформа языковых моделей', kind: 'platform', maturity: 'production', in_registry: true,
        competencies: ['llm', 'rag', 'mlops'], tags: ['GigaChat', 'YandexGPT', 'Kubernetes'],
        description: 'Доступ ведомств к языковым моделям в защищённом контуре города: API, база знаний, контроль качества ответов.',
        price_note: 'Для ведомств города — без оплаты, по заявке' },
      { name: 'Сервис суммаризации обращений', kind: 'model', maturity: 'production',
        competencies: ['nlp', 'llm'], tags: ['YandexGPT'],
        description: 'Выжимка, тематика и срочность обращения по его тексту.' },
    ],
    reviews: [
      { email: 'coordinator@social1.mos.ru', quality: 4, deadlines: 4, communication: 4,
        context: 'Подключение к платформе', comment: 'Подключились за месяц; очередь на доработки у центра длинная.' },
    ],
    notes: [
      { kind: 'meeting', days: 21, body: 'Обсудили подключение ассистента специалистов к городской платформе. Нужна заявка от ДТСЗН.' },
      { kind: 'letter', days: 9, body: 'Направлена заявка на подключение, ответ ожидается в течение месяца.' },
    ],
  },
  {
    kind: 'dit', name: 'ДИТ: команда компьютерного зрения',
    org_unit: 'Департамент информационных технологий, центр видеоаналитики', city: 'Москва', team_size: 25,
    description: 'Видеоаналитика и распознавание документов для городских сервисов.',
    contact_name: 'Алексеева Ольга Викторовна', contact_role: 'Руководитель продукта',
    contact_email: 'alekseeva@dit.example',
    status: 'qualified', availability: 'busy',
    competencies: ['cv', 'ocr'], domains: ['city', 'gov'],
    compliance: ['fstec', 'pdn', 'on_prem'],
    tags: ['PyTorch', 'OpenCV', 'Kubernetes'],
    cases: [
      { title: 'Распознавание документов в городских сервисах', customer: 'Городские ведомства', year: 2023,
        public_sector: true, tags: ['OCR'], description: 'Общий сервис распознавания сканов для ведомственных систем.',
        result: 'Подключено 7 ведомственных систем' },
    ],
    solutions: [
      { name: 'Сервис распознавания документов', kind: 'model', maturity: 'production',
        competencies: ['ocr'], tags: ['OCR', 'PyTorch'],
        description: 'API распознавания паспортов, справок и заявлений для систем города.' },
    ],
    reviews: [],
    notes: [
      { kind: 'call', days: 14, body: 'Команда полностью загружена до конца года; подключение к сервису распознавания — в порядке очереди.' },
    ],
  },
  {
    kind: 'dit', name: 'ДИТ: команда голосовых сервисов',
    org_unit: 'Департамент информационных технологий, голосовые сервисы справочной', city: 'Москва', team_size: 15,
    description: 'Голосовые роботы и распознавание речи для городских линий: приём звонков, опросы, напоминания.',
    contact_name: 'Белов Роман Сергеевич', contact_role: 'Ведущий менеджер продукта',
    contact_email: 'belov@dit.example', contact_phone: '+7 495 000-55-05',
    status: 'screening', availability: 'limited',
    competencies: ['speech', 'chatbot', 'nlp'], domains: ['gov', 'city'],
    compliance: ['ru_registry', 'pdn', 'on_prem'],
    tags: ['Kaldi', 'Python', 'Asterisk'],
    cases: [
      { title: 'Голосовой робот городской справочной', customer: 'Городская справочная служба', year: 2024,
        public_sector: true, tags: ['Kaldi'], description: 'Робот отвечает на типовые вопросы и переводит сложные звонки на оператора.',
        result: '35% звонков завершаются без оператора' },
    ],
    solutions: [
      { name: 'Распознавание и синтез речи', kind: 'model', maturity: 'production', in_registry: true,
        competencies: ['speech'], tags: ['Kaldi'],
        description: 'Распознавание телефонной речи и синтез голоса для городских линий.' },
      { name: 'Конструктор голосовых сценариев', kind: 'platform', maturity: 'pilot',
        competencies: ['chatbot', 'speech'], tags: ['Asterisk'],
        description: 'Сценарии обзвона и приёма звонков без программирования.' },
    ],
    reviews: [],
    notes: [
      { kind: 'rfi', days: 3, body: 'Запросили возможность обзвона получателей с напоминанием о продлении мер поддержки.' },
    ],
  },
];

// Демонстрация управления доступом: кому каталог открыт по отдельной роли
const SAMPLE_ACCESS = [
  ['lebedeva@social1.mos.ru', 'provider_editor'],
  ['tihonov@social1.mos.ru', 'provider_viewer'],
];

// Демонстрация представителя разработчика: учётная запись поставщика ведёт профиль
// своей компании, и одна её правка ещё ждёт подтверждения модератором
const SAMPLE_MEMBERS = [
  { email: 'vendor@cst.ru', provider: 'АО «Зоркий Код»', pending: 'добавлено решение «Зоркий.Поток»' },
];

const userByEmail = (email) => q.get('SELECT * FROM users WHERE email = ? AND is_active = 1', email);

/**
 * Заводит демонстрационный набор. Повторный вызов ничего не делает, пока в
 * каталоге есть хотя бы одна демо-запись. Возвращает число заведённых разработчиков.
 */
export function seedSampleProviders() {
  if (q.get('SELECT COUNT(*) AS c FROM providers WHERE is_demo = 1').c) return 0;
  const owner = userByEmail('director@social1.mos.ru')
    ?? q.get("SELECT * FROM users WHERE role = 'dtszn' AND is_active = 1 ORDER BY id LIMIT 1");
  if (!owner) return 0;   // пустая база: сначала нужны участники

  return tx(() => {
    let n = 0;
    for (const s of SAMPLE_PROVIDERS) {
      const { cases, solutions, reviews, notes, stale_days, ...fields } = s;
      const p = pr.createProvider({ ...fields, owner_id: owner.id }, owner, 'seed');
      q.run('UPDATE providers SET is_demo = 1 WHERE id = ?', p.id);
      for (const c of cases) pr.saveCase(p.id, null, c, owner, 'seed');
      for (const sol of solutions) pr.saveSolution(p.id, null, sol, owner, 'seed');
      for (const r of reviews) {
        const author = userByEmail(r.email);
        if (author) pr.saveReview(p.id, r, author, 'seed');
      }
      for (const note of notes) {
        pr.addNote(p.id, { kind: note.kind, body: note.body, happened_at: daysAgo(note.days) }, owner, 'seed');
      }
      // Даты правки ставятся последними: каждая вложенная запись освежает карточку
      const age = stale_days ?? Math.min(...notes.map((x) => x.days), 30);
      q.run(`UPDATE providers SET created_at = datetime('now', ?), updated_at = datetime('now', ?) WHERE id = ?`,
        `-${age + 60} days`, `-${age} days`, p.id);
      n++;
    }
    for (const [email, role] of SAMPLE_ACCESS) {
      const u = userByEmail(email);
      if (u) grantRole(u.id, role, { grantedBy: owner.id });
    }
    for (const m of SAMPLE_MEMBERS) {
      const u = userByEmail(m.email);
      const p = q.get('SELECT id FROM providers WHERE name = ? AND is_demo = 1', m.provider);
      if (!u || !p) continue;
      q.run('INSERT OR IGNORE INTO provider_members (provider_id, user_id, added_by) VALUES (?,?,?)', p.id, u.id, owner.id);
      if (m.pending) {
        q.run(`UPDATE providers SET profile_status = 'pending', profile_changed_by = ?, profile_note = ?,
               profile_changed_at = datetime('now', '-2 days') WHERE id = ?`, u.id, m.pending, p.id);
      }
    }
    return n;
  });
}

/** Убирает демонстрационных разработчиков; введённые вручную остаются. */
export function removeSampleProviders() {
  return tx(() => {
    const n = q.run('DELETE FROM providers WHERE is_demo = 1').changes;
    for (const [email, role] of SAMPLE_ACCESS) {
      const u = userByEmail(email);
      if (u) q.run('DELETE FROM user_roles WHERE user_id = ? AND role_code = ?', u.id, role);
    }
    return Number(n);
  });
}

// Запуск отдельной командой: npm run seed:providers [-- --remove]
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  ensureRoles();
  if (process.argv.includes('--remove')) {
    console.log(`Демонстрационных разработчиков удалено: ${removeSampleProviders()}`);
  } else {
    const n = seedSampleProviders();
    console.log(n
      ? `Демонстрационных разработчиков заведено: ${n}`
      : 'Демонстрационные разработчики уже есть или в базе нет участников (сначала npm run seed)');
  }
}
