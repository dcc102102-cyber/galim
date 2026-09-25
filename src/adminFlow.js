const db = require('./store');
const config = require('./config');
const session = require('./session');
const kb = require('./keyboards');
const fmt = require('./format');
const { allTripsForDate, carInfo, capacityOf, isPastTrip } = require('./schedule');
const { getUserId, getChatId, getText } = require('./ctxHelpers');
const { sendToAllGroups, publishGroupBroadcast, refreshGroupBroadcastIfChanged } = require('./groupUtil');

function isWife(ctx) {
  return config.adminIds.length > 0 && config.adminIds.includes(getUserId(ctx));
}

// Отправляет уведомление ВСЕМ администраторам из WIFE_USER_ID (жене, мужу — кто угодно
// указан через запятую в .env), а не только первому. Используется вместо прямого
// bot.api.sendMessageToUser(config.wifeId, ...) везде, где раньше уведомлялась «жена».
function notifyAdmins(bot, text, opts) {
  config.adminIds.forEach((id) => {
    bot.api
      .sendMessageToUser(id, text, opts)
      .catch((e) => console.error(`Не удалось отправить уведомление администратору ${id}:`, e));
  });
}

function guardWife(handler) {
  return async (ctx) => {
    if (!isWife(ctx)) {
      await ctx.reply('Этот раздел доступен только администратору.');
      return;
    }
    return handler(ctx);
  };
}

// Часть строки после имени/телефона — количество мест для пассажира или пометка
// «посылка» для доставки. Используется во всех местах, где выводится список заявок.
function bookingDetailLabel(b) {
  return b.kind === 'parcel' ? '📦 посылка' : `${b.seats} мест${b.seats > 1 ? 'а' : 'о'}`;
}

// Текст списка для водителя (используется и в превью, и при реальной отправке).
// Пассажиры и посылки показываются отдельными блоками, посылки — после пассажиров.
function buildDriverText(info, date, bookings) {
  const passengers = bookings.filter((b) => b.kind !== 'parcel');
  const parcels = bookings.filter((b) => b.kind === 'parcel');
  let text = `🚗 ${fmt.bold(`РЕЙС${info.isExtra ? ' (доп. машина)' : ''}`)}\n\n${fmt.bold(fmt.directionLabel(info.direction))}\n${fmt.bold(`${fmt.formatDateRu(date)}, ${info.time}`)}\n`;
  if (passengers.length > 0) {
    text += '\n👥 Пассажиры:\n\n';
    passengers.forEach((b, i) => {
      const place = b.village ? `${b.village}${b.address ? `, ${b.address}` : ''}` : '—';
      const note = b.note ? `\n   📝 ${b.note}` : '';
      const confirmIcon = fmt.rideConfirmIcon(b) ? ` ${fmt.rideConfirmIcon(b)}` : '';
      text += `${i + 1}. ${b.phone} — ${place} — ${b.name}${confirmIcon} — ${bookingDetailLabel(b)}${note}\n`;
    });
  }
  if (parcels.length > 0) {
    text += '\n📦 Посылки:\n\n';
    parcels.forEach((b, i) => {
      const place = b.village ? `${b.village}${b.address ? `, ${b.address}` : ''}` : '—';
      const note = b.note ? `\n   📝 ${b.note}` : '';
      text += `${i + 1}. ${b.phone} — ${place} — ${b.name}${note}\n`;
    });
  }
  const totalSeats = passengers.reduce((s, b) => s + b.seats, 0);
  text += `\nВсего: ${totalSeats} пассажир(а/ов)`;
  if (parcels.length > 0) {
    text += `, ${parcels.length} ${fmt.pluralRu(parcels.length, 'посылка', 'посылки', 'посылок')}`;
  }
  return text;
}

// Текст объявления в группу о свободных местах на рейсе. Специально не содержит
// никаких данных о пассажирах (имена/телефоны/адреса) — это публичное сообщение
// в общий чат, а не список для водителя.
function buildGroupFreeSeatsText(info, date, free) {
  return (
    `🚕 ${fmt.bold('Есть свободные места!')}\n\n` +
    `${fmt.bold(fmt.directionLabel(info.direction))}${info.isExtra ? ' 🚐 (доп. машина)' : ''}\n` +
    `${fmt.bold(`${fmt.formatDateRu(date)}, ${info.time}`)}\n\n` +
    `Чтобы записаться — напишите боту в личные сообщения:\n` +
    `🤖 https://max.ru/id021401888395_1_bot\n` +
    `или позвоните: +79273336124`
  );
}

// Рейсы за дату, которые имеет смысл включать в рассылку: ещё не уехали и есть
// свободные места.
function freeTripsForBroadcast(date) {
  return allTripsForDate(date).filter((t) => !isPastTrip(date, t.time) && t.free > 0);
}

// Текст общей рассылки в группу — сразу по всем рейсам со свободными местами за
// один день (оба направления). Как и buildGroupFreeSeatsText, не содержит никаких
// данных о пассажирах — только направления, время и число свободных мест.
function buildGroupBroadcastText(date, trips) {
  const dayWord = date === fmt.todayISO() ? 'сегодня, ' : date === fmt.tomorrowISO() ? 'завтра, ' : '';
  let text = `🚕 ${fmt.bold(`Свободные места на ${dayWord}${fmt.formatDateRu(date)}:`)}\n\n`;
  trips.forEach((t) => {
    text += `${fmt.bold(fmt.directionLabel(t.direction))} ${fmt.bold(t.time)}${t.isExtra ? ' 🚐(доп)' : ''}\n`;
  });
  text +=
    `\nЧтобы записаться — напишите боту в личные сообщения:\n` +
    `🤖 https://max.ru/id021401888395_1_bot\n` +
    `или позвоните: +79273336124`;
  return text;
}

function tripDetailText(carId, date) {
  const info = carInfo(carId, date);
  const bookings = db.getBookingsForTrip(carId, date);
  const active = bookings.filter((b) => b.status !== 'cancelled');
  const total = active.filter((b) => b.kind !== 'parcel').reduce((s, b) => s + b.seats, 0);
  const parcelCount = active.filter((b) => b.kind === 'parcel').length;
  let text = `${fmt.bold(fmt.directionLabel(info.direction))}${info.isExtra ? ' 🚐 (доп. машина)' : ''}\n${fmt.bold(`${fmt.formatDateRu(date)} — ${info.time}`)}\n\n`;
  if (bookings.length === 0) {
    text += 'Пока никто не записан.\n';
  } else {
    bookings.forEach((b, i) => {
      const icon = fmt.STATUS_ICON[b.status] || '';
      const confirmIcon = fmt.rideConfirmIcon(b) ? ` ${fmt.rideConfirmIcon(b)}` : '';
      const place = b.village ? ` — 🏘 ${b.village}${b.address ? `, ${b.address}` : ''}` : '';
      const note = b.note ? `\n   📝 ${b.note}` : '';
      text += `${i + 1}. ${icon} ${b.name}${confirmIcon} — ${b.phone} — ${bookingDetailLabel(b)}${place} (${fmt.STATUS_LABEL[b.status]})${note}\n`;
    });
    if (bookings.some((b) => b.rideConfirmed)) {
      text += '\n✅ — пассажир подтвердил поездку, ❗ — сказал, что не едет.';
    }
  }
  text += `\nВсего: ${total}/${info.capacity}`;
  if (parcelCount > 0) {
    text += ` + 📦 ${parcelCount} ${fmt.pluralRu(parcelCount, 'посылка', 'посылки', 'посылок')}`;
  }
  return text;
}

