const DIRECTIONS = {
  YA_UFA: { code: 'YA_UFA', label: 'Акьяр → Уфа' },
  UFA_YA: { code: 'UFA_YA', label: 'Уфа → Акьяр' },
};

// Список деревень, которые обслуживает маршрут. Пассажир выбирает свою деревню
// после выбора рейса, а при поездке в Уфу дополнительно пишет свой адрес в деревне
// (машина забирает от адреса в деревне при поездке в Уфу, и от адреса в Уфе при поездке из Уфы).
const VILLAGES = [
  'Акьяр',
  'Садовый',
  'Самарское',
  'Бурибай',
  'Бузавлык',
  'Матраева',
  'Ямансаз',
  'Зилаир',
  'Юлдыбаево',
];

// Текст экрана «Цены» — тариф на межгород Акьяр—Уфа и тарифы такси по г. Уфа
// (скриншот прайса от 16.07.2026). Актуализируется вручную при изменении цен.
const PRICES_TEXT = `💰 Цены

Акьяр ⇄ Уфа — 2400 руб

Тарифы цен по г.Уфа от 16.07.2026:

1. Аэропорт; центр.рынок; Телецентр; Южный автовокзал; пр.Октября до Гор.совета — без доплаты
2. По проспекту от ост. Гор.совет до Б.Славы — 200
3. От Б.Славы до Черниковки — 300
4. ТЦ Планета до Рудольфа Нуриева, Энтузиастов — 100
5. Лесной проезд, ТЦ Башкирия, Зеленая роща — 100
6. Инорс — 600
7. Сипайлово — 400
8. Шакша — 1700
9. Иглино — 2200
10. Затон, Алексеевка, Михайловка — 500
11. Ж.д. вокзал — 200
12. Нижегородка (обе) — 400
13. Зубово после ул. Дорожной — 100
14. Зубово Лайф — 200
15. Мкр "Яркий" — 300
16. Дема; дальше Новороссийской — 400 / 500
17. Авдон, Уптино — 900
18. Юматово — 1000
19. Нагаево, Федоровка, Карпово — 700
20. Акбердино — 800
21. Шамонино — 700
22. Черниковка — 500
23. Кузнецовский Затон — 100
24. дальше А. Невского — 600
25. дальше Машиностр — 700`;

const STATUS_ICON = {
  new: '🟡',
  confirmed: '🟢',
  cancelled: '🔴',
  sent: '🚗',
};

const STATUS_LABEL = {
  new: 'Новая',
  confirmed: 'Подтверждена',
  cancelled: 'Отменена',
  sent: 'Передана водителю',
};

// Группы дней недели для шаблона расписания. Дни — по JS Date.getDay():
// 0=Вс, 1=Пн, 2=Вт, 3=Ср, 4=Чт, 5=Пт, 6=Сб.
const WEEKDAY_GROUPS = {
  weekday: { code: 'weekday', label: 'Будни (Пн-Пт, кроме Ср)', days: [1, 2, 4, 5] },
  sat: { code: 'sat', label: 'Суббота', days: [6] },
  sun: { code: 'sun', label: 'Воскресенье', days: [0] },
  all: { code: 'all', label: 'Каждый день', days: [0, 1, 2, 3, 4, 5, 6] },
};

