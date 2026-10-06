// Наполнение платформы демонстрационными данными: учреждения, участники,
// инициативы на всех стадиях жизненного цикла с реальной историей решений.
import { q, tx, db } from './db.js';
import { hashPassword, ensureRoles, grantRole } from './auth.js';
import { ensureWorkflow, stageConfig, dueDate, grantAward, lastStage, ensureStageEvents } from './workflow.js';
import { ensureIdeaHub, awardPoints, refreshBadges, periodBounds } from './ideahub.js';
import * as repo from './process-repo.js';
import { ensureProcesses } from './process-repo.js';
import { ensureKnowledge } from './knowledge.js';
import { ensureSampleForms } from './seed-forms.js';
import { seedSampleProviders } from './seed-providers.js';
import * as kn from './knowledge.js';
import * as discussions from './discussions.js';
import { reindexAll } from './search.js';
import * as changes from './process-changes.js';
import { logAction } from './audit.js';
import { classify } from './ai.js';

const RESET = process.argv.includes('--reset');
const NOW = Date.now();
const ts = (daysAgo, hour = 10) => {
  const d = new Date(NOW - daysAgo * 864e5);
  d.setHours(hour, Math.floor(Math.random() * 55), 0, 0);
  return d.toISOString().slice(0, 19).replace('T', ' ');
};
const pick = (a) => a[Math.floor(Math.random() * a.length)];

if (RESET) {
  // Журнал аудита неизменяем и ссылается на пользователей — на время очистки
  // отключаем проверку внешних ключей, сам журнал при этом сохраняется.
  db.exec('PRAGMA foreign_keys = OFF');
  for (const t of ['form_answers','form_responses','form_questions','forms',
    // каталог разработчиков ИИ-решений
    'provider_members','provider_notes','provider_reviews','provider_solutions','provider_cases','providers',
    'survey_answers','survey_responses','survey_questions','surveys','pilot_kpis','pilots',
    'pilot_applications','board_items','sprints','documents','projects','forum_posts','forum_topics',
    'best_practices','rollouts','awards','comments','attachments','gate_decisions','stage_transitions',
    'votes','follows',
    // модуль «Идеи и решения»
    'review_flags','proposal_reviews','idea_reports','incentives','advisor_badges','points_ledger',
    'idea_comments','proposal_endorsements','idea_reactions','idea_attachments','proposals',
    'idea_drafts','ideas',
    'notifications','tasks','initiatives','sessions','users','institutions',
    // Настройки восстанавливаются значениями по умолчанию сразу после очистки:
    // ensureRoles, ensureWorkflow и ensureIdeaHub вызываются следом
    'user_roles','role_permissions','roles','permissions_catalog','workflow_config',
    'points_rules','incentive_types','ideahub_settings',
    // совместная работа над процессами и репозиторий схем: схемы восстанавливаются
    // из начального наполнения, обсуждения и предложения — это данные пользователей
    'search_index',
    'knowledge_versions','knowledge_docs','knowledge_sections',
    'event_failures','events',
    'discussion_votes','discussions','approvals','process_change_votes',
    'process_changes','process_approval_routes','process_versions','process_defs']) {
    try { db.exec(`DELETE FROM ${t}`); } catch {}
  }
  try { db.exec("DELETE FROM sqlite_sequence WHERE name != 'audit_log'"); } catch {}
  db.exec('PRAGMA foreign_keys = ON');
  console.log('Данные очищены (журнал аудита сохранён — он неизменяем).');
}

ensureRoles();
ensureWorkflow();
ensureIdeaHub();
ensureProcesses();
ensureKnowledge();
if (q.get('SELECT COUNT(*) AS c FROM users').c > 0 && !RESET) {
  console.log('Данные уже загружены. Для пересоздания: npm run reset');
  process.exit(0);
}

// ── Учреждения ───────────────────────────────────────────────
const INSTITUTIONS = [
  ['Департамент труда и социальной защиты населения города Москвы', 'ДТСЗН', 'dtszn', 'Центральный', 340, 0],
  ['Территориальный центр социального обслуживания «Ярославский»', 'ТЦСО «Ярославский»', 'institution', 'СВАО', 285, 1],
  ['Территориальный центр социального обслуживания «Бибирево»', 'ТЦСО «Бибирево»', 'institution', 'СВАО', 240, 1],
  ['Центр социальной помощи семье и детям «Гармония»', 'ЦСПСиД «Гармония»', 'institution', 'ЮВАО', 130, 1],
  ['Центр содействия семейному воспитанию «Кунцевский»', 'ЦССВ «Кунцевский»', 'institution', 'ЗАО', 165, 0],
  ['Психоневрологический интернат № 11', 'ПНИ № 11', 'institution', 'ЮАО', 310, 0],
  ['Реабилитационный центр для инвалидов «Преодоление»', 'РЦ «Преодоление»', 'institution', 'САО', 145, 1],
  ['Центр социальной адаптации имени Е. П. Глинки', 'ЦСА «Люблино»', 'institution', 'ЮВАО', 190, 0],
  ['Государственное бюджетное учреждение «Моя карьера»', 'ГБУ «Моя карьера»', 'institution', 'ЦАО', 95, 1],
  ['Ресурсный центр по поддержке семьи «Отрадное»', 'РЦ «Отрадное»', 'institution', 'СВАО', 110, 0],
  ['ООО «Цифровые социальные технологии»', 'ЦСТ', 'vendor', '—', 0, 0],
  ['АНО «Лаборатория доступной среды»', 'ЛДС', 'vendor', '—', 0, 0],
];
const inst = {};
for (const [name, short, kind, district, staff, pilot] of INSTITUTIONS) {
  const id = q.insert(`INSERT INTO institutions (name, short_name, kind, district, staff_count, is_pilot_site)
                       VALUES (?,?,?,?,?,?)`, name, short, kind, district, staff, pilot);
  inst[short] = id;
}

// ── Участники ────────────────────────────────────────────────
const USERS = [
  // email, ФИО, роль, учреждение, должность, экспертиза
  ['smirnova@social1.mos.ru', 'Смирнова Анна Викторовна', 'employee', 'ТЦСО «Ярославский»', 'Социальный работник', 'Надомное обслуживание'],
  ['petrov@social1.mos.ru', 'Петров Игорь Сергеевич', 'employee', 'ТЦСО «Ярославский»', 'Специалист по социальной работе', 'Приём заявлений'],
  ['ivanova@social1.mos.ru', 'Иванова Мария Дмитриевна', 'employee', 'ЦСПСиД «Гармония»', 'Психолог', 'Работа с семьями'],
  ['kuznecov@social1.mos.ru', 'Кузнецов Павел Андреевич', 'employee', 'ПНИ № 11', 'Специалист по реабилитации', 'Абилитация'],
  ['orlova@social1.mos.ru', 'Орлова Екатерина Павловна', 'employee', 'РЦ «Преодоление»', 'Инструктор-методист', 'Доступная среда'],
  ['fedorov@social1.mos.ru', 'Фёдоров Дмитрий Олегович', 'employee', 'ТЦСО «Бибирево»', 'Специалист по социальной работе', 'Меры поддержки'],
  ['nikitina@social1.mos.ru', 'Никитина Ольга Романовна', 'employee', 'ЦССВ «Кунцевский»', 'Воспитатель', 'Семейное устройство'],
  ['larina@social1.mos.ru', 'Ларина Светлана Игоревна', 'employee', 'ГБУ «Моя карьера»', 'Карьерный консультант', 'Трудоустройство'],

  ['volkov@social1.mos.ru', 'Волков Сергей Николаевич', 'head', 'ТЦСО «Ярославский»', 'Директор', null],
  ['sokolova@social1.mos.ru', 'Соколова Ирина Львовна', 'head', 'ЦСПСиД «Гармония»', 'Директор', null],
  ['morozov@social1.mos.ru', 'Морозов Артём Викторович', 'head', 'ПНИ № 11', 'Директор', null],
  ['belova@social1.mos.ru', 'Белова Наталья Юрьевна', 'head', 'ТЦСО «Бибирево»', 'Директор', null],
  ['gusev@social1.mos.ru', 'Гусев Роман Аркадьевич', 'head', 'РЦ «Преодоление»', 'Директор', null],
  ['pavlova@social1.mos.ru', 'Павлова Елена Сергеевна', 'head', 'ЦССВ «Кунцевский»', 'Директор', null],
  ['zaharov@social1.mos.ru', 'Захаров Михаил Ильич', 'head', 'ГБУ «Моя карьера»', 'Директор', null],

  ['lebedeva@social1.mos.ru', 'Лебедева Татьяна Анатольевна', 'expert', 'ДТСЗН', 'Начальник управления развития', 'Стратегия, методология соцуслуг'],
  ['grigoriev@social1.mos.ru', 'Григорьев Антон Юрьевич', 'expert', 'ДТСЗН', 'Главный аналитик', 'Оценка эффектов, КПЭ'],
  ['romanova@social1.mos.ru', 'Романова Вера Константиновна', 'expert', 'ДТСЗН', 'Эксперт по социальным технологиям', 'Реабилитация, доступная среда'],

  ['tihonov@social1.mos.ru', 'Тихонов Алексей Валерьевич', 'developer', 'ДТСЗН', 'Руководитель команды цифровой трансформации', 'Архитектура, интеграции'],
  ['makarova@social1.mos.ru', 'Макарова Юлия Денисовна', 'developer', 'ДТСЗН', 'Продакт-менеджер', 'Продуктовая аналитика'],
  ['sorokin@social1.mos.ru', 'Сорокин Кирилл Максимович', 'developer', 'ЦСТ', 'Ведущий разработчик', 'Backend, мобильные решения'],

  ['ershova@social1.mos.ru', 'Ершова Полина Андреевна', 'pilot_coordinator', 'ДТСЗН', 'Координатор пилотных площадок', 'Организация пилотов'],
  ['danilov@social1.mos.ru', 'Данилов Егор Петрович', 'pilot_coordinator', 'ДТСЗН', 'Специалист по внедрению', 'Обучение и сопровождение'],

  ['vendor@cst.ru', 'Абрамов Виктор Тимурович', 'supplier', 'ЦСТ', 'Руководитель проектов', 'Платформенные решения'],
  ['lab@lds.ru', 'Королёва Дарья Максимовна', 'supplier', 'ЛДС', 'Эксперт по доступной среде', 'ТСР, адаптация помещений'],

  ['director@social1.mos.ru', 'Ковалёв Андрей Витальевич', 'dtszn', 'ДТСЗН', 'Заместитель руководителя Департамента', 'Портфель инициатив'],
  ['coordinator@social1.mos.ru', 'Жукова Алиса Германовна', 'dtszn', 'ДТСЗН', 'Координатор экосистемы Social1', 'Управление экосистемой'],
];

const U = {};
for (const [email, name, role, institution, position, expertise] of USERS) {
  const { hash, salt } = hashPassword('social1');
  const id = q.insert(`INSERT INTO users (email, full_name, password_hash, password_salt, role, institution_id, position, expertise, created_at)
                       VALUES (?,?,?,?,?,?,?,?,?)`,
    email, name, hash, salt, role, inst[institution], position, expertise, ts(200));
  U[email] = { id, role, institution_id: inst[institution], full_name: name };
}
const byRole = (r, n = 0) => Object.values(U).filter((u) => u.role === r)[n];