// Полный отчёт по всем рейсам, пассажирам и посылкам за один день (оба направления)
function dayReportText(date) {
  // Сортируем строго по времени выезда (а не по направлению), чтобы рейсы шли
  // в реальном хронологическом порядке дня — так жене проще воспринимать отчёт.
  const trips = [...allTripsForDate(date)].sort((a, b) => a.time.localeCompare(b.time));
  let text = `📊 Отчёт за ${fmt.formatDateRu(date)}\n`;
  if (trips.length === 0) {
    text += '\nНа эту дату рейсов нет.';
    return text;
  }
  let totalPassengers = 0;
  let totalSeats = 0;
  let totalParcels = 0;
  trips.forEach((t) => {
    const bookings = db.getBookingsForTrip(t.id, date).filter((b) => b.status !== 'cancelled');
    const passengers = bookings.filter((b) => b.kind !== 'parcel');
    const parcels = bookings.filter((b) => b.kind === 'parcel');
    const seats = passengers.reduce((s, b) => s + b.seats, 0);
    totalPassengers += passengers.length;
    totalSeats += seats;
    totalParcels += parcels.length;
    text += `\n🚌 ${fmt.directionLabel(t.direction)} ${t.time}${t.isExtra ? ' 🚐(доп)' : ''} — ${seats}/${t.max}`;
    if (parcels.length > 0) text += ` + 📦${parcels.length}`;
    text += '\n';
    if (bookings.length === 0) {
      text += '   — пусто\n';
    } else {
      bookings.forEach((b, i) => {
        const place = b.village ? ` (${b.village}${b.address ? ', ' + b.address : ''})` : '';
        const note = b.note ? `\n      📝 ${b.note}` : '';
        const confirmIcon = fmt.rideConfirmIcon(b) ? ` ${fmt.rideConfirmIcon(b)}` : '';
        text += `   ${i + 1}. ${b.name}${confirmIcon} — ${b.phone} — ${bookingDetailLabel(b)}${place}${note}\n`;
      });
    }
  });
  text += `\nВсего заявок за день: ${totalPassengers} (мест: ${totalSeats})`;
  if (totalParcels > 0) {
    text += `\nВсего посылок за день: ${totalParcels}`;
  }
  return text;
}

// Рассылает вопрос "точно едете?" пассажирам конкретного рейса (кроме тех,
// кто уже подтвердил) и возвращает, кому реально отправили (askable) и
// скольким не смогли, потому что они записаны вручную без своего чата с
// ботом (skipped). Используется и ручной кнопкой «Запросить подтверждение» в
// адинке, и автоматикой по расписанию (rideConfirmAutoNotify.js).
function sendRideConfirmRequests(bot, carId, date, info) {
  const bookings = db
    .getActiveBookingsForTrip(carId, date)
    .filter((b) => b.kind !== 'parcel' && b.rideConfirmed !== 'yes');
  const askable = bookings.filter((b) => b.userId);
  const skipped = bookings.length - askable.length;
  if (askable.length > 0) {
    const text =
      `❓ Подтвердите, пожалуйста, поездку:\n\n` +
      `🚌 ${fmt.directionLabel(info.direction)}\n` +
      `📅 ${fmt.formatDateRu(date)}\n` +
      `🕡 ${info.time}\n\n` +
      `Вы точно едете?`;
    askable.forEach((b) => {
      bot.api
        .sendMessageToUser(b.userId, text, { attachments: [kb.rideConfirmKeyboard(b.id)] })
        .catch((e) => console.error(`Не удалось запросить подтверждение у ${b.name} (${b.id}):`, e));
    });
  }
  return { askable, skipped };
}

