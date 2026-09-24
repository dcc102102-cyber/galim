// Автоматический запрос "точно едете?" пассажирам за N минут до рейса — то же
// самое, что ручная кнопка «Запросить подтверждение» в детали рейса (см.
// sendRideConfirmRequests в adminFlow.js), только без нажатия, по расписанию.
//
// Исключение: для самых ранних рейсов (по умолчанию 06:30 и 07:30,
// RIDE_CONFIRM_EVENING_BEFORE_TIMES) вопрос шлётся не в само утро, а заранее,
// вечером ПРЕДЫДУЩЕГО дня (по умолчанию в 21:00, RIDE_CONFIRM_EVENING_BEFORE_ASK_TIME) —
// иначе пришлось бы будить человека уведомлением среди ночи.
//
// Включается переменной окружения RIDE_CONFIRM_AUTO_MINUTES (за сколько минут
// до рейса спрашивать; 0 или не задана — функции нет вообще). Дополнительно
// есть тумблер в главном меню админки (db.isRideConfirmAutoEnabled()) — им
// можно поставить автоматику на паузу на лету, не трогая .env и не
// перезапуская бота.

const db = require('./store');
const config = require('./config');
const fmt = require('./format');
const { allTripsForDate } = require('./schedule');
const { sendRideConfirmRequests } = require('./adminFlow');

// см. комментарий у driverAutoNotify.js — fmt.nowYekb() отдаёт время как UTC-поля,
// поэтому здесь тоже читаем через getUTC*, а не через локальные getHours/getMinutes.
function minutesSinceMidnight(date) {
  return date.getUTCHours() * 60 + date.getUTCMinutes();
}

function timeStrToMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function checkAndNotify(bot) {
  const windowMinutes = config.rideConfirmAutoMinutes;
  if (!windowMinutes || windowMinutes <= 0) return; // выключено переменной окружения
  if (!db.isRideConfirmAutoEnabled()) return; // на паузе тумблером в админке

  const today = fmt.todayISO();
  const nowMinutes = minutesSinceMidnight(fmt.nowYekb());
  const eveningTimes = config.rideConfirmEveningBeforeTimes;

  askForDate(bot, today, nowMinutes, windowMinutes, eveningTimes);

  // Рейсы из "ранних" времён (по умолчанию 06:30 и 07:30) считаются не по
  // общему окну (иначе пришлось бы будить человека уведомлением среди ночи),
  // а заранее, вечером сегодняшнего дня — про рейсы ЗАВТРАШНЕГО утра.
  if (eveningTimes.length > 0) {
    const askMinutes = timeStrToMinutes(config.rideConfirmEveningBeforeAskTime);
    if (nowMinutes >= askMinutes) {
      const tomorrow = fmt.tomorrowISO();
      allTripsForDate(tomorrow)
        .filter((t) => eveningTimes.includes(t.time))
        .forEach((t) => askOneTrip(bot, tomorrow, t));
    }
  }
}

// Общая логика на один рейс: если ещё не спрашивали (и есть кого спрашивать) —
// шлёт вопрос и помечает рейс отправленным. Ключ дедупликации ("rc_" + id
// рейса) в той же таблице auto_notified, что и у driverAutoNotify.js, но со
// своим префиксом — иначе совпадение (date, carId) с уведомлением водителя
// заставило бы эту проверку решить, что пассажирам уже писали, хотя это не так.
function askOneTrip(bot, date, t) {
  const dedupKey = `rc_${t.id}`;
  if (db.wasAutoNotified(date, dedupKey)) return;
  const info = { direction: t.direction, time: t.time, isExtra: t.isExtra };
  const { askable } = sendRideConfirmRequests(bot, t.id, date, info);
  if (askable.length > 0) {
    db.markAutoNotified(date, dedupKey);
  }
  // Если спрашивать было не у кого (пусто или все записаны вручную) — ключ НЕ
  // помечаем как отправленный: вдруг кто-то запишется через бота позже, но ещё
  // успеет попасть в окно оповещения на следующей минутной проверке.
}

// Обычная логика "за N минут до рейса" — только для рейсов СЕГОДНЯ и только
// для тех времён, что не входят в "вечерний" список исключений выше (те
// обрабатываются отдельно, см. checkAndNotify).
function askForDate(bot, date, nowMinutes, windowMinutes, eveningTimes) {
  allTripsForDate(date)
    .filter((t) => !eveningTimes.includes(t.time))
    .forEach((t) => {
      const tripMinutes = timeStrToMinutes(t.time);
      const minutesUntil = tripMinutes - nowMinutes;
      // Рейс уже уехал — пропускаем; рейс дальше, чем окно оповещения — тоже пропускаем.
      if (minutesUntil < 0 || minutesUntil > windowMinutes) return;
      askOneTrip(bot, date, t);
    });
}

// Запускает периодическую проверку (раз в минуту), плюс одна проверка сразу при
// старте бота — на случай, если бот перезапустился прямо перед самым рейсом.
function startRideConfirmAutoNotify(bot) {
  if (!config.rideConfirmAutoMinutes || config.rideConfirmAutoMinutes <= 0) return;
  checkAndNotify(bot);
  setInterval(() => checkAndNotify(bot), 60 * 1000);
}

module.exports = { startRideConfirmAutoNotify };