// ── Инициативы ───────────────────────────────────────────────
// history: последовательность решений на Gate; итоговый этап рассчитывается автоматически
const INITIATIVES = [
  {
    author: 'smirnova@social1.mos.ru', created: 148,
    title: 'Мобильное приложение социального работника для надомного обслуживания',
    problem: 'Социальный работник при надомном обслуживании ведёт бумажный журнал посещений: отмечает время прихода, перечень оказанных услуг, подпись получателя. Вечером он возвращается в центр и вручную переносит записи в информационную систему. На это уходит 40–60 минут ежедневно у каждого из 68 сотрудников отделения. Записи теряются, почерк не всегда разборчив, при проверках возникают расхождения между журналом и системой.',
    solution: 'Мобильное приложение с офлайн-режимом: работник отмечает визит на смартфоне, выбирает оказанные услуги из справочника, получатель расписывается пальцем на экране. При появлении связи данные автоматически синхронизируются с учётной системой. Геометка подтверждает факт визита, повторный ввод не требуется.',
    effect: 'Экономия 45 минут рабочего времени ежедневно на каждого социального работника, устранение двойного ввода данных, исключение расхождений при проверках.',
    effect_type: 'time', effect_value: 45, effect_unit: 'мин/день на сотрудника',
    history: [
      { gate: 1, d: 145, dec: 'go', by: 'volkov@social1.mos.ru', why: 'Проблема подтверждается данными хронометража по отделению. Экономия времени очевидна, решение не требует изменения регламентов обслуживания. Направляю на экспертизу Департамента.' },
      { gate: 2, d: 141, dec: 'go', by: 'lebedeva@social1.mos.ru', why: 'Инициатива соответствует приоритету цифровизации надомного обслуживания. Потенциал масштабирования — все 34 ТЦСО. Эффект измерим. Техническая осуществимость подтверждена командой цифровой трансформации.' },
      { gate: 3, d: 82, dec: 'go', by: 'tihonov@social1.mos.ru', why: 'MVP собран за 4 спринта: офлайн-режим, справочник услуг, электронная подпись получателя, синхронизация. Демонстрация пройдена, замечания устранены. Готовы к пилоту.' },
      { gate: 4, d: 38, dec: 'go', by: 'ershova@social1.mos.ru', why: 'Пилот в ТЦСО «Ярославский», 22 социальных работника, 31 день. Фактическая экономия — 47 минут в день, что выше прогноза. Удовлетворённость 4,6 из 5. Критических сбоев не зафиксировано, требования к защите персональных данных соблюдены.' },
      { gate: 5, d: 24, dec: 'go', by: 'director@social1.mos.ru', why: 'Эффект подтверждён пилотом, экономия в масштабе города оценивается в 21 тысячу человеко-часов в год. Ресурсы на тиражирование выделены. Утверждаю масштабирование на все территориальные центры.' },
    ],
    pilot: { inst: 'ТЦСО «Ярославский»', start: 68, end: 37, participants: 22 },
    scaled: true,
  },
  {
    author: 'petrov@social1.mos.ru', created: 120, pending: 8,
    title: 'Предварительная проверка комплектности документов при записи на приём',
    problem: 'Около трети граждан приходят на приём с неполным пакетом документов. Специалист вынужден отказать в приёме заявления и назначить повторный визит. Гражданин теряет время, очередь растёт, а показатели по срокам предоставления услуги ухудшаются. За квартал по отделению — 412 повторных визитов.',
    solution: 'При онлайн-записи на приём система показывает персонализированный чек-лист документов в зависимости от выбранной услуги и категории заявителя. За день до визита приходит SMS-напоминание со списком. Специалист видит отметку гражданина о готовности пакета.',
    effect: 'Сокращение доли повторных визитов с 33% до 10%, снижение нагрузки на приёме, сокращение очереди.',
    effect_type: 'quality', effect_value: 23, effect_unit: '% сокращения повторных визитов',
    history: [
      { gate: 1, d: 117, dec: 'go', by: 'volkov@social1.mos.ru', why: 'Повторные визиты — системная проблема отделения приёма. Решение не требует дополнительных штатных единиц. Поддерживаю.' },
      { gate: 2, d: 112, dec: 'go', by: 'grigoriev@social1.mos.ru', why: 'Эффект для граждан прямой и измеримый. Требуется интеграция со справочником услуг, что технически осуществимо. Рекомендую к разработке с приоритетом.' },
      { gate: 3, d: 64, dec: 'go', by: 'tihonov@social1.mos.ru', why: 'Реализованы чек-листы по 18 массовым услугам, SMS-уведомления и отметка готовности. MVP протестирован, готов к пилотированию.' },
      { gate: 4, d: 22, dec: 'go', by: 'ershova@social1.mos.ru', why: 'Пилот в двух ТЦСО. Доля повторных визитов снизилась с 33% до 12%. Граждане отмечают удобство напоминаний. Рекомендую к масштабированию.' },
    ],
    pilot: { inst: 'ТЦСО «Бибирево»', start: 53, end: 22, participants: 14 },
    stage: 6,
  },
  {
    author: 'orlova@social1.mos.ru', created: 96,
    title: 'Единый цифровой маршрут реабилитации для получателя услуг',
    problem: 'Индивидуальная программа реабилитации ведётся на бумаге и распределена между специалистами: инструктор ЛФК, психолог, эрготерапевт заполняют свои разделы отдельно. Никто не видит полной картины динамики. Родственники не понимают, что происходит с реабилитацией и какие результаты достигнуты.',
    solution: 'Цифровой маршрут: все специалисты вносят результаты занятий в единую карточку получателя. Формируется наглядная динамика по каждому направлению. Родственники получают доступ к сводке через личный кабинет.',
    effect: 'Сокращение времени на согласование программы между специалистами, повышение прозрачности для семьи, рост удовлетворённости получателей услуг.',
    effect_type: 'quality', effect_value: 30, effect_unit: '% сокращения времени согласования',
    history: [
      { gate: 1, d: 93, dec: 'go', by: 'gusev@social1.mos.ru', why: 'Разрозненность документации по реабилитации — известная проблема центра. Инициатива снимает её и повышает прозрачность для семей. Одобряю.' },
      { gate: 2, d: 87, dec: 'go', by: 'romanova@social1.mos.ru', why: 'Соответствует направлению развития реабилитационных услуг. Масштабируется на все реабилитационные центры. Необходимо предусмотреть требования к защите данных о здоровье.' },
      { gate: 3, d: 30, dec: 'go', by: 'tihonov@social1.mos.ru', why: 'Прототип реализован: единая карточка, динамика по направлениям, ограниченный доступ для родственников. Требования к персональным данным учтены.' },
    ],
    pilot: { inst: 'РЦ «Преодоление»', start: 26, end: 5, participants: 18, status: 'analysis' },
    stage: 5,
  },
  {
    author: 'ivanova@social1.mos.ru', created: 72,
    title: 'Скрининг риска семейного неблагополучия на основе обращений',
    problem: 'Специалисты выявляют семьи в кризисе поздно — как правило, после обращения из школы или поликлиники, когда ситуация уже запущена. Сигналы копятся в разных журналах: пропуски занятий, обращения за материальной помощью, жалобы соседей. Никто не сводит их воедино.',
    solution: 'Карточка семьи, объединяющая сигналы из разных источников, с прозрачной шкалой риска по понятным критериям. При накоплении сигналов специалист получает уведомление о необходимости профилактического визита. Решение о вмешательстве принимает человек, а не алгоритм.',
    effect: 'Более раннее выявление кризисных ситуаций, снижение числа случаев, дошедших до изъятия ребёнка из семьи.',
    effect_type: 'quality', effect_value: 20, effect_unit: '% раннего выявления',
    history: [
      { gate: 1, d: 69, dec: 'go', by: 'sokolova@social1.mos.ru', why: 'Раннее выявление — приоритет центра. Инициатива требует внимательной проработки этики и защиты данных, но потенциал высокий. Направляю экспертам.' },
      { gate: 2, d: 62, dec: 'go', by: 'lebedeva@social1.mos.ru', why: 'Стратегически значимо. Обязательное условие — решение об вмешательстве принимает специалист, шкала риска носит вспомогательный характер и должна быть объяснимой. С этой оговоркой — Go.' },
    ],
    stage: 4, project: true,
  },
  {
    author: 'kuznecov@social1.mos.ru', created: 54,
    title: 'Видеоинструкции по уходу для родственников проживающих в ПНИ',
    problem: 'Родственники забирают проживающих домой на выходные и праздники, но не владеют навыками ухода: перемещение маломобильного человека, кормление, профилактика пролежней. Персонал объясняет устно при каждой выписке, информация забывается. Возвраты после выходных сопровождаются осложнениями.',
    solution: 'Библиотека коротких видеоинструкций, снятых персоналом интерната по стандартным ситуациям ухода. QR-код в памятке при выписке ведёт на нужный ролик. Библиотека доступна с телефона без регистрации.',
    effect: 'Снижение числа осложнений после домашних отпусков, сокращение времени персонала на повторные объяснения.',
    effect_type: 'quality', effect_value: 25, effect_unit: '% снижения осложнений',
    history: [
      { gate: 1, d: 51, dec: 'go', by: 'morozov@social1.mos.ru', why: 'Проблема реальная, решение не требует существенных затрат — съёмка силами персонала. Поддерживаю и выделяю методиста для подготовки сценариев.' },
      { gate: 2, d: 44, dec: 'hold', by: 'romanova@social1.mos.ru', why: 'Идея полезная, но требуется согласование медицинской корректности инструкций с профильными специалистами и решение вопроса о согласии проживающих на съёмку. Приостанавливаю до предоставления этой информации.' },
    ],
    stage: 3, status: 'hold',
  },
  {
    author: 'fedorov@social1.mos.ru', created: 41, pending: 3,
    title: 'Автоматическое формирование пакета межведомственных запросов',
    problem: 'При назначении мер социальной поддержки специалист формирует до семи межведомственных запросов вручную: в СФР, налоговую, Росреестр, органы ЗАГС. На один комплект уходит около 25 минут, при этом реквизиты заявителя вводятся повторно в каждую форму. Ошибки в реквизитах приводят к отказам и повторным запросам.',
    solution: 'Единая форма: специалист один раз вводит данные заявителя и выбирает вид меры поддержки. Система сама формирует и отправляет весь необходимый комплект запросов, отслеживает поступление ответов и уведомляет о готовности пакета.',
    effect: 'Сокращение времени формирования запросов с 25 до 5 минут, снижение доли ошибок в реквизитах.',
    effect_type: 'time', effect_value: 20, effect_unit: 'мин на комплект',
    history: [
      { gate: 1, d: 38, dec: 'go', by: 'belova@social1.mos.ru', why: 'Ручное дублирование реквизитов — очевидная потеря времени специалистов. Инициатива хорошо проработана автором, есть хронометраж. Одобряю.' },
    ],
    stage: 3,
  },
  {
    author: 'larina@social1.mos.ru', created: 33, pending: 2,
    title: 'Наставничество для сотрудников в первые три месяца работы',
    problem: 'Новые специалисты уходят в первые полгода: доля увольнений среди принятых в текущем году — 28%. Новичок получает регламенты в виде папки документов и учится методом проб и ошибок. Опытные коллеги помогают неформально, но эта работа никак не организована и не учитывается.',
    solution: 'Программа наставничества: за каждым новым сотрудником закрепляется наставник, есть чек-лист адаптации на 90 дней с контрольными точками, а наставник получает признание и надбавку. Ход адаптации виден руководителю.',
    effect: 'Снижение текучести среди новых сотрудников, сокращение срока выхода на полную производительность.',
    effect_type: 'quality', effect_value: 15, effect_unit: '% снижения текучести',
    history: [
      { gate: 1, d: 30, dec: 'go', by: 'zaharov@social1.mos.ru', why: 'Текучесть новичков — болевая точка учреждения. Инициатива опирается на наш собственный неформальный опыт и предлагает его закрепить. Поддерживаю.' },
      { gate: 2, d: 24, dec: 'redirect', by: 'lebedeva@social1.mos.ru', why: 'Инициатива ценная, но относится к кадровой политике, а не к цифровым сервисам. Прошу автора дополнить расчётом стоимости надбавок наставникам и согласовать с управлением кадров, после чего вернуть на экспертизу.' },
    ],
    stage: 2,
  },
  {
    author: 'nikitina@social1.mos.ru', created: 26, pending: 2,
    title: 'Цифровой дневник подготовки к самостоятельной жизни выпускника',
    problem: 'Подготовка выпускника центра содействия семейному воспитанию к самостоятельной жизни ведётся бессистемно. Нет единого понимания, какие навыки уже освоены: приготовление еды, оплата счетов, запись к врачу, планирование бюджета. При выпуске обнаруживаются пробелы, которые уже поздно закрывать.',
    solution: 'Дневник навыков с понятными для подростка формулировками. Воспитатель и сам подросток отмечают освоенные умения, видна общая картина готовности. За полгода до выпуска формируется список пробелов для целевой работы.',
    effect: 'Системная подготовка к выпуску, снижение числа выпускников с критическими пробелами в бытовых навыках.',
    effect_type: 'quality', effect_value: 40, effect_unit: '% охвата навыков',
    history: [
      { gate: 1, d: 23, dec: 'go', by: 'pavlova@social1.mos.ru', why: 'Подготовка к самостоятельной жизни — ключевая задача центра, а системного инструмента у нас нет. Инициатива закрывает реальный пробел. Направляю на экспертизу.' },
    ],
    stage: 3,
  },
  {
    author: 'smirnova@social1.mos.ru', created: 18, pending: 9,
    title: 'Электронная очередь на выдачу технических средств реабилитации',
    problem: 'Получатели ТСР приезжают в пункт выдачи и ждут в живой очереди по 2–3 часа, не зная, поступило ли их средство реабилитации на склад. Часть визитов оказывается напрасной. Маломобильным гражданам такие поездки даются особенно тяжело.',
    solution: 'Уведомление о поступлении ТСР на склад с возможностью записаться на конкретное время выдачи. Гражданин приезжает к назначенному времени и не ждёт в очереди.',
    effect: 'Исключение напрасных визитов, сокращение времени ожидания с 2–3 часов до 15 минут.',
    effect_type: 'time', effect_value: 150, effect_unit: 'мин ожидания на визит',
    history: [
      { gate: 1, d: 15, dec: 'go', by: 'volkov@social1.mos.ru', why: 'Проблема очередей на выдаче ТСР поднимается регулярно, в том числе в обращениях граждан. Решение простое и понятное. Одобряю.' },
    ],
    stage: 3,
  },
  {
    author: 'ivanova@social1.mos.ru', created: 12, pending: 1,
    title: 'Чат-бот для первичной консультации по мерам поддержки семей',
    problem: 'Значительная часть обращений на телефон центра — типовые вопросы о том, какие меры поддержки положены семье и какие документы нужны. Специалист тратит на них до трети рабочего дня, при этом граждане долго не могут дозвониться.',
    solution: 'Чат-бот в мессенджере проводит по короткому опроснику о составе семьи и ситуации, после чего показывает перечень доступных мер поддержки и список документов. Сложные случаи переводятся на специалиста.',
    effect: 'Освобождение до 30% времени специалистов от типовых консультаций, круглосуточная доступность справочной информации.',
    effect_type: 'time', effect_value: 30, effect_unit: '% времени специалиста',
    history: [],
    stage: 2,
  },
  {
    author: 'orlova@social1.mos.ru', created: 7, pending: 1,
    title: 'Адаптация маршрутов внутри центра для незрячих посетителей',
    problem: 'Незрячие и слабовидящие посетители не могут самостоятельно перемещаться по зданию центра. Каждого приходится сопровождать сотруднику, что отвлекает персонал и лишает посетителей самостоятельности.',
    solution: 'Тактильная разметка основных маршрутов, звуковые маяки у ключевых точек и аудионавигация через приложение по QR-меткам на входе.',
    effect: 'Самостоятельное перемещение посетителей, высвобождение времени сопровождающих сотрудников.',
    effect_type: 'quality', effect_value: 60, effect_unit: '% самостоятельных визитов',
    history: [],
    stage: 2,
  },
  {
    author: 'kuznecov@social1.mos.ru', created: 88,
    title: 'Замена бумажных журналов дежурств на общий экран в холле',
    problem: 'Информация о дежурных специалистах ведётся в бумажном журнале на посту. Проживающие и родственники не знают, к кому обращаться в конкретный момент.',
    solution: 'Экран в холле с актуальным составом дежурной смены и контактами.',
    effect: 'Снижение числа обращений не по адресу.',
    effect_type: 'other', effect_value: null, effect_unit: null,
    history: [
      { gate: 1, d: 85, dec: 'go', by: 'morozov@social1.mos.ru', why: 'Решение простое, поддерживаю. Направляю на экспертизу для оценки целесообразности тиражирования.' },
      { gate: 2, d: 79, dec: 'kill', by: 'grigoriev@social1.mos.ru', why: 'Инициатива решает локальную задачу одного учреждения и не требует централизованной разработки: экран с расписанием реализуется силами учреждения в рамках текущей деятельности. Рекомендую внедрить самостоятельно, без централизованного проекта. Опыт полезен и будет размещён в библиотеке практик.' },
    ],
    stage: 3, status: 'killed',
  },
  {
    author: 'fedorov@social1.mos.ru', created: 63,
    title: 'Единый реестр отказов в предоставлении услуг с анализом причин',
    problem: 'Причины отказов в предоставлении мер поддержки нигде не накапливаются системно. Невозможно понять, какие требования чаще всего оказываются невыполнимыми для граждан и где регламент нуждается в корректировке.',
    solution: 'Реестр отказов с обязательным указанием кодифицированной причины и ежеквартальный анализ структуры причин для пересмотра избыточных требований.',
    effect: 'Обоснованный пересмотр требований, снижение доли отказов.',
    effect_type: 'quality', effect_value: 12, effect_unit: '% снижения отказов',
    history: [
      { gate: 1, d: 60, dec: 'go', by: 'belova@social1.mos.ru', why: 'Аналитика причин отказов действительно отсутствует. Инициатива даёт основу для пересмотра регламентов. Одобряю.' },
      { gate: 2, d: 54, dec: 'go', by: 'grigoriev@social1.mos.ru', why: 'Инициатива создаёт управленческую аналитику, которой сейчас нет ни на одном уровне. Прямо поддерживает задачу выявления узких мест. Go, с приоритетом на реализацию отчётности.' },
      { gate: 3, d: 12, dec: 'redirect', by: 'makarova@social1.mos.ru', why: 'Прототип реестра работает, но справочник причин отказа получился слишком дробным — 64 позиции, специалисты выбирают наугад. Возвращаю на доработку: требуется укрупнить классификатор до 12–15 позиций совместно с методологами.' },
    ],
    stage: 4, project: true,
  },
  {
    author: 'larina@social1.mos.ru', created: 78,
    title: 'Подбор вакансий для соискателей с инвалидностью по доступности рабочего места',
    problem: 'Соискатели с инвалидностью получают предложения вакансий без учёта доступности рабочего места: подъёма к офису, наличия лифта, приспособленного санузла. Значительная часть собеседований оказывается бессмысленной, соискатели теряют мотивацию.',
    solution: 'Карточка вакансии дополняется проверенными параметрами доступности рабочего места. Подбор учитывает эти параметры и сопоставляет их с потребностями соискателя.',
    effect: 'Рост доли результативных собеседований, сокращение времени поиска работы.',
    effect_type: 'quality', effect_value: 35, effect_unit: '% результативных собеседований',
    history: [
      { gate: 1, d: 75, dec: 'go', by: 'zaharov@social1.mos.ru', why: 'Инициатива напрямую отвечает профилю учреждения. Данные о доступности можно собирать при верификации работодателей. Поддерживаю.' },
      { gate: 2, d: 69, dec: 'go', by: 'romanova@social1.mos.ru', why: 'Соответствует задачам содействия занятости инвалидов. Требует методики оценки доступности — рекомендую привлечь профильную организацию. Go.' },
      { gate: 3, d: 20, dec: 'go', by: 'tihonov@social1.mos.ru', why: 'Реализована карточка доступности из 11 параметров и алгоритм сопоставления. Методика оценки согласована с АНО «Лаборатория доступной среды». Готово к пилоту.' },
    ],
    pilot: { inst: 'ГБУ «Моя карьера»', start: 16, end: 14, participants: 9, status: 'running' },
    stage: 5,
  },
  {
    author: 'nikitina@social1.mos.ru', created: 4, pending: 6,
    title: 'Сокращение времени оформления временной передачи ребёнка в семью',
    problem: 'Оформление документов на временную передачу ребёнка в семью гражданина занимает до 14 дней. Значительная часть времени уходит на последовательный сбор согласований, хотя многие из них можно получать параллельно.',
    solution: 'Параллельная схема согласований с контролем сроков по каждому участнику и единым статусом заявки, видимым принимающей семье.',
    effect: 'Сокращение срока оформления с 14 до 6 дней.',
    effect_type: 'time', effect_value: 8, effect_unit: 'дней',
    history: [],
    stage: 2,
  },
];

