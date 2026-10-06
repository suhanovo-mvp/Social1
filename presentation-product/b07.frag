<div class="sl">
  <div class="rule" style="background:#1a7f52"></div>
  <div style="padding:48px 64px 0">
    <div class="eyebrow" style="color:#1a7f52">Компонент 4 · Конструктор форм</div>
    <h2 style="margin-top:14px">Анкета собирается в интерфейсе, а не в коде</h2>
    <p class="lede" style="margin:14px 0 0;max-width:1030px;font-size:18px">
      Одиннадцать видов вопросов. Длинные перечни — учреждения, роли, направления —
      заводятся справочником один раз и дальше подставляются в анкеты вариантами ответа.
    </p>

    <div style="display:flex;flex-wrap:wrap;gap:7px;margin-top:24px">
      <span style="background:#f9fafc;border:1px solid #dfe4ed;padding:6px 13px;border-radius:7px;font-size:14px">Короткий текст</span>
      <span style="background:#f9fafc;border:1px solid #dfe4ed;padding:6px 13px;border-radius:7px;font-size:14px">Длинный текст</span>
      <span style="background:#f9fafc;border:1px solid #dfe4ed;padding:6px 13px;border-radius:7px;font-size:14px">Один вариант</span>
      <span style="background:#f9fafc;border:1px solid #dfe4ed;padding:6px 13px;border-radius:7px;font-size:14px">Несколько вариантов</span>
      <span style="background:#e3f5ec;border:1px solid #c7e8d8;padding:6px 13px;border-radius:7px;font-size:14px;color:#1a7f52;font-weight:700">Выпадающий список · справочник</span>
      <span style="background:#f9fafc;border:1px solid #dfe4ed;padding:6px 13px;border-radius:7px;font-size:14px">Шкала</span>
      <span style="background:#f9fafc;border:1px solid #dfe4ed;padding:6px 13px;border-radius:7px;font-size:14px">Число</span>
      <span style="background:#f9fafc;border:1px solid #dfe4ed;padding:6px 13px;border-radius:7px;font-size:14px">Дата</span>
      <span style="background:#f9fafc;border:1px solid #dfe4ed;padding:6px 13px;border-radius:7px;font-size:14px">Электронная почта</span>
      <span style="background:#f9fafc;border:1px solid #dfe4ed;padding:6px 13px;border-radius:7px;font-size:14px">Телефон</span>
      <span style="background:#f9fafc;border:1px solid #dfe4ed;padding:6px 13px;border-radius:7px;font-size:14px">Разделы блоков</span>
      <span style="background:#f9fafc;border:1px dashed #c4ccda;padding:6px 13px;border-radius:7px;font-size:14px;color:#7c8798">«Другое» со своим текстом</span>
    </div>

    <div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;margin-top:22px">
      <div class="card" style="border-top:3px solid #1a7f52">
        <h3 style="font-size:17px">Условие показа — у самого вопроса</h3>
        <p>«Уточните, где именно» видит только тот, кто поставил оценку 3 и выше. Правило работает
        одинаково в браузере и на сервере: скрытый вопрос не считается обязательным, а ответ на него
        не сохраняется — оценка, изменённая в последний момент, не оставляет следов.</p>
      </div>
      <div class="card" style="border-top:3px solid #1a7f52">
        <h3 style="font-size:17px">Публикация внутрь и наружу</h3>
        <p>Участникам платформы или ссылкой: страница по ссылке открывается без входа в систему,
        поэтому её можно разослать в учреждения, у сотрудников которых нет учётной записи.
        Настраиваются анонимность, один ответ, срок сбора и текст после отправки.</p>
      </div>
      <div class="card" style="border-top:3px solid #1a7f52">
        <h3 style="font-size:17px">Результаты сводятся сразу</h3>
        <p>Распределение по вариантам, среднее и медиана по шкалам, свободные ответы целиком,
        таблица анкет построчно, выгрузка в CSV. У условных вопросов рядом с числом ответов
        показан охват — иначе доля отвечающих врёт.</p>
      </div>
    </div>

    <div style="margin-top:20px;background:#eff5fd;border:1px solid #dde9f9;border-radius:10px;padding:15px 20px;display:flex;gap:24px;align-items:center">
      <div class="tag" style="color:#24508f;flex-shrink:0;width:172px">Образец в поставке</div>
      <div style="font-size:15.5px;line-height:1.5;color:#1b3a6b">
        Опросник ДЗМ «Оценка потенциала переиспользования ИИ-решений в учреждениях ДТСЗН»:
        пять блоков, 25 вопросов, оценка пяти решений по шкале и восемь условных уточнений об эффектах.
        <b>Собран целиком в конструкторе</b> — это и есть проверка того, что движок покрывает реальные требования.
      </div>
    </div>
  </div>
  <div class="foot"><span>Social1 · Управление реинжинирингом и коммуникациями</span><span class="num">7</span></div>
</div>
