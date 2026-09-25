// Автоматическая отправка водителю актуального списка пассажиров за N минут
// до отправления рейса — без нажатия каких-либо кнопок. Управляется переменной
// окружения DRIVER_AUTO_NOTIFY_MINUTES (0 или не задана — отключено).

const db = require('./store');
const config = require('./config');
const fmt = require('./format');
const { allTripsForDate } = require('./schedule');
const { buildDriverText } = require('./adminFlow');

// date здесь — результат fmt.nowYekb(), поэтому читаем через getUTC*-методы
// (см. комментарий у fmt.nowYekb() в src/format.js — обычные getHours/
// getMinutes завязаны на TZ процесса, который не всегда корректен на хостинге).
function minutesSinceMidnight(date) {
  return date.getUTCHours() * 60 + date.getUTCMinutes();
}

function timeStrToMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

// Проверяет рейсы на сегодня и, если до отправления осталось не больше
// DRIVER_AUTO_NOTIFY_MINUTES минут (и список этому рейсу ещё не отправлялся),
// шлёт водителю актуальный список пассажиров.
function checkAndNotify(bot) {
  const windowMinutes = config.driverAutoNotifyMinutes;
  if (!windowMinutes || windowMinutes <= 0) return; // функция выключена (0)
  if (!config.driverId) return; // некому отправлять

  const date = fmt.todayISO();
  const nowMinutes = minutesSinceMidnight(fmt.nowYekb());

  const trips = allTripsForDate(date);
  trips.forEach((t) => {
    const tripMinutes = timeStrToMinutes(t.time);
    const minutesUntil = tripMinutes - nowMinutes;
    // Рейс уже уехал — пропускаем; рейс дальше, чем окно оповещения — тоже пропускаем
    if (minutesUntil < 0 || minutesUntil > windowMinutes) return;
    if (db.wasAutoNotified(date, t.id)) return;

    const info = { direction: t.direction, time: t.time, isExtra: t.isExtra };
    const bookings = fmt.sortByVillageRoute(db.getActiveBookingsForTrip(t.id, date), t.direction);
    const text = `⏰ Автонапоминание: до рейса ${minutesUntil} мин.\n\n${buildDriverText(info, date, bookings)}`;

    bot.api
      .sendMessageToUser(config.driverId, text, { format: 'markdown' })
      .then(() => db.markAutoNotified(date, t.id))
      .catch((e) => console.error(`Не удалось отправить авто-список водителю (рейс ${t.id}):`, e));
  });
}

// Запускает периодическую проверку (раз в минуту) — этого достаточно для
// точности в пределах минуты. Плюс одна проверка сразу при старте бота —
// на случай, если бот перезапустился прямо перед самым рейсом.
function startDriverAutoNotify(bot) {
  if (!config.driverAutoNotifyMinutes || config.driverAutoNotifyMinutes <= 0) return;
  checkAndNotify(bot);
  setInterval(() => checkAndNotify(bot), 60 * 1000);
}

module.exports = { startDriverAutoNotify };
