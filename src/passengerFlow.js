const { Keyboard } = require('@maxhub/max-bot-api');
const db = require('./store');
const config = require('./config');
const session = require('./session');
const kb = require('./keyboards');
const fmt = require('./format');
const { availableTrips, carInfo } = require('./schedule');
const { getUserId, getChatId, getText, getUserName, getContactFromMessage } = require('./ctxHelpers');
const { notifyAdmins, freeTripsForBroadcast, buildGroupBroadcastText } = require('./adminFlow');
const { refreshGroupBroadcastIfChanged } = require('./groupUtil');

function notifyWife(bot, booking) {
  if (config.adminIds.length === 0) return;
  const occupied = db.occupiedSeats(booking.scheduleId, booking.date);
  const info = carInfo(booking.scheduleId, booking.date) || { capacity: config.maxSeats, isExtra: false };
  const text =
    `🔔 Новая заявка\n\n` +
    `🚌 ${fmt.directionLabel(booking.direction)}${info.isExtra ? ' (доп. машина)' : ''}\n` +
    `📅 ${fmt.formatDateRu(booking.date)}\n` +
    `🕡 ${booking.time}\n` +
    `🏘 ${booking.village}\n` +
    (booking.address ? `📍 ${booking.address}\n` : '') +
    `\n👤 ${booking.name}\n` +
    `📞 ${booking.phone}\n` +
    `👥 ${booking.seats} пассажир(а/ов)\n` +
    (booking.note ? `📝 ${booking.note}\n` : '') +
    `\nЗанято: ${occupied}/${info.capacity}`;
  notifyAdmins(bot, text, {
    attachments: [
      kb.adminTripDetailKeyboard(
        db.getActiveBookingsForTrip(booking.scheduleId, booking.date),
        booking.scheduleId,
        booking.date.replace(/-/g, ''),
        info.isExtra
      ),
    ],
  });
}

