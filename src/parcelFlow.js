const db = require('./store');
const config = require('./config');
const session = require('./session');
const kb = require('./keyboards');
const fmt = require('./format');
const { availableTrips, carInfo } = require('./schedule');
const { getUserId, getText, getContactFromMessage } = require('./ctxHelpers');
const { notifyAdmins } = require('./adminFlow');

// Посылка не занимает место в машине — даже полностью занятый пассажирами рейс
// всё равно должен её взять, поэтому весь этот поток нигде не проверяет свободные места.

function notifyWifeParcel(bot, booking) {
  if (config.adminIds.length === 0) return;
  const info = carInfo(booking.scheduleId, booking.date) || { capacity: config.maxSeats, isExtra: false };
  const text =
    `🔔 Новая посылка\n\n` +
    `🚌 ${fmt.directionLabel(booking.direction)}${info.isExtra ? ' (доп. машина)' : ''}\n` +
    `📅 ${fmt.formatDateRu(booking.date)}\n` +
    `🕡 ${booking.time}\n` +
    `🏘 ${booking.village}\n` +
    (booking.address ? `📍 ${booking.address}\n` : '') +
    `\n👤 ${booking.name}\n` +
    `📞 ${booking.phone}\n` +
    `📦 Посылка`;
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

function registerParcelFlow(bot) {
  bot.action('p:start', async (ctx) => {
    session.clear(getUserId(ctx));
    await ctx.reply('📦 Отправка посылки.\nВыберите направление:', { attachments: [kb.directionKeyboard('p')] });
  });

  // Повторная отправка из карточки уже оформленной посылки — подставляем имя и телефон
  bot.action(/^p:again:(b\d+)$/, async (ctx) => {
    const bookingId = ctx.match[1];
    const userId = getUserId(ctx);
    const prev = db.getBooking(bookingId);
    const prefill = prev ? { name: prev.name, phone: prev.phone } : null;
    session.set(userId, prefill ? { prefill } : {});
    await ctx.reply('📦 Отправка посылки.\nВыберите направление:', { attachments: [kb.directionKeyboard('p')] });
  });

  bot.action('p:backdir', async (ctx) => {
    const userId = getUserId(ctx);
    const prevSt = session.get(userId);
    const prefill = prevSt && prevSt.prefill;
    session.set(userId, prefill ? { prefill } : {});
    await ctx.reply('Выберите направление:', { attachments: [kb.directionKeyboard('p')] });
  });

  bot.action(/^p:dir:(YA_UFA|UFA_YA)$/, async (ctx) => {
    const direction = ctx.match[1];
    const userId = getUserId(ctx);
    const prevSt = session.get(userId);
    const prefill = prevSt && prevSt.prefill;
    session.set(userId, { step: 'p_date', direction, ...(prefill ? { prefill } : {}) });
    await ctx.reply('На какую дату?', { attachments: [kb.dateKeyboard('p', 'p:backdir')] });
  });

  bot.action('p:backdate', async (ctx) => {
    const userId = getUserId(ctx);
    const st = session.get(userId);
    if (!st || !st.direction) {
      await ctx.reply('Начните заново: нажмите «Отправить посылку».');
      return;
    }
    session.set(userId, { step: 'p_date', direction: st.direction, ...(st.prefill ? { prefill: st.prefill } : {}) });
    await ctx.reply('На какую дату?', { attachments: [kb.dateKeyboard('p', 'p:backdir')] });
  });

  bot.action(/^p:date:(\d{8}|other)$/, async (ctx) => {
    const choice = ctx.match[1];
    const userId = getUserId(ctx);
    const st = session.get(userId);
    if (!st || st.step !== 'p_date') {
      await ctx.reply('Начните заново: нажмите «Отправить посылку».');
      return;
    }
    if (choice === 'other') {
      st.step = 'p_awaiting_date_text';
      session.set(userId, st);
      await ctx.reply('Введите дату в формате ДД.ММ.ГГГГ (например, 15.08.2026):');
      return;
    }
    const date = `${choice.slice(0, 4)}-${choice.slice(4, 6)}-${choice.slice(6, 8)}`;
    await showParcelTimeOptions(ctx, userId, st.direction, date, st.prefill);
  });

  async function showParcelTimeOptions(ctx, userId, direction, date, prefill) {
    // Берём тот же список рейсов, что и для пассажиров (уже без прошедших по времени),
    // но показываем ВСЕ рейсы дня — свободные места пассажиров тут не важны.
    const trips = availableTrips(direction, date);
    if (trips.length === 0) {
      // Не тупик: сразу предлагаем выбрать другую дату для того же направления —
      // например, у водителя в этот день выходной (среда).
      session.set(userId, { step: 'p_date', direction, ...(prefill ? { prefill } : {}) });
      await ctx.reply(
        'На эту дату рейсов не найдено (например, в этот день у водителя выходной). Выберите другую дату:',
        { attachments: [kb.dateKeyboard('p', 'p:backdir')] }
      );
      return;
    }
    session.set(userId, { step: 'p_time', direction, date, ...(prefill ? { prefill } : {}) });
    const compact = date.replace(/-/g, '');
    await ctx.reply(
      `📦 ${fmt.directionLabel(direction)}\n📅 ${fmt.formatDateRu(date)}\n\nВыберите рейс:`,
      { attachments: [kb.parcelTimeKeyboard(trips, compact, 'p:backdate')] }
    );
  }

  bot.action('p:backtime', async (ctx) => {
    const userId = getUserId(ctx);
    const st = session.get(userId);
    if (!st || !st.direction || !st.date) {
      await ctx.reply('Начните заново: нажмите «Отправить посылку».');
      return;
    }
    await showParcelTimeOptions(ctx, userId, st.direction, st.date, st.prefill);
  });

  bot.action(/^p:time:(s\d+|x\d+):(\d{8})$/, async (ctx) => {
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
      await showParcelTimeOptions(ctx, userId, direction, date, prefill);
      return;
    }
    session.set(userId, {
      step: 'p_awaiting_village',
      direction: item.direction,
      date,
      scheduleId,
      time: item.time,
      ...(prefill ? { prefill } : {}),
    });
    const villagePrompt =
      (item.direction === 'YA_UFA' ? 'Из какого населённого пункта посылка?' : 'В какой населённый пункт доставить посылку?') +
      '\n\nЕсли вашего населённого пункта нет в списке — нажмите «Другое» и напишите его сами.';
    await ctx.reply(villagePrompt, { attachments: [kb.villageKeyboard('p', 'p:backtime')] });
  });

  bot.action('p:villageother', async (ctx) => {
    const userId = getUserId(ctx);
    const st = session.get(userId);
    if (!st || st.step !== 'p_awaiting_village') {
      await ctx.reply('Начните заново: нажмите «Отправить посылку».');
      return;
    }
    st.step = 'p_awaiting_custom_village';
    session.set(userId, st);
    await ctx.reply('Напишите название вашего населённого пункта:');
  });

  bot.action(/^p:village:(\d+)$/, async (ctx) => {
    const idx = Number(ctx.match[1]);
    const userId = getUserId(ctx);
    const st = session.get(userId);
    if (!st || st.step !== 'p_awaiting_village') {
      await ctx.reply('Начните заново: нажмите «Отправить посылку».');
      return;
    }
    const village = fmt.VILLAGES[idx];
    if (!village) {
      await ctx.reply('Не удалось распознать населённый пункт, попробуйте ещё раз.');
      return;
    }
    st.village = village;
    st.step = 'p_awaiting_address';
    session.set(userId, st);
    // В отличие от записи пассажиров, адрес спрашиваем ВСЕГДА, независимо от направления —
    // посылку нужно точно куда-то доставить или откуда-то забрать внутри деревни.
    const addressPrompt =
      st.direction === 'YA_UFA'
        ? 'Напишите адрес в населённом пункте, откуда забрать посылку:'
        : 'Напишите адрес в населённом пункте, куда доставить посылку:';
    await ctx.reply(addressPrompt);
  });

  // Если у отправителя уже есть предыдущая посылка/заявка (пришёл по кнопке
  // «Отправить ещё одну посылку»), предлагаем использовать те же имя и телефон.
  async function askNameOrUsePrefill(ctx, userId, st) {
    if (st.prefill && st.prefill.name && st.prefill.phone) {
      st.step = 'p_confirm_prefill';
      session.set(userId, st);
      await ctx.reply(
        `Использовать данные как в прошлый раз?\n👤 ${st.prefill.name}\n📞 ${st.prefill.phone}`,
        { attachments: [kb.prefillConfirmKeyboard('p')] }
      );
    } else {
      st.step = 'p_awaiting_name';
      session.set(userId, st);
      await ctx.reply(
        'Введите имя (отправитель/получатель):\n\nИли нажмите кнопку ниже, чтобы отправить имя и номер из телефонной книги одним нажатием.',
        { attachments: [kb.contactShareKeyboard('p', 'p:backname')] }
      );
    }
  }

  // Кнопка «Назад» с шага ввода имени — возвращает к вводу адреса (адрес
  // в потоке посылки запрашивается всегда, вне зависимости от направления)
  bot.action('p:backname', async (ctx) => {
    const userId = getUserId(ctx);
    const st = session.get(userId);
    if (!st || !st.direction) {
      await ctx.reply('Начните заново: нажмите «Отправить посылку».');
      return;
    }
    st.step = 'p_awaiting_address';
    session.set(userId, st);
    const addressPrompt =
      st.direction === 'YA_UFA'
        ? 'Напишите адрес в населённом пункте, откуда забрать посылку:'
        : 'Напишите адрес в населённом пункте, куда доставить посылку:';
    await ctx.reply(addressPrompt);
  });

  // Кнопка «Назад» с шага ввода телефона — возвращает к вводу имени
  bot.action('p:backphone', async (ctx) => {
    const userId = getUserId(ctx);
    const st = session.get(userId);
    if (!st) {
      await ctx.reply('Начните заново: нажмите «Отправить посылку».');
      return;
    }
    st.step = 'p_awaiting_name';
    session.set(userId, st);
    await ctx.reply('Введите имя (отправитель/получатель):', {
      attachments: [kb.contactShareKeyboard('p', 'p:backname')],
    });
  });

  bot.action('p:useprefill', async (ctx) => {
    const userId = getUserId(ctx);
    const st = session.get(userId);
    if (!st || st.step !== 'p_confirm_prefill' || !st.prefill) {
      await ctx.reply('Начните заново: нажмите «Отправить посылку».');
      return;
    }
    st.name = st.prefill.name;
    st.phone = st.prefill.phone;
    await finalizeParcel(ctx, bot, userId, st);
  });

  bot.action('p:freshname', async (ctx) => {
    const userId = getUserId(ctx);
    const st = session.get(userId);
    if (!st || st.step !== 'p_confirm_prefill') {
      await ctx.reply('Начните заново: нажмите «Отправить посылку».');
      return;
    }
    st.step = 'p_awaiting_name';
    session.set(userId, st);
    await ctx.reply('Введите имя (отправитель/получатель):', { attachments: [kb.contactShareKeyboard('p', 'p:backname')] });
  });

  async function finalizeParcel(ctx, bot, userId, st) {
    const booking = db.addBooking({
      direction: st.direction,
      date: st.date,
      time: st.time,
      scheduleId: st.scheduleId,
      village: st.village,
      address: st.address || null,
      name: st.name,
      phone: st.phone,
      seats: 0,
      userId,
      kind: 'parcel',
    });
    session.clear(userId);
    await ctx.reply(
      `✅ Посылка принята!\n\n🚌 ${fmt.directionLabel(st.direction)}\n📅 ${fmt.formatDateRu(st.date)}\n🕡 ${st.time}\n🏘 ${st.village}` +
        (st.address ? `\n📍 ${st.address}` : '') +
        `\n👤 ${st.name}\n📞 ${st.phone}\n📦 Посылка\n\nМы свяжемся с вами при необходимости.`,
      { attachments: [kb.myParcelCancelKeyboard(booking.id)] }
    );
    notifyWifeParcel(bot, booking);
  }

  // Обработка текстовых сообщений — многошаговый ввод даты/адреса/имени/телефона
  bot.on('message_created', async (ctx, next) => {
    const userId = getUserId(ctx);
    const st = session.get(userId);

    // Кнопка «Отправить свой номер» присылает вложение-контакт без текста
    // сообщения, поэтому эту проверку делаем раньше проверки на пустой текст.
    if (st && (st.step === 'p_awaiting_name' || st.step === 'p_awaiting_phone')) {
      const contact = getContactFromMessage(ctx);
      if (contact) {
        if (contact.phone) st.phone = contact.phone;
        if (contact.name) st.name = contact.name;
        if (st.name && st.phone) {
          await finalizeParcel(ctx, bot, userId, st);
        } else if (st.phone) {
          // В контакте не оказалось имени — просим ввести его вручную.
          st.step = 'p_awaiting_name';
          session.set(userId, st);
          await ctx.reply(`✅ Номер получен: ${st.phone}\n\nВведите имя (отправитель/получатель):`);
        } else if (st.name) {
          st.step = 'p_awaiting_phone';
          session.set(userId, st);
          await ctx.reply(`✅ Имя получено: ${st.name}\n\nВведите номер телефона:`, {
            attachments: [kb.contactShareKeyboard('p', 'p:backphone')],
          });
        }
        return;
      }
    }

    const text = getText(ctx).trim();

    if (!st || !text || typeof st.step !== 'string' || !st.step.startsWith('p_')) {
      if (typeof next === 'function') return next();
      return;
    }

    if (st.step === 'p_awaiting_date_text') {
      const iso = fmt.parseRuDate(text);
      if (!iso) {
        await ctx.reply('Не удалось распознать дату. Введите в формате ДД.ММ.ГГГГ, например 15.08.2026:');
        return;
      }
      await showParcelTimeOptions(ctx, userId, st.direction, iso, st.prefill);
      return;
    }

    if (st.step === 'p_awaiting_custom_village') {
      const village = text.trim();
      if (!village) {
        await ctx.reply('Напишите название вашего населённого пункта:');
        return;
      }
      st.village = village;
      st.step = 'p_awaiting_address';
      session.set(userId, st);
      const addressPrompt =
        st.direction === 'YA_UFA'
          ? 'Напишите адрес в населённом пункте, откуда забрать посылку:'
          : 'Напишите адрес в населённом пункте, куда доставить посылку:';
      await ctx.reply(addressPrompt);
      return;
    }

    if (st.step === 'p_awaiting_address') {
      st.address = text;
      await askNameOrUsePrefill(ctx, userId, st);
      return;
    }

    if (st.step === 'p_awaiting_name') {
      st.name = text;
      st.step = 'p_awaiting_phone';
      session.set(userId, st);
      await ctx.reply('Введите номер телефона:', { attachments: [kb.contactShareKeyboard('p', 'p:backphone')] });
      return;
    }

    if (st.step === 'p_awaiting_phone') {
      if (!fmt.isLikelyPhone(text)) {
        await ctx.reply('Похоже, номер телефона указан некорректно. Введите ещё раз, например +79991234567:');
        return;
      }
      st.phone = fmt.normalizePhone(text);
      await finalizeParcel(ctx, bot, userId, st);
      return;
    }

    if (typeof next === 'function') return next();
  });
}

module.exports = { registerParcelFlow, notifyWifeParcel };
