const { Keyboard } = require('@maxhub/max-bot-api');
const fmt = require('./format');
const config = require('./config');

function mainMenuKeyboard() {
  return Keyboard.inlineKeyboard([
    [Keyboard.button.callback('🚌 Записаться на поездку', 'b:start')],
    [Keyboard.button.callback('📦 Отправить посылку', 'p:start')],
    [Keyboard.button.callback('📋 Мои заказы', 'b:myorders')],
    [Keyboard.button.callback('💰 Цены', 'menu:prices')],
  ]);
}

// Экран «Цены»: просто текст с тарифами (см. fmt.PRICES_TEXT) и кнопка
// «Назад» — возвращает в главное меню тем же способом, что и «🏠 Главное
// меню» (go:home), но подписана иначе, как просили — «⬅️ Назад».
function pricesKeyboard() {
  return Keyboard.inlineKeyboard([
    [Keyboard.button.callback('⬅️ Назад', 'go:home')],
  ]);
}

// Клавиатура после самостоятельной отмены заявки/посылки пассажиром: те же
// кнопки, что и в главном меню, плюс отдельная кнопка «Главное меню» —
// для единообразия с остальными экранами записи.
function afterCancelKeyboard() {
  return Keyboard.inlineKeyboard([
    [Keyboard.button.callback('🚌 Записаться на поездку', 'b:start')],
    [Keyboard.button.callback('📦 Отправить посылку', 'p:start')],
    [Keyboard.button.callback('📋 Мои заказы', 'b:myorders')],
    homeRow(),
  ]);
}

// «Мои заказы»: по одной кнопке отмены на каждую ПРЕДСТОЯЩУЮ заявку (прошедшие
// и уже отменённые в тексте просто перечисляются, кнопок под ними нет —
// отменять или подтверждать там уже нечего).
function myOrdersKeyboard(upcoming) {
  const rows = upcoming.map((b) => [
    Keyboard.button.callback(`❌ Отменить: ${fmt.formatDateRu(b.date)} ${b.time}`, `b:mycancel:${b.id}`),
  ]);
  rows.push(homeRow());
  return Keyboard.inlineKeyboard(rows);
}

function adminEntryKeyboard() {
  return Keyboard.inlineKeyboard([
    [Keyboard.button.callback('🚌 Записаться на поездку', 'b:start')],
    [Keyboard.button.callback('📦 Отправить посылку', 'p:start')],
    [Keyboard.button.callback('⚙️ Администратор', 'a:menu')],
  ]);
}

function driverEntryKeyboard() {
  return Keyboard.inlineKeyboard([
    [Keyboard.button.callback('🚗 Мои рейсы (водитель)', 'd:menu')],
  ]);
}

// Кнопка «в главное меню», добавляется в конец клавиатуры клиентских шагов
// (запись на поездку / отправка посылки), чтобы человек не застревал в середине
// диалога и мог в один тап вернуться в самое начало.
function homeRow() {
  return [Keyboard.button.callback('🏠 Главное меню', 'go:home')];
}

// Кнопка «Отправить номер из телефонной книги» (request_contact) — MAX сам
// откроет системный выбор контакта и пришлёт вложение с именем и телефоном,
// без ручного ввода. Полезно для пожилых пассажиров, которым проще нажать
// кнопку, чем печатать номер. prefix — 'b' (пассажир) или 'p' (посылка).
// backCallback — колбэк кнопки «Назад» на предыдущий шаг этого же потока.
function contactShareKeyboard(prefix, backCallback) {
  const rows = [[Keyboard.button.requestContact('📱 Отправить своё имя и номер телефона')]];
  if (backCallback) rows.push([Keyboard.button.callback('⬅️ Назад', backCallback)]);
  rows.push(homeRow());
  return Keyboard.inlineKeyboard(rows);
}

// Экран «Сколько человек поедет?»: кнопки 1-4 в один ряд + «Больше», если
// свободных мест хватает на 5 или 6. Отдельно кнопкой, а не текстом — чтобы
// не заставлять печатать число руками.
function countKeyboard(free) {
  const shown = Math.min(free, 4);
  const numberRow = [];
  for (let n = 1; n <= shown; n++) {
    numberRow.push(Keyboard.button.callback(String(n), `b:count:${n}`));
  }
  const rows = [numberRow];
  if (free > 4) rows.push([Keyboard.button.callback('Больше', 'b:count:more')]);
  rows.push([Keyboard.button.callback('⬅️ Назад', 'b:backcount')]);
  rows.push([Keyboard.button.callback('📋 Мои заказы', 'b:myorders')]);
  rows.push(homeRow());
  return Keyboard.inlineKeyboard(rows);
}