// ── Загрузка инициатив с воспроизведением истории ────────────
let seq = 0;
const year = new Date().getFullYear();
const created = [];

for (const spec of INITIATIVES) {
  const author = U[spec.author];
  const ai = classify(`${spec.title} ${spec.problem} ${spec.solution}`);
  seq += 1;
  const number = `SOC-${year}-${String(seq).padStart(4, '0')}`;
  const createdAt = ts(spec.created);

  const id = q.insert(`INSERT INTO initiatives
    (number, title, problem, solution, expected_effect, effect_type, effect_value, effect_unit,
     category, tags, author_id, institution_id, stage, status, stage_entered_at, created_at, updated_at,
     ai_category, ai_score, ai_rationale)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,'active',?,?,?,?,?,?)`,
    number, spec.title, spec.problem, spec.solution, spec.effect,
    spec.effect_type, spec.effect_value, spec.effect_unit,
    ai.category, JSON.stringify([]), author.id, author.institution_id,
    createdAt, createdAt, createdAt, ai.category, ai.confidence, ai.rationale);

  // Этап 1 → 2 автоматически
  q.run(`INSERT INTO stage_transitions (initiative_id, from_stage, to_stage, at, by_user, reason)
         VALUES (?,1,2,?,?,?)`, id, createdAt, author.id, 'Автоматический переход: этап 1 не содержит точки принятия решения');
  let stage = 2;
  let enteredAt = createdAt;
  let firstDecision = null;

  for (const h of spec.history) {
    const cfg = stageConfig(stage);
    const decidedAt = ts(h.d, 11 + (h.gate % 5));
    const decider = U[h.by];
    const slaDue = dueDate(enteredAt, cfg.sla_value, cfg.sla_unit);
    const durationHours = (new Date(decidedAt.replace(' ', 'T') + 'Z') - new Date(enteredAt.replace(' ', 'T') + 'Z')) / 36e5;
    const slaMet = slaDue ? (new Date(decidedAt.replace(' ', 'T') + 'Z') <= new Date(slaDue.replace(' ', 'T') + 'Z') ? 1 : 0) : null;

    const scores = {};
    for (const c of cfg.criteria) scores[c] = h.dec === 'go' ? pick([4, 4, 5]) : pick([2, 3]);

    q.insert(`INSERT INTO gate_decisions
      (initiative_id, gate_no, stage_no, decision, rationale, criteria_scores, decided_by, decided_at, sla_due_at, sla_met, duration_hours)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      id, cfg.gate_no, stage, h.dec, h.why, JSON.stringify(scores), decider.id, decidedAt, slaDue, slaMet, durationHours);

    if (!firstDecision) firstDecision = decidedAt;

    if (h.dec === 'go') {
      if (stage === lastStage()) { enteredAt = decidedAt; continue; } // Gate 5: цикл завершён
      const next = stage + 1;
      q.run(`INSERT INTO stage_transitions (initiative_id, from_stage, to_stage, at, by_user, reason, hours_in_stage)
             VALUES (?,?,?,?,?,?,?)`, id, stage, next, decidedAt, decider.id, `Go на ${cfg.gate_name}`, durationHours);
      stage = next; enteredAt = decidedAt;
    } else if (h.dec === 'redirect') {
      const back = Math.max(1, stage - 1);
      q.run(`INSERT INTO stage_transitions (initiative_id, from_stage, to_stage, at, by_user, reason, hours_in_stage)
             VALUES (?,?,?,?,?,?,?)`, id, stage, back, decidedAt, decider.id, `Redirect с ${cfg.gate_name}`, durationHours);
      stage = back; enteredAt = decidedAt;
    }
  }

  const finalStage = spec.stage || stage;
  const status = spec.status || (spec.scaled ? 'scaled' : 'active');
  const cfgFinal = stageConfig(finalStage);

  // Инициатива, ожидающая решения, «зашла» на текущий этап spec.pending дней назад.
  // Синхронизируем последнее решение и переход, чтобы хронология оставалась связной.
  if (status === 'active' && spec.pending !== undefined) {
    const entered = ts(spec.pending, 14);
    if (spec.history.length) {
      const lastGate = q.get('SELECT id FROM gate_decisions WHERE initiative_id=? ORDER BY id DESC LIMIT 1', id);
      if (lastGate) q.run('UPDATE gate_decisions SET decided_at=? WHERE id=?', entered, lastGate.id);
      const lastTr = q.get('SELECT id FROM stage_transitions WHERE initiative_id=? ORDER BY id DESC LIMIT 1', id);
      if (lastTr) q.run('UPDATE stage_transitions SET at=? WHERE id=?', entered, lastTr.id);
      if (firstDecision && spec.history.length === 1) firstDecision = entered;
    }
    enteredAt = entered;
  }

  const slaDueFinal = status === 'active' ? dueDate(enteredAt, cfgFinal?.sla_value, cfgFinal?.sla_unit) : null;

  q.run(`UPDATE initiatives SET stage=?, status=?, stage_entered_at=?, sla_due_at=?, first_decision_at=?,
         scaled_at=?, closed_at=?, updated_at=? WHERE id=?`,
    finalStage, status, enteredAt, slaDueFinal, firstDecision,
    spec.scaled ? ts(spec.history.at(-1).d) : null,
    (status === 'scaled' || status === 'killed') ? ts(spec.history.at(-1)?.d ?? spec.created) : null,
    enteredAt, id);

  created.push({ id, number, spec, stage: finalStage, status, author });
}

console.log(`Загружено инициатив: ${created.length}`);

// ── Проекты разработки для инициатив, дошедших до этапа 4 ────
const SPRINT_GOALS = [
  'Каркас решения и базовая модель данных',
  'Основной сценарий пользователя',
  'Интеграции и синхронизация',
  'Стабилизация, безопасность, подготовка к пилоту',
];
const TASK_POOL = [
  ['Спроектировать модель данных', 'story', 5], ['Экран основного сценария', 'story', 8],
  ['Офлайн-режим и синхронизация', 'story', 13], ['Роли и разграничение доступа', 'task', 5],
  ['Журналирование действий пользователя', 'task', 3], ['Нагрузочное тестирование', 'task', 5],
  ['Исправить сброс формы при потере связи', 'bug', 2], ['Инструкция для пользователей', 'task', 3],
  ['Согласовать требования по персональным данным', 'task', 5], ['Демонстрация заказчику', 'task', 2],
];

for (const it of created.filter((c) => c.stage >= 4 || c.spec.project)) {
  const pid = q.insert(`INSERT INTO projects (initiative_id, name, product_owner_id, team_lead_id, created_at)
                        VALUES (?,?,?,?,?)`,
    it.id, it.spec.title, U['makarova@social1.mos.ru'].id, U['tihonov@social1.mos.ru'].id, ts(it.spec.created - 5));

  const devs = [U['tihonov@social1.mos.ru'], U['sorokin@social1.mos.ru'], U['makarova@social1.mos.ru']];
  const sprintCount = it.stage >= 5 ? 4 : (it.stage === 4 ? 2 : 1);
  for (let s = 1; s <= 4; s++) {
    const active = s === sprintCount;
    const sid = q.insert(`INSERT INTO sprints (project_id, number, name, goal, starts_at, ends_at, status)
                          VALUES (?,?,?,?,?,?,?)`,
      pid, s, `Спринт ${s}`, SPRINT_GOALS[s - 1],
      ts(it.spec.created - 5 - (s - 1) * -14).slice(0, 10), ts(it.spec.created - 19 - (s - 1) * -14).slice(0, 10),
      s < sprintCount ? 'closed' : (active ? 'active' : 'planned'));

    for (let k = 0; k < 3; k++) {
      const [title, type, est] = TASK_POOL[(s * 3 + k) % TASK_POOL.length];
      const done = s < sprintCount;
      const statuses = ['todo', 'in_progress', 'review'];
      q.run(`INSERT INTO board_items (project_id, sprint_id, title, type, status, priority, estimate, assignee_id, order_idx)
             VALUES (?,?,?,?,?,?,?,?,?)`,
        pid, sid, title, type, done ? 'done' : (s > sprintCount ? 'backlog' : pick(statuses)),
        pick(['normal', 'normal', 'high']), est, pick(devs).id, s * 10 + k);
    }
  }
  // Бэклог продукта
  for (const [title, type, est] of TASK_POOL.slice(0, 4)) {
    q.run(`INSERT INTO board_items (project_id, sprint_id, title, type, status, priority, estimate, order_idx)
           VALUES (?,NULL,?,?, 'backlog', ?, ?, ?)`, pid, `${title} (расширение)`, type, 'low', est, 99);
  }

  q.run(`INSERT INTO documents (initiative_id, project_id, title, kind, body, created_by, created_at)
         VALUES (?,?,?,?,?,?,?)`,
    it.id, pid, 'Архитектурное решение', 'arch',
    'Компонентная схема, модель данных, требования к защите персональных данных и журналированию действий пользователей.',
    U['tihonov@social1.mos.ru'].id, ts(it.spec.created - 10));
  q.run(`INSERT INTO documents (initiative_id, project_id, title, kind, body, created_by, created_at)
         VALUES (?,?,?,?,?,?,?)`,
    it.id, pid, 'Протокол приёмочного тестирования', 'test',
    'Сценарии проверки основного пользовательского пути, результаты прогонов, перечень выявленных и устранённых замечаний.',
    U['sorokin@social1.mos.ru'].id, ts(Math.max(1, it.spec.created - 40)));
}

// ── Пилоты, KPI, опросы ──────────────────────────────────────
const FEEDBACK_POSITIVE = [
  'Стало заметно удобнее, экономит время в конце дня',
  'Хорошее решение, больше не нужно переписывать журнал вечером',
  'Понятный интерфейс, разобралась за один день',
  'Очень помогает, особенно на участках с большим числом визитов',
  'Полезная вещь, рекомендую распространить на другие отделения',
  'Быстро работает, подпись получателя оформляется просто',
];
const FEEDBACK_MIXED = [
  'В целом удобно, но иногда долго синхронизируется в подвалах',
  'Сложно было разобраться в первый день, потом привыкла',
  'Не всегда понятно, сохранилась запись или нет',
  'Неудобно вводить длинные комментарии с телефона',
];

for (const it of created.filter((c) => c.spec.pilot)) {
  const p = it.spec.pilot;
  const pilotId = q.insert(`INSERT INTO pilots (initiative_id, institution_id, coordinator_id, plan, status, starts_at, ends_at, participants_count, created_at)
                            VALUES (?,?,?,?,?,?,?,?,?)`,
    it.id, inst[p.inst], U['ershova@social1.mos.ru'].id,
    'Внедрение прототипа в реальную работу отделения на срок 1 месяц с еженедельным снятием показателей и сбором обратной связи.',
    p.status || 'finished', ts(p.start).slice(0, 10), ts(p.end).slice(0, 10), p.participants, ts(p.start + 3));

  q.run(`INSERT INTO pilot_applications (initiative_id, institution_id, applicant_id, message, status, created_at)
         VALUES (?,?,?,?,'approved',?)`,
    it.id, inst[p.inst], byRole('head').id, 'Готовы предоставить площадку и выделить участников из числа сотрудников отделения.', ts(p.start + 6));

  const kpiSets = {
    time: [['Время на оформление визита', 'мин', 12, 5], ['Время переноса данных в систему', 'мин/день', 45, 5]],
    quality: [['Доля обращений без повторного визита', '%', 67, 90], ['Удовлетворённость сотрудников', 'балл', 3.4, 4.5]],
    other: [['Удовлетворённость сотрудников', 'балл', 3.5, 4.3]],
  };
  const set = kpiSets[it.spec.effect_type] || kpiSets.quality;
  for (const [name, unit, baseline, target] of set) {
    const finished = (p.status || 'finished') === 'finished';
    const actual = finished ? target * (0.92 + Math.random() * 0.16) : baseline + (target - baseline) * 0.55;
    q.run(`INSERT INTO pilot_kpis (pilot_id, name, unit, baseline, target, actual, direction)
           VALUES (?,?,?,?,?,?,?)`,
      pilotId, name, unit, baseline, target, Math.round(actual * 10) / 10, target > baseline ? 'up' : 'down');
  }

  // Опрос сотрудников с ответами
  const surveyId = q.insert(`INSERT INTO surveys (pilot_id, initiative_id, title, audience, is_open, created_by, created_at)
                             VALUES (?,?,?,?,?,?,?)`,
    pilotId, it.id, 'Оценка решения участниками пилота', 'staff', p.status === 'finished' ? 0 : 1,
    U['ershova@social1.mos.ru'].id, ts(p.end + 2));
  const qIds = [];
  for (const [i, [text, type, options]] of [
    ['Насколько удобно пользоваться решением?', 'scale', []],
    ['Экономит ли решение ваше рабочее время?', 'choice', ['Да, заметно', 'Незначительно', 'Нет']],
    ['Что стоит улучшить в решении?', 'text', []],
  ].entries()) {
    qIds.push(q.insert(`INSERT INTO survey_questions (survey_id, text, type, options, order_idx) VALUES (?,?,?,?,?)`,
      surveyId, text, type, JSON.stringify(options), i));
  }
  const respondents = Object.values(U).filter((u) => u.role === 'employee' || u.role === 'head');
  const n = Math.min(respondents.length, Math.max(4, Math.round(p.participants / 2)));
  for (let i = 0; i < n; i++) {
    const rid = q.insert('INSERT INTO survey_responses (survey_id, respondent_id, submitted_at) VALUES (?,?,?)',
      surveyId, respondents[i % respondents.length].id, ts(Math.max(1, p.end - 1)));
    const good = i % 4 !== 3;
    q.run('INSERT INTO survey_answers (response_id, question_id, value_num) VALUES (?,?,?)', rid, qIds[0], good ? pick([4, 5, 5]) : pick([2, 3]));
    q.run('INSERT INTO survey_answers (response_id, question_id, value_text) VALUES (?,?,?)', rid, qIds[1], good ? 'Да, заметно' : 'Незначительно');
    q.run('INSERT INTO survey_answers (response_id, question_id, value_text) VALUES (?,?,?)', rid, qIds[2],
      good ? pick(FEEDBACK_POSITIVE) : pick(FEEDBACK_MIXED));
  }
}

// ── Масштабирование и лучшие практики ────────────────────────
const scaledInit = created.find((c) => c.status === 'scaled');
if (scaledInit) {
  const sites = ['ТЦСО «Бибирево»', 'ЦСПСиД «Гармония»', 'РЦ «Отрадное»', 'ЦСА «Люблино»', 'ПНИ № 11'];
  sites.forEach((s, i) => {
    q.run(`INSERT INTO rollouts (initiative_id, institution_id, status, bottom_up, started_at, completed_at, created_at)
           VALUES (?,?,?,?,?,?,?)`,
      scaledInit.id, inst[s], i < 3 ? 'deployed' : (i === 3 ? 'training' : 'planned'),
      i === 2 || i === 4 ? 1 : 0, ts(20 - i * 2), i < 3 ? ts(8 - i) : null, ts(22 - i * 2));
  });
  q.insert(`INSERT INTO best_practices (initiative_id, title, summary, materials, effect_text, published_by, published_at)
            VALUES (?,?,?,?,?,?,?)`,
    scaledInit.id, 'Мобильное приложение социального работника',
    'Отказ от бумажного журнала посещений при надомном обслуживании. Работник отмечает визит на смартфоне, получатель расписывается на экране, данные синхронизируются автоматически.',
    'Методические рекомендации по внедрению, инструкция пользователя, программа обучения (4 часа), типовой приказ о переходе на электронный учёт визитов.',
    'Пилот в ТЦСО «Ярославский»: экономия 47 минут рабочего времени в день на сотрудника при прогнозе 45. Удовлетворённость 4,6 из 5. В масштабе города — около 21 тыс. человеко-часов в год.',
    U['lebedeva@social1.mos.ru'].id, ts(20));
  grantAward(scaledInit.author.id, scaledInit.id, 'scaled', 'Автор масштабированной инициативы', U['director@social1.mos.ru'].id);
  grantAward(scaledInit.author.id, scaledInit.id, 'author', 'Практика включена в библиотеку лучших решений', U['lebedeva@social1.mos.ru'].id);
}
const secondScaled = created.find((c) => c.stage === 6 && c.status === 'active');
if (secondScaled) {
  q.insert(`INSERT INTO best_practices (initiative_id, title, summary, materials, effect_text, published_by, published_at)
            VALUES (?,?,?,?,?,?,?)`,
    secondScaled.id, 'Чек-лист документов при записи на приём',
    'Персонализированный перечень документов при онлайн-записи и SMS-напоминание за день до визита.',
    'Шаблоны чек-листов по 18 массовым услугам, тексты уведомлений, порядок актуализации перечней.',
    'Доля повторных визитов снизилась с 33% до 12% в двух территориальных центрах.',
    U['grigoriev@social1.mos.ru'].id, ts(15));
}

// ── Комментарии к инициативам ────────────────────────────────
const COMMENTS = [
  ['grigoriev@social1.mos.ru', 'Прошу автора уточнить, как измерялись 45 минут: это оценка или результат хронометража? От этого зависит расчёт эффекта при масштабировании.'],
  ['smirnova@social1.mos.ru', 'Это результат хронометража: две недели, 12 сотрудников отделения, замеры вечернего переноса данных. Диапазон 38–61 минута, среднее — 45.'],
  ['tihonov@social1.mos.ru', 'С технической стороны ограничение одно — устойчивая работа офлайн. Заложим локальное хранилище и очередь синхронизации, это стандартная задача.'],
  ['ershova@social1.mos.ru', 'Готовы взять площадку под пилот. Предлагаю ТЦСО «Ярославский» — там инициатива и родилась, сотрудники мотивированы.'],
];
if (created[0]) {
  COMMENTS.forEach(([email, body], i) => {
    q.run('INSERT INTO comments (initiative_id, author_id, body, created_at) VALUES (?,?,?,?)',
      created[0].id, U[email].id, body, ts(140 - i * 3));
  });
}
if (created[3]) {
  q.run('INSERT INTO comments (initiative_id, author_id, body, created_at) VALUES (?,?,?,?)',
    created[3].id, U['romanova@social1.mos.ru'].id,
    'Ключевой момент — шкала риска должна оставаться вспомогательной. Решение о профилактическом визите принимает специалист и фиксирует основание. Прошу заложить это в требования.', ts(60));
  q.run('INSERT INTO comments (initiative_id, author_id, body, created_at) VALUES (?,?,?,?)',
    created[3].id, U['ivanova@social1.mos.ru'].id,
    'Согласна. В прототипе шкала показывает, из каких именно сигналов сложилась оценка, — специалист видит основания, а не итоговый балл.', ts(58));
}

// ── Голоса и подписки ────────────────────────────────────────
// Поддержка распределена неравномерно: у решений с очевидной болью — больше голосов.
const voterPool = Object.values(U).filter((u) => ['employee', 'head', 'expert', 'developer', 'pilot_coordinator'].includes(u.role));
const SUPPORT = {  // доля пула, поддержавшая инициативу, и доля голосов против
  1: [0.92, 0.00], 2: [0.78, 0.04], 3: [0.62, 0.04], 4: [0.55, 0.12],
  5: [0.40, 0.08], 6: [0.70, 0.00], 7: [0.48, 0.08], 8: [0.36, 0.04],
  9: [0.66, 0.00], 10: [0.44, 0.12], 11: [0.30, 0.04], 12: [0.16, 0.20],
  13: [0.52, 0.08], 14: [0.58, 0.04], 15: [0.26, 0.00],
};
let votesPlaced = 0;
created.forEach((it, idx) => {
  const [upShare, downShare] = SUPPORT[idx + 1] || [0.3, 0.05];
  const shuffled = [...voterPool].sort(() => Math.random() - 0.5);
  const ups = Math.round(shuffled.length * upShare);
  const downs = Math.round(shuffled.length * downShare);
  shuffled.slice(0, ups + downs).forEach((u, i) => {
    if (u.id === it.author.id) return;              // автор не голосует за себя
    const value = i < ups ? 1 : -1;
    try {
      q.run('INSERT INTO votes (initiative_id, user_id, value, created_at) VALUES (?,?,?,?)',
        it.id, u.id, value, ts(Math.max(1, it.spec.created - 2 - Math.floor(Math.random() * 20))));
      votesPlaced += 1;
    } catch {}
  });
  // Подписки: часть проголосовавших следит за судьбой инициативы
  shuffled.slice(0, Math.round(ups * 0.5)).forEach((u) => {
    if (u.id === it.author.id) return;
    try {
      q.run('INSERT INTO follows (initiative_id, user_id, created_at) VALUES (?,?,?)',
        it.id, u.id, ts(Math.max(1, it.spec.created - 3)));
    } catch {}
  });
  // Автор всегда следит за своей инициативой
  try { q.run('INSERT INTO follows (initiative_id, user_id, created_at) VALUES (?,?,?)', it.id, it.author.id, ts(it.spec.created)); } catch {}
});
console.log(`Расставлено голосов: ${votesPlaced}`);

// ── Форум ────────────────────────────────────────────────────
const TOPICS = [
  ['Как правильно измерить эффект инициативы до пилота?', 'methodology', 'grigoriev@social1.mos.ru',
   'Частая причина возврата инициативы на доработку — эффект заявлен словами «станет удобнее», без чисел. Делюсь простым подходом: выберите один показатель, замерьте его текущее значение хотя бы за неделю и укажите, каким оно станет. Даже грубая оценка на основе хронометража работает лучше, чем общие формулировки.',
   [['smirnova@social1.mos.ru', 'Именно так и делала: две недели замеров перед подачей. Экспертиза прошла без вопросов, а на пилоте цифра почти совпала с прогнозом.'],
    ['fedorov@social1.mos.ru', 'А если эффект в качестве услуги, а не во времени? У нас снижение доли отказов — как это правильно посчитать?'],
    ['grigoriev@social1.mos.ru', 'Так же: текущая доля отказов за квартал и целевая. Главное — показатель должен считаться из данных, которые у вас уже есть.']]],
  ['Опыт пилотирования: чего мы не учли в первый раз', 'pilots', 'ershova@social1.mos.ru',
   'Собрала наблюдения по завершённым пилотам. Первое: обучение нужно проводить до начала пилота, а не в первый день — иначе первая неделя уходит на освоение и портит статистику. Второе: назначайте в учреждении ответственного за сбор обратной связи, иначе анкеты остаются незаполненными. Третье: снимайте базовые значения показателей заранее, до внедрения.',
   [['volkov@social1.mos.ru', 'Подтверждаю по нашему пилоту. Базовые замеры сделали за две недели до старта, это сильно упростило защиту результатов на Gate 4.'],
    ['danilov@social1.mos.ru', 'Добавлю: полезно заранее договориться, что считается критическим сбоем. Иначе спор о том, останавливать пилот или нет, возникает в самый неподходящий момент.']]],
  ['Инициатива получила Kill — что дальше?', 'general', 'kuznecov@social1.mos.ru',
   'Мою инициативу про экран дежурств остановили на экспертизе с формулировкой «решается силами учреждения». Сначала расстроился, потом перечитал обоснование: эксперт прямо написал, что идея рабочая, просто не требует централизованного проекта. Внедрили сами за две недели. Вопрос к коллегам: стоит ли такие локальные решения оформлять через платформу вообще?',
   [['lebedeva@social1.mos.ru', 'Обязательно стоит. Kill в этом случае означает «не нужен централизованный проект», а не «идея плохая». Ваш опыт мы разместим в библиотеке практик — другие учреждения смогут повторить.'],
    ['morozov@social1.mos.ru', 'Поддерживаю. У нас после вашего примера сделали то же самое, ушло десять дней.']]],
  ['Что делать, если инициатива дублирует уже существующую?', 'methodology', 'nikitina@social1.mos.ru',
   'При подаче система показала похожую инициативу из другого центра — совпадение 62%. Правильно ли объединять усилия или подавать отдельно, если контекст всё-таки различается?',
   [['romanova@social1.mos.ru', 'Если проблема одна, а контекст разный — лучше присоединиться к существующей и описать свою специфику в комментариях. Так решение сразу проектируется под несколько типов учреждений и легче масштабируется.']]],
];
for (const [title, cat, author, body, replies] of TOPICS) {
  const tid = q.insert(`INSERT INTO forum_topics (title, category, author_id, created_at) VALUES (?,?,?,?)`,
    title, cat, U[author].id, ts(30 + TOPICS.indexOf(TOPICS.find((t) => t[0] === title)) * 4));
  q.run('INSERT INTO forum_posts (topic_id, author_id, body, created_at) VALUES (?,?,?,?)', tid, U[author].id, body, ts(30));
  replies.forEach(([email, text], i) => {
    q.run('INSERT INTO forum_posts (topic_id, author_id, body, created_at) VALUES (?,?,?,?)', tid, U[email].id, text, ts(28 - i * 2));
  });
}

// ── Модуль «Идеи и решения» ──────────────────────────────────
// Идеи — быстрый вход в экосистему: сотрудник фиксирует проблему, коллеги
// предлагают решения и делятся опытом, за полезный вклад начисляются очки.
const IDEAS = [
  {
    author: 'smirnova@social1.mos.ru', created: 74, status: 'done', template: 'speed',
    category: 'Оптимизация процессов', priority: 'high',
    title: 'Долгая передача смены в отделении надомного обслуживания',
    problem: 'Передача смены занимает до 40 минут: уходящий социальный работник пересказывает сменщику особенности каждого получателя услуг — кто на диете, у кого сегодня врач, к кому нельзя приходить до полудня. Часть информации теряется, из-за этого случаются накладки с визитами.',
    desired_result: 'Сменщик получает готовую сводку по своим получателям услуг за 5 минут и ничего не забывает.',
    moderator: 'lebedeva@social1.mos.ru', moderated: 72,
    note: 'Проблема понятна и подтверждается коллегами из других центров. Принимаю к обсуждению.',
    reactions: [['petrov@social1.mos.ru', 'useful'], ['fedorov@social1.mos.ru', 'useful'],
                ['ivanova@social1.mos.ru', 'support'], ['orlova@social1.mos.ru', 'support'],
                ['nikitina@social1.mos.ru', 'join'], ['kuznecov@social1.mos.ru', 'useful']],
    proposals: [
      {
        author: 'fedorov@social1.mos.ru', created: 70, kind: 'experience', status: 'implemented',
        summary: 'У нас в «Бибирево» два года работает короткая карточка получателя услуг в общей таблице: три строки — ограничения, ближайшие события, особые пожелания. Смена передаётся по списку, а не по памяти.',
        how_to_apply: 'Завести в общем доступе таблицу по отделению: одна строка на получателя услуг, три поля. Заполняет тот, кто был на визите последним, — это занимает минуту. Сменщик утром открывает свой список и читает только своих.',
        expected_effect: 'Передача смены сократилась с 35–40 до 6–8 минут. За два года ни одной накладки с визитами по причине несогласованности.',
        risks: 'В таблицу нельзя вносить диагнозы и другие сведения, которые относятся к специальным категориям персональных данных.',
        verified_by: 'lebedeva@social1.mos.ru',
        endorsers: ['smirnova@social1.mos.ru', 'petrov@social1.mos.ru', 'ivanova@social1.mos.ru',
                    'orlova@social1.mos.ru', 'nikitina@social1.mos.ru', 'kuznecov@social1.mos.ru',
                    'larina@social1.mos.ru'],
      },
      {
        author: 'petrov@social1.mos.ru', created: 68, kind: 'proposal', status: 'published',
        summary: 'Добавить в учётную систему поле «заметка к следующему визиту», которое видно сменщику при открытии карточки.',
        how_to_apply: 'Доработка карточки получателя услуг в существующей системе. Требуется заявка в отдел сопровождения.',
        expected_effect: 'Информация не теряется между сменами, доступ разграничен по отделению.',
        risks: 'Потребуется время на доработку системы, за неделю не сделать.',
        needs_approval: 1,
        endorsers: ['smirnova@social1.mos.ru', 'orlova@social1.mos.ru'],
      },
    ],
    comments: [
      ['orlova@social1.mos.ru', 'У нас та же история, только в реабилитационном центре. Таблица выглядит рабочим вариантом — попробуем на одном отделении.', 66],
      ['smirnova@social1.mos.ru', 'Спасибо, начали вести карточки со вторника. Передача смены уже укладывается в десять минут.', 60],
    ],
  },
  {
    author: 'ivanova@social1.mos.ru', created: 58, status: 'in_progress', template: 'errors',
    category: 'Качество услуг', priority: 'high',
    title: 'Родители заполняют одни и те же сведения в четырёх заявлениях',
    problem: 'Семья, обращающаяся за несколькими мерами поддержки, каждый раз заново вписывает состав семьи, доходы и контакты. На четыре заявления уходит около часа, ошибки в повторяющихся данных приводят к возврату документов.',
    desired_result: 'Данные вводятся один раз и подставляются в остальные заявления автоматически.',
    moderator: 'lebedeva@social1.mos.ru', moderated: 56,
    note: 'Идея пересекается с направлением цифровизации приёма. Открываю обсуждение.',
    reactions: [['larina@social1.mos.ru', 'useful'], ['fedorov@social1.mos.ru', 'useful'],
                ['petrov@social1.mos.ru', 'support'], ['nikitina@social1.mos.ru', 'support'],
                ['smirnova@social1.mos.ru', 'join']],
    proposals: [
      {
        author: 'larina@social1.mos.ru', created: 54, kind: 'proposal', status: 'useful', accepted: true,
        summary: 'Ввести единую анкету семьи: специалист заполняет её один раз при первом обращении, дальше данные подставляются во все заявления, а заявитель только подтверждает актуальность.',
        how_to_apply: 'Первый шаг — бумажный: единый бланк сведений о семье, который прикладывается к пакету. Параллельно — заявка на доработку системы приёма заявлений.',
        expected_effect: 'Время подачи четырёх заявлений сокращается с часа до 15–20 минут, повторные ошибки исчезают.',
        risks: 'Нужно согласовать состав единой анкеты с юридической службой: перечень сведений в разных услугах различается.',
        needs_approval: 1,
        endorsers: ['ivanova@social1.mos.ru', 'petrov@social1.mos.ru', 'fedorov@social1.mos.ru',
                    'nikitina@social1.mos.ru'],
      },
      {
        author: 'nikitina@social1.mos.ru', created: 52, kind: 'proposal', status: 'published',
        summary: 'Сделать памятку со списком услуг, которые обычно оформляются вместе, чтобы специалист сразу предлагал полный набор.',
        how_to_apply: 'Собрать статистику по частым сочетаниям услуг и выпустить памятку для специалистов приёма.',
        expected_effect: 'Меньше повторных визитов, семья узнаёт обо всех доступных мерах сразу.',
        endorsers: ['ivanova@social1.mos.ru'],
      },
    ],
    comments: [
      ['larina@social1.mos.ru', 'Готова собрать перечень полей, которые повторяются во всех четырёх заявлениях. По нашей практике их около двадцати.', 50],
    ],
  },
  {
    author: 'kuznecov@social1.mos.ru', created: 45, status: 'accepted', template: 'ui',
    category: 'Цифровые сервисы', priority: 'normal',
    title: 'Расписание занятий в интернате висит только на стенде',
    problem: 'Расписание реабилитационных занятий печатается и вывешивается на стенде первого этажа. Проживающие с нарушениями зрения и мобильности не могут его прочитать, родственники звонят по телефону и уточняют каждый раз.',
    desired_result: 'Расписание доступно с телефона и на экране в холле, с крупным шрифтом и голосовым прочтением.',
    moderator: 'grigoriev@social1.mos.ru', moderated: 43,
    note: 'Идея касается доступной среды — приоритетное направление. Принимаю к обсуждению.',
    reactions: [['orlova@social1.mos.ru', 'useful'], ['orlova@social1.mos.ru', 'join'],
                ['nikitina@social1.mos.ru', 'useful'], ['ivanova@social1.mos.ru', 'support']],
    proposals: [
      {
        author: 'orlova@social1.mos.ru', created: 42, kind: 'experience', status: 'verified',
        summary: 'В «Преодолении» повесили в холле обычный телевизор с флешкой: расписание крупным шрифтом сменяется каждые 20 секунд. Обошлось без закупки специального оборудования — использовали списанный телевизор.',
        how_to_apply: 'Файл расписания готовит методист в понедельник, сохраняет на флешку в формате изображений. Телевизор включается по расписанию розеточным таймером.',
        expected_effect: 'Звонков родственников с вопросом «когда занятие» стало заметно меньше, проживающие с остаточным зрением читают расписание сами.',
        risks: 'Решение не помогает полностью незрячим — им по-прежнему нужен голосовой формат.',
        verified_by: 'grigoriev@social1.mos.ru',
        endorsers: ['kuznecov@social1.mos.ru', 'nikitina@social1.mos.ru', 'ivanova@social1.mos.ru',
                    'smirnova@social1.mos.ru'],
      },
    ],
    comments: [
      ['kuznecov@social1.mos.ru', 'Телевизор нашли, попробуем на этой неделе. Отдельно подумаем про голосовое прочтение для незрячих.', 40],
    ],
  },
  {
    author: 'orlova@social1.mos.ru', created: 33, status: 'accepted', template: 'automate',
    category: 'Оптимизация процессов', priority: 'normal',
    title: 'Ежемесячный отчёт по занятости залов собирается вручную',
    problem: 'Методист в конце месяца обходит журналы четырёх залов, переписывает часы занятий в таблицу и сводит отчёт. Уходит полный рабочий день, к тому же данные из журналов не всегда совпадают с фактическим расписанием.',
    desired_result: 'Отчёт формируется из расписания автоматически, методист только проверяет и подписывает.',
    moderator: 'lebedeva@social1.mos.ru', moderated: 31,
    note: 'Типовая задача для большинства учреждений. Принимаю к обсуждению — интересен опыт коллег.',
    reactions: [['kuznecov@social1.mos.ru', 'useful'], ['nikitina@social1.mos.ru', 'useful'],
                ['smirnova@social1.mos.ru', 'support']],
    proposals: [
      {
        author: 'nikitina@social1.mos.ru', created: 30, kind: 'proposal', status: 'useful',
        summary: 'Вести расписание сразу в электронной таблице с автоматическим подсчётом часов по залам — тогда отчёт получается сам собой к концу месяца.',
        how_to_apply: 'Один раз настроить шаблон таблицы с формулами. Дальше методист вносит занятия в расписание, а лист «Отчёт» пересчитывается автоматически.',
        expected_effect: 'День работы в конце месяца превращается в проверку готовых цифр за полчаса.',
        endorsers: ['orlova@social1.mos.ru', 'kuznecov@social1.mos.ru', 'ivanova@social1.mos.ru'],
      },
    ],
    comments: [],
  },
  {
    author: 'larina@social1.mos.ru', created: 26, status: 'accepted', template: 'other',
    category: 'Качество услуг', priority: 'normal',
    title: 'Соискателям неясно, чем именно помогает центр занятости',
    problem: 'На первой консультации половина времени уходит на объяснение, какие услуги вообще существуют. Люди приходят с ожиданием, что им сразу дадут вакансию, и уходят разочарованными, не узнав про обучение и профориентацию.',
    desired_result: 'Человек до прихода понимает, с чем ему помогут, и приходит с конкретным запросом.',
    moderator: 'lebedeva@social1.mos.ru', moderated: 25,
    note: 'Идея открыта для решений. Интересны примеры из других учреждений.',
    reactions: [['ivanova@social1.mos.ru', 'useful'], ['petrov@social1.mos.ru', 'support'],
                ['fedorov@social1.mos.ru', 'support']],
    proposals: [
      {
        author: 'ivanova@social1.mos.ru', created: 24, kind: 'proposal', status: 'published',
        summary: 'Короткий опросник при записи: три вопроса о ситуации соискателя. По ответам система показывает, какие услуги ему подойдут, а консультант заранее видит запрос.',
        how_to_apply: 'Составить опросник вместе с консультантами, разместить на странице записи. Ответы приходят вместе с записью.',
        expected_effect: 'Консультация начинается с сути, ожидания совпадают с возможностями центра.',
        endorsers: ['larina@social1.mos.ru', 'petrov@social1.mos.ru'],
      },
    ],
    comments: [],
  },
  {
    author: 'petrov@social1.mos.ru', created: 18, status: 'review',
    category: 'Цифровые сервисы', priority: 'normal', template: 'ui',
    title: 'В электронной очереди не видно, к какому окну идти',
    problem: 'Табло показывает номер талона, но не номер окна. Люди подходят не к тому специалисту, очередь сбивается, сотрудники тратят время на перенаправление.',
    desired_result: 'На табло и в SMS видно номер окна вместе с номером талона.',
    moderator: 'grigoriev@social1.mos.ru', moderated: 16,
    note: 'Уточните, пожалуйста, о каком именно табло идёт речь — в холле или в зале ожидания? От этого зависит, кто исполнитель.',
    reactions: [['smirnova@social1.mos.ru', 'useful'], ['fedorov@social1.mos.ru', 'useful']],
    proposals: [],
    comments: [
      ['petrov@social1.mos.ru', 'Речь про большое табло в холле. В зале ожидания табло вообще нет, там сотрудник называет номера голосом.', 15],
    ],
  },
  {
    author: 'fedorov@social1.mos.ru', created: 12, status: 'accepted', template: 'speed',
    category: 'Оптимизация процессов', priority: 'high',
    title: 'Согласование заявки на бытовую технику для подопечного идёт три недели',
    problem: 'Заявка на выдачу технических средств проходит четырёх согласующих последовательно, каждый по нескольку дней. Подопечный ждёт три недели, при этом отказов почти не бывает — согласование формально.',
    desired_result: 'Срок сокращается до недели без потери контроля.',
    moderator: 'lebedeva@social1.mos.ru', moderated: 11,
    note: 'Проблема системная, встречается в нескольких учреждениях. Открываю обсуждение.',
    reactions: [['smirnova@social1.mos.ru', 'useful'], ['kuznecov@social1.mos.ru', 'useful'],
                ['orlova@social1.mos.ru', 'useful'], ['ivanova@social1.mos.ru', 'support'],
                ['nikitina@social1.mos.ru', 'support'], ['larina@social1.mos.ru', 'join'],
                ['petrov@social1.mos.ru', 'join']],
    proposals: [
      {
        author: 'smirnova@social1.mos.ru', created: 10, kind: 'proposal', status: 'useful',
        summary: 'Согласовывать параллельно, а не по цепочке: заявка уходит всем четверым сразу, решение считается принятым, если за три дня не поступило возражений.',
        how_to_apply: 'Изменить порядок в регламенте учреждения и настроить рассылку заявки всем согласующим одновременно.',
        expected_effect: 'Срок сокращается с трёх недель до трёх–пяти дней, контроль сохраняется.',
        risks: 'Требуется изменение внутреннего регламента и согласие руководителя учреждения.',
        needs_approval: 1,
        endorsers: ['fedorov@social1.mos.ru', 'kuznecov@social1.mos.ru', 'ivanova@social1.mos.ru',
                    'orlova@social1.mos.ru', 'nikitina@social1.mos.ru'],
      },
      {
        author: 'kuznecov@social1.mos.ru', created: 9, kind: 'proposal', status: 'published',
        summary: 'Установить предельный срок ответа для каждого согласующего — два рабочих дня, с автоматическим напоминанием.',
        how_to_apply: 'Добавить контроль сроков в существующую систему документооборота.',
        expected_effect: 'Дисциплина согласования повышается, крайние случаи видны руководителю.',
        endorsers: ['fedorov@social1.mos.ru'],
      },
    ],
    comments: [
      ['fedorov@social1.mos.ru', 'Параллельное согласование выглядит реалистично. Обсудим с директором на ближайшей планёрке.', 8],
    ],
  },
  {
    author: 'nikitina@social1.mos.ru', created: 7, status: 'new',
    category: 'Качество услуг', priority: 'normal', template: 'other',
    title: 'Приёмные семьи не знают, к кому обращаться между визитами куратора',
    problem: 'Между плановыми визитами куратора у приёмной семьи возникают вопросы, а к кому обратиться — непонятно. Звонят на общий номер учреждения, попадают не туда, часть вопросов остаётся без ответа.',
    desired_result: 'У каждой семьи есть понятный канал связи с ответом в течение рабочего дня.',
    reactions: [['ivanova@social1.mos.ru', 'useful'], ['larina@social1.mos.ru', 'support']],
    proposals: [], comments: [],
  },
  {
    author: 'orlova@social1.mos.ru', created: 5, status: 'new',
    category: 'Доступная среда', priority: 'high', template: 'errors',
    title: 'Пандус у входа обледеневает раньше, чем его успевают обработать',
    problem: 'Утром пандус покрывается наледью, а обработка по графику начинается в девять. Первые посетители приходят к восьми. За зиму — два падения.',
    desired_result: 'Пандус безопасен с момента открытия учреждения.',
    reactions: [['kuznecov@social1.mos.ru', 'useful'], ['nikitina@social1.mos.ru', 'useful'],
                ['smirnova@social1.mos.ru', 'support']],
    proposals: [], comments: [],
  },
  {
    author: 'petrov@social1.mos.ru', created: 21, status: 'rejected',
    category: 'Цифровые сервисы', priority: 'low', template: 'other',
    title: 'Сделать в системе кнопку «напечатать всё»',
    problem: 'Приходится печатать документы по одному.',
    desired_result: 'Печатать всё сразу.',
    moderator: 'grigoriev@social1.mos.ru', moderated: 19,
    note: 'Идея решается настройкой рабочего места: пакетная печать уже есть в меню «Файл — Печать пакета». Обратитесь в отдел сопровождения, вам покажут. Централизованный проект здесь не требуется.',
    reactions: [], proposals: [], comments: [],
  },
];

const ideaRows = [];
IDEAS.forEach((spec, idx) => {
  const author = U[spec.author];
  const number = `IDEA-${new Date().getFullYear()}-${String(idx + 1).padStart(4, '0')}`;
  const id = q.insert(`INSERT INTO ideas
    (number, title, problem, desired_result, category, priority, template, author_id, institution_id,
     status, moderation_note, moderated_by, moderated_at, created_at, updated_at, closed_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    number, spec.title, spec.problem, spec.desired_result, spec.category, spec.priority || 'normal',
    spec.template || null, author.id, author.institution_id, spec.status,
    spec.note || null, spec.moderator ? U[spec.moderator].id : null,
    spec.moderated ? ts(spec.moderated) : null,
    ts(spec.created), ts(Math.max(1, spec.moderated ?? spec.created)),
    ['rejected', 'archived', 'done'].includes(spec.status) ? ts(Math.max(1, spec.created - 40)) : null);

  for (const [email, kind] of spec.reactions || []) {
    try {
      q.run('INSERT INTO idea_reactions (idea_id, user_id, kind, created_at) VALUES (?,?,?,?)',
        id, U[email].id, kind, ts(Math.max(1, spec.created - 2)));
    } catch {}
  }
  for (const [email, body, days] of spec.comments || []) {
    q.run('INSERT INTO idea_comments (idea_id, author_id, body, created_at) VALUES (?,?,?,?)',
      id, U[email].id, body, ts(days));
  }
  ideaRows.push({ id, number, spec, author });
});

// Начисление очков через рабочие правила модуля — с теми же проверками,
// что и при обычной работе: дубли, самооценка и предел по объекту.
let ledgerCount = 0;
const awardAt = (when, opts) => {
  const r = awardPoints(opts);
  if (!r.awarded) return r;
  ledgerCount += 1;
  q.run('UPDATE points_ledger SET created_at=? WHERE id=(SELECT MAX(id) FROM points_ledger)', ts(when));
  return r;
};

for (const idea of ideaRows) {
  const { spec } = idea;
  if (['accepted', 'in_progress', 'done'].includes(spec.status)) {
    awardAt(spec.moderated ?? spec.created, {
      userId: idea.author.id, code: 'idea.approved', ideaId: idea.id,
      reason: `Идея ${idea.number} принята к обсуждению`,
      awardedBy: spec.moderator ? U[spec.moderator].id : null,
    });
  }

  for (const p of spec.proposals || []) {
    const pAuthor = U[p.author];
    const pid = q.insert(`INSERT INTO proposals
      (idea_id, author_id, summary, how_to_apply, expected_effect, risks, needs_approval, kind, status,
       verified_by, verified_at, useful_marked_at, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      idea.id, pAuthor.id, p.summary, p.how_to_apply || null, p.expected_effect || null,
      p.risks || null, p.needs_approval || 0, p.kind, p.status,
      p.verified_by ? U[p.verified_by].id : null, p.verified_by ? ts(p.created - 2) : null,
      ['useful', 'implemented'].includes(p.status) ? ts(p.created - 3) : null,
      ts(p.created), ts(Math.max(1, p.created - 3)));

    if (p.accepted) q.run('UPDATE ideas SET accepted_proposal_id=? WHERE id=?', pid, idea.id);

    awardAt(p.created, {
      userId: pAuthor.id, code: 'proposal.created', ideaId: idea.id, proposalId: pid,
      sourceUserId: idea.author.id, reason: `Предложено решение по идее ${idea.number}`,
    });

    for (const email of p.endorsers || []) {
      if (U[email].id === pAuthor.id) continue;
      try {
        q.run('INSERT INTO proposal_endorsements (proposal_id, user_id, created_at) VALUES (?,?,?)',
          pid, U[email].id, ts(Math.max(1, p.created - 4)));
      } catch { continue; }
      awardAt(Math.max(1, p.created - 4), {
        userId: pAuthor.id, code: 'proposal.endorsed', ideaId: idea.id, proposalId: pid,
        sourceUserId: U[email].id, reason: 'Решение поддержано коллегой',
      });
    }

    if (['useful', 'implemented'].includes(p.status)) {
      awardAt(Math.max(1, p.created - 3), {
        userId: pAuthor.id, code: 'proposal.useful', ideaId: idea.id, proposalId: pid,
        sourceUserId: idea.author.id, reason: `Решение признано полезным автором идеи ${idea.number}`,
      });
    }
    if (p.status === 'verified' || (p.kind === 'experience' && p.status === 'implemented')) {
      awardAt(Math.max(1, p.created - 2), {
        userId: pAuthor.id, code: 'experience.verified', ideaId: idea.id, proposalId: pid,
        sourceUserId: p.verified_by ? U[p.verified_by].id : U['lebedeva@social1.mos.ru'].id,
        reason: `Проверенный опыт подтверждён (идея ${idea.number})`,
      });
    }
    if (p.accepted) {
      awardAt(Math.max(1, p.created - 5), {
        userId: pAuthor.id, code: 'proposal.accepted', ideaId: idea.id, proposalId: pid,
        sourceUserId: U['lebedeva@social1.mos.ru'].id, reason: `Предложение принято в работу (идея ${idea.number})`,
      });
    }
    if (p.status === 'implemented') {
      awardAt(Math.max(1, p.created - 6), {
        userId: pAuthor.id, code: 'proposal.implemented', ideaId: idea.id, proposalId: pid,
        sourceUserId: U['lebedeva@social1.mos.ru'].id, reason: `Предложение внедрено и дало эффект (идея ${idea.number})`,
      });
    }
  }
}

// ── Быстрое ревью предложений ────────────────────────────────
// Оценки коллег в режиме карточек: они формируют полезность предложения
// и порядок в очереди модератора, но очков автору не начисляют.
const REVIEWERS = Object.values(U).filter((u) => ['employee', 'head', 'expert', 'pilot_coordinator'].includes(u.role));
const SKIP_REASON_CODES = ['unclear', 'costly', 'risky', 'duplicate', 'irrelevant', 'against_rules'];
// Чем ближе предложение к внедрению, тем охотнее его отмечают полезным
const LIKE_SHARE = { implemented: 0.92, verified: 0.85, useful: 0.72, published: 0.45, rejected: 0.2 };

let reviewCount = 0;
for (const p of q.all(`SELECT p.id, p.author_id, p.status, p.created_at, i.status AS idea_status
                       FROM proposals p JOIN ideas i ON i.id = p.idea_id`)) {
  if (!['review', 'accepted', 'in_progress'].includes(p.idea_status)) continue;
  const share = LIKE_SHARE[p.status] ?? 0.5;
  // Заметные предложения видит больше коллег
  const audience = [...REVIEWERS].sort(() => Math.random() - 0.5)
    .slice(0, Math.round(REVIEWERS.length * (0.45 + share * 0.5)));

  for (const r of audience) {
    if (r.id === p.author_id) continue;
    const roll = Math.random();
    const verdict = roll < share ? 'like' : roll < share + 0.12 ? 'favorite' : 'skip';
    try {
      q.run(`INSERT INTO proposal_reviews (proposal_id, user_id, verdict, reason, dwell_ms, device, created_at)
             VALUES (?,?,?,?,?,?,?)`,
        p.id, r.id, verdict,
        verdict === 'skip' ? pick(SKIP_REASON_CODES) : null,
        2000 + Math.floor(Math.random() * 9000),      // осмысленное время на карточке
        `seed-${r.id}`, ts(Math.max(1, Math.floor(Math.random() * 20))));
      reviewCount += 1;
    } catch {}
  }
}
console.log(`Оценок в ревью: ${reviewCount}`);

// Обращение о нарушении — для демонстрации разбора модератором
q.run(`INSERT INTO idea_reports (target_type, target_id, user_id, reason, created_at) VALUES ('idea',?,?,?,?)`,
  ideaRows.at(-1).id, U['fedorov@social1.mos.ru'].id,
  'Идея дублирует уже настроенную возможность системы, стоит объединить с описанием в базе знаний.', ts(17));

// Часть начислений переносим в текущий календарный месяц: иначе рейтинг за месяц
// оказывается пустым, если демонстрационные данные загружены в начале месяца.
const daysThisMonth = Math.max(1, new Date().getDate() - 1);
q.all('SELECT id FROM points_ledger ORDER BY created_at DESC LIMIT ?', Math.ceil(ledgerCount * 0.45))
  .forEach((r, i) => q.run('UPDATE points_ledger SET created_at=? WHERE id=?', ts(i % daysThisMonth), r.id));

for (const u of q.all("SELECT DISTINCT user_id FROM points_ledger WHERE status='approved'")) {
  refreshBadges(u.user_id);
}

// Рекомендации к поощрению по итогам периода: система предлагает, решает руководитель
const period = periodBounds('month');
const totals = q.all(`
  SELECT l.user_id, SUM(l.points) AS points, u.institution_id FROM points_ledger l
  JOIN users u ON u.id = l.user_id
  WHERE l.status='approved' GROUP BY l.user_id ORDER BY points DESC`);
// Три лучших социальных советника экосистемы и лучший социальный советник учреждения, чей руководитель
// открывает демонстрацию, — иначе раздел поощрений у него окажется пустым.
const demoInstitution = U['volkov@social1.mos.ru'].institution_id;
const leaders = totals.slice(0, 3);
const local = totals.find((t) => t.institution_id === demoInstitution && !leaders.includes(t));
if (local) leaders.push(local);

const MEASURES = [
  ['bonus', 'approved', 'Вклад подтверждён внедрённым решением. Направлено в отдел кадров для оформления.'],
  ['extra_day_off', 'agreed', 'Согласовано с руководителем отделения, дата будет определена по графику.'],
  ['head_gratitude', 'proposed', null],
  ['advisor_of_month', 'proposed', null],
];
leaders.forEach((l, i) => {
  const [code, status, note] = MEASURES[i] || MEASURES[2];
  q.run(`INSERT INTO incentives
    (user_id, type_code, period, period_label, points_at_creation, rank_at_creation, status, note,
     decision_note, proposed_by, decided_by, decided_at, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    l.user_id, code, 'month', period.label, l.points, i + 1, status,
    `${l.points} очков за период, ${i + 1} место в рейтинге социальных советников.`, note,
    U['lebedeva@social1.mos.ru'].id,
    status === 'proposed' ? null : U['volkov@social1.mos.ru'].id,
    status === 'proposed' ? null : ts(3), ts(6), ts(status === 'proposed' ? 6 : 3));
});

// Уведомления модуля старше десяти дней помечаем прочитанными — иначе список
// в демонстрации выглядит как непрочитанная лента начислений.
q.run(`UPDATE notifications SET is_read=1
       WHERE idea_id IS NOT NULL OR type IN ('points','badge','incentive_proposed')`);

console.log(`Идей: ${ideaRows.length}, предложений: ${q.get('SELECT COUNT(*) AS c FROM proposals').c}, начислений: ${ledgerCount}`);

// ── Изменения процессов ──────────────────────────────────────
// Предложения заводятся тем же кодом, что работает в интерфейсе: с обсуждением,
// голосами, листом согласования и начислением очков. Демонстрационные данные
// показывают раздел во всех состояниях — от обсуждения до вступления в силу.
const backdate = (table, id, fields) => {
  const sets = Object.keys(fields).map((f) => `${f}=?`).join(', ');
  q.run(`UPDATE ${table} SET ${sets} WHERE id=?`, ...Object.values(fields), id);
};

// Замечания на шагах схем: метки видны прямо на диаграмме
const SCHEME_NOTES = [
  ['e2e', 'g2', 'lebedeva@social1.mos.ru', 21,
   'Пять рабочих дней на вердикт — половина времени пути инициативы до пилота. По типовым обращениям решение готово за три.'],
  ['e2e', 'build', 'tihonov@social1.mos.ru', 14,
   'Четыре спринта — усреднённый план. Для простых доработок хватает двух, и это стоит отражать в схеме.'],
  ['emp-submit', 'search', 'petrov@social1.mos.ru', 9,
   'Проверять дубли приходится в другом разделе: возвращаешься к форме и заполняешь заново.'],
  ['emp-pilot', 'analyse', 'ershova@social1.mos.ru', 26,
   'Сопоставление откликов с KPI по итогам месяца — поздно. Расхождение прогноза с фактом всплывает уже на Gate 4.'],
];
for (const [defKey, nodeId, email, daysAgo, body] of SCHEME_NOTES) {
  const c = changes.addComment({ defKey, nodeId, body, user: U[email] });
  backdate('discussions', c.id, { created_at: ts(daysAgo) });
}
// Часть замечаний коллеги отметили полезными
for (const [nodeId, email] of [['g2', 'grigoriev@social1.mos.ru'], ['g2', 'volkov@social1.mos.ru'],
                               ['analyse', 'danilov@social1.mos.ru']]) {
  const row = q.get("SELECT id FROM discussions WHERE anchor_id=? AND target_type='process' ORDER BY id LIMIT 1", nodeId);
  if (row) changes.markCommentUseful({ commentId: row.id, user: U[email] });
}

/** Завести предложение и довести его до нужного состояния. */
function seedChange({ defKey, author, title, rationale, effect, edit, supporters = [],
                      objectors = [], discussion = [], stage, verdicts = {}, days }) {
  const c = changes.createChange({
    defKey, title, rationale, expectedEffect: effect ?? null, user: U[author],
  });
  const model = structuredClone(repo.getVersion(c.draft_version_id).model);
  edit(model);
  changes.saveChangeModel({ changeId: c.id, model, user: U[author] });
  backdate('process_changes', c.id, { created_at: ts(days.created) });
  if (stage === 'draft') return c;

  changes.submitForDiscussion({ changeId: c.id, user: U[author] });
  backdate('process_changes', c.id, { submitted_at: ts(days.submitted), updated_at: ts(days.submitted) });
  for (const email of supporters) changes.vote({ changeId: c.id, user: U[email], value: 1 });
  for (const email of objectors) changes.vote({ changeId: c.id, user: U[email], value: -1 });
  for (const [email, body] of discussion) {
    const m = changes.addComment({ defKey, changeId: c.id, body, user: U[email] });
    backdate('discussions', m.id, { created_at: ts(Math.max(0, days.submitted - 1)) });
  }
  if (stage === 'discussion') return c;

  changes.submitForApproval({ changeId: c.id, user: U[author] });
  for (const row of changes.approvalSheet(c.id)) {
    const decision = verdicts[row.role_code];
    if (!decision) continue;                       // роль ещё не высказалась
    changes.decideApproval({ changeId: c.id, user: U[decision.by],
                             verdict: decision.verdict, comment: decision.comment ?? null });
    backdate('approvals', row.id, { decided_at: ts(days.decided) });
  }
  if (changes.getChange(c.id).status === 'accepted' && stage === 'published') {
    changes.publishChange({ changeId: c.id, user: U['director@social1.mos.ru'] });
    backdate('process_changes', c.id, { decided_at: ts(days.decided), published_at: ts(days.published) });
  } else {
    backdate('process_changes', c.id, { decided_at: ts(days.decided) });
  }
  return c;
}

seedChange({
  defKey: 'emp-pilot', author: 'smirnova@social1.mos.ru',
  title: 'Сверять отклики пилота с KPI еженедельно',
  rationale: 'Сейчас отклики сопоставляются с показателями только по итогам месяца. Расхождение прогноза с фактом всплывает уже на Gate 4, когда исправлять прототип поздно, и пилот приходится продлевать.',
  effect: 'Проблемы прототипа видны на второй неделе пилота, а не после его окончания',
  edit: (m) => { m.nodes.find((n) => n.id === 'analyse').label = 'Сверять отклики с KPI еженедельно'; },
  supporters: ['ershova@social1.mos.ru', 'danilov@social1.mos.ru', 'volkov@social1.mos.ru',
               'orlova@social1.mos.ru', 'grigoriev@social1.mos.ru'],
  discussion: [['ershova@social1.mos.ru',
    'Поддерживаю. Еженедельная сверка — это полчаса координатора, а на Gate 4 экономит недели переделок.']],
  stage: 'published',
  verdicts: { pilot_coordinator: { by: 'ershova@social1.mos.ru', verdict: 'agree',
    comment: 'Готовы вести сверку еженедельно: данные и так собираются непрерывно.' } },
  days: { created: 24, submitted: 23, decided: 18, published: 16 },
});

seedChange({
  defKey: 'e2e', author: 'fedorov@social1.mos.ru',
  title: 'Сократить срок решения руководителя до двух рабочих дней',
  rationale: 'Три рабочих дня на Gate 1 растягивают ожидание автора до недели с учётом выходных. Руководитель принимает решение по трём критериям и, как показывает журнал, укладывается в два дня.',
  effect: 'Автор получает первое решение на день раньше',
  edit: (m) => {
    const g = m.nodes.find((n) => n.stage && n.stage.stage_no === 2);
    g.stage.sla_value = 2;
    g.stage.sla_text = 'Руководитель учреждения принимает решение в течение 2 рабочих дней.';
    g.label = 'Gate 1 — 2 рабочих дня';
  },
  supporters: ['smirnova@social1.mos.ru', 'petrov@social1.mos.ru', 'nikitina@social1.mos.ru',
               'larina@social1.mos.ru', 'kuznecov@social1.mos.ru', 'ivanova@social1.mos.ru'],
  objectors: ['morozov@social1.mos.ru'],
  discussion: [
    ['morozov@social1.mos.ru',
     'В большом интернате три дня нужны: приходится советоваться с профильными специалистами. Двух хватит не везде.'],
    ['volkov@social1.mos.ru',
     'По журналу за полгода средний срок решения — 1,4 дня. Два дня оставляют запас даже для сложных случаев.'],
  ],
  // Руководители согласовали, центральный аппарат ещё смотрит — в листе идёт срок
  stage: 'approval',
  verdicts: { head: { by: 'volkov@social1.mos.ru', verdict: 'agree',
    comment: 'Срок реалистичный, статистика решений его подтверждает.' } },
  days: { created: 6, submitted: 5, decided: 3, published: 3 },
});

seedChange({
  defKey: 'adv-propose', author: 'nikitina@social1.mos.ru',
  title: 'Показывать социальному советнику судьбу его прежних предложений',
  rationale: 'Социальный советник видит начисленные очки, но не видит, что из предложенного дошло до внедрения. Обратная связь обрывается на публикации, и мотивация держится только на цифре рейтинга.',
  effect: 'Социальный советник видит, какие его решения работают в учреждениях',
  edit: (m) => { m.nodes.find((n) => n.id === 'end').label = 'Видно, что из предложенного внедрено'; },
  supporters: ['orlova@social1.mos.ru', 'larina@social1.mos.ru', 'petrov@social1.mos.ru',
               'kuznecov@social1.mos.ru'],
  discussion: [['lebedeva@social1.mos.ru',
    'Полезно и для модерации: видно, чьи советы доходят до дела, а не только собирают отметки.']],
  stage: 'discussion',
  days: { created: 3, submitted: 3, decided: 3, published: 3 },
});

seedChange({
  defKey: 'head-gate1', author: 'larina@social1.mos.ru',
  title: 'Не требовать аргументацию при решении «Остановить»',
  rationale: 'Заполнение обоснования при отказе занимает время руководителя, а автор всё равно чаще всего не возвращается к инициативе. Предлагаю сделать поле необязательным.',
  edit: (m) => { m.nodes.find((n) => n.id === 'gw').label = 'Решение руководителя'; },
  supporters: ['zaharov@social1.mos.ru'],
  objectors: ['smirnova@social1.mos.ru', 'petrov@social1.mos.ru', 'grigoriev@social1.mos.ru'],
  discussion: [['smirnova@social1.mos.ru',
    'Обоснование — единственное, что автор получает при отказе. Без него отказ выглядит произвольным.']],
  stage: 'approval',
  verdicts: { head: { by: 'sokolova@social1.mos.ru', verdict: 'reject',
    comment: 'Аргументация на Gate — не формальность, а архив знаний: по ней следующие авторы понимают, почему похожее решение не прошло. Снимать нельзя.' } },
  days: { created: 12, submitted: 11, decided: 9, published: 9 },
});

console.log('Предложений об изменении процессов: '
  + q.get('SELECT COUNT(*) AS c FROM process_changes').c
  + ', замечаний на схемах: '
  + q.get("SELECT COUNT(*) AS c FROM discussions WHERE anchor_kind='node'").c);

// ── Задачи и уведомления по текущим ожидающим Gate ───────────
for (const it of created.filter((c) => c.status === 'active')) {
  const cfg = stageConfig(it.stage);
  if (!cfg?.gate_no) continue;
  const row = q.get('SELECT * FROM initiatives WHERE id=?', it.id);
  q.run(`INSERT INTO tasks (role_target, institution_id, initiative_id, type, title, due_at, created_at)
         VALUES (?,?,?,'gate',?,?,?)`,
    cfg.role_required, cfg.gate_no === 1 ? it.author.institution_id : null, it.id,
    `${cfg.gate_name}: ${it.spec.title}`, row.sla_due_at, row.stage_entered_at);
}
for (const it of created.slice(0, 6)) {
  q.run(`INSERT INTO notifications (user_id, initiative_id, type, title, body, is_read, created_at)
         VALUES (?,?,?,?,?,?,?)`,
    it.author.id, it.id, 'status', `Инициатива ${it.number}: изменение статуса`,
    `Текущий этап — «${stageConfig(it.stage)?.stage_name}».`, it.stage > 3 ? 1 : 0, ts(Math.max(1, it.spec.created - 30)));
}

// Награды активным экспертам и участникам
grantAward(U['lebedeva@social1.mos.ru'].id, null, 'expert', 'Эксперт года по числу рассмотренных инициатив', U['director@social1.mos.ru'].id);
grantAward(U['petrov@social1.mos.ru'].id, created[1]?.id, 'author', 'Инициатива дошла до пилотирования', U['director@social1.mos.ru'].id);

// События переходов восстанавливаются в конце: к этому моменту история этапов
// уже воспроизведена, и метрика времени на этапе получает данные сразу
// ── База знаний ──────────────────────────────────────────────
// Документы заводятся тем же кодом, что работает в интерфейсе: с рецензированием,
// замечаниями к разделам и публикацией. Раздел показывается во всех состояниях —
// от черновика до заменённого решения, — иначе по нему не понять, как он живёт.
{
  const архитектор = U['tihonov@social1.mos.ru'];
  grantRole(архитектор.id, 'architect', { grantedBy: U['director@social1.mos.ru'].id });
  // Права считаются по всем ролям участника, а объект в сиде собран до выдачи
  архитектор.extra_roles = 'architect';

  const заведи = ({ kind, title, author, subjectType = null, subjectId = null, sections,
                    stage, verdicts = {}, notes = [], days }) => {
    const doc = kn.createDoc({ kind, title, subjectType, subjectId, user: U[author] });
    kn.saveDraft({ docId: doc.id, sections, user: U[author] });
    backdate('knowledge_docs', doc.id, { created_at: ts(days.created) });
    if (stage === 'draft') return doc;

    kn.submitForReview({ docId: doc.id, user: U[author] });
    for (const [section, [email, body]] of Object.entries(notes.length ? Object.fromEntries(notes) : {})) {
      const c = discussions.add({ targetType: 'knowledge_doc', targetId: doc.id,
        anchorKind: 'section', anchorId: section, body, user: U[email] });
      backdate('discussions', c.id, { created_at: ts(days.created - 1) });
    }
    if (stage === 'review') return doc;

    for (const row of kn.reviewSheet(doc.id)) {
      const кто = row.user_id
        ? Object.values(U).find((u) => u.id === row.user_id)
        : U[verdicts[row.role_code]];
      if (!кто) continue;
      kn.decideReview({ docId: doc.id, user: кто, verdict: stage === 'rejected' ? 'reject' : 'agree',
        comment: stage === 'rejected'
          ? 'Решение переносит нагрузку на учреждения без дополнительных ресурсов — в таком виде принять нельзя.'
          : null });
      if (stage === 'rejected') break;
    }
    if (stage === 'rejected') { backdate('knowledge_docs', doc.id, { decided_at: ts(days.decided) }); return doc; }
    if (stage === 'accepted') return doc;

    kn.publishDoc({ docId: doc.id, user: U['director@social1.mos.ru'] });
    backdate('knowledge_docs', doc.id, { published_at: ts(days.published), decided_at: ts(days.decided) });
    return doc;
  };

  заведи({
    kind: 'adr', title: 'Возврат заявления сопровождается перечнем недостающих сведений',
    author: 'lebedeva@social1.mos.ru', stage: 'published',
    sections: {
      context: 'Специалист возвращал заявление с отметкой «неполный пакет». Заявитель не понимал, чего именно не хватает, и приходил повторно — в среднем 1,7 раза на одно обращение.',
      decision: 'Возврат оформляется только вместе с перечнем недостающих документов. Перечень формируется из карточки услуги, вручную ничего не набирается.',
      consequences: 'Повторные обращения по одному поводу сократились. Приём удлинился примерно на две минуты: специалист сверяет перечень при заявителе.',
      alternatives: 'Рассматривали памятку на стенде — отклонено: перечень зависит от жизненной ситуации заявителя, общая памятка её не покрывает.',
    },
    verdicts: { architect: 'tihonov@social1.mos.ru', dtszn: 'director@social1.mos.ru' },
    days: { created: 62, decided: 55, published: 54 },
  });

  заведи({
    kind: 'adr', title: 'Очередь на путёвки формируется по нуждаемости, а не по дате обращения',
    author: 'grigoriev@social1.mos.ru', stage: 'published',
    sections: {
      context: 'Путёвки распределялись по дате обращения. Семьи, узнавшие об услуге позже, оказывались в конце очереди независимо от положения.',
      decision: 'Очередь строится по оценке нуждаемости; дата обращения используется только при равных оценках.',
      consequences: 'Доступность выросла для семей в трудной ситуации. Ожидание для части заявителей увеличилось — им заранее сообщается расчётный срок.',
      alternatives: 'Рассматривали квоты по категориям — отклонено: жёсткие квоты не учитывают изменение положения семьи в течение года.',
    },
    verdicts: { architect: 'tihonov@social1.mos.ru', dtszn: 'director@social1.mos.ru' },
    days: { created: 40, decided: 33, published: 32 },
  });

  заведи({
    kind: 'rfc', title: 'Единая анкета семьи вместо четырёх отдельных заявлений',
    author: 'smirnova@social1.mos.ru', stage: 'review',
    sections: {
      problem: 'Родители заполняют одни и те же сведения в четырёх заявлениях: на путёвку, на питание, на кружки и на компенсацию проезда. На это уходит около 40 минут и часть данных расходится между заявлениями.',
      solution: 'Единая анкета семьи заполняется один раз. Из неё формируются заявления по каждой услуге; специалист правит только то, что относится к конкретной услуге.',
      alternatives: 'Рассматривали автозаполнение из учётной системы — отклонено: часть сведений там устаревает, и родители всё равно правят их вручную. Рассматривали объединение только двух самых частых заявлений — отклонено: экономия времени меньше трудозатрат на переделку.',
      risks: 'Единая анкета собирает больше сведений за один раз — нужна проверка на избыточность персональных данных. Семьям без доступа к порталу сохраняется бумажный приём.',
      effect: 'Время подачи сокращается с 40 до 12 минут; расхождения между заявлениями исчезают.',
    },
    notes: [['risks', ['tihonov@social1.mos.ru',
      'Проверку на избыточность нужно описать конкретнее: кто её проводит и на каком шаге. Иначе раздел не проходит согласование с юристами.']]],
    days: { created: 9, decided: 9, published: 9 },
  });

  заведи({
    kind: 'rfc', title: 'Передать приём заявлений на бытовую технику в учреждения',
    author: 'fedorov@social1.mos.ru', stage: 'rejected',
    sections: {
      problem: 'Заявления на бытовую технику принимает центральный аппарат, срок рассмотрения — до 30 дней.',
      solution: 'Передать приём и первичную проверку в учреждения.',
      alternatives: 'Рассматривали сокращение срока без передачи полномочий — отклонено: узкое место в пересылке документов.',
      risks: 'Учреждения получат дополнительную нагрузку.',
    },
    verdicts: { architect: 'tihonov@social1.mos.ru' },
    days: { created: 21, decided: 16, published: 16 },
  });

  заведи({
    kind: 'guide', title: 'Как учреждению подготовиться к роли пилотной площадки',
    author: 'ershova@social1.mos.ru', stage: 'draft',
    sections: {
      audience: 'Директорам и заместителям учреждений, которые подали заявку на пилот.',
      steps: 'Назначить ответственного, выделить двух сотрудников на обучение, согласовать окно в расписании, подготовить рабочие места.',
    },
    days: { created: 4, decided: 4, published: 4 },
  });

  console.log('Документов в базе знаний: '
    + q.get('SELECT COUNT(*) AS c FROM knowledge_docs').c
    + ', опубликовано: '
    + q.get("SELECT COUNT(*) AS c FROM knowledge_docs WHERE status='published'").c);
}

// Образец формы-опросника: функциональные требования ДЗМ, собранные в конструкторе
const sampleForm = ensureSampleForms();
if (sampleForm) {
  console.log(`Образец формы: «${sampleForm.title}» — ${sampleForm.responses} ответов, `
    + `ссылка /f/${sampleForm.slug}`);
}

// Каталог разработчиков: по три вымышленных разработчика каждого вида, помечены как демо
console.log(`Демонстрационных разработчиков ИИ-решений: ${seedSampleProviders()}`);
console.log(`Восстановлено событий переходов: ${ensureStageEvents()}`);
console.log(`Проиндексировано для поиска: ${reindexAll()}`);

logAction(U['coordinator@social1.mos.ru'].id, 'system.seed', 'system', null,
  { initiatives: created.length, users: Object.keys(U).length }, 'system');

console.log(`
  Демонстрационные данные загружены
  ─────────────────────────────────
  Учреждений:    ${q.get('SELECT COUNT(*) AS c FROM institutions').c}
  Участников:    ${q.get('SELECT COUNT(*) AS c FROM users').c}
  Инициатив:     ${q.get('SELECT COUNT(*) AS c FROM initiatives').c}
  Решений Gate:  ${q.get('SELECT COUNT(*) AS c FROM gate_decisions').c}
  Проектов:      ${q.get('SELECT COUNT(*) AS c FROM projects').c}
  Пилотов:       ${q.get('SELECT COUNT(*) AS c FROM pilots').c}
  Тем форума:    ${q.get('SELECT COUNT(*) AS c FROM forum_topics').c}
  Голосов:       ${q.get('SELECT COUNT(*) AS c FROM votes').c}
  Идей:          ${q.get('SELECT COUNT(*) AS c FROM ideas').c}
  Решений к ним: ${q.get('SELECT COUNT(*) AS c FROM proposals').c}
  Оценок в ревью:${q.get('SELECT COUNT(*) AS c FROM proposal_reviews').c}
  Очков:         ${q.get("SELECT COALESCE(SUM(points),0) AS s FROM points_ledger WHERE status='approved'").s}
  Поощрений:     ${q.get('SELECT COUNT(*) AS c FROM incentives').c}
  Изменений процессов: ${q.get('SELECT COUNT(*) AS c FROM process_changes').c}
  База знаний:   ${q.get('SELECT COUNT(*) AS c FROM knowledge_docs').c} документов, ${q.get("SELECT COUNT(*) AS c FROM knowledge_docs WHERE status='published'").c} опубликовано
  Формы:         ${q.get('SELECT COUNT(*) AS c FROM forms').c}, ответов собрано: ${q.get('SELECT COUNT(*) AS c FROM form_responses').c}

  Вход: любой e-mail из списка, пароль social1
  Например: director@social1.mos.ru (ДТСЗН), volkov@social1.mos.ru (руководитель),
            smirnova@social1.mos.ru (сотрудник), lebedeva@social1.mos.ru (эксперт)
`);
