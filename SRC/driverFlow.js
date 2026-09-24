const db = require('./store');
const config = require('./config');
const kb = require('./keyboards');
const fmt = require('./format');
const { allTripsForDate, carInfo } = require('./schedule');
const { getUserId, getText } = require('./ctxHelpers');
const session = require('./session');

function isDriver(ctx) {
  return config.driverId && getUserId(ctx) === config.driverId;
}

function guardDriver(handler) {
  return async (ctx) => {
    if (!isDriver(ctx)) {
      await ctx.reply('Этот раздел доступен только водителю.');
      return;
    }
    return handler(ctx);
  };
}

function registerDriverFlow(bot) {
  bot.command('driver', guardDriver(async (ctx) => {
    await ctx.reply('Панель водителя. Выберите день:', { attachments: [kb.driverDayKeyboard()] });
  }));

  bot.action('d:menu', guardDriver(async (ctx) => {
    await ctx.reply('Выберите день:', { attachments: [kb.driverDayKeyboard()] });
  }));

  bot.action(/^d:day:(\d{8}|other)$/, guardDriver(async (ctx) => {
    const choice = ctx.match[1];
    if (choice === 'other') {
      session.set(getUserId(ctx), { step: 'driver_awaiting_date' });
      await ctx.reply('Введите дату в формате ДД.ММ.ГГГГ:');
      return;
    }
    const date = `${choice.slice(0, 4)}-${choice.slice(4, 6)}-${choice.slice(6, 8)}`;
    const trips = allTripsForDate(date).filter((t) => t.occupied > 0 || db.getBookingsForTrip(t.id, date).some((b) => b.status !== 'cancelled'));
    if (trips.length === 0) {
      await ctx.reply('На этот день пока нет пассажиров.');
      return;
    }
    await ctx.reply(`Рейсы на ${fmt.formatDateRu(date)}:`, {
      attachments: [kb.driverTripListKeyboard(trips, date.replace(/-/g, ''))],
    });
  }));

  bot.on('message_created', async (ctx, next) => {
    if (!isDriver(ctx)) {
      if (typeof next === 'function') return next();
      return;
    }
    const userId = getUserId(ctx);
    const st = session.get(userId);
    const text = getText(ctx).trim();
    if (!st || st.step !== 'driver_awaiting_date' || !text) {
      if (typeof next === 'function') return next();
      return;
    }
    const date = fmt.parseRuDate(text);
    if (!date) {
      await ctx.reply('Не удалось распознать дату. Формат: ДД.ММ.ГГГГ');
      return;
    }
    session.clear(userId);
    const trips = allTripsForDate(date).filter((t) => t.occupied > 0 || db.getBookingsForTrip(t.id, date).some((b) => b.status !== 'cancelled'));
    if (trips.length === 0) {
      await ctx.reply('На этот день пока нет пассажиров.');
      return;
    }
    await ctx.reply(`Рейсы на ${fmt.formatDateRu(date)}:`, {
      attachments: [kb.driverTripListKeyboard(trips, date.replace(/-/g, ''))],
    });
  });

  bot.action(/^d:back:(\d{8})$/, guardDriver(async (ctx) => {
    const dateCompact = ctx.match[1];
    const date = `${dateCompact.slice(0, 4)}-${dateCompact.slice(4, 6)}-${dateCompact.slice(6, 8)}`;
    const trips = allTripsForDate(date).filter((t) => t.occupied > 0 || db.getBookingsForTrip(t.id, date).some((b) => b.status !== 'cancelled'));
    if (trips.length === 0) {
      await ctx.reply('На этот день пока нет пассажиров.');
      return;
    }
    await ctx.reply(`Рейсы на ${fmt.formatDateRu(date)}:`, {
      attachments: [kb.driverTripListKeyboard(trips, dateCompact)],
    });
  }));

  bot.action(/^d:trip:(s\d+|x\d+):(\d{8})$/, guardDriver(async (ctx) => {
    const carId = ctx.match[1];
    const dateCompact = ctx.match[2];
    const date = `${dateCompact.slice(0, 4)}-${dateCompact.slice(4, 6)}-${dateCompact.slice(6, 8)}`;
    const item = carInfo(carId, date);
    if (!item) {
      await ctx.reply('Эта машина больше недоступна.');
      return;
    }
    const all = fmt.sortByVillageRoute(db.getActiveBookingsForTrip(carId, date), item.direction);
    const passengers = all.filter((b) => b.kind !== 'parcel');
    const parcels = all.filter((b) => b.kind === 'parcel');
    let text = `${fmt.directionLabel(item.direction)}${item.isExtra ? ' 🚐 (доп. машина)' : ''}\n${fmt.formatDateRu(date)} — ${item.time}\n\n👥 Пассажиры:\n\n`;
    if (passengers.length === 0) {
      text += 'Пока никто не записан.\n';
    } else {
      passengers.forEach((b, i) => {
        const place = b.village ? ` (${b.village}${b.address ? `, ${b.address}` : ''})` : '';
        const seats = ` — ${b.seats} мест${b.seats > 1 ? 'а' : 'о'}`;
        const note = b.note ? `\n   📝 ${b.note}` : '';
        text += `${i + 1}. ${b.name} — ${b.phone}${seats}${place}${note}\n`;
      });
    }
    if (parcels.length > 0) {
      text += '\n📦 Посылки:\n\n';
      parcels.forEach((b, i) => {
        const place = b.village ? ` (${b.village}${b.address ? `, ${b.address}` : ''})` : '';
        text += `${i + 1}. ${b.name} — ${b.phone}${place}\n`;
      });
    }
    await ctx.reply(text, { attachments: [kb.driverTripBackKeyboard(dateCompact)] });
  }));
}

module.exports = { registerDriverFlow, isDriver };
