// ВАЖНО ДЛЯ РАЗРАБОТЧИКА, КТО БУДЕТ ДОРАБАТЫВАТЬ БОТА:
// Библиотека @maxhub/max-bot-api документирована довольно скупо, и точные названия
// полей у ctx (объект контекста обновления) не везде подтверждены официальными
// примерами. Поэтому все обращения к «сырым» полям ctx собраны в одном месте — здесь.
// Если после запуска бота какое-то поле не найдётся (userId/chatId будут undefined),
// достаточно поправить ТОЛЬКО этот файл — остальной код бота трогать не придётся.
//
// Как отладить: раскомментируйте строку с console.log(JSON.stringify(...)) в index.js
// в обработчике bot.on('message_created', ...), напишите боту любое сообщение и
// посмотрите в консоли реальную структуру объекта — тогда поправьте функции ниже.

const fmt = require('./format');

function getUserId(ctx) {
  return (
    ctx.user?.userId ??
    ctx.user?.user_id ??
    ctx.message?.sender?.userId ??
    ctx.message?.sender?.user_id ??
    ctx.update?.message?.sender?.user_id ??
    ctx.update?.user?.user_id ??
    null
  );
}

function getChatId(ctx) {
  return (
    ctx.chat?.chatId ??
    ctx.chat?.chat_id ??
    ctx.message?.recipient?.chatId ??
    ctx.message?.recipient?.chat_id ??
    ctx.update?.message?.recipient?.chat_id ??
    getUserId(ctx) // в личных чатах chatId часто совпадает с userId получателя
  );
}

function getText(ctx) {
  return ctx.message?.body?.text ?? ctx.update?.message?.body?.text ?? ctx.text ?? '';
}

function getUserName(ctx) {
  return (
    ctx.user?.name ??
    ctx.message?.sender?.name ??
    ctx.update?.message?.sender?.name ??
    'Пассажир'
  );
}

// Достаём хвост payload после известного префикса, например для payload
// "a:conf:b12" и префикса "a:conf:" вернёт "b12".
function payloadTail(payload, prefix) {
  return payload.startsWith(prefix) ? payload.slice(prefix.length) : null;
}

// Достаём имя и телефон из вложения-контакта, которое MAX присылает после
// нажатия кнопки «Отправить номер» (request_contact): message_created с
// attachments: [{ type: 'contact', payload: { vcf_info: '...vCard...' } }],
// текст сообщения при этом обычно пустой. Как и остальные поля ctx выше,
// путь к attachments подтверждён официальными примерами лишь частично —
// если контакт не распознаётся, проверьте здесь реальную структуру ctx.
function getContactFromMessage(ctx) {
  const attachments =
    ctx.message?.body?.attachments ?? ctx.update?.message?.body?.attachments ?? null;
  if (!Array.isArray(attachments)) return null;
  const contactAttachment = attachments.find((a) => a?.type === 'contact');
  if (!contactAttachment?.payload) return null;
  return fmt.parseVcfContact(contactAttachment.payload.vcf_info);
}

module.exports = { getUserId, getChatId, getText, getUserName, payloadTail, getContactFromMessage };