function registerAdminFlow(bot) {
  bot.command('admin', guardWife(async (ctx) => {
    await ctx.reply('Панель администратора:', { attachments: [kb.adminMenuKeyboard()] });
  }));

  bot.action('a:menu', guardWife(async (ctx) => {
    await ctx.reply('Панель администратора:', { attachments: [kb.adminMenuKeyboard()] });
  }));

  bot.action('a:settings', guardWife(async (ctx) => {
    await ctx.reply('Настройки:', { attachments: [kb.adminSettingsKeyboard(db.isRideConfirmAutoEnabled())] });
  }));

  bot.action('a:togglerideconfirm', guardWife(async (ctx) => {
    const enabled = !db.isRideConfirmAutoEnabled();
    db.setRideConfirmAutoEnabled(enabled);
    await ctx.reply(
      enabled
        ? `🔔 Включил авто-вопрос «точно едете?» — буду спрашивать пассажиров за ${config.rideConfirmAutoMinutes} мин. до рейса.`
        : '🔕 Выключил авто-вопрос «точно едете?» — теперь только по кнопке вручную.',
      { attachments: [kb.adminSettingsKeyboard(enabled)] }
    );
  }));

  bot.action('a:home', guardWife(async (ctx) => {
    await ctx.reply('Главное меню:', { attachments: [kb.adminEntryKeyboard()] });
  }));

  bot.action('a:report:pick_entry', guardWife(async (ctx) => {
    await ctx.reply('За какую дату показать отчёт?', { attachments: [kb.reportDayKeyboard()] });
  }));

  bot.action(/^a:report:(\d{8}|other)$/, guardWife(async (ctx) => {
    const choice = ctx.match[1];
    if (choice === 'other') {
      session.set(getUserId(ctx), { step: 'admin_report_awaiting_date' });
      await ctx.reply('Введите дату в формате ДД.ММ.ГГГГ:');
      return;
    }
    const date = `${choice.slice(0, 4)}-${choice.slice(4, 6)}-${choice.slice(6, 8)}`;
    await ctx.reply(dayReportText(date), { attachments: [kb.adminMenuKeyboard()] });
  }));

  bot.action('a:day:pick_entry', guardWife(async (ctx) => {
    await ctx.reply('За какую дату показать рейсы?', { attachments: [kb.adminDayKeyboard()] });
  }));

  bot.action(/^a:day:(\d{8}|other)$/, guardWife(async (ctx) => {
    const choice = ctx.match[1];
    if (choice === 'other') {
      session.set(getUserId(ctx), { step: 'admin_awaiting_date' });
      await ctx.reply('Введите дату в формате ДД.ММ.ГГГГ:');
      return;
    }
    const date = `${choice.slice(0, 4)}-${choice.slice(4, 6)}-${choice.slice(6, 8)}`;
    await showTripsForDate(ctx, date);
  }));

  async function showTripsForDate(ctx, date) {
    const trips = allTripsForDate(date);
    const compact = date.replace(/-/g, '');
    // Даже если рейсов по расписанию нет, всё равно даём возможность добавить
    // разовую машину на этот день — поэтому не блокируем экран полностью.
    await ctx.reply(
      trips.length === 0
        ? `📅 На ${fmt.bold(fmt.formatDateRu(date))} нет рейсов в расписании. Можно добавить разовую машину:`
        : `📅 ${fmt.bold(`Рейсы на ${fmt.formatDateRu(date)}:`)}`,
      { attachments: [kb.adminTripListKeyboard(trips, compact)], format: 'markdown' }
    );
  }

  bot.action(/^a:back:(\d{8})$/, guardWife(async (ctx) => {
    const dateCompact = ctx.match[1];
    const date = `${dateCompact.slice(0, 4)}-${dateCompact.slice(4, 6)}-${dateCompact.slice(6, 8)}`;
    await showTripsForDate(ctx, date);
  }));

  bot.action(/^a:trip:(s\d+|x\d+):(\d{8})$/, guardWife(async (ctx) => {
    const carId = ctx.match[1];
    const dateCompact = ctx.match[2];
    const date = `${dateCompact.slice(0, 4)}-${dateCompact.slice(4, 6)}-${dateCompact.slice(6, 8)}`;
    const info = carInfo(carId, date);
    if (!info) {
      await ctx.reply('Эта машина больше недоступна (возможно, была удалена).');
      return;
    }
    const bookings = db.getActiveBookingsForTrip(carId, date);
    await ctx.reply(tripDetailText(carId, date), {
      attachments: [kb.adminTripDetailKeyboard(bookings, carId, dateCompact, info.isExtra)],
      format: 'markdown',
    });
  }));

  bot.action(/^a:conf:(b\d+)$/, guardWife(async (ctx) => {
    const id = ctx.match[1];
    const b = db.updateBooking(id, { status: 'confirmed' });
    if (b) {
      const info = carInfo(b.scheduleId, b.date);
      await ctx.reply(`✅ Заявка ${b.name} подтверждена.`, {
        attachments: [
          kb.adminTripDetailKeyboard(
            db.getActiveBookingsForTrip(b.scheduleId, b.date),
            b.scheduleId,
            b.date.replace(/-/g, ''),
            info && info.isExtra
          ),
        ],
      });
    }
  }));

  bot.action(/^a:cancel:(b\d+)$/, guardWife(async (ctx) => {
    const id = ctx.match[1];
    const b = db.updateBooking(id, { status: 'cancelled' });
    if (b) {
      const info = carInfo(b.scheduleId, b.date);
      await ctx.reply(`🔴 Заявка ${b.name} отменена, место освобождено.`, {
        attachments: [
          kb.adminTripDetailKeyboard(
            db.getActiveBookingsForTrip(b.scheduleId, b.date),
            b.scheduleId,
            b.date.replace(/-/g, ''),
            info && info.isExtra,
            { bookingId: b.id, name: b.name }
          ),
        ],
      });
      refreshGroupBroadcastIfChanged(bot, b.date, freeTripsForBroadcast(b.date), buildGroupBroadcastText).catch(
        (e) => console.error('Не удалось обновить объявление в группе:', e)
      );
    }
  }));

  // Восстановление случайно отменённой заявки — возвращает статус «Новая»,
  // с проверкой, что место на рейсе всё ещё свободно
  bot.action(/^a:restore:(b\d+)$/, guardWife(async (ctx) => {
    const id = ctx.match[1];
    const b = db.getBooking(id);
    if (!b) {
      await ctx.reply('Заявка не найдена.');
      return;
    }
    if (b.status !== 'cancelled') {
      await ctx.reply('Эта заявка уже не отменена — возвращать не нужно.');
      return;
    }
    const info = carInfo(b.scheduleId, b.date);
    const capacity = info ? info.capacity : 0;
    const occupied = db.occupiedSeats(b.scheduleId, b.date);
    const free = capacity - occupied;
    if (b.seats > free) {
      await ctx.reply(
        `❌ Нельзя вернуть: свободно только ${free} мест(а), а нужно ${b.seats}. Возможно, место уже занял другой пассажир.`
      );
      return;
    }
    db.updateBooking(id, { status: 'new' });
    await ctx.reply(`↩️ Заявка ${b.name} возвращена в список.`, {
      attachments: [
        kb.adminTripDetailKeyboard(
          db.getActiveBookingsForTrip(b.scheduleId, b.date),
          b.scheduleId,
          b.date.replace(/-/g, ''),
          info && info.isExtra
        ),
      ],
    });
    refreshGroupBroadcastIfChanged(bot, b.date, freeTripsForBroadcast(b.date), buildGroupBroadcastText).catch((e) =>
      console.error('Не удалось обновить объявление в группе:', e)
    );
  }));

  bot.action(/^a:call:(b\d+)$/, guardWife(async (ctx) => {
    const id = ctx.match[1];
    const b = db.getBooking(id);
    if (b) await ctx.reply(`📞 ${b.name}: ${b.phone}`);
  }));

  bot.action(/^a:edit:(b\d+)$/, guardWife(async (ctx) => {
    const id = ctx.match[1];
    const b = db.getBooking(id);
    if (!b) return;
    session.set(getUserId(ctx), { step: 'admin_edit_name', bookingId: id });
    await ctx.reply(`Текущее имя: ${b.name}\nВведите новое имя (или отправьте «-», чтобы оставить как есть):`);
  }));

  bot.action(/^a:addpax:(s\d+|x\d+):(\d{8})$/, guardWife(async (ctx) => {
    const carId = ctx.match[1];
    const dateCompact = ctx.match[2];
    const date = `${dateCompact.slice(0, 4)}-${dateCompact.slice(4, 6)}-${dateCompact.slice(6, 8)}`;
    const info = carInfo(carId, date);
    session.set(getUserId(ctx), { step: 'admin_add_name', scheduleId: carId, date, direction: info && info.direction });
    await ctx.reply('Добавление пассажира вручную.\nВведите имя:');
  }));

  // Ручное добавление посылки (например, если её принесли не через бота, а лично/по звонку) —
  // тот же карман шагов, что и у пассажира, но без вопроса про число мест и без проверки
  // свободных мест: посылка не занимает место в машине.
  bot.action(/^a:addparcel:(s\d+|x\d+):(\d{8})$/, guardWife(async (ctx) => {
    const carId = ctx.match[1];
    const dateCompact = ctx.match[2];
    const date = `${dateCompact.slice(0, 4)}-${dateCompact.slice(4, 6)}-${dateCompact.slice(6, 8)}`;
    const info = carInfo(carId, date);
    session.set(getUserId(ctx), {
      step: 'admin_addparcel_name',
      scheduleId: carId,
      date,
      direction: info && info.direction,
    });
    await ctx.reply('Добавление посылки вручную.\nВведите имя (отправитель/получатель):');
  }));

  bot.action(/^a:addvillage:village:(\d+)$/, guardWife(async (ctx) => {
    const idx = Number(ctx.match[1]);
    const userId = getUserId(ctx);
    const st = session.get(userId);
    if (!st || st.step !== 'admin_add_village') {
      await ctx.reply('Начните добавление пассажира заново.');
      return;
    }
    const village = fmt.VILLAGES[idx];
    if (!village) {
      await ctx.reply('Не удалось распознать населённый пункт, попробуйте ещё раз.');
      return;
    }
    st.village = village;
    if (st.direction === 'YA_UFA') {
      st.step = 'admin_add_address';
      session.set(userId, st);
      await ctx.reply('Введите адрес в населённом пункте (откуда забрать):');
    } else {
      st.step = 'admin_add_seats';
      session.set(userId, st);
      await ctx.reply('Сколько мест занимает?');
    }
  }));

  bot.action(/^a:addparcelvillage:village:(\d+)$/, guardWife(async (ctx) => {
    const idx = Number(ctx.match[1]);
    const userId = getUserId(ctx);
    const st = session.get(userId);
    if (!st || st.step !== 'admin_addparcel_village') {
      await ctx.reply('Начните добавление посылки заново.');
      return;
    }
    const village = fmt.VILLAGES[idx];
    if (!village) {
      await ctx.reply('Не удалось распознать населённый пункт, попробуйте ещё раз.');
      return;
    }
    st.village = village;
    st.step = 'admin_addparcel_address';
    session.set(userId, st);
    // В отличие от пассажира, адрес для посылки спрашиваем всегда, в обе стороны —
    // нужно точно знать, откуда забрать или куда доставить внутри деревни.
    const addressPrompt =
      st.direction === 'YA_UFA'
        ? 'Введите адрес в населённом пункте, откуда забрать посылку:'
        : 'Введите адрес в населённом пункте, куда доставить посылку:';
    await ctx.reply(addressPrompt);
  }));

  // У зятя несколько водителей (в отличие от исходного проекта с одним
  // фиксированным DRIVER_USER_ID) — поэтому бот здесь ничего никому не
  // отправляет сам, а просто формирует текстом список пассажиров на рейс.
  // Кому из водителей его переслать — решает и делает вручную сам админ.
  bot.action(/^a:senddriver:(s\d+|x\d+):(\d{8})$/, guardWife(async (ctx) => {
    const carId = ctx.match[1];
    const dateCompact = ctx.match[2];
    const date = `${dateCompact.slice(0, 4)}-${dateCompact.slice(4, 6)}-${dateCompact.slice(6, 8)}`;
    const info = carInfo(carId, date);
    const bookings = fmt.sortByVillageRoute(db.getActiveBookingsForTrip(carId, date), info.direction);
    if (bookings.length === 0) {
      await ctx.reply('На этот рейс пока никто не записан.');
      return;
    }
    const text = buildDriverText(info, date, bookings);
    bookings.forEach((b) => db.updateBooking(b.id, { status: 'sent' }));
    await ctx.reply(`📋 ${fmt.bold('Список для водителя (перешлите нужному водителю сами):')}\n\n${text}`, {
      attachments: [kb.driverListKeyboard(carId, dateCompact)],
      format: 'markdown',
    });
  }));

  // --- Ручное объявление в группу о свободных местах на рейсе ---

  bot.action(/^a:notifygroup:(s\d+|x\d+):(\d{8})$/, guardWife(async (ctx) => {
    const carId = ctx.match[1];
    const dateCompact = ctx.match[2];
    const date = `${dateCompact.slice(0, 4)}-${dateCompact.slice(4, 6)}-${dateCompact.slice(6, 8)}`;
    const info = carInfo(carId, date);
    if (!info) {
      await ctx.reply('Эта машина больше недоступна (возможно, была удалена).');
      return;
    }
    const occupied = db.occupiedSeats(carId, date);
    const free = Math.max(0, info.capacity - occupied);
    if (free <= 0) {
      await ctx.reply('На этом рейсе нет свободных мест — объявлять нечего.');
      return;
    }
    const text = buildGroupFreeSeatsText(info, date, free);
    await ctx.reply(`👀 Проверьте объявление перед отправкой в группу:\n\n${text}`, {
      attachments: [kb.sendGroupPreviewKeyboard(carId, dateCompact)],
    });
  }));

  bot.action(/^a:notifygroupok:(s\d+|x\d+):(\d{8})$/, guardWife(async (ctx) => {
    const carId = ctx.match[1];
    const dateCompact = ctx.match[2];
    const date = `${dateCompact.slice(0, 4)}-${dateCompact.slice(4, 6)}-${dateCompact.slice(6, 8)}`;
    const info = carInfo(carId, date);
    if (!info) {
      await ctx.reply('Эта машина больше недоступна (возможно, была удалена).');
      return;
    }
    if (config.groupChatIds.length === 0) {
      await ctx.reply(
        '⚠️ ID группы не настроен (GROUP_CHAT_ID в .env). Напишите /groupid прямо в группе, чтобы узнать его.'
      );
      return;
    }
    const occupied = db.occupiedSeats(carId, date);
    const free = Math.max(0, info.capacity - occupied);
    if (free <= 0) {
      await ctx.reply('На этом рейсе уже нет свободных мест — объявление не отправлено.');
      return;
    }
    const text = buildGroupFreeSeatsText(info, date, free);
    await sendToAllGroups(bot, text).then(() => db.markGroupNotified(date, carId));
    await ctx.reply(
      config.groupChatIds.length > 1
        ? `✅ Объявление отправлено в ${config.groupChatIds.length} групп(ы).`
        : '✅ Объявление отправлено в группу.'
    );
  }));

  // --- Рассылка в группу сразу по всем рейсам со свободными местами за день ---

  bot.action('a:broadcast:pick_entry', guardWife(async (ctx) => {
    await ctx.reply('За какую дату разослать объявление о свободных местах?', {
      attachments: [kb.broadcastDayKeyboard()],
    });
  }));

  async function showBroadcastPreview(ctx, date) {
    const trips = freeTripsForBroadcast(date);
    if (trips.length === 0) {
      await ctx.reply(`На ${fmt.formatDateRu(date)} нет рейсов со свободными местами — рассылать нечего.`);
      return;
    }
    const dateCompact = date.replace(/-/g, '');
    const text = buildGroupBroadcastText(date, trips);
    await ctx.reply(`👀 Проверьте объявление перед отправкой в группу:\n\n${text}`, {
      attachments: [kb.sendBroadcastPreviewKeyboard(dateCompact)],
    });
  }

  bot.action(/^a:broadcast:(\d{8}|other)$/, guardWife(async (ctx) => {
    const choice = ctx.match[1];
    if (choice === 'other') {
      session.set(getUserId(ctx), { step: 'admin_broadcast_awaiting_date' });
      await ctx.reply('Введите дату в формате ДД.ММ.ГГГГ:');
      return;
    }
    const date = `${choice.slice(0, 4)}-${choice.slice(4, 6)}-${choice.slice(6, 8)}`;
    await showBroadcastPreview(ctx, date);
  }));

  bot.action(/^a:broadcastok:(\d{8})$/, guardWife(async (ctx) => {
    const dateCompact = ctx.match[1];
    const date = `${dateCompact.slice(0, 4)}-${dateCompact.slice(4, 6)}-${dateCompact.slice(6, 8)}`;
    if (config.groupChatIds.length === 0) {
      await ctx.reply(
        '⚠️ ID группы не настроен (GROUP_CHAT_ID в .env). Напишите /groupid прямо в группе, чтобы узнать его.'
      );
      return;
    }
    const trips = freeTripsForBroadcast(date);
    if (trips.length === 0) {
      await ctx.reply(`На ${fmt.formatDateRu(date)} уже нет рейсов со свободными местами — объявление не отправлено.`);
      return;
    }
    const text = buildGroupBroadcastText(date, trips);
    await publishGroupBroadcast(bot, date, text, trips).then(() =>
      trips.forEach((t) => db.markGroupNotified(date, t.id))
    );
    await ctx.reply(
      config.groupChatIds.length > 1
        ? `✅ Рассылка отправлена в ${config.groupChatIds.length} групп(ы).`
        : '✅ Рассылка отправлена в группу.'
    );
  }));

  // --- Запрос подтверждения у пассажиров конкретного рейса: бот пишет каждому
  // напрямую (кому есть куда писать — то есть кто записывался сам через бота,
  // а не был добавлен админом вручную) и спрашивает, точно ли он едет ---

  bot.action(/^a:askconfirm:(s\d+|x\d+):(\d{8})$/, guardWife(async (ctx) => {
    const carId = ctx.match[1];
    const dateCompact = ctx.match[2];
    const date = `${dateCompact.slice(0, 4)}-${dateCompact.slice(4, 6)}-${dateCompact.slice(6, 8)}`;
    const info = carInfo(carId, date);
    if (!info) {
      await ctx.reply('Эта машина больше недоступна (возможно, была удалена).');
      return;
    }
    const { askable, skipped } = sendRideConfirmRequests(bot, carId, date, info);
    if (askable.length === 0) {
      await ctx.reply(
        skipped > 0
          ? 'Всем, кому можно написать напрямую, уже приходил этот вопрос — либо все записаны вручную (без бота), и им написать нельзя.'
          : 'На этом рейсе нет пассажиров, которых ещё нужно спросить.'
      );
      return;
    }
    let reply = `✅ Вопрос отправлен ${askable.length} пассажир(ам/у): ${askable.map((b) => b.name).join(', ')}.`;
    if (skipped > 0) {
      reply += `\n\n⚠️ ${skipped} пассажир(а/ов) записаны вручную (без бота) — им написать напрямую нельзя, спросите лично.`;
    }
    await ctx.reply(reply);
  }));

  // --- Дополнительные («попутные») машины на конкретную дату ---

  bot.action(/^a:extracar:start:(\d{8})$/, guardWife(async (ctx) => {
    const dateCompact = ctx.match[1];
    const date = `${dateCompact.slice(0, 4)}-${dateCompact.slice(4, 6)}-${dateCompact.slice(6, 8)}`;
    session.set(getUserId(ctx), { step: 'admin_extracar_dir', date });
    await ctx.reply('Добавление дополнительной машины.\nВыберите направление:', {
      attachments: [kb.directionKeyboard('a:extradir', `a:back:${dateCompact}`)],
    });
  }));

  bot.action(/^a:extradir:dir:(YA_UFA|UFA_YA)$/, guardWife(async (ctx) => {
    const userId = getUserId(ctx);
    const st = session.get(userId);
    if (!st || st.step !== 'admin_extracar_dir') {
      await ctx.reply('Начните заново: откройте рейсы на нужную дату и нажмите «Добавить машину».');
      return;
    }
    st.direction = ctx.match[1];
    st.step = 'admin_extracar_time';
    session.set(userId, st);
    await ctx.reply('Введите время отправления в формате ЧЧ:ММ (например, 16:50):');
  }));

  bot.action(/^a:extracap:(x\d+)$/, guardWife(async (ctx) => {
    const carId = ctx.match[1];
    const car = db.getExtraCar(carId);
    if (!car) {
      await ctx.reply('Эта машина уже удалена.');
      return;
    }
    const occupied = db.occupiedSeats(carId, car.date);
    session.set(getUserId(ctx), { step: 'admin_extracar_newcap', carId });
    await ctx.reply(
      `Сейчас вместимость: ${car.capacity} мест, занято: ${occupied}.\nВведите новое число мест:`
    );
  }));

  bot.action(/^a:extradel:(x\d+)$/, guardWife(async (ctx) => {
    const carId = ctx.match[1];
    const car = db.getExtraCar(carId);
    if (!car) {
      await ctx.reply('Эта машина уже удалена.');
      return;
    }
    const active = db.getActiveBookingsForTrip(carId, car.date);
    if (active.length > 0) {
      await ctx.reply(
        `❌ Нельзя удалить: на этой машине ещё ${active.length} активная(ых) заявка(и). Сначала отмените их.`
      );
      return;
    }
    db.deleteExtraCar(carId);
    await ctx.reply('🗑 Дополнительная машина удалена.');
    refreshGroupBroadcastIfChanged(bot, car.date, freeTripsForBroadcast(car.date), buildGroupBroadcastText).catch(
      (e) => console.error('Не удалось обновить объявление в группе:', e)
    );
  }));

  // --- Расписание ---
  bot.action('a:sched', guardWife(async (ctx) => {
    await ctx.reply('Расписание рейсов:', { attachments: [kb.scheduleListKeyboard(db.getSchedule())] });
  }));

  bot.action(/^a:sched:view:(s\d+)$/, guardWife(async (ctx) => {
    const item = db.getScheduleItem(ctx.match[1]);
    if (!item) return;
    await ctx.reply(`${fmt.directionLabel(item.direction)} — ${item.time}${item.active ? '' : ' (выключен)'}`, {
      attachments: [kb.scheduleItemKeyboard(item)],
    });
  }));

  bot.action(/^a:sched:toggle:(s\d+)$/, guardWife(async (ctx) => {
    const item = db.getScheduleItem(ctx.match[1]);
    if (!item) return;
    const updated = db.updateScheduleItem(item.id, { active: !item.active });
    await ctx.reply(`Рейс ${updated.time} теперь ${updated.active ? 'включён' : 'выключен'}.`, {
      attachments: [kb.scheduleItemKeyboard(updated)],
    });
  }));

  bot.action(/^a:sched:del:(s\d+)$/, guardWife(async (ctx) => {
    db.deleteScheduleItem(ctx.match[1]);
    await ctx.reply('Рейс удалён из расписания.', { attachments: [kb.scheduleListKeyboard(db.getSchedule())] });
  }));

  bot.action(/^a:sched:edittime:(s\d+)$/, guardWife(async (ctx) => {
    session.set(getUserId(ctx), { step: 'admin_sched_edittime', scheduleId: ctx.match[1] });
    await ctx.reply('Введите новое время в формате ЧЧ:ММ (например, 07:15):');
  }));

  bot.action('a:sched:add', guardWife(async (ctx) => {
    session.set(getUserId(ctx), { step: 'admin_sched_add_dir' });
    await ctx.reply('Новый рейс. Выберите направление:', {
      attachments: [kb.directionKeyboard('a:sched:newdir', 'a:sched')],
    });
  }));

  bot.action(/^a:sched:newdir:dir:(YA_UFA|UFA_YA)$/, guardWife(async (ctx) => {
    session.set(getUserId(ctx), { step: 'admin_sched_add_wd', direction: ctx.match[1] });
    await ctx.reply('По каким дням ходит этот рейс?', {
      attachments: [kb.weekdayGroupKeyboard('a:sched:newwd', 'a:sched:add')],
    });
  }));

  bot.action(/^a:sched:newwd:wd:(weekday|sat|sun|all)$/, guardWife(async (ctx) => {
    const userId = getUserId(ctx);
    const st = session.get(userId);
    if (!st || st.step !== 'admin_sched_add_wd') {
      await ctx.reply('Начните добавление рейса заново: «Расписание» → «Добавить рейс».');
      return;
    }
    st.weekdays = fmt.WEEKDAY_GROUPS[ctx.match[1]].days;
    st.step = 'admin_sched_add_time';
    session.set(userId, st);
    await ctx.reply('Введите время рейса в формате ЧЧ:ММ (например, 07:15):');
  }));

  // --- Изменение / отмена рейса ТОЛЬКО на конкретную дату (шаблон не трогаем) ---

  bot.action(/^a:daytime:(s\d+):(\d{8})$/, guardWife(async (ctx) => {
    const carId = ctx.match[1];
    const dateCompact = ctx.match[2];
    const date = `${dateCompact.slice(0, 4)}-${dateCompact.slice(4, 6)}-${dateCompact.slice(6, 8)}`;
    session.set(getUserId(ctx), { step: 'admin_daytime_edit', scheduleId: carId, date });
    await ctx.reply(
      `Введите новое время ЧЧ:ММ для этого рейса ТОЛЬКО на ${fmt.formatDateRu(date)}.\n` +
        'На другие дни расписание не изменится.'
    );
  }));

  bot.action(/^a:daycap:(s\d+):(\d{8})$/, guardWife(async (ctx) => {
    const carId = ctx.match[1];
    const dateCompact = ctx.match[2];
    const date = `${dateCompact.slice(0, 4)}-${dateCompact.slice(4, 6)}-${dateCompact.slice(6, 8)}`;
    const info = carInfo(carId, date);
    if (!info) {
      await ctx.reply('Этот рейс больше недоступен.');
      return;
    }
    const occupied = db.occupiedSeats(carId, date);
    session.set(getUserId(ctx), { step: 'admin_daycap_edit', scheduleId: carId, date });
    await ctx.reply(
      `Сейчас в рейсе ${info.capacity} мест, занято: ${occupied}.\n` +
        `Введите новое число мест ТОЛЬКО на ${fmt.formatDateRu(date)}.\n` +
        'На другие дни число мест не изменится.'
    );
  }));

  bot.action(/^a:daydel:(s\d+):(\d{8})$/, guardWife(async (ctx) => {
    const carId = ctx.match[1];
    const dateCompact = ctx.match[2];
    const date = `${dateCompact.slice(0, 4)}-${dateCompact.slice(4, 6)}-${dateCompact.slice(6, 8)}`;
    const active = db.getActiveBookingsForTrip(carId, date);
    if (active.length > 0) {
      await ctx.reply(
        `❌ Нельзя отменить: на этот рейс уже ${active.length} активная(ых) заявка(и). Сначала отмените их.`
      );
      return;
    }
    db.setOverrideDeleted(date, carId);
    await ctx.reply(
      `🚫 Рейс отменён только на ${fmt.formatDateRu(date)}. На другие дни расписание не изменится.`,
      { attachments: [kb.restoreTripKeyboard(carId, dateCompact)] }
    );
    await showTripsForDate(ctx, date);
  }));

  bot.action(/^a:dayrestore:(s\d+):(\d{8})$/, guardWife(async (ctx) => {
    const carId = ctx.match[1];
    const dateCompact = ctx.match[2];
    const date = `${dateCompact.slice(0, 4)}-${dateCompact.slice(4, 6)}-${dateCompact.slice(6, 8)}`;
    db.clearOverride(date, carId);
    await ctx.reply(`↩️ Рейс возвращён — на ${fmt.formatDateRu(date)} снова идёт как в обычном расписании.`);
    await showTripsForDate(ctx, date);
  }));

  // Текстовые шаги админ-флоу (имя/телефон/кол-во при ручном добавлении, редактирование, время рейса,
  // добавление доп. машины, изменение её вместимости)
  bot.on('message_created', async (ctx, next) => {
    if (!isWife(ctx)) {
      if (typeof next === 'function') return next();
      return;
    }
    const userId = getUserId(ctx);
    const st = session.get(userId);
    const text = getText(ctx).trim();
    if (!st || !text) {
      if (typeof next === 'function') return next();
      return;
    }

    if (st.step === 'admin_awaiting_date') {
      const iso = fmt.parseRuDate(text);
      if (!iso) {
        await ctx.reply('Не удалось распознать дату. Формат: ДД.ММ.ГГГГ');
        return;
      }
      session.clear(userId);
      await showTripsForDate(ctx, iso);
      return;
    }

    if (st.step === 'admin_report_awaiting_date') {
      const iso = fmt.parseRuDate(text);
      if (!iso) {
        await ctx.reply('Не удалось распознать дату. Формат: ДД.ММ.ГГГГ');
        return;
      }
      session.clear(userId);
      await ctx.reply(dayReportText(iso), { attachments: [kb.adminMenuKeyboard()] });
      return;
    }

    if (st.step === 'admin_broadcast_awaiting_date') {
      const iso = fmt.parseRuDate(text);
      if (!iso) {
        await ctx.reply('Не удалось распознать дату. Формат: ДД.ММ.ГГГГ');
        return;
      }
      session.clear(userId);
      await showBroadcastPreview(ctx, iso);
      return;
    }

    if (st.step === 'admin_add_name') {
      st.name = text;
      st.step = 'admin_add_phone';
      session.set(userId, st);
      await ctx.reply('Введите телефон:');
      return;
    }
    if (st.step === 'admin_add_phone') {
      if (!fmt.isLikelyPhone(text)) {
        await ctx.reply('Похоже на некорректный номер. Введите ещё раз:');
        return;
      }
      st.phone = fmt.normalizePhone(text);
      st.step = 'admin_add_village';
      session.set(userId, st);
      const villagePrompt = st.direction === 'YA_UFA' ? 'Из какого населённого пункта пассажир?' : 'В какой населённый пункт едет пассажир?';
      await ctx.reply(villagePrompt, {
        attachments: [kb.villageKeyboard('a:addvillage', `a:trip:${st.scheduleId}:${st.date.replace(/-/g, '')}`)],
      });
      return;
    }
    if (st.step === 'admin_add_address') {
      st.address = text;
      st.step = 'admin_add_seats';
      session.set(userId, st);
      await ctx.reply('Сколько мест занимает?');
      return;
    }
    if (st.step === 'admin_add_seats') {
      const count = parseInt(text, 10);
      if (!Number.isInteger(count) || count < 1) {
        await ctx.reply('Введите число мест (например, 1):');
        return;
      }
      const free = capacityOf(st.scheduleId, st.date) - db.occupiedSeats(st.scheduleId, st.date);
      if (count > free) {
        await ctx.reply(`Свободно только ${free} мест(а).`);
        return;
      }
      const info = carInfo(st.scheduleId, st.date);
      db.addBooking({
        direction: info.direction,
        date: st.date,
        time: info.time,
        scheduleId: st.scheduleId,
        village: st.village,
        address: st.address || null,
        name: st.name,
        phone: st.phone,
        seats: count,
        userId: null,
        source: 'manual',
        status: 'confirmed',
      });
      session.clear(userId);
      await ctx.reply('✅ Пассажир добавлен.', {
        attachments: [
          kb.adminTripDetailKeyboard(
            db.getActiveBookingsForTrip(st.scheduleId, st.date),
            st.scheduleId,
            st.date.replace(/-/g, ''),
            info.isExtra
          ),
        ],
      });
      refreshGroupBroadcastIfChanged(
        bot,
        st.date,
        freeTripsForBroadcast(st.date),
        buildGroupBroadcastText
      ).catch((e) => console.error('Не удалось обновить объявление в группе:', e));
      return;
    }

    if (st.step === 'admin_addparcel_name') {
      st.name = text;
      st.step = 'admin_addparcel_phone';
      session.set(userId, st);
      await ctx.reply('Введите телефон:');
      return;
    }
    if (st.step === 'admin_addparcel_phone') {
      if (!fmt.isLikelyPhone(text)) {
        await ctx.reply('Похоже на некорректный номер. Введите ещё раз:');
        return;
      }
      st.phone = fmt.normalizePhone(text);
      st.step = 'admin_addparcel_village';
      session.set(userId, st);
      const villagePrompt = st.direction === 'YA_UFA' ? 'Из какого населённого пункта посылка?' : 'В какой населённый пункт доставить посылку?';
      await ctx.reply(villagePrompt, {
        attachments: [kb.villageKeyboard('a:addparcelvillage', `a:trip:${st.scheduleId}:${st.date.replace(/-/g, '')}`)],
      });
      return;
    }
    if (st.step === 'admin_addparcel_address') {
      st.address = text;
      const info = carInfo(st.scheduleId, st.date);
      db.addBooking({
        direction: info.direction,
        date: st.date,
        time: info.time,
        scheduleId: st.scheduleId,
        village: st.village,
        address: st.address || null,
        name: st.name,
        phone: st.phone,
        seats: 0,
        userId: null,
        source: 'manual',
        status: 'confirmed',
        kind: 'parcel',
      });
      session.clear(userId);
      await ctx.reply('✅ Посылка добавлена.', {
        attachments: [
          kb.adminTripDetailKeyboard(
            db.getActiveBookingsForTrip(st.scheduleId, st.date),
            st.scheduleId,
            st.date.replace(/-/g, ''),
            info.isExtra
          ),
        ],
      });
      return;
    }

    if (st.step === 'admin_edit_name') {
      if (text !== '-') {
        db.updateBooking(st.bookingId, { name: text });
      }
      st.step = 'admin_edit_phone';
      session.set(userId, st);
      await ctx.reply('Введите новый телефон (или «-», чтобы оставить как есть):');
      return;
    }
    if (st.step === 'admin_edit_phone') {
      if (text !== '-') {
        if (!fmt.isLikelyPhone(text)) {
          await ctx.reply('Похоже на некорректный номер. Введите ещё раз, либо «-»:');
          return;
        }
        db.updateBooking(st.bookingId, { phone: fmt.normalizePhone(text) });
      }
      const b = db.getBooking(st.bookingId);
      if (!b) {
        session.clear(userId);
        await ctx.reply('Эта заявка больше не найдена.');
        return;
      }
      // Адрес спрашиваем: у посылки — всегда, в обе стороны (нужно точно знать,
      // откуда забрать/куда доставить внутри деревни); у пассажира — только
      // для «из деревни» (Акьяр → Уфа), в обратную сторону адрес не
      // спрашивается вообще, поэтому и редактировать нечего.
      if (b.kind === 'parcel' || b.direction === 'YA_UFA') {
        st.step = 'admin_edit_address';
        session.set(userId, st);
        await ctx.reply(
          `Текущий адрес: ${b.address || '—'}\nВведите новый адрес (или «-», чтобы оставить как есть):`
        );
        return;
      }
      st.step = 'admin_edit_seats';
      session.set(userId, st);
      await ctx.reply(`Текущее число мест: ${b.seats}\nВведите новое число мест (или «-», чтобы оставить как есть):`);
      return;
    }
    if (st.step === 'admin_edit_address') {
      if (text !== '-') {
        db.updateBooking(st.bookingId, { address: text });
      }
      const b = db.getBooking(st.bookingId);
      // У посылки нет числа мест (она всегда «0», не занимает место в машине) —
      // для неё редактирование мест пропускаем и сразу завершаем.
      if (!b || b.kind === 'parcel') {
        const info = b && carInfo(b.scheduleId, b.date);
        session.clear(userId);
        await ctx.reply('✅ Изменения сохранены.', {
          attachments: [
            kb.adminTripDetailKeyboard(
              db.getActiveBookingsForTrip(b.scheduleId, b.date),
              b.scheduleId,
              b.date.replace(/-/g, ''),
              info && info.isExtra
            ),
          ],
        });
        return;
      }
      st.step = 'admin_edit_seats';
      session.set(userId, st);
      await ctx.reply(`Текущее число мест: ${b.seats}\nВведите новое число мест (или «-», чтобы оставить как есть):`);
      return;
    }
    if (st.step === 'admin_edit_seats') {
      const before = db.getBooking(st.bookingId);
      if (text !== '-') {
        const count = parseInt(text, 10);
        if (!Number.isInteger(count) || count < 1) {
          await ctx.reply('Введите число мест (например, 1), либо «-», чтобы оставить как есть:');
          return;
        }
        const capacity = capacityOf(before.scheduleId, before.date);
        // Свободные места с учётом этой же заявки (иначе её собственные места
        // посчитались бы как «занятые» и мешали бы увеличить их же количество)
        const freeIncludingThis = capacity - db.occupiedSeats(before.scheduleId, before.date) + before.seats;
        if (count > freeIncludingThis) {
          await ctx.reply(`Свободно только ${freeIncludingThis} мест(а) с учётом этой заявки. Введите меньше, либо «-»:`);
          return;
        }
        db.updateBooking(st.bookingId, { seats: count });
      }
      const b = db.getBooking(st.bookingId);
      const info = carInfo(b.scheduleId, b.date);
      session.clear(userId);
      await ctx.reply('✅ Изменения сохранены.', {
        attachments: [
          kb.adminTripDetailKeyboard(
            db.getActiveBookingsForTrip(b.scheduleId, b.date),
            b.scheduleId,
            b.date.replace(/-/g, ''),
            info && info.isExtra
          ),
        ],
      });
      return;
    }

    if (st.step === 'admin_sched_edittime') {
      if (!/^\d{1,2}:\d{2}$/.test(text)) {
        await ctx.reply('Формат времени: ЧЧ:ММ, например 07:15');
        return;
      }
      const updated = db.updateScheduleItem(st.scheduleId, { time: text });
      session.clear(userId);
      await ctx.reply('✅ Время рейса обновлено.', { attachments: [kb.scheduleItemKeyboard(updated)] });
      return;
    }

    if (st.step === 'admin_sched_add_time') {
      if (!/^\d{1,2}:\d{2}$/.test(text)) {
        await ctx.reply('Формат времени: ЧЧ:ММ, например 07:15');
        return;
      }
      db.addScheduleItem(st.direction, text, st.weekdays);
      session.clear(userId);
      await ctx.reply('✅ Рейс добавлен в расписание.', { attachments: [kb.scheduleListKeyboard(db.getSchedule())] });
      return;
    }

    if (st.step === 'admin_daycap_edit') {
      const cap = parseInt(text, 10);
      if (!Number.isInteger(cap) || cap < 1 || cap > 99) {
        await ctx.reply('Введите число мест (например, 4):');
        return;
      }
      const occupied = db.occupiedSeats(st.scheduleId, st.date);
      if (cap < occupied) {
        await ctx.reply(
          `❌ Сейчас уже занято ${occupied} мест(а) — меньше поставить нельзя. ` +
            `Сначала отмените лишние заявки, либо укажите число не меньше ${occupied}.`
        );
        return;
      }
      // Если ввели обычное число мест (MAX_SEATS) — просто снимаем исключение по местам
      db.setOverrideCapacity(st.date, st.scheduleId, cap === config.maxSeats ? null : cap);
      session.clear(userId);
      const info = carInfo(st.scheduleId, st.date);
      await ctx.reply(
        `✅ Число мест изменено только для ${fmt.formatDateRu(st.date)}: теперь ${info.capacity}.`,
        {
          attachments: [
            kb.adminTripDetailKeyboard(
              db.getActiveBookingsForTrip(st.scheduleId, st.date),
              st.scheduleId,
              st.date.replace(/-/g, ''),
              false
            ),
          ],
        }
      );
      refreshGroupBroadcastIfChanged(
        bot,
        st.date,
        freeTripsForBroadcast(st.date),
        buildGroupBroadcastText
      ).catch((e) => console.error('Не удалось обновить объявление в группе:', e));
      return;
    }

    if (st.step === 'admin_daytime_edit') {
      if (!/^\d{1,2}:\d{2}$/.test(text)) {
        await ctx.reply('Формат времени: ЧЧ:ММ, например 07:15');
        return;
      }
      db.setOverrideTime(st.date, st.scheduleId, text);
      session.clear(userId);
      await ctx.reply(
        `✅ Время изменено только для ${fmt.formatDateRu(st.date)}. На другие дни расписание не изменится.`,
        { attachments: [kb.restoreTripKeyboard(st.scheduleId, st.date.replace(/-/g, ''))] }
      );
      await showTripsForDate(ctx, st.date);
      return;
    }

    // --- Шаги добавления доп. машины ---
    if (st.step === 'admin_extracar_time') {
      if (!/^\d{1,2}:\d{2}$/.test(text)) {
        await ctx.reply('Формат времени: ЧЧ:ММ, например 16:50');
        return;
      }
      st.time = text;
      st.step = 'admin_extracar_capacity';
      session.set(userId, st);
      await ctx.reply('Сколько мест в этой машине?');
      return;
    }
    if (st.step === 'admin_extracar_capacity') {
      const cap = parseInt(text, 10);
      if (!Number.isInteger(cap) || cap < 1) {
        await ctx.reply('Введите число мест (например, 3):');
        return;
      }
      db.addExtraCar(st.date, st.direction, st.time, cap);
      session.clear(userId);
      await ctx.reply(`✅ Добавлена машина на ${st.time} (${cap} мест${cap > 1 ? 'а' : 'о'}).`);
      await showTripsForDate(ctx, st.date);
      refreshGroupBroadcastIfChanged(
        bot,
        st.date,
        freeTripsForBroadcast(st.date),
        buildGroupBroadcastText
      ).catch((e) => console.error('Не удалось обновить объявление в группе:', e));
      return;
    }

    // --- Изменение вместимости доп. машины ---
    if (st.step === 'admin_extracar_newcap') {
      const cap = parseInt(text, 10);
      if (!Number.isInteger(cap) || cap < 1) {
        await ctx.reply('Введите число мест (например, 2):');
        return;
      }
      const car = db.getExtraCar(st.carId);
      if (!car) {
        session.clear(userId);
        await ctx.reply('Эта машина уже удалена.');
        return;
      }
      const occupied = db.occupiedSeats(st.carId, car.date);
      if (cap < occupied) {
        await ctx.reply(
          `❌ Сейчас уже занято ${occupied} мест(а) — меньше поставить нельзя. ` +
            `Сначала отмените лишние заявки, либо укажите число не меньше ${occupied}.`
        );
        return;
      }
      const updated = db.updateExtraCar(st.carId, { capacity: cap });
      session.clear(userId);
      await ctx.reply(`✅ Вместимость обновлена: теперь ${updated.capacity} мест.`, {
        attachments: [
          kb.adminTripDetailKeyboard(
            db.getActiveBookingsForTrip(st.carId, updated.date),
            st.carId,
            updated.date.replace(/-/g, ''),
            true
          ),
        ],
      });
      refreshGroupBroadcastIfChanged(
        bot,
        updated.date,
        freeTripsForBroadcast(updated.date),
        buildGroupBroadcastText
      ).catch((e) => console.error('Не удалось обновить объявление в группе:', e));
      return;
    }

    if (typeof next === 'function') return next();
  });
}

module.exports = {
  registerAdminFlow,
  isWife,
  notifyAdmins,
  buildDriverText,
  buildGroupFreeSeatsText,
  freeTripsForBroadcast,
  buildGroupBroadcastText,
  sendRideConfirmRequests,
};
