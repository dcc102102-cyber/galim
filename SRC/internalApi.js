// Внутреннее API — мост между MAX-ботом (у которого есть прямой доступ к
// data.db) и другими ботами на bothost.ru (например, vk-bot/), которые
// работают отдельным процессом БЕЗ общего диска. Через этот API они читают
// расписание/свободные места и создают заявки в ОДНОЙ и той же базе — так
// заявка из ВК тут же видна жене в MAX-панели, и наоборот.
//
// Защищено общим секретом INTERNAL_API_KEY (см. config.js) — без него любой
// в интернете, кто узнает адрес контейнера (а он публичный, раз подключён
// домен), мог бы читать телефоны и имена пассажиров или создавать fake-заявки.
// Секрет передаётся в заголовке X-Internal-Api-Key и должен быть одинаковым
// в .env у ОБОИХ ботов.
//
// Все маршруты начинаются с /api/ — это не мешает уже существующему
// health-check на "/", который отвечает раньше (см. index.js).

const url = require('url');
const crypto = require('crypto');
const config = require('./config');
const db = require('./store');
const { availableTrips, carInfo } = require('./schedule');
const { notifyAdmins, freeTripsForBroadcast, buildGroupBroadcastText } = require('./adminFlow');
const { notifyWife } = require('./passengerFlow');
const { notifyWifeParcel } = require('./parcelFlow');
const { refreshGroupBroadcastIfChanged } = require('./groupUtil');
const fmt = require('./format');

// Сравнение ключа за постоянное время: обычное "!==" по строкам сравнивает
// побайтово и прекращает сравнение на первом несовпадении, поэтому по времени
// ответа теоретически можно подобрать секрет посимвольно (timing attack).
// timingSafeEqual требует буферы одинаковой длины — если длины разные, ключ
// заведомо неверный, но всё равно сначала выполняем "пустое" сравнение той же
// длины, чтобы не выдавать разницу в длине по времени раньше времени.
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e6) req.destroy(); // защита от слишком большого тела запроса
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

