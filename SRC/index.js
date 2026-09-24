// Жёстко закрепляем часовой пояс Уфы/Башкортостана (UTC+5) для ВСЕГО процесса —
// независимо от того, в каком часовом поясе на самом деле работает сервер (на
// телефоне это неважно, но на облачном хостинге контейнер часто по умолчанию
// в UTC, из-за чего "сегодня"/"завтра" в расписании съезжали на день).
// Это должно стоять раньше любых вычислений с датами, поэтому — самая первая строка.
process.env.TZ = 'Asia/Yekaterinburg';

const { Bot } = require('@maxhub/max-bot-api');
const http = require('http');

const config = require('./config');
const kb = require('./keyboards');
const session = require('./session');
const { getUserId, getUserName, getChatId } = require('./ctxHelpers');
const { registerPassengerFlow } = require('./passengerFlow');
const { registerParcelFlow } = require('./parcelFlow');
const { registerAdminFlow, isWife } = require('./adminFlow');
const { registerDriverFlow, isDriver } = require('./driverFlow');
const { startDriverAutoNotify } = require('./driverAutoNotify');
const { startGroupAutoNotify } = require('./groupAutoNotify');
const { startDailyBroadcastAutoNotify } = require('./dailyBroadcastAutoNotify');
const { startWaitlistAutoNotify } = require('./waitlistAutoNotify');
const { startRideConfirmAutoNotify } = require('./rideConfirmAutoNotify');
const { handleInternalApiRequest } = require('./internalApi');

if (!config.botToken) {
  console.error('Не задан BOT_TOKEN — проверьте файл .env. Останавливаюсь.');
  process.exit(1);
}

const bot = new Bot(config.botToken);

// --- Общий экран приветствия — используется и для /start, и для нативной
// кнопки «Начать», которую MAX сам показывает при первом открытии чата с ботом.
async function showWelcome(ctx) {
  if (isWife(ctx)) {
    await ctx.reply(
      'Здравствуйте! Вы вошли как администратор.\nВыберите действие:',
      { attachments: [kb.adminEntryKeyboard()] }
    );
    return;
  }
  if (isDriver(ctx)) {
    await ctx.reply(
      'Здравствуйте! Вы вошли как водитель.\nВыберите действие:',
      { attachments: [kb.driverEntryKeyboard()] }
    );
    return;
  }
  await ctx.reply(
    '👋 Здравствуйте! Это бот записи на поездки Акьяр — Уфа.',
    { attachments: [kb.mainMenuKeyboard()] }
  );
}

// Событие "bot_started" MAX отправляет автоматически, когда пользователь открывает
// чат с ботом в первый раз и нажимает нативную кнопку «Начать» — печатать /start
// не требуется. Это как раз то, что нужно для клиентов старшего возраста.
bot.on('bot_started', showWelcome);

// Команда /start оставлена как резервный вариант (например, если пользователь
// уже писал боту раньше и открывает чат заново).
bot.command('start', showWelcome);

// --- /myid — вспомогательная команда, чтобы узнать свой user_id для .env ---
bot.command('myid', async (ctx) => {
  const id = getUserId(ctx);
  await ctx.reply(
    `Ваш user_id: ${id}\n\nЕсли вы жена или водитель — сообщите это значение тому, кто настраивает бота, чтобы вписать его в .env (WIFE_USER_ID или DRIVER_USER_ID).`
  );
});

// --- /groupid — вспомогательная команда: написать прямо в нужной группе (бот должен
// быть в неё уже добавлен), чтобы узнать её chat_id для .env (GROUP_CHAT_ID) —
// именно туда потом уходят объявления о свободных местах.
bot.command('groupid', async (ctx) => {
  const id = getChatId(ctx);
  await ctx.reply(
    `ID этого чата: ${id}\n\nЕсли это одна из групп, куда нужно слать объявления о свободных местах — впишите это значение в .env как GROUP_CHAT_ID (если групп несколько — перечислите их ID через запятую).`
  );
});

registerPassengerFlow(bot);
registerParcelFlow(bot);
registerAdminFlow(bot);
registerDriverFlow(bot);

// Общая кнопка «🏠 Главное меню», доступная на всех клиентских экранах записи/посылки —
// сбрасывает любой незавершённый многошаговый ввод и показывает меню по роли пользователя.
bot.action('go:home', async (ctx) => {
  session.clear(getUserId(ctx));
  await showWelcome(ctx);
});

// Небольшой health-check веб-сервер — нужен только для бесплатных хостингов
// (например, Render), которым важно, чтобы приложение слушало HTTP-порт и
// отвечало на запросы. Самому боту (Long Polling) он не нужен.
// Он же теперь обслуживает внутреннее API (/api/...) — см. internalApi.js —
// через которое ВК-бот (vk-bot/) читает расписание и создаёт заявки в этой же базе.
const PORT = process.env.PORT || 3000;
http
  .createServer(async (req, res) => {
    const handled = await handleInternalApiRequest(req, res, bot);
    if (handled) return;
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Бот Акьяр — Уфа работает.');
  })
  .listen(PORT, () => {
    console.log(`Health-check сервер слушает порт ${PORT}`);
  });

// bot.start() запускает бесконечный цикл long polling и НЕ резолвит свой promise
// в штатной работе (только если бот когда-нибудь остановится) — поэтому всё, что
// должно стартовать вместе с ботом (в т.ч. вся автоматика ниже), нельзя вешать на
// .then() после него: до .then() в реальности никогда не доходит, и автоматика
// просто никогда не запускается. Поэтому не await'им bot.start(), а параллельно
// сразу запускаем автоматику; ошибки самого polling ловим через bot.catch/.catch
// на промисе (это не помешает автоматике, которая уже стартовала).
bot.start().catch((e) => {
  console.error('Ошибка Long Polling:', e);
});

console.log('Бот запущен (Long Polling).');
startDriverAutoNotify(bot);
startGroupAutoNotify(bot);
startDailyBroadcastAutoNotify(bot);
startWaitlistAutoNotify(bot);
startRideConfirmAutoNotify(bot);

process.on('unhandledRejection', (err) => {
  console.error('Необработанная ошибка:', err);
});