// Экран после «Больше»: 5 и 6, если на них хватает свободных мест.
function countMoreKeyboard(free) {
  const numberRow = [];
  for (let n = 5; n <= Math.min(free, 6); n++) {
    numberRow.push(Keyboard.button.callback(String(n), `b:count:${n}`));
  }
  const rows = [numberRow];
  rows.push([Keyboard.button.callback('⬅️ Назад', 'b:count:back')]);
  rows.push([Keyboard.button.callback('📋 Мои заказы', 'b:myorders')]);
  rows.push(homeRow());
  return Keyboard.inlineKeyboard(rows);
}

function directionKeyboard(prefix, backCallback) {
  const rows = [
    [Keyboard.button.callback('Акьяр → Уфа', `${prefix}:dir:YA_UFA`)],
    [Keyboard.button.callback('Уфа → Акьяр', `${prefix}:dir:UFA_YA`)],
  ];
  if (backCallback) rows.push([Keyboard.button.callback('⬅️ Назад', backCallback)]);
  if (prefix === 'b' || prefix === 'p') rows.push(homeRow());
  return Keyboard.inlineKeyboard(rows);
}

// Выбор группы дней недели при добавлении нового рейса в шаблон расписания
function weekdayGroupKeyboard(prefix, backCallback) {
  const rows = [
    [Keyboard.button.callback(fmt.WEEKDAY_GROUPS.weekday.label, `${prefix}:wd:weekday`)],
    [Keyboard.button.callback(fmt.WEEKDAY_GROUPS.sat.label, `${prefix}:wd:sat`)],
    [Keyboard.button.callback(fmt.WEEKDAY_GROUPS.sun.label, `${prefix}:wd:sun`)],
    [Keyboard.button.callback(fmt.WEEKDAY_GROUPS.all.label, `${prefix}:wd:all`)],
  ];
  if (backCallback) rows.push([Keyboard.button.callback('⬅️ Назад', backCallback)]);
  return Keyboard.inlineKeyboard(rows);
}

// idx — индекс в fmt.VILLAGES. Кнопки по 2 в ряд, чтобы список из 10 деревень
// помещался компактно на маленьком экране. «Другое» — если своего населённого
// пункта нет в списке, можно напечатать его самому вместо выбора кнопкой.
function villageKeyboard(prefix, backCallback) {
  const rows = [];
  for (let i = 0; i < fmt.VILLAGES.length; i += 2) {
    const row = [Keyboard.button.callback(fmt.VILLAGES[i], `${prefix}:village:${i}`)];
    if (fmt.VILLAGES[i + 1]) {
      row.push(Keyboard.button.callback(fmt.VILLAGES[i + 1], `${prefix}:village:${i + 1}`));
    }
    rows.push(row);
  }
  rows.push([Keyboard.button.callback('✍️ Другое (напишу сам)', `${prefix}:villageother`)]);
  if (backCallback) rows.push([Keyboard.button.callback('⬅️ Назад', backCallback)]);
  if (prefix === 'b' || prefix === 'p') rows.push(homeRow());
  return Keyboard.inlineKeyboard(rows);
}

// Строит кнопки с датами на неделю вперёд (сегодня + 6 дней), по 2 в строке:
// «Сегодня, 16.09», «Завтра, 17.09», затем день недели с датой («Пятница,
// 18.09») и так далее. prefix+action формируют callback-данные вида
// `${prefix}:${action}:ГГГГММДД` — этот же формат разбирают все обработчики,
// которые раньше принимали `today`/`tomorrow`.
function weekDateRows(prefix, action) {
  const days = fmt.nextDaysISO(7);
  const rows = [];
  for (let i = 0; i < days.length; i += 2) {
    const row = [
      Keyboard.button.callback(fmt.dayButtonLabel(days[i]), `${prefix}:${action}:${days[i].replace(/-/g, '')}`),
    ];
    if (days[i + 1]) {
      row.push(
        Keyboard.button.callback(fmt.dayButtonLabel(days[i + 1]), `${prefix}:${action}:${days[i + 1].replace(/-/g, '')}`)
      );
    }
    rows.push(row);
  }
  return rows;
}