// Возвращает true, если запрос обработан этим модулем (и дальше в index.js
// ничего делать не нужно) — иначе false, и index.js обрабатывает запрос сам
// (сейчас это просто health-check-ответ на любой другой путь).
async function handleInternalApiRequest(req, res, bot) {
  const parsed = url.parse(req.url, true);
  if (!parsed.pathname.startsWith('/api/')) return false;

  if (!config.internalApiKey) {
    sendJson(res, 503, { error: 'internal_api_disabled' });
    return true;
  }
  if (!safeEqual(req.headers['x-internal-api-key'] || '', config.internalApiKey)) {
    sendJson(res, 401, { error: 'unauthorized' });
    return true;
  }

  try {
    // GET /api/trips?direction=YA_UFA&date=2026-09-15 — список рейсов со
    // свободными местами (то же самое, что видит пассажир в MAX-боте).
    if (req.method === 'GET' && parsed.pathname === '/api/trips') {
      const { direction, date } = parsed.query;
      if (!direction || !date) {
        sendJson(res, 400, { error: 'direction_and_date_required' });
        return true;
      }
      sendJson(res, 200, availableTrips(direction, date));
      return true;
    }

    // GET /api/cars/:id?date=2026-09-15 — данные конкретного рейса/машины плюс
    // сколько сейчас занято/свободно мест на эту дату.
    if (req.method === 'GET' && parsed.pathname.startsWith('/api/cars/')) {
      const carId = parsed.pathname.slice('/api/cars/'.length);
      const date = parsed.query.date;
      const info = carInfo(carId, date);
      if (!info) {
        sendJson(res, 404, { error: 'not_found' });
        return true;
      }
      const occupied = db.occupiedSeats(carId, date);
      sendJson(res, 200, { ...info, occupied, free: Math.max(0, info.capacity - occupied) });
      return true;
    }

    // GET /api/bookings/by-user?userId=... — «Мои заказы» для ВК-бота: все
    // заявки (поездки + посылки) конкретного человека. source форсим в 'vk'
    // здесь же — этот маршрут только для ВК (см. комментарий у /api/waitlist).
    // ВАЖНО: этот блок должен идти РАНЬШЕ общего "GET /api/bookings/:id" ниже —
    // тот матчится по префиксу '/api/bookings/' и иначе перехватил бы этот же
    // путь, приняв "by-user" за id заявки (реальный баг, который тут и был).
    if (req.method === 'GET' && parsed.pathname === '/api/bookings/by-user') {
      const userId = parsed.query.userId;
      if (!userId) {
        sendJson(res, 400, { error: 'missing_userId' });
        return true;
      }
      const bookings = db.getBookingsByUserId(userId, 'vk');
      sendJson(res, 200, bookings);
      return true;
    }

    // GET /api/bookings/:id — нужно ВК-боту для "Записаться ещё раз" (подстановка
    // имени/телефона) и для проверки владельца при отмене/подтверждении поездки.
    if (req.method === 'GET' && parsed.pathname.startsWith('/api/bookings/')) {
      const id = parsed.pathname.slice('/api/bookings/'.length);
      const booking = db.getBooking(id);
      if (!booking) {
        sendJson(res, 404, { error: 'not_found' });
        return true;
      }
      sendJson(res, 200, booking);
      return true;
    }

    // POST /api/bookings — создать новую заявку (пассажир или посылка, см. body.kind).
    // Делает ровно то же самое, что происходит при записи через сам MAX-бот:
    // сохраняет в базу, уведомляет жену и (для пассажиров) обновляет "живое"
    // объявление в группе, если оно есть.
    if (req.method === 'POST' && parsed.pathname === '/api/bookings') {
      const body = await readJsonBody(req);
      const kind = body.kind === 'parcel' ? 'parcel' : 'passenger';
      const required =
        kind === 'parcel'
          ? ['scheduleId', 'date', 'direction', 'time', 'village', 'name', 'phone', 'userId']
          : ['scheduleId', 'date', 'direction', 'time', 'village', 'name', 'phone', 'seats', 'userId'];
      const missing = required.filter((k) => body[k] === undefined || body[k] === null || body[k] === '');
      if (missing.length > 0) {
        sendJson(res, 400, { error: 'missing_fields', fields: missing });
        return true;
      }
      const booking = db.addBooking({
        scheduleId: body.scheduleId,
        date: body.date,
        direction: body.direction,
        time: body.time,
        village: body.village,
        address: body.address || null,
        name: body.name,
        phone: body.phone,
        seats: kind === 'parcel' ? 0 : body.seats,
        note: body.note || null,
        userId: body.userId,
        source: body.source || 'external',
        kind,
      });
      if (kind === 'parcel') {
        notifyWifeParcel(bot, booking);
      } else {
        notifyWife(bot, booking);
        refreshGroupBroadcastIfChanged(
          bot,
          booking.date,
          freeTripsForBroadcast(booking.date),
          buildGroupBroadcastText
        ).catch((e) => console.error('[internalApi] Не удалось обновить объявление в группе:', e));
      }
      sendJson(res, 200, booking);
      return true;
    }

    // POST /api/bookings/:id/cancel — отмена заявки самим пассажиром/отправителем
    // (то же, что кнопка "Отменить" в MAX-боте): body: { userId }.
    if (req.method === 'POST' && /^\/api\/bookings\/[^/]+\/cancel$/.test(parsed.pathname)) {
      const id = parsed.pathname.split('/')[3];
      const body = await readJsonBody(req);
      const booking = db.getBooking(id);
      if (!booking) {
        sendJson(res, 404, { error: 'not_found' });
        return true;
      }
      if (String(booking.userId) !== String(body.userId) || booking.source !== 'vk') {
        sendJson(res, 403, { error: 'not_owner' });
        return true;
      }
      if (booking.status === 'cancelled') {
        sendJson(res, 200, booking);
        return true;
      }
      const updated = db.updateBooking(id, { status: 'cancelled' });
      const isParcel = booking.kind === 'parcel';
      const label = isParcel ? '📦 Клиент сам отменил отправку посылки:' : '🔴 Пассажир сам отменил заявку:';
      notifyAdmins(
        bot,
        `${label}\n\n🚌 ${fmt.directionLabel(booking.direction)}\n📅 ${fmt.formatDateRu(booking.date)}\n🕡 ${booking.time}\n👤 ${booking.name} — ${booking.phone}`
      );
      if (!isParcel) {
        refreshGroupBroadcastIfChanged(
          bot,
          booking.date,
          freeTripsForBroadcast(booking.date),
          buildGroupBroadcastText
        ).catch((e) => console.error('[internalApi] Не удалось обновить объявление в группе:', e));
      }
      sendJson(res, 200, updated);
      return true;
    }

    // POST /api/bookings/:id/ride-confirm — ответ пассажира "еду/не еду" на
    // вопрос бота. body: { userId, value: 'yes' | 'no' }.
    if (req.method === 'POST' && /^\/api\/bookings\/[^/]+\/ride-confirm$/.test(parsed.pathname)) {
      const id = parsed.pathname.split('/')[3];
      const body = await readJsonBody(req);
      const booking = db.getBooking(id);
      if (!booking) {
        sendJson(res, 404, { error: 'not_found' });
        return true;
      }
      if (String(booking.userId) !== String(body.userId) || booking.source !== 'vk') {
        sendJson(res, 403, { error: 'not_owner' });
        return true;
      }
      if (body.value !== 'yes' && body.value !== 'no') {
        sendJson(res, 400, { error: 'invalid_value' });
        return true;
      }
      const updated = db.updateBooking(id, { rideConfirmed: body.value });
      const icon = body.value === 'yes' ? '✅' : '❗';
      const label = body.value === 'yes' ? 'подтвердил(а), что едет' : 'сообщил(а), что НЕ едет';
      notifyAdmins(
        bot,
        `${icon} ${booking.name} ${label}:\n\n🚌 ${fmt.directionLabel(booking.direction)}\n📅 ${fmt.formatDateRu(booking.date)}\n🕡 ${booking.time}`
      );
      sendJson(res, 200, updated);
      return true;
    }

    // POST /api/waitlist — встать в очередь на полностью занятый рейс (кнопка
    // «Встать в очередь» в ВК-боте). platform всегда форсим в 'vk' здесь —
    // MAX-бот сам пишет в эту же таблицу напрямую (db.addWaitlistEntry) со
    // своим platform 'max', этот HTTP-маршрут предназначен только для ВК.
    if (req.method === 'POST' && parsed.pathname === '/api/waitlist') {
      const body = await readJsonBody(req);
      const required = ['scheduleId', 'date', 'userId'];
      const missing = required.filter((k) => body[k] === undefined || body[k] === null || body[k] === '');
      if (missing.length > 0) {
        sendJson(res, 400, { error: 'missing_fields', fields: missing });
        return true;
      }
      const existing = db.findWaitlistEntry(body.scheduleId, body.date, 'vk', body.userId);
      if (existing) {
        sendJson(res, 200, { joined: false, alreadyOnList: true, entry: existing });
        return true;
      }
      const item = carInfo(body.scheduleId, body.date);
      const entry = db.addWaitlistEntry({
        scheduleId: body.scheduleId,
        date: body.date,
        direction: (item && item.direction) || body.direction || null,
        time: (item && item.time) || body.time || null,
        platform: 'vk',
        userId: body.userId,
        name: body.name || null,
        phone: body.phone || null,
      });
      sendJson(res, 200, { joined: true, alreadyOnList: false, entry });
      return true;
    }

    // GET /api/waitlist/vk-pending — записи ВК-очереди, для рейсов которых уже
    // появились свободные места (ВК-бот опрашивает этот маршрут раз в минуту
    // из того же цикла, что и refreshIfChanged — см. vk_bot/wallBroadcast.js —
    // и сам шлёт сообщение через VK API, потому что у MAX-бота нет токена ВК).
    if (req.method === 'GET' && parsed.pathname === '/api/waitlist/vk-pending') {
      const trips = db.getWaitlistTrips();
      const ready = [];
      trips.forEach(({ scheduleId, date }) => {
        const item = carInfo(scheduleId, date);
        if (!item) {
          db.clearWaitlistForTrip(scheduleId, date);
          return;
        }
        const free = item.capacity - db.occupiedSeats(scheduleId, date);
        if (free <= 0) return;
        db.getWaitlistForTrip(scheduleId, date)
          .filter((e) => e.platform === 'vk')
          .forEach((e) => ready.push({ ...e, tripDirection: item.direction, tripTime: item.time }));
      });
      sendJson(res, 200, ready);
      return true;
    }

    // POST /api/waitlist/:id/ack — подтверждение, что ВК-бот уже отправил
    // уведомление этому человеку — убираем его из очереди, чтобы не писать
    // повторно на каждой следующей проверке.
    if (req.method === 'POST' && /^\/api\/waitlist\/[^/]+\/ack$/.test(parsed.pathname)) {
      const id = parsed.pathname.split('/')[3];
      db.removeWaitlistEntry(id);
      sendJson(res, 200, { ok: true });
      return true;
    }

    // GET /api/broadcast?date=2026-09-15 — список рейсов со свободными местами
    // за дату (оба направления), для рассылки/поста в ВК-группе.
    if (req.method === 'GET' && parsed.pathname === '/api/broadcast') {
      const { date } = parsed.query;
      if (!date) {
        sendJson(res, 400, { error: 'date_required' });
        return true;
      }
      sendJson(res, 200, freeTripsForBroadcast(date));
      return true;
    }

    // GET/POST /api/kv/:key — универсальное хранилище состояния для других
    // ботов (например, id последнего поста на стене ВК) — см. db.getKV/setKV.
    if (parsed.pathname.startsWith('/api/kv/')) {
      const key = decodeURIComponent(parsed.pathname.slice('/api/kv/'.length));
      if (!key) {
        sendJson(res, 400, { error: 'key_required' });
        return true;
      }
      if (req.method === 'GET') {
        sendJson(res, 200, { key, value: db.getKV(key) });
        return true;
      }
      if (req.method === 'POST') {
        const body = await readJsonBody(req);
        db.setKV(key, body.value);
        sendJson(res, 200, { key, value: body.value });
        return true;
      }
    }

    sendJson(res, 404, { error: 'no_such_route' });
    return true;
  } catch (e) {
    console.error('[internalApi] Ошибка обработки запроса:', e);
    sendJson(res, 500, { error: 'internal_error' });
    return true;
  }
}

module.exports = { handleInternalApiRequest };
