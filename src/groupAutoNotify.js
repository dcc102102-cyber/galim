// Автоматическая отправка в группу объявления о свободных местах за N минут до
// отправления рейса — без нажатия каких-либо кнопок (аналогично driverAutoNotify.js,
// но шлёт не список пассажиров водителю, а публичное объявление в общий чат).
// Управляется переменной окружения GROUP_AUTO_NOTIFY_MINUTES (0 или не задана —
// отключено) и GROUP_CHAT_ID (куда слать). Ручная отправка кнопкой из админ-панели
// (a:notifygroup / a:notifygroupok в adminFlow.js) работает независимо от этой
// автоматики и её не заменяет.

const db = require('./store');
const config = require('./config');
const fmt = require('./format');
const { allTripsForDate } = require('./schedule');
const { buildGroupFreeSeatsText } = require('./adminFlow');
const { sendToAllGroups } = require('./groupUtil');

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
// GROUP_AUTO_NOTIFY_MINUTES минут, на рейсе ещё есть свободные места (не меньше
// GROUP_NOTIFY_MIN_FREE_SEATS) и объявление по этому рейсу ещё не отправлялось —
// шлёт объявление в группу.
function checkAndNotify(bot) {
  const windowMinutes = config.groupAutoNotifyMinutes;
  if (!windowMinutes || windowMinutes <= 0) return; // функция выключена (0)
  if (!config.groupChatIds.length) return; // некуда отправлять

  const date = fmt.todayISO();
  const nowMinutes = minutesSinceMidnight(fmt.nowYekb());

  const trips = allTripsForDate(date);
  trips.forEach((t) => {
    const tripMinutes = timeStrToMinutes(t.time);
    const minutesUntil = tripMinutes - nowMinutes;
    // Рейс уже уехал — пропускаем; рейс дальше, чем окно оповещения — тоже пропускаем
    if (minutesUntil < 0 || minutesUntil > windowMinutes) return;
    if (db.wasGroupNotified(date, t.id)) return;
    if (t.free < config.groupNotifyMinFreeSeats) return; // мест мало/нет — объявлять нечего

    const info = { direction: t.direction, time: t.time, capacity: t.max, isExtra: t.isExtra };
    const text = buildGroupFreeSeatsText(info, date, t.free);

    sendToAllGroups(bot, text).then(() => db.markGroupNotified(date, t.id));
  });
}

// Запускает периодическую проверку (раз в минуту) — этого достаточно для
// точности в пределах минуты. Плюс одна проверка сразу при старте бота —
// на случай, если бот перезапустился прямо перед самым рейсом.
function startGroupAutoNotify(bot) {
  if (!config.groupAutoNotifyMinutes || config.groupAutoNotifyMinutes <= 0) return;
  checkAndNotify(bot);
  setInterval(() => checkAndNotify(bot), 60 * 1000);
}

module.exports = { startGroupAutoNotify };