function dateKeyboard(prefix, backCallback) {
  const rows = weekDateRows(prefix, 'date');
  rows.push([Keyboard.button.callback('Другая дата', `${prefix}:date:other`)]);
  if (backCallback) rows.push([Keyboard.button.callback('⬅️ Назад', backCallback)]);
  if (prefix === 'b' || prefix === 'p') rows.push(homeRow());
  return Keyboard.inlineKeyboard(rows);
}

// trips: [{id, time, free, isExtra}]
function timeKeyboard(prefix, trips, dateCompact, backCallback) {
  const rows = trips.map((t) => {
    const suffix = t.isExtra ? ' (попутка)' : '';
    const label =
      t.free > 0 ? `🕡 ${t.time}${suffix} — свободно ${t.free}` : `🕡 ${t.time}${suffix} — мест нет`;
    if (t.free > 0) {
      return [Keyboard.button.callback(label, `${prefix}:time:${t.id}:${dateCompact}`)];
    }
    // Занятый рейс — при нажатии предложим встать в лист ожидания вместо
    // простого "мест нет" в никуда (см. bot.action(`${prefix}:full:...`)).
    return [Keyboard.button.callback(`❌ ${label}`, `${prefix}:full:${t.id}:${dateCompact}`)];
  });
  if (backCallback) rows.push([Keyboard.button.callback('⬅️ Назад', backCallback)]);
  rows.push(homeRow());
  return Keyboard.inlineKeyboard(rows);
}

// Клавиатура-предложение встать в лист ожидания на конкретный полностью занятый рейс.
function waitlistOfferKeyboard(prefix, scheduleId, dateCompact, backCallback) {
  const rows = [
    [Keyboard.button.callback('🔔 Сообщить, когда освободится место', `${prefix}:waitlist:${scheduleId}:${dateCompact}`)],
  ];
  if (backCallback) rows.push([Keyboard.button.callback('⬅️ Назад', backCallback)]);
  rows.push(homeRow());
  return Keyboard.inlineKeyboard(rows);
}

// Выбор рейса для посылки: в отличие от timeKeyboard, доступны ВСЕ рейсы дня —
// посылка не занимает место в машине, поэтому даже полностью занятый пассажирами
// рейс всё равно может её взять.
function parcelTimeKeyboard(trips, dateCompact, backCallback) {
  const rows = trips.map((t) => {
    const suffix = t.isExtra ? ' (попутка)' : '';
    return [Keyboard.button.callback(`🕡 ${t.time}${suffix}`, `p:time:${t.id}:${dateCompact}`)];
  });
  if (backCallback) rows.push([Keyboard.button.callback('⬅️ Назад', backCallback)]);
  rows.push(homeRow());
  return Keyboard.inlineKeyboard(rows);
}

// Шаг «примечание для водителя» — необязательный текст (например, «я на ост.
// 8 марта»), поэтому даём кнопку «Пропустить», чтобы не заставлять печатать.
function noteSkipKeyboard(prefix) {
  return Keyboard.inlineKeyboard([
    [Keyboard.button.callback('➡️ Пропустить', `${prefix}:skipnote`)],
  ]);
}

function confirmCancelKeyboard(prefix, payloadSuffix) {
  return Keyboard.inlineKeyboard([
    [Keyboard.button.callback('Отмена', `${prefix}:cancelflow`)],
  ]);
}

function adminMenuKeyboard() {
  return Keyboard.inlineKeyboard([
    [Keyboard.button.callback('📅 Рейсы', 'a:day:pick_entry')],
    [Keyboard.button.callback('📊 Отчёт за день', 'a:report:pick_entry')],
    [Keyboard.button.callback('⚙️ Настройки', 'a:settings')],
    [Keyboard.button.callback('⬅️ Назад', 'a:home')],
  ]);
}

// Реже нужные разделы — расписание, рассылка о местах, тумблер авто-«едете?» —
// вынесены сюда из главного меню админки, чтобы там оставались только те два
// пункта («Рейсы», «Отчёт за день»), которыми пользуются каждый день.
function adminSettingsKeyboard(rideConfirmAutoEnabled) {
  const rows = [
    [Keyboard.button.callback('✏️ Расписание', 'a:sched')],
    [Keyboard.button.callback('📢 Рассылка о местах', 'a:broadcast:pick_entry')],
  ];
  // Кнопку показываем, только если функция вообще настроена переменной
  // окружения RIDE_CONFIRM_AUTO_MINUTES — иначе тумблер ничего не переключал бы.
  if (config.rideConfirmAutoMinutes > 0) {
    rows.push([
      Keyboard.button.callback(
        rideConfirmAutoEnabled ? '🔔 Авто-«едете?»: ВКЛ (нажмите, чтобы выключить)' : '🔕 Авто-«едете?»: ВЫКЛ (нажмите, чтобы включить)',
        'a:togglerideconfirm'
      ),
    ]);
  }
  rows.push([Keyboard.button.callback('⬅️ Назад', 'a:menu')]);
  return Keyboard.inlineKeyboard(rows);
}

