// Общие функции для отправки сообщений в группы (GROUP_CHAT_ID — одна или
// несколько через запятую, см. config.js), в том числе с заменой устаревших
// объявлений о свободных местах на актуальные, чтобы в группе не копились
// вчерашние/неактуальные объявления, где какое-то время уже заполнилось.
//
// ВАЖНО: методы bot.api.deleteMessage(messageId) и извлечение id отправленного
// сообщения из ответа sendMessageToChat подобраны по документации MAX Bot API
// и другим официальным клиентам (PHP/Python/Go), но не проверялись вживую с
// именно этой версией @maxhub/max-bot-api. Если удаление/дедупликация не
// сработает — само сообщение всё равно уйдёт (см. try/catch ниже), просто
// старое объявление останется висеть рядом с новым. Стоит проверить в реальной
// группе и, если понадобится, прислать логи — поправим извлечение id.

const db = require('./store');
const config = require('./config');
const fmt = require('./format');

// Возвращает Promise, который выполняется после того, как отправка была
// предпринята во все группы — ошибка при отправке в одну из групп не мешает
// отправить в остальные (просто попадёт в консоль).
function sendToAllGroups(bot, text) {
  return Promise.all(
    config.groupChatIds.map((chatId) =>
      bot.api
        .sendMessageToChat(chatId, text)
        .catch((e) => console.error(`Не удалось отправить сообщение в группу ${chatId}:`, e))
    )
  );
}

// Пытается вытащить id отправленного сообщения из ответа sendMessageToChat —
// разные версии/обёртки API отдают его в разных полях, поэтому проверяем
// несколько вариантов. Если не нашли — логируем сырой ответ целиком, чтобы по
// логам можно было увидеть реальную структуру и поправить этот список путей.
function extractMessageId(res) {
  if (!res) return null;
  const id =
    (res.message && res.message.body && res.message.body.mid) ||
    (res.body && res.body.mid) ||
    res.mid ||
    res.message_id ||
    (res.message && res.message.message_id) ||
    null;
  if (!id) {
    console.error('[groupUtil] Не удалось найти id сообщения в ответе sendMessageToChat:', JSON.stringify(res));
  }
  return id;
}

// Отпечаток набора рейсов со свободными местами — используется, чтобы понять,
// изменился ли список с момента последней публикации (кто-то занял/освободил
// последнее место), и стоит ли обновлять уже висящее в группе объявление.
function tripsSignature(trips) {
  return trips
    .map((t) => `${t.direction}|${t.time}`)
    .sort()
    .join(',');
}

// Публикует комбинированное объявление о свободных местах за дату во всех
// группах: если в конкретной группе уже висит предыдущее объявление за эту же
// дату — сначала удаляет его, и только потом отправляет новое. Так в группе
// всегда только одно, актуальное объявление за день, а не пачка старых.
async function publishGroupBroadcast(bot, date, text, trips) {
  const signature = tripsSignature(trips);
  await Promise.all(
    config.groupChatIds.map(async (chatId) => {
      const prev = db.getGroupBroadcastMessage(chatId, date);
      if (prev) {
        console.log(`[groupUtil] Удаляю предыдущее объявление ${prev.messageId} в группе ${chatId} за ${date}`);
        try {
          await bot.api.deleteMessage(prev.messageId);
          console.log(`[groupUtil] Удалено успешно: ${prev.messageId}`);
        } catch (e) {
          console.error(`Не удалось удалить старое объявление в группе ${chatId} за ${date}:`, e);
        }
        db.clearGroupBroadcastMessage(chatId, date);
      } else {
        console.log(`[groupUtil] Предыдущего объявления за ${date} в группе ${chatId} не найдено (нечего удалять)`);
      }
      try {
        const res = await bot.api.sendMessageToChat(chatId, text);
        const messageId = extractMessageId(res);
        if (messageId) {
          console.log(`[groupUtil] Новое объявление отправлено, id=${messageId} (группа ${chatId}, дата ${date})`);
          db.setGroupBroadcastMessage(chatId, date, messageId, signature);
        }
      } catch (e) {
        console.error(`Не удалось отправить сообщение в группу ${chatId}:`, e);
      }
    })
  );
}

// Вызывается после любого события, которое могло изменить число свободных
// мест на дату (новая заявка, отмена, восстановление) — если в группах уже
// висит "живое" объявление за эту дату и список рейсов со свободными местами
// с тех пор изменился (например, какое-то время заполнилось или освободилось),
// сразу обновляет объявление, не дожидаясь следующей плановой рассылки.
// Если живых объявлений за эту дату нет — ничего не делает (не создаёт новых
// объявлений сама, только актуализирует уже существующие).
async function refreshGroupBroadcastIfChanged(bot, date, trips, buildText) {
  const anyLive = config.groupChatIds.some((chatId) => db.getGroupBroadcastMessage(chatId, date));
  if (!anyLive) return;

  const signature = tripsSignature(trips);
  const changed = config.groupChatIds.some((chatId) => {
    const prev = db.getGroupBroadcastMessage(chatId, date);
    return prev && prev.signature !== signature;
  });
  if (!changed) return;

  if (trips.length === 0) {
    // Свободных мест по этой дате больше нигде нет — просто убираем
    // объявления, слать новое (пустое) незачем.
    await Promise.all(
      config.groupChatIds.map(async (chatId) => {
        const prev = db.getGroupBroadcastMessage(chatId, date);
        if (!prev) return;
        try {
          await bot.api.deleteMessage(prev.messageId);
        } catch (e) {
          console.error(`Не удалось удалить объявление в группе ${chatId} за ${date}:`, e);
        }
        db.clearGroupBroadcastMessage(chatId, date);
      })
    );
    return;
  }

  const text = buildText(date, trips);
  await publishGroupBroadcast(bot, date, text, trips);
}

// Убирает из групп объявления о свободных местах, оставшиеся от прошедших дат
// (вчера и раньше) — например, чтобы вчерашняя автоматическая рассылка не
// висела в группе после того, как её актуальность прошла. Вызывается регулярно
// (см. dailyBroadcastAutoNotify.js), а не только когда приходит новое
// объявление за ту же дату — иначе объявление за прошедший день, для которой
// новых рассылок больше не будет, никогда бы не удалилось.
async function cleanupExpiredGroupBroadcasts(bot) {
  const today = fmt.todayISO();
  const tomorrow = fmt.tomorrowISO();
  const stale = db.getAllGroupBroadcastMessages().filter((m) => m.date !== today && m.date !== tomorrow);
  if (stale.length > 0) {
    console.log(`[groupUtil] Найдено просроченных объявлений для чистки: ${stale.length}`);
  }
  await Promise.all(
    stale.map(async (m) => {
      try {
        await bot.api.deleteMessage(m.messageId);
        console.log(`[groupUtil] Просроченное объявление ${m.messageId} (группа ${m.chatId}, дата ${m.date}) удалено`);
      } catch (e) {
        console.error(`Не удалось удалить просроченное объявление в группе ${m.chatId} за ${m.date}:`, e);
      }
      db.clearGroupBroadcastMessage(m.chatId, m.date);
    })
  );
}

module.exports = {
  sendToAllGroups,
  publishGroupBroadcast,
  refreshGroupBroadcastIfChanged,
  cleanupExpiredGroupBroadcasts,
};
