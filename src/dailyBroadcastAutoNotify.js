// Автоматическая ежедневная рассылка в группу(ы) о свободных местах — заменяет
// то, что жена раньше делала вручную несколько раз в день: сначала отдельным
// сообщением за сегодня, затем отдельным сообщением за завтра. Управляется
// переменной окружения DAILY_BROADCAST_TIME (одно время ЧЧ:ММ или несколько через
// запятую, например 09:30,11:45,14:45,20:00; значение "off" отключает автоматику)
// и уже существующей GROUP_CHAT_ID (тоже может быть несколько групп через запятую).
// Ручная кнопка «📢 Рассылка о местах» в админ-панели работает независимо от этой
// автоматики и её не заменяет.

const db = require('./store');
const config = require('./config');
const fmt = require('./format');
const { freeTripsForBroadcast, buildGroupBroadcastText } = require('./adminFlow');
const { publishGroupBroadcast, cleanupExpiredGroupBroadcasts } = require('./groupUtil');

// Отправляет отдельным сообщением рассылку за одну дату (если на неё есть
// рейсы со свободными местами) и помечает её отправленной под ключом key —
// чтобы разные времена (09:30/11:45/...) и «сегодня»/«завтра» в рамках одного
// дня не путались друг с другом и не дублировались при перезапуске бота.
function sendOneDay(bot, triggerDate, key, date) {
  const trips = freeTripsForBroadcast(date);
  if (trips.length === 0) {
    db.markDailyBroadcastSent(triggerDate, key);
    return;
  }
  const text = buildGroupBroadcastText(date, trips);
  publishGroupBroadcast(bot, date, text, trips).then(() => {
    trips.forEach((t) => db.markGroupNotified(date, t.id));
    db.markDailyBroadcastSent(triggerDate, key);
  });
}

function checkAndNotify(bot) {
  // Чистка просроченных объявлений не зависит от того, включена ли сама
  // ежедневная авторассылка по времени — объявления в группах могли появиться
  // и от ручной кнопки «Рассылка о местах».
  cleanupExpiredGroupBroadcasts(bot).catch((e) => console.error('Не удалось убрать просроченные объявления:', e));

  if (config.dailyBroadcastTimes.length === 0) return; // автоматика выключена (DAILY_BROADCAST_TIME=off)
  if (config.groupChatIds.length === 0) return; // некуда отправлять

  const time = fmt.nowHM();
  if (!config.dailyBroadcastTimes.includes(time)) return;

  const triggerDate = fmt.todayISO();
  if (!db.wasDailyBroadcastSent(triggerDate, `${time}|today`)) {
    sendOneDay(bot, triggerDate, `${time}|today`, fmt.todayISO());
  }
  if (!db.wasDailyBroadcastSent(triggerDate, `${time}|tomorrow`)) {
    sendOneDay(bot, triggerDate, `${time}|tomorrow`, fmt.tomorrowISO());
  }
}

// Запускает периодическую проверку (раз в минуту) — этого достаточно для
// точности в пределах минуты. Работает, даже если сама ежедневная рассылка по
// времени выключена (DAILY_BROADCAST_TIME=off) — раз в минуту всё равно нужно
// чистить просроченные объявления, оставшиеся от ручных рассылок.
function startDailyBroadcastAutoNotify(bot) {
  if (config.groupChatIds.length === 0) return; // групп не настроено — нечего слать и нечего чистить
  checkAndNotify(bot);
  setInterval(() => checkAndNotify(bot), 60 * 1000);
}

module.exports = { startDailyBroadcastAutoNotify };
