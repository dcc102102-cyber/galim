require('dotenv').config();

// WIFE_USER_ID может содержать один ID или несколько через запятую —
// например: WIFE_USER_ID=111111,222222 — тогда доступ к панели администратора
// получат оба пользователя (жена и муж, например), и уведомления о новых
// заявках/посылках тоже придут обоим.
function parseIds(raw) {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number)
    .filter((n) => !Number.isNaN(n));
}

// DAILY_BROADCAST_TIME может содержать одно время или несколько через запятую —
// например: DAILY_BROADCAST_TIME=09:30,11:45,14:45,20:00 — тогда ежедневная
// автоматическая рассылка о свободных местах будет уходить в группу(ы) в каждое
// из этих времён (каждый раз отдельно за сегодня и отдельно за завтра).
function parseTimes(raw) {
  if (raw === undefined) return ['09:30']; // переменная не задана — время по умолчанию
  if (raw.trim() === '' || raw.trim().toLowerCase() === 'off') return []; // явно выключено
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((t) => /^([01]?\d|2[0-3]):[0-5]\d$/.test(t));
}

const adminIds = parseIds(process.env.WIFE_USER_ID);
// GROUP_CHAT_ID может содержать один ID группы или несколько через запятую —
// например: GROUP_CHAT_ID=-100111,-100222 — тогда все объявления и рассылки
// (ручные и автоматические) уходят сразу во все перечисленные группы.
const groupChatIds = parseIds(process.env.GROUP_CHAT_ID);

const config = {
  botToken: process.env.BOT_TOKEN,
  adminIds,
  // wifeId оставлен для обратной совместимости — это первый ID из списка
  wifeId: adminIds.length > 0 ? adminIds[0] : null,
  driverId: process.env.DRIVER_USER_ID ? Number(process.env.DRIVER_USER_ID) : null,
  maxSeats: process.env.MAX_SEATS ? Number(process.env.MAX_SEATS) : 6,
  // За сколько минут до рейса водителю автоматически присылать актуальный список
  // пассажиров, без ручного нажатия кнопки. 0 (или переменная не задана) — отключено.
  driverAutoNotifyMinutes: process.env.DRIVER_AUTO_NOTIFY_MINUTES
    ? Number(process.env.DRIVER_AUTO_NOTIFY_MINUTES)
    : 0,
  // За сколько минут до рейса автоматически спрашивать у пассажиров "точно едете?"
  // (то же самое, что кнопка «Запросить подтверждение» в детали рейса, только сама,
  // без нажатия). 0 (или переменная не задана) — отключено по умолчанию.
  // Включать/выключать на лету (без перезапуска бота) можно ещё и тумблером в
  // главном меню админки — см. db.isRideConfirmAutoEnabled()/setRideConfirmAutoEnabled().
  rideConfirmAutoMinutes: process.env.RIDE_CONFIRM_AUTO_MINUTES
    ? Number(process.env.RIDE_CONFIRM_AUTO_MINUTES)
    : 0,
  // Исключение для самых ранних рейсов (по умолчанию 06:30 и 07:30): спрашивать
  // "точно едете?" не за N минут до отправления (среди ночи это неуместно), а
  // заранее, вечером ПРЕДЫДУЩЕГО дня — см. RIDE_CONFIRM_EVENING_BEFORE_ASK_TIME
  // ниже. RIDE_CONFIRM_EVENING_BEFORE_TIMES=off отключает это исключение (тогда
  // такие рейсы снова считаются по общему окну RIDE_CONFIRM_AUTO_MINUTES).
  rideConfirmEveningBeforeTimes:
    process.env.RIDE_CONFIRM_EVENING_BEFORE_TIMES === undefined
      ? ['06:30', '07:30']
      : parseTimes(process.env.RIDE_CONFIRM_EVENING_BEFORE_TIMES),
  // Во сколько вечером предыдущего дня спрашивать про рейсы из списка выше.
  rideConfirmEveningBeforeAskTime:
    process.env.RIDE_CONFIRM_EVENING_BEFORE_ASK_TIME &&
    /^([01]?\d|2[0-3]):[0-5]\d$/.test(process.env.RIDE_CONFIRM_EVENING_BEFORE_ASK_TIME.trim())
      ? process.env.RIDE_CONFIRM_EVENING_BEFORE_ASK_TIME.trim()
      : '21:00',
  // ID групповых чатов MAX, куда бот шлёт объявления о свободных местах (вручную
  // кнопкой из админ-панели и автоматически) — один или несколько через запятую в
  // GROUP_CHAT_ID. Узнать ID конкретной группы можно, написав в ней команду /groupid
  // (бот должен уже быть добавлен в группу).
  groupChatIds,
  // Оставлено для обратной совместимости — первая группа из списка.
  groupChatId: groupChatIds.length > 0 ? groupChatIds[0] : null,
  // За сколько минут до рейса автоматически слать в группу объявление о свободных
  // местах (если они ещё есть). 0 (или переменная не задана) — автоотправка выключена,
  // но ручная отправка кнопкой из админ-панели работает независимо от этой настройки.
  groupAutoNotifyMinutes: process.env.GROUP_AUTO_NOTIFY_MINUTES
    ? Number(process.env.GROUP_AUTO_NOTIFY_MINUTES)
    : 0,
  // Минимальное число свободных мест, при котором автоотправка в группу срабатывает —
  // чтобы не слать объявление, если осталось, например, ровно одно место, а хочется
  // объявлять только когда свободно от 2 и больше. По умолчанию — от 1 места.
  groupNotifyMinFreeSeats: process.env.GROUP_NOTIFY_MIN_FREE_SEATS
    ? Number(process.env.GROUP_NOTIFY_MIN_FREE_SEATS)
    : 1,
  // Время(-а) (ЧЧ:ММ, по местному часовому поясу Asia/Yekaterinburg), в которые бот
  // сам, без нажатия кнопок, шлёт в группу(ы) рассылку о свободных местах — сначала
  // за сегодня, отдельным сообщением за завтра. Одно время или несколько через
  // запятую в DAILY_BROADCAST_TIME, например: DAILY_BROADCAST_TIME=09:30,11:45,14:45,20:00.
  // Чтобы отключить автоматику полностью и оставить только ручную кнопку «Рассылка
  // о местах» — задайте DAILY_BROADCAST_TIME=off. По умолчанию — только 09:30.
  dailyBroadcastTimes: parseTimes(process.env.DAILY_BROADCAST_TIME),
  // Ключ для внутреннего API (см. internalApi.js) — им пользуется ВК-версия бота
  // (vk-bot/), чтобы читать расписание и создавать заявки в ТОЙ ЖЕ базе, что и
  // MAX-бот, не имея прямого доступа к файлу data.db (два бота на bothost.ru —
  // это два изолированных процесса без общего диска). Один и тот же секрет
  // должен быть прописан в .env у обоих ботов как INTERNAL_API_KEY. Если не
  // задан — внутреннее API полностью отключено (см. internalApi.js).
  internalApiKey: process.env.INTERNAL_API_KEY || null,
};

if (!config.botToken) {
  console.error('ОШИБКА: не задан BOT_TOKEN в .env — бот не сможет запуститься.');
}

module.exports = config;
