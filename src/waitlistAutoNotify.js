// Фоновая проверка листа ожидания: раз в минуту смотрим, не появилось ли
// свободных мест на рейсы, где кто-то стоит в очереди («Сообщить, когда
// освободится место» — см. b:waitlist в passengerFlow.js), и если да — сразу
// пишем каждому из очереди на этот рейс.
//
// Обрабатываются здесь только записи с platform === 'max' — они дадут знать
// пользователю через bot.api.sendMessageToUser напрямую. Записи с platform
// === 'vk' у этого бота нет прав отправить (это другой токен/процесс) —
// их забирает и уведомляет сама ВК-версия, опрашивая внутреннее API (см.
// GET /api/waitlist/vk-pending в internalApi.js и vk_bot/waitlist.js).

const db = require('./store');
const fmt = require('./format');
const { carInfo } = require('./schedule');

function checkAndNotify(bot) {
  const trips = db.getWaitlistTrips();
  trips.forEach(({ scheduleId, date }) => {
    const item = carInfo(scheduleId, date);
    if (!item) {
      // Рейса больше не существует (например, удалили доп. машину) — очередь
      // на него уже не имеет смысла держать.
      db.clearWaitlistForTrip(scheduleId, date);
      return;
    }
    const free = item.capacity - db.occupiedSeats(scheduleId, date);
    if (free <= 0) return; // мест всё ещё нет — ждём дальше

    const entries = db.getWaitlistForTrip(scheduleId, date).filter((e) => e.platform === 'max');
    entries.forEach((entry) => {
      const text =
        `🎉 ${fmt.bold('Освободилось место!')}\n\n` +
        `🚌 ${fmt.bold(fmt.directionLabel(item.direction))}\n` +
        `📅 ${fmt.bold(fmt.formatDateRu(date))}\n` +
        `🕡 ${fmt.bold(item.time)}\n\n` +
        `Успейте записаться, пока место снова не заняли — нажмите «Записаться на поездку» в главном меню.`;
      bot.api
        .sendMessageToUser(Number(entry.userId), text, { format: 'markdown' })
        .then(() => db.removeWaitlistEntry(entry.id))
        .catch((e) => console.error(`[waitlist] Не удалось уведомить ${entry.userId}:`, e));
    });
  });
}

function startWaitlistAutoNotify(bot) {
  checkAndNotify(bot);
  setInterval(() => checkAndNotify(bot), 60 * 1000);
}

module.exports = { startWaitlistAutoNotify };