const WEEKDAY_SHORT = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
const WEEKDAY_FULL = ['Воскресенье', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота'];

// Подбирает читаемое название для набора дней недели: если совпадает с одной
// из готовых групп (будни/суббота/воскресенье/каждый день) — берёт её label,
// иначе перечисляет дни через запятую.
function weekdayGroupLabel(days) {
  const sorted = [...days].sort().join(',');
  const preset = Object.values(WEEKDAY_GROUPS).find((g) => [...g.days].sort().join(',') === sorted);
  if (preset) return preset.label;
  return [...days].sort().map((d) => WEEKDAY_SHORT[d]).join(', ');
}

function pad(n) {
  return String(n).padStart(2, '0');
}

// Смещение Asia/Yekaterinburg относительно UTC в миллисекундах. Этот часовой
// пояс не переходит на летнее время, поэтому смещение всегда ровно +5:00 —
// и его надёжнее зашить прямо здесь, чем полагаться на то, что процесс
// правильно понимает process.env.TZ = 'Asia/Yekaterinburg' (задаётся в
// src/index.js и vk_bot/index.js). На некоторых хостингах (в частности так
// нашлось на хостинге ВК-бота) контейнер либо игнорирует TZ, либо не содержит
// нужных данных о часовых поясах — тогда new Date().getHours() и все даты
// "сегодня"/"завтра", посчитанные через локальные методы Date, незаметно
// съезжают на несколько часов. Например, ежедневная рассылка, настроенная на
// 09:30, однажды ушла в реальные 06:30 — ровно из-за этого.
//
// Date.now() — это всегда абсолютный момент времени (мс с начала эпохи UNIX),
// он не зависит от часового пояса процесса. Прибавляя к нему фиксированное
// смещение и читая результат через getUTC*-методы (а не локальные getHours/
// getFullYear/...), получаем екатеринбургское время, которое не может
// разъехаться из-за особенностей хостинга.
const YEKB_OFFSET_MS = 5 * 60 * 60 * 1000;

// "Сейчас" в Екатеринбурге — Date, у которого год/месяц/день/час/минута нужно
// читать ТОЛЬКО через getUTC*-методы (getFullYear/getHours и т.п. применят
// поверх ещё и часовой пояс самого процесса и всё испортят).
function nowYekb() {
  return new Date(Date.now() + YEKB_OFFSET_MS);
}

// ЧЧ:ММ текущего времени в Екатеринбурге — используется во всех проверках
// "не пора ли выполнить действие по расписанию" (авторассылки, автонапоминания,
// "рейс уже прошёл").
function nowHM() {
  const d = nowYekb();
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

// Возвращает YYYY-MM-DD для локального времени (d должен быть либо обычным
// Date с явно заданными год/месяц/день — тогда читаем как обычно, — либо
// результатом nowYekb(), см. toISODateUTC ниже для этого случая)
function toISODate(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// То же самое, но для Date, полученного из nowYekb() — то есть значения
// нужно читать через getUTC*, а не через локальные методы.
function toISODateUTC(d) {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function todayISO() {
  return toISODateUTC(nowYekb());
}

function tomorrowISO() {
  const d = nowYekb();
  d.setUTCDate(d.getUTCDate() + 1);
  return toISODateUTC(d);
}

// Список из n дат подряд начиная с сегодня (сегодня включительно), в формате
// YYYY-MM-DD — используется для кнопок выбора дня на неделю вперёд.
function nextDaysISO(n) {
  const days = [];
  const d = nowYekb();
  for (let i = 0; i < n; i++) {
    days.push(toISODateUTC(d));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return days;
}

// ДД.ММ без года — короткая подпись даты для кнопок.
function shortDateRu(iso) {
  const [, m, d] = iso.split('-');
  return `${d}.${m}`;
}

// Подпись для кнопки выбора дня: "Сегодня, 16.09", "Завтра, 17.09", а для
// остальных дней недели — "Пятница, 18.09" и т.д. Дата разбирается по частям
// (не через new Date(iso)), чтобы не зависеть от того, как именно движок
// трактует часовой пояс в ISO-строке без времени.
function dayButtonLabel(iso) {
  if (iso === todayISO()) return `Сегодня, ${shortDateRu(iso)}`;
  if (iso === tomorrowISO()) return `Завтра, ${shortDateRu(iso)}`;
  const [y, m, d] = iso.split('-').map(Number);
  const weekday = WEEKDAY_FULL[new Date(y, m - 1, d).getDay()];
  return `${weekday}, ${shortDateRu(iso)}`;
}

// Принимает дату в формате ДД.ММ.ГГГГ или ДД.ММ (текущий год), возвращает YYYY-MM-DD или null
function parseRuDate(text) {
  const m = text.trim().match(/^(\d{1,2})[.\/](\d{1,2})(?:[.\/](\d{2,4}))?$/);
  if (!m) return null;
  const day = Number(m[1]);
  const month = Number(m[2]);
  let year = m[3] ? Number(m[3]) : nowYekb().getUTCFullYear();
  if (year < 100) year += 2000;
  const d = new Date(year, month - 1, day);
  if (d.getMonth() !== month - 1 || d.getDate() !== day) return null; // невалидная дата
  return toISODate(d);
}

// YYYY-MM-DD -> ДД.ММ.ГГГГ для показа пользователю
function formatDateRu(iso) {
  const [y, m, d] = iso.split('-');
  const weekday = WEEKDAY_FULL[new Date(Number(y), Number(m) - 1, Number(d)).getDay()];
  return `${d}.${m}.${y}, ${weekday.toLowerCase()}`;
}

// Экранирует спецсимволы MAX-разметки (**жирный**, __курсив__, ~~зачёркнутый~~,
// ++подчёркнутый++, `код`, [ссылки]) в тексте, который ввёл человек (имя,
// телефон, адрес, заметка), — чтобы случайные звёздочки/подчёркивания в чужом
// тексте не ломали форматирование остального сообщения.
function escapeMd(text) {
  return String(text).replace(/([*_~+`\[\]])/g, '\\$1');
}

// Оборачивает текст в жирное начертание (разметка MAX, см. dev.max.ru/docs/chatbots/bots-coding/formatting).
// Использовать только для собственного (статического) текста бота, не для
// текста, введённого пользователем, — для него сначала escapeMd().
function bold(text) {
  return `**${text}**`;
}

function directionLabel(code) {
  return DIRECTIONS[code] ? DIRECTIONS[code].label : code;
}

function otherDirection(code) {
  return code === 'YA_UFA' ? 'UFA_YA' : 'YA_UFA';
}

function normalizePhone(text) {
  let digits = text.replace(/[^\d+]/g, '').replace(/^\+*/, (m) => (m ? '+' : ''));
  const hadPlus = digits.startsWith('+');
  let onlyDigits = digits.replace(/\D/g, '');
  // 8XXXXXXXXXX -> 7XXXXXXXXXX — тот же самый номер, только по-разному введённый
  // (человек с городского/старой привычки набирает "8", а не "+7"). Без этого один
  // и тот же клиент оказывался в базе то как "89261234567", то как "+79261234567" —
  // мешает искать повторную запись и сверять номер при звонке.
  if (onlyDigits.length === 11 && onlyDigits.startsWith('8')) {
    onlyDigits = `7${onlyDigits.slice(1)}`;
  }
  if (onlyDigits.length === 10) {
    // Ввели без кода страны (просто "9261234567") — дополняем до +7.
    onlyDigits = `7${onlyDigits}`;
  }
  return (hadPlus || onlyDigits.length === 11) ? `+${onlyDigits}` : onlyDigits;
}

function isLikelyPhone(text) {
  const digits = text.replace(/\D/g, '');
  return digits.length >= 10 && digits.length <= 12;
}

// Порядок деревень по ходу движения машины: Акьяр → Уфа — как в списке VILLAGES;
// Уфа → Акьяр — в обратном порядке (начиная с Кашкалаши).
function villageRouteOrder(direction) {
  return direction === 'UFA_YA' ? [...VILLAGES].reverse() : VILLAGES;
}

// Сортирует пассажиров по порядку деревень на маршруте (для списка водителю),
// чтобы посадка/высадка шла по ходу движения, а не в порядке записи. Пассажиры
// без указанной деревни (например, добавленные до этой функции) уходят в конец.
function sortByVillageRoute(bookings, direction) {
  const order = villageRouteOrder(direction);
  return [...bookings].sort((a, b) => {
    const ia = order.indexOf(a.village);
    const ib = order.indexOf(b.village);
    const ra = ia === -1 ? order.length : ia;
    const rb = ib === -1 ? order.length : ib;
    return ra - rb;
  });
}

// Склонение русских существительных по числу: pluralRu(5, 'посылка', 'посылки', 'посылок') -> 'посылок'
function pluralRu(n, one, few, many) {
  const n10 = n % 10;
  const n100 = n % 100;
  if (n10 === 1 && n100 !== 11) return one;
  if (n10 >= 2 && n10 <= 4 && (n100 < 10 || n100 >= 20)) return few;
  return many;
}

// Номер дня недели (0-6, как Date.getDay()) для даты в формате YYYY-MM-DD
function weekdayOf(dateIso) {
  return new Date(`${dateIso}T00:00:00`).getDay();
}

// Разбирает vCard (поле vcf_info), которое MAX присылает во вложении
// type: "contact" после того, как пользователь нажал кнопку «Отправить номер»
// (request_contact). Формат задокументирован MAX (dev.max.ru/docs-api), пример:
// "BEGIN:VCARD\r\nVERSION:3.0\r\nTEL;TYPE=cell:79990000000\r\nFN:Иван Иванов\r\nEND:VCARD\r\n"
// TEL — телефон, FN — отображаемое имя контакта. Любое из полей может отсутствовать.
function parseVcfContact(vcfInfo) {
  if (!vcfInfo || typeof vcfInfo !== 'string') return null;
  const normalized = vcfInfo.replace(/\\r\\n/g, '\n').replace(/\r\n/g, '\n');
  const telMatch = normalized.match(/^TEL[^:]*:(.+)$/im);
  const fnMatch = normalized.match(/^FN[^:]*:(.+)$/im);

  let phone = null;
  if (telMatch) {
    let digits = telMatch[1].replace(/\D/g, '');
    // 8XXXXXXXXXX -> +7XXXXXXXXXX, как обычно ожидают номера в этом боте
    if (digits.length === 11 && digits.startsWith('8')) digits = `7${digits.slice(1)}`;
    if (digits.length >= 10) phone = `+${digits}`;
  }
  const name = fnMatch ? fnMatch[1].trim() : null;

  if (!phone && !name) return null;
  return { name: name || null, phone: phone || null };
}

// Значок рядом с именем пассажира, показывающий, подтвердил ли он сам поездку
// в ответ на вопрос бота (см. rideConfirmed заявки). Пустая строка — бота ещё
// не спрашивали или пассажир не ответил.
function rideConfirmIcon(b) {
  if (b.rideConfirmed === 'yes') return '✅';
  if (b.rideConfirmed === 'no') return '❗';
  return '';
}

module.exports = {
  escapeMd,
  bold,
  DIRECTIONS,
  VILLAGES,
  PRICES_TEXT,
  STATUS_ICON,
  STATUS_LABEL,
  WEEKDAY_GROUPS,
  WEEKDAY_SHORT,
  weekdayGroupLabel,
  weekdayOf,
  pluralRu,
  nowYekb,
  nowHM,
  todayISO,
  tomorrowISO,
  nextDaysISO,
  shortDateRu,
  dayButtonLabel,
  toISODate,
  parseRuDate,
  formatDateRu,
  directionLabel,
  otherDirection,
  normalizePhone,
  isLikelyPhone,
  parseVcfContact,
  villageRouteOrder,
  sortByVillageRoute,
  rideConfirmIcon,
};