function registerPassengerFlow(bot) {
  bot.action('b:start', async (ctx) => {
    session.clear(getUserId(ctx));
    await ctx.reply('Выберите направление:', { attachments: [kb.directionKeyboard('b')] });
  });

  // Повторная запись из карточки уже оформленной заявки — подставляем имя и телефон
  // из той заявки, чтобы не вводить их заново (например, обратный рейс в тот же день).
  bot.action(/^b:again:(b\d+)$/, async (ctx) => {
    const bookingId = ctx.match[1];
    const userId = getUserId(ctx);
    const prev = db.getBooking(bookingId);
    const prefill = prev ? { name: prev.name, phone: prev.phone } : null;
    session.set(userId, prefill ? { prefill } : {});
    await ctx.reply('Выберите направление:', { attachments: [kb.directionKeyboard('b')] });
  });

  // Кнопка «Назад» с шага выбора даты — возвращает к выбору направления,
  // сохраняя подставленные имя/телефон, если запись оформлялась через «Записаться ещё раз»
  bot.action('b:backdir', async (ctx) => {
    const userId = getUserId(ctx);
    const prevSt = session.get(userId);
    const prefill = prevSt && prevSt.prefill;
    session.set(userId, prefill ? { prefill } : {});
    await ctx.reply('Выберите направление:', { attachments: [kb.directionKeyboard('b')] });
  });

  bot.action(/^b:dir:(YA_UFA|UFA_YA)$/, async (ctx) => {
    const direction = ctx.match[1];
    const userId = getUserId(ctx);
    const prevSt = session.get(userId);
    const prefill = prevSt && prevSt.prefill;
    session.set(userId, { step: 'date', direction, ...(prefill ? { prefill } : {}) });
    await ctx.reply('На какую дату?', { attachments: [kb.dateKeyboard('b', 'b:backdir')] });
  });

  // Кнопка «Назад» с шага выбора времени — возвращает к выбору даты для того же направления
  bot.action('b:backdate', async (ctx) => {
    const userId = getUserId(ctx);
    const st = session.get(userId);
    if (!st || !st.direction) {
      await ctx.reply('Начните запись заново: нажмите «Записаться на поездку».');
      return;
    }
    session.set(userId, { step: 'date', direction: st.direction, ...(st.prefill ? { prefill: st.prefill } : {}) });
    await ctx.reply('На какую дату?', { attachments: [kb.dateKeyboard('b', 'b:backdir')] });
  });

  bot.action(/^b:date:(\d{8}|other)$/, async (ctx) => {
    const choice = ctx.match[1];
    const userId = getUserId(ctx);
    const st = session.get(userId);
    if (!st || st.step !== 'date') {
      await ctx.reply('Начните запись заново: нажмите «Записаться на поездку».');
      return;
    }
    if (choice === 'other') {
      st.step = 'awaiting_date_text';
      session.set(userId, st);
      await ctx.reply('Введите дату в формате ДД.ММ.ГГГГ (например, 15.08.2026):');
      return;
    }
    const date = `${choice.slice(0, 4)}-${choice.slice(4, 6)}-${choice.slice(6, 8)}`;
    await showTimeOptions(ctx, userId, st.direction, date, st.prefill);
  });

  async function showTimeOptions(ctx, userId, direction, date, prefill) {
    const trips = availableTrips(direction, date);
    if (trips.length === 0) {
      // Не тупик: сразу предлагаем выбрать другую дату для того же направления —
      // например, у водителя в этот день выходной (среда).
      session.set(userId, { step: 'date', direction, ...(prefill ? { prefill } : {}) });
      await ctx.reply(
        'На эту дату рейсов не найдено (например, в этот день у водителя выходной). Выберите другую дату:',
        { attachments: [kb.dateKeyboard('b', 'b:backdir')] }
      );
      return;
    }
    session.set(userId, { step: 'time', direction, date, ...(prefill ? { prefill } : {}) });
    const compact = date.replace(/-/g, '');
    await ctx.reply(
      `🚌 ${fmt.bold(fmt.directionLabel(direction))}\n📅 ${fmt.bold(fmt.formatDateRu(date))}\n\n${fmt.bold('Выберите рейс:')}`,
      { attachments: [kb.timeKeyboard('b', trips, compact, 'b:backdate')], format: 'markdown' }
    );
  }

  // Кнопка «Назад» с шага выбора деревни — возвращает к выбору времени для той же даты
  bot.action('b:backtime', async (ctx) => {
    const userId = getUserId(ctx);
    const st = session.get(userId);
    if (!st || !st.direction || !st.date) {
      await ctx.reply('Начните запись заново: нажмите «Записаться на поездку».');
      return;
    }
    await showTimeOptions(ctx, userId, st.direction, st.date, st.prefill);
  });

  bot.action(/^b:full:(s\d+|x\d+):(\d{8})$/, async (ctx) => {
    const scheduleId = ctx.match[1];
    const dateCompact = ctx.match[2];
    const date = `${dateCompact.slice(0, 4)}-${dateCompact.slice(4, 6)}-${dateCompact.slice(6, 8)}`;
    await ctx.reply('❌ На этот рейс свободных мест больше нет.', {
      attachments: [kb.waitlistOfferKeyboard('b', scheduleId, dateCompact, 'b:backtime')],
    });
  });

  bot.action(/^b:waitlist:(s\d+|x\d+):(\d{8})$/, async (ctx) => {
    const scheduleId = ctx.match[1];
    const dateCompact = ctx.match[2];
    const date = `${dateCompact.slice(0, 4)}-${dateCompact.slice(4, 6)}-${dateCompact.slice(6, 8)}`;
    const userId = getUserId(ctx);
    const item = carInfo(scheduleId, date);
    if (!item) {
      await ctx.reply('Этот рейс больше недоступен.', { attachments: [kb.mainMenuKeyboard()] });
      return;
    }
    const existing = db.findWaitlistEntry(scheduleId, date, 'max', userId);
    if (existing) {
      await ctx.reply('Вы уже в списке ожидания на этот рейс — напишу, как только появится место.', {
        attachments: [kb.mainMenuKeyboard()],
      });
      return;
    }
    const st = session.get(userId);
    const prefill = st && st.prefill;
    db.addWaitlistEntry({
      scheduleId,
      date,
      direction: item.direction,
      time: item.time,
      platform: 'max',
      userId,
      name: prefill ? prefill.name : null,
      phone: prefill ? prefill.phone : null,
    });
    await ctx.reply(
      `🔔 ${fmt.bold('Записал вас в лист ожидания:')}\n🚌 ${fmt.bold(fmt.directionLabel(item.direction))}\n📅 ${fmt.bold(fmt.formatDateRu(date))}\n🕡 ${fmt.bold(item.time)}\n\nКак только кто-то отменит поездку — сразу напишу вам.`,
      { attachments: [kb.mainMenuKeyboard()], format: 'markdown' }
    );
  });

  bot.action(/^b:time:(s\d+|x\d+):(\d{8})$/, async (ctx) => {
    const scheduleId = ctx.match[1];
    const dateCompact = ctx.match[2];
    const date = `${dateCompact.slice(0, 4)}-${dateCompact.slice(4, 6)}-${dateCompact.slice(6, 8)}`;
    const userId = getUserId(ctx);
    const prevSt = session.get(userId);
    const prefill = prevSt && prevSt.prefill;
    const direction = prevSt && prevSt.direction;
    const item = carInfo(scheduleId, date);
    if (!item) {
      await ctx.reply('Этот рейс больше недоступен. Выберите другой:');
      await showTimeOptions(ctx, userId, direction, date, prefill);
      return;
    }
    const free = item.capacity - db.occupiedSeats(scheduleId, date);
    if (free <= 0) {
      await ctx.reply('❌ На этот рейс свободных мест больше нет.', {
        attachments: [kb.waitlistOfferKeyboard('b', scheduleId, dateCompact, 'b:backtime')],
      });
      return;
    }
    session.set(userId, {
      step: 'awaiting_village',
      direction: item.direction,
      date,
      scheduleId,
      time: item.time,
      free,
      ...(prefill ? { prefill } : {}),
    });
    const villagePrompt =
      (item.direction === 'YA_UFA' ? 'Из какого вы населённого пункта?' : 'В какой населённый пункт вы едете?') +
      '\n\nЕсли вашего населённого пункта нет в списке — нажмите «Другое» и напишите его сами.';
    await ctx.reply(villagePrompt, { attachments: [kb.villageKeyboard('b', 'b:backtime')] });
  });

  bot.action('b:villageother', async (ctx) => {
    const userId = getUserId(ctx);
    const st = session.get(userId);
    if (!st || st.step !== 'awaiting_village') {
      await ctx.reply('Начните запись заново: нажмите «Записаться на поездку».');
      return;
    }
    st.step = 'awaiting_custom_village';
    session.set(userId, st);
    await ctx.reply('Напишите название вашего населённого пункта:');
  });

  bot.action(/^b:village:(\d+)$/, async (ctx) => {
    const idx = Number(ctx.match[1]);
    const userId = getUserId(ctx);
    const st = session.get(userId);
    if (!st || st.step !== 'awaiting_village') {
      await ctx.reply('Начните запись заново: нажмите «Записаться на поездку».');
      return;
    }
    const village = fmt.VILLAGES[idx];
    if (!village) {
      await ctx.reply('Не удалось распознать населённый пункт, попробуйте ещё раз.');
      return;
    }
    st.village = village;
    if (st.direction === 'YA_UFA') {
      // Едем В Уфу — машина забирает от конкретного адреса в деревне.
      st.step = 'awaiting_address';
      session.set(userId, st);
      await ctx.reply('Напишите ваш адрес в населённом пункте (откуда забрать):');
    } else {
      // Едем ИЗ Уфы — посадка с конечной точки (остановка Галле), адрес не нужен.
      await askNameOrUsePrefill(ctx, userId, st);
    }
  });

  // Если у пассажира уже есть предыдущая заявка (прешел по кнопке «Записаться ещё раз»),
  // предлагаем использовать те же имя и телефон вместо повторного ввода.
  async function askNameOrUsePrefill(ctx, userId, st) {
    if (st.prefill && st.prefill.name && st.prefill.phone) {
      st.step = 'confirm_prefill';
      session.set(userId, st);
      await ctx.reply(
        `Использовать данные как в прошлый раз?\n👤 ${st.prefill.name}\n📞 ${st.prefill.phone}`,
        { attachments: [kb.prefillConfirmKeyboard('b')] }
      );
    } else {
      st.step = 'awaiting_name';
      session.set(userId, st);
      await ctx.reply('Введите имя пассажира:\n\nИли нажмите кнопку ниже, чтобы отправить имя и номер из телефонной книги одним нажатием.', {
        attachments: [kb.contactShareKeyboard('b', 'b:backname')],
      });
    }
  }

  // Кнопка «Назад» с шага ввода имени — возвращает к вводу адреса (если едем
  // в Уфу) или к выбору деревни (если едем из Уфы, адрес не запрашивался)
  bot.action('b:backname', async (ctx) => {
    const userId = getUserId(ctx);
    const st = session.get(userId);
    if (!st || !st.direction) {
      await ctx.reply('Начните запись заново: нажмите «Записаться на поездку».');
      return;
    }
    if (st.direction === 'YA_UFA') {
      st.step = 'awaiting_address';
      session.set(userId, st);
      await ctx.reply('Напишите ваш адрес в населённом пункте (откуда забрать):');
    } else {
      st.step = 'awaiting_village';
      session.set(userId, st);
      await ctx.reply('В какой населённый пункт вы едете?', { attachments: [kb.villageKeyboard('b', 'b:backtime')] });
    }
  });

  // Кнопка «Назад» с шага ввода телефона — возвращает к вводу имени
  bot.action('b:backphone', async (ctx) => {
    const userId = getUserId(ctx);
    const st = session.get(userId);
    if (!st) {
      await ctx.reply('Начните запись заново: нажмите «Записаться на поездку».');
      return;
    }
    st.step = 'awaiting_name';
    session.set(userId, st);
    await ctx.reply('Введите имя пассажира:', { attachments: [kb.contactShareKeyboard('b', 'b:backname')] });
  });

  // Кнопка «Назад» с шага «сколько человек» — возвращает к вводу телефона
  bot.action('b:backcount', async (ctx) => {
    const userId = getUserId(ctx);
    const st = session.get(userId);
    if (!st) {
      await ctx.reply('Начните запись заново: нажмите «Записаться на поездку».');
      return;
    }
    st.step = 'awaiting_phone';
    session.set(userId, st);
    await ctx.reply('Введите номер телефона:', { attachments: [kb.contactShareKeyboard('b', 'b:backphone')] });
  });

  // «Больше» на экране «сколько человек» — показывает 5 и 6 (если хватает
  // свободных мест), «Назад» с этого экрана возвращает к 1-4.
  bot.action('b:count:more', async (ctx) => {
    const userId = getUserId(ctx);
    const st = session.get(userId);
    if (!st || st.step !== 'awaiting_count') {
      await ctx.reply('Начните запись заново: нажмите «Записаться на поездку».');
      return;
    }
    await ctx.reply(`СКОЛЬКО ЧЕЛОВЕК ПОЕДЕТ? (свободно мест: ${st.free})`, {
      attachments: [kb.countMoreKeyboard(st.free)],
    });
  });

  bot.action('b:count:back', async (ctx) => {
    const userId = getUserId(ctx);
    const st = session.get(userId);
    if (!st || st.step !== 'awaiting_count') {
      await ctx.reply('Начните запись заново: нажмите «Записаться на поездку».');
      return;
    }
    await ctx.reply(`СКОЛЬКО ЧЕЛОВЕК ПОЕДЕТ? (свободно мест: ${st.free})`, {
      attachments: [kb.countKeyboard(st.free)],
    });
  });

  bot.action(/^b:count:([1-6])$/, async (ctx) => {
    const userId = getUserId(ctx);
    const st = session.get(userId);
    if (!st || st.step !== 'awaiting_count') {
      await ctx.reply('Начните запись заново: нажмите «Записаться на поездку».');
      return;
    }
    const count = Number(ctx.match[1]);
    if (count > st.free) {
      await ctx.reply(`Свободно только ${st.free} мест(а). Выберите число не больше этого:`, {
        attachments: [kb.countKeyboard(st.free)],
      });
      return;
    }
    st.count = count;
    st.step = 'awaiting_note';
    session.set(userId, st);
    await ctx.reply(
      'Примечание для водителя (необязательно). Например: «я на ост. 8 марта».\n\nНапишите текст или нажмите «Пропустить».',
      { attachments: [kb.noteSkipKeyboard('b')] }
    );
  });

  // Финальный шаг: создаём заявку (с примечанием для водителя или без него)
  // и показываем подтверждение. Общая функция — вызывается и после ввода
  // текста примечания, и после нажатия «Пропустить».
  async function finalizeBooking(ctx, userId, st) {
    const booking = db.addBooking({
      direction: st.direction,
      date: st.date,
      time: st.time,
      scheduleId: st.scheduleId,
      village: st.village,
      address: st.address || null,
      name: st.name,
      phone: st.phone,
      seats: st.count,
      note: st.note || null,
      userId,
    });
    session.clear(userId);
    await ctx.reply(
      `✅ ${fmt.bold('Вы записаны!')}\n\n🚌 ${fmt.bold(fmt.directionLabel(st.direction))}\n📅 ${fmt.bold(fmt.formatDateRu(st.date))}\n🕡 ${fmt.bold(st.time)}\n🏘 ${fmt.escapeMd(st.village)}` +
        (st.address ? `\n📍 ${fmt.escapeMd(st.address)}` : '') +
        `\n👤 ${fmt.escapeMd(st.name)}\n📞 ${st.phone}\n👥 ${st.count} пассажир(а/ов)` +
        (st.note ? `\n📝 ${fmt.escapeMd(st.note)}` : '') +
        `\n\nМы свяжемся с вами при необходимости.`,
      { attachments: [kb.myBookingCancelKeyboard(booking.id)], format: 'markdown' }
    );
    notifyWife(bot, booking);
    refreshGroupBroadcastIfChanged(
      bot,
      booking.date,
      freeTripsForBroadcast(booking.date),
      buildGroupBroadcastText
    ).catch((e) => console.error('Не удалось обновить объявление в группе:', e));
  }

  // Кнопка «Пропустить» на шаге примечания для водителя
  bot.action('b:skipnote', async (ctx) => {
    const userId = getUserId(ctx);
    const st = session.get(userId);
    if (!st || st.step !== 'awaiting_note') {
      await ctx.reply('Начните запись заново: нажмите «Записаться на поездку».');
      return;
    }
    await finalizeBooking(ctx, userId, st);
  });

  bot.action('b:useprefill', async (ctx) => {
    const userId = getUserId(ctx);
    const st = session.get(userId);
    if (!st || st.step !== 'confirm_prefill' || !st.prefill) {
      await ctx.reply('Начните запись заново: нажмите «Записаться на поездку».');
      return;
    }
    st.name = st.prefill.name;
    st.phone = st.prefill.phone;
    st.step = 'awaiting_count';
    session.set(userId, st);
    await ctx.reply(`СКОЛЬКО ЧЕЛОВЕК ПОЕДЕТ? (свободно мест: ${st.free})`, {
      attachments: [kb.countKeyboard(st.free)],
    });
  });

  bot.action('b:freshname', async (ctx) => {
    const userId = getUserId(ctx);
    const st = session.get(userId);
    if (!st || st.step !== 'confirm_prefill') {
      await ctx.reply('Начните запись заново: нажмите «Записаться на поездку».');
      return;
    }
    st.step = 'awaiting_name';
    session.set(userId, st);
    await ctx.reply('Введите имя пассажира:', { attachments: [kb.contactShareKeyboard('b', 'b:backname')] });
  });

  // Обработка текстовых сообщений — многошаговый ввод даты/адреса/имени/телефона/кол-ва мест
  bot.on('message_created', async (ctx, next) => {
    const userId = getUserId(ctx);
    const st = session.get(userId);

    // Кнопка «Отправить свой номер» присылает вложение-контакт без текста
    // сообщения, поэтому эту проверку делаем раньше проверки на пустой текст.
    if (st && (st.step === 'awaiting_name' || st.step === 'awaiting_phone')) {
      const contact = getContactFromMessage(ctx);
      if (contact) {
        if (contact.phone) st.phone = contact.phone;
        if (contact.name) st.name = contact.name;
        if (st.name && st.phone) {
          st.step = 'awaiting_count';
          session.set(userId, st);
          await ctx.reply(
            `✅ Данные получены из контакта:\n👤 ${st.name}\n📞 ${st.phone}\n\nСКОЛЬКО ЧЕЛОВЕК ПОЕДЕТ? (свободно мест: ${st.free})`,
            { attachments: [kb.countKeyboard(st.free)] }
          );
        } else if (st.phone) {
          // В контакте не оказалось имени (например, отправлен только номер) —
          // просим ввести имя пассажира вручную.
          st.step = 'awaiting_name';
          session.set(userId, st);
          await ctx.reply(`✅ Номер получен: ${st.phone}\n\nВведите имя пассажира:`);
        } else if (st.name) {
          st.step = 'awaiting_phone';
          session.set(userId, st);
          await ctx.reply(`✅ Имя получено: ${st.name}\n\nВведите номер телефона:`, {
            attachments: [kb.contactShareKeyboard('b', 'b:backphone')],
          });
        }
        return;
      }
    }

    const text = getText(ctx).trim();

    if (!st || !text) {
      if (typeof next === 'function') return next();
      return;
    }

    if (st.step === 'awaiting_date_text') {
      const iso = fmt.parseRuDate(text);
      if (!iso) {
        await ctx.reply('Не удалось распознать дату. Введите в формате ДД.ММ.ГГГГ, например 15.08.2026:');
        return;
      }
      if (iso < fmt.todayISO()) {
        await ctx.reply('Эта дата уже прошла. Введите сегодняшнюю дату или дату в будущем, например 15.08.2026:');
        return;
      }
      await showTimeOptions(ctx, userId, st.direction, iso, st.prefill);
      return;
    }

    if (st.step === 'awaiting_custom_village') {
      const village = text.trim();
      if (!village) {
        await ctx.reply('Напишите название вашего населённого пункта:');
        return;
      }
      st.village = village;
      if (st.direction === 'YA_UFA') {
        st.step = 'awaiting_address';
        session.set(userId, st);
        await ctx.reply('Напишите ваш адрес в населённом пункте (откуда забрать):');
      } else {
        await askNameOrUsePrefill(ctx, userId, st);
      }
      return;
    }

    if (st.step === 'awaiting_address') {
      st.address = text;
      await askNameOrUsePrefill(ctx, userId, st);
      return;
    }

    if (st.step === 'awaiting_name') {
      st.name = text;
      st.step = 'awaiting_phone';
      session.set(userId, st);
      await ctx.reply('Введите номер телефона:', { attachments: [kb.contactShareKeyboard('b', 'b:backphone')] });
      return;
    }

    if (st.step === 'awaiting_phone') {
      if (!fmt.isLikelyPhone(text)) {
        await ctx.reply('Похоже, номер телефона указан некорректно. Введите ещё раз, например +79991234567:');
        return;
      }
      st.phone = fmt.normalizePhone(text);
      st.step = 'awaiting_count';
      session.set(userId, st);
      await ctx.reply(`СКОЛЬКО ЧЕЛОВЕК ПОЕДЕТ? (свободно мест: ${st.free})`, {
        attachments: [kb.countKeyboard(st.free)],
      });
      return;
    }

    if (st.step === 'awaiting_count') {
      const count = parseInt(text, 10);
      if (!Number.isInteger(count) || count < 1) {
        await ctx.reply('Введите число пассажиров (например, 1):');
        return;
      }
      if (count > st.free) {
        await ctx.reply(`Свободно только ${st.free} мест(а). Введите число не больше этого:`);
        return;
      }
      st.count = count;
      st.step = 'awaiting_note';
      session.set(userId, st);
      await ctx.reply(
        'Примечание для водителя (необязательно). Например: «я на ост. 8 марта».\n\nНапишите текст или нажмите «Пропустить».',
        { attachments: [kb.noteSkipKeyboard('b')] }
      );
      return;
    }

    if (st.step === 'awaiting_note') {
      st.note = text;
      await finalizeBooking(ctx, userId, st);
      return;
    }

    if (typeof next === 'function') return next();
  });

  // Самостоятельная отмена заявки пассажиром (кнопка под сообщением о записи)
  // «Мои заказы»: и поездки, и посылки вместе — то, что человек сам оформлял
  // через ЭТОГО бота (source: 'bot', см. getBookingsByUserId в store.js — на
  // ВК то же самое, но там свои source: 'vk' и своя копия экрана в vk_bot/).
  bot.action('b:myorders', async (ctx) => {
    const userId = getUserId(ctx);
    const all = db.getBookingsByUserId(userId, 'bot');

    if (all.length === 0) {
      await ctx.reply('У вас пока нет заказов.', { attachments: [kb.mainMenuKeyboard()] });
      return;
    }

    const today = fmt.todayISO();
    const nowHM = fmt.nowHM();
    const isUpcoming = (b) => b.status !== 'cancelled' && (b.date > today || (b.date === today && b.time >= nowHM));
    const upcoming = all.filter(isUpcoming).sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
    const history = all.filter((b) => !isUpcoming(b)).slice(0, 5); // из БД уже по убыванию даты

    const line = (b) => {
      const icon = b.kind === 'parcel' ? '📦' : '🚌';
      const extra = b.kind === 'parcel' ? '' : `, ${b.seats} мест`;
      return `${icon} ${fmt.directionLabel(b.direction)} — ${fmt.formatDateRu(b.date)}, ${b.time}${extra}`;
    };

    let text = '📋 Ваши заказы';
    text += upcoming.length > 0
      ? `\n\n🟢 Предстоящие:\n${upcoming.map(line).join('\n')}`
      : '\n\n🟢 Предстоящих заказов нет.';
    if (history.length > 0) {
      const histLine = (b) => `${line(b)} — ${b.status === 'cancelled' ? '🔴 отменено' : '✅ состоялось'}`;
      text += `\n\n🕓 Последние из истории:\n${history.map(histLine).join('\n')}`;
    }

    await ctx.reply(text, { attachments: [kb.myOrdersKeyboard(upcoming)] });
  });

  bot.action(/^b:mycancel:(b\d+)$/, async (ctx) => {
    const bookingId = ctx.match[1];
    const userId = getUserId(ctx);
    const booking = db.getBooking(bookingId);
    if (!booking) {
      await ctx.reply('Эта заявка уже не найдена.');
      return;
    }
    if (booking.userId !== userId || booking.source !== 'bot') {
      await ctx.reply('Вы можете отменить только свою собственную заявку.');
      return;
    }
    if (booking.status === 'cancelled') {
      await ctx.reply('Эта заявка уже была отменена.');
      return;
    }
    db.updateBooking(bookingId, { status: 'cancelled' });
    const isParcel = booking.kind === 'parcel';
    await ctx.reply(
      isParcel ? '🔴 Отправка посылки отменена.' : '🔴 Ваша заявка отменена, место освобождено.',
      { attachments: [kb.afterCancelKeyboard()] }
    );
    if (config.adminIds.length > 0) {
      const label = isParcel ? '📦 Клиент сам отменил отправку посылки:' : '🔴 Пассажир сам отменил заявку:';
      notifyAdmins(
        bot,
        `${label}\n\n🚌 ${fmt.directionLabel(booking.direction)}\n📅 ${fmt.formatDateRu(booking.date)}\n🕡 ${booking.time}\n👤 ${booking.name} — ${booking.phone}`
      );
    }
    if (!isParcel) {
      refreshGroupBroadcastIfChanged(
        bot,
        booking.date,
        freeTripsForBroadcast(booking.date),
        buildGroupBroadcastText
      ).catch((e) => console.error('Не удалось обновить объявление в группе:', e));
    }
  });
  bot.action(/^b:rideyes:(b\d+)$/, async (ctx) => {
    const bookingId = ctx.match[1];
    const userId = getUserId(ctx);
    const booking = db.getBooking(bookingId);
    if (!booking) {
      await ctx.reply('Эта заявка уже не найдена.');
      return;
    }
    if (booking.userId !== userId || booking.source !== 'bot') {
      await ctx.reply('Это не ваша заявка.');
      return;
    }
    if (booking.status === 'cancelled') {
      await ctx.reply('Эта заявка уже была отменена.');
      return;
    }
    db.updateBooking(bookingId, { rideConfirmed: 'yes' });
    await ctx.reply('✅ Отлично, ждём вас!');
    notifyAdmins(
      bot,
      `✅ ${booking.name} подтвердил(а), что едет:\n\n🚌 ${fmt.directionLabel(booking.direction)}\n📅 ${fmt.formatDateRu(booking.date)}\n🕡 ${booking.time}`
    );
  });

  bot.action(/^b:rideno:(b\d+)$/, async (ctx) => {
    const bookingId = ctx.match[1];
    const userId = getUserId(ctx);
    const booking = db.getBooking(bookingId);
    if (!booking) {
      await ctx.reply('Эта заявка уже не найдена.');
      return;
    }
    if (booking.userId !== userId || booking.source !== 'bot') {
      await ctx.reply('Это не ваша заявка.');
      return;
    }
    if (booking.status === 'cancelled') {
      await ctx.reply('Эта заявка уже была отменена.');
      return;
    }
    db.updateBooking(bookingId, { rideConfirmed: 'no' });
    await ctx.reply(
      'Понятно, спасибо, что предупредили! Если хотите освободить место — нажмите «Отменить мою запись» в сообщении о записи.'
    );
    notifyAdmins(
      bot,
      `❗ ${booking.name} сообщил(а), что НЕ едет:\n\n🚌 ${fmt.directionLabel(booking.direction)}\n📅 ${fmt.formatDateRu(booking.date)}\n🕡 ${booking.time}\n\nМесто пока не освобождено — при необходимости отмените заявку вручную.`,
      { attachments: [kb.adminTripDetailKeyboard(
        db.getActiveBookingsForTrip(booking.scheduleId, booking.date),
        booking.scheduleId,
        booking.date.replace(/-/g, ''),
        (carInfo(booking.scheduleId, booking.date) || {}).isExtra
      )] }
    );
  });
}

module.exports = { registerPassengerFlow, notifyWife };