function reportDayKeyboard() {
  const rows = weekDateRows('a', 'report');
  rows.push([Keyboard.button.callback('Выбрать дату', 'a:report:other')]);
  rows.push([Keyboard.button.callback('⬅️ Назад', 'a:menu')]);
  return Keyboard.inlineKeyboard(rows);
}

function broadcastDayKeyboard() {
  const rows = weekDateRows('a', 'broadcast');
  rows.push([Keyboard.button.callback('Выбрать дату', 'a:broadcast:other')]);
  rows.push([Keyboard.button.callback('⬅️ Назад', 'a:settings')]);
  return Keyboard.inlineKeyboard(rows);
}

// Предпросмотр общей рассылки о всех рейсах со свободными местами за день,
// перед реальной отправкой в группу
function sendBroadcastPreviewKeyboard(dateCompact) {
  return Keyboard.inlineKeyboard([
    [Keyboard.button.callback('✅ Отправить в группу', `a:broadcastok:${dateCompact}`)],
    [Keyboard.button.callback('⬅️ Назад', 'a:settings')],
  ]);
}

function adminDayKeyboard() {
  const rows = weekDateRows('a', 'day');
  rows.push([Keyboard.button.callback('Выбрать дату', 'a:day:other')]);
  rows.push([Keyboard.button.callback('⬅️ Назад', 'a:menu')]);
  return Keyboard.inlineKeyboard(rows);
}

// items: [{id, direction, time, occupied, max, isExtra}]
// Порядок направлений в списке рейсов админки: сначала «Уфа → Акьяр», потом
// «Акьяр → Уфа» (внутри каждого направления — по времени, как и раньше).
const TRIP_DIRECTION_ORDER = { UFA_YA: 0, YA_UFA: 1 };

function adminTripListKeyboard(items, dateCompact) {
  const sorted = [...items].sort((a, b) => {
    const d = TRIP_DIRECTION_ORDER[a.direction] - TRIP_DIRECTION_ORDER[b.direction];
    if (d !== 0) return d;
    return a.time.localeCompare(b.time);
  });
  const rows = sorted.map((it) => [
    Keyboard.button.callback(
      `${fmt.directionLabel(it.direction)} ${it.time}${it.isExtra ? ' 🚐' : ''} (${it.occupied}/${it.max})`,
      `a:trip:${it.id}:${dateCompact}`
    ),
  ]);
  rows.push([Keyboard.button.callback('➕ Добавить машину', `a:extracar:start:${dateCompact}`)]);
  rows.push([Keyboard.button.callback('⬅️ Назад', 'a:menu')]);
  rows.push([Keyboard.button.callback('🏠 Главное меню', 'a:home')]);
  return Keyboard.inlineKeyboard(rows);
}

function adminTripDetailKeyboard(bookings, carId, dateCompact, isExtra, restoreInfo) {
  const rows = [];
  if (restoreInfo) {
    rows.push([
      Keyboard.button.callback(`↩️ Вернуть ${restoreInfo.name} обратно`, `a:restore:${restoreInfo.bookingId}`),
    ]);
  }
  for (const b of bookings) {
    rows.push([
      Keyboard.button.callback(b.kind === 'parcel' ? `📦 ${b.name}` : `✅ ${b.name}`, `a:conf:${b.id}`),
      Keyboard.button.callback('❌', `a:cancel:${b.id}`),
      Keyboard.button.callback('✏️', `a:edit:${b.id}`),
      Keyboard.button.callback('📞', `a:call:${b.id}`),
    ]);
  }
  rows.push([Keyboard.button.callback('➕ Добавить пассажира', `a:addpax:${carId}:${dateCompact}`)]);
  rows.push([Keyboard.button.callback('📦 Добавить посылку', `a:addparcel:${carId}:${dateCompact}`)]);
  rows.push([Keyboard.button.callback('🚗 Список для водителя', `a:senddriver:${carId}:${dateCompact}`)]);
  rows.push([Keyboard.button.callback('❓ Спросить пассажиров о поездке', `a:askconfirm:${carId}:${dateCompact}`)]);
  rows.push([Keyboard.button.callback('📢 Сообщить в группу о местах', `a:notifygroup:${carId}:${dateCompact}`)]);
  if (isExtra) {
    rows.push([Keyboard.button.callback('✏️ Изменить число мест', `a:extracap:${carId}`)]);
    rows.push([Keyboard.button.callback('🗑 Удалить эту машину', `a:extradel:${carId}`)]);
  } else {
    rows.push([Keyboard.button.callback('✏️ Изменить число мест (только на этот день)', `a:daycap:${carId}:${dateCompact}`)]);
    rows.push([Keyboard.button.callback('✏️ Изменить время (только на этот день)', `a:daytime:${carId}:${dateCompact}`)]);
    rows.push([Keyboard.button.callback('🚫 Отменить рейс на этот день', `a:daydel:${carId}:${dateCompact}`)]);
  }
  rows.push([Keyboard.button.callback('⬅️ Назад к рейсам', `a:back:${dateCompact}`)]);
  rows.push([Keyboard.button.callback('🏠 Главное меню', 'a:home')]);
  return Keyboard.inlineKeyboard(rows);
}

// Порядок групп дней при отображении списка: будни → суббота → воскресенье → прочее
const WEEKDAY_GROUP_ORDER = ['weekday', 'sat', 'sun'];

function weekdayGroupSortKey(weekdays) {
  const sorted = [...weekdays].sort().join(',');
  const idx = WEEKDAY_GROUP_ORDER.findIndex(
    (code) => [...fmt.WEEKDAY_GROUPS[code].days].sort().join(',') === sorted
  );
  return idx === -1 ? WEEKDAY_GROUP_ORDER.length : idx;
}

// Список рейсов шаблона расписания, сгруппированный по дням недели и отсортированный
// внутри группы по времени (а не по порядку добавления)
function scheduleListKeyboard(items) {
  const sorted = [...items].sort((a, b) => {
    const g = weekdayGroupSortKey(a.weekdays) - weekdayGroupSortKey(b.weekdays);
    if (g !== 0) return g;
    return a.time.localeCompare(b.time);
  });
  const rows = sorted.map((s) => [
    Keyboard.button.callback(
      `[${fmt.weekdayGroupLabel(s.weekdays)}] ${fmt.directionLabel(s.direction)} ${s.time}${s.active ? '' : ' (выкл)'}`,
      `a:sched:view:${s.id}`
    ),
  ]);
  rows.push([Keyboard.button.callback('➕ Добавить рейс', 'a:sched:add')]);
  rows.push([Keyboard.button.callback('⬅️ Назад', 'a:settings')]);
  return Keyboard.inlineKeyboard(rows);
}

function scheduleItemKeyboard(item) {
  return Keyboard.inlineKeyboard([
    [Keyboard.button.callback('✏️ Изменить время (навсегда)', `a:sched:edittime:${item.id}`)],
    [
      Keyboard.button.callback(
        item.active ? '⏸ Выключить' : '▶️ Включить',
        `a:sched:toggle:${item.id}`
      ),
    ],
    [Keyboard.button.callback('🗑 Удалить из шаблона (навсегда)', `a:sched:del:${item.id}`)],
    [Keyboard.button.callback('⬅️ Назад', 'a:sched')],
  ]);
}

// Кнопка «вернуть рейс» после отмены/изменения времени на конкретную дату —
// убирает исключение, и рейс на эту дату снова идёт как в обычном шаблоне
function restoreTripKeyboard(carId, dateCompact) {
  return Keyboard.inlineKeyboard([
    [Keyboard.button.callback('↩️ Вернуть рейс как в расписании', `a:dayrestore:${carId}:${dateCompact}`)],
  ]);
}

// Кнопка «Назад» после показа списка для водителя (список просто выводится
// текстом — реальная отправка не делается, у зятя несколько водителей, и
// пересылает список нужному он сам, вручную).
function driverListKeyboard(carId, dateCompact) {
  return Keyboard.inlineKeyboard([[Keyboard.button.callback('⬅️ Назад', `a:trip:${carId}:${dateCompact}`)]]);
}

// Предпросмотр объявления о свободных местах перед реальной отправкой в группу
function sendGroupPreviewKeyboard(carId, dateCompact) {
  return Keyboard.inlineKeyboard([
    [Keyboard.button.callback('✅ Отправить в группу', `a:notifygroupok:${carId}:${dateCompact}`)],
    [Keyboard.button.callback('⬅️ Назад', `a:trip:${carId}:${dateCompact}`)],
  ]);
}

function driverDayKeyboard() {
  const rows = weekDateRows('d', 'day');
  rows.push([Keyboard.button.callback('Выбрать дату', 'd:day:other')]);
  return Keyboard.inlineKeyboard(rows);
}

function driverTripListKeyboard(items, dateCompact) {
  const rows = items.map((it) => [
    Keyboard.button.callback(
      `${fmt.directionLabel(it.direction)} ${it.time}${it.isExtra ? ' 🚐' : ''} (${it.occupied}/${it.max})`,
      `d:trip:${it.id}:${dateCompact}`
    ),
  ]);
  rows.push([Keyboard.button.callback('⬅️ Назад', 'd:menu')]);
  return Keyboard.inlineKeyboard(rows);
}

// Кнопка «назад» на карточке конкретного рейса у водителя — возвращает к списку
// рейсов на ту же дату
function driverTripBackKeyboard(dateCompact) {
  return Keyboard.inlineKeyboard([[Keyboard.button.callback('⬅️ Назад', `d:back:${dateCompact}`)]]);
}

function myBookingCancelKeyboard(bookingId) {
  return Keyboard.inlineKeyboard([
    [Keyboard.button.callback('❌ Отменить мою запись', `b:mycancel:${bookingId}`)],
    [Keyboard.button.callback('🔁 Записаться на другую поездку', `b:again:${bookingId}`)],
    homeRow(),
  ]);
}

// Кнопки Да/Нет под вопросом боту пассажиру «вы точно едете?»
function rideConfirmKeyboard(bookingId) {
  return Keyboard.inlineKeyboard([
    [
      Keyboard.button.callback('✅ Да, еду', `b:rideyes:${bookingId}`),
      Keyboard.button.callback('❌ Нет, не еду', `b:rideno:${bookingId}`),
    ],
  ]);
}

// Аналог myBookingCancelKeyboard, но для посылки — отмена использует тот же
// обработчик b:mycancel (он не завязан на вид заявки), а «ещё раз» ведёт в поток посылки
function myParcelCancelKeyboard(bookingId) {
  return Keyboard.inlineKeyboard([
    [Keyboard.button.callback('❌ Отменить отправку', `b:mycancel:${bookingId}`)],
    [Keyboard.button.callback('📦 Отправить ещё одну посылку', `p:again:${bookingId}`)],
    homeRow(),
  ]);
}

// Предложение использовать имя/телефон из прошлой записи вместо повторного ввода.
// prefix — 'b' (пассажир) или 'p' (посылка), чтобы кнопки вели в нужный поток.
function prefillConfirmKeyboard(prefix) {
  return Keyboard.inlineKeyboard([
    [Keyboard.button.callback('✅ Да, использовать', `${prefix}:useprefill`)],
    [Keyboard.button.callback('✏️ Ввести заново', `${prefix}:freshname`)],
    homeRow(),
  ]);
}

module.exports = {
  mainMenuKeyboard,
  pricesKeyboard,
  afterCancelKeyboard,
  myOrdersKeyboard,
  adminEntryKeyboard,
  driverEntryKeyboard,
  directionKeyboard,
  contactShareKeyboard,
  countKeyboard,
  countMoreKeyboard,
  weekdayGroupKeyboard,
  villageKeyboard,
  dateKeyboard,
  timeKeyboard,
  waitlistOfferKeyboard,
  parcelTimeKeyboard,
  noteSkipKeyboard,
  confirmCancelKeyboard,
  myBookingCancelKeyboard,
  rideConfirmKeyboard,
  myParcelCancelKeyboard,
  prefillConfirmKeyboard,
  adminMenuKeyboard,
  adminSettingsKeyboard,
  adminDayKeyboard,
  reportDayKeyboard,
  broadcastDayKeyboard,
  sendBroadcastPreviewKeyboard,
  adminTripListKeyboard,
  adminTripDetailKeyboard,
  scheduleListKeyboard,
  scheduleItemKeyboard,
  restoreTripKeyboard,
  driverListKeyboard,
  sendGroupPreviewKeyboard,
  driverDayKeyboard,
  driverTripListKeyboard,
  driverTripBackKeyboard,
};
