// Хранилище на SQLite (файл data.db в DATA_DIR) вместо прежнего JSON-файла.
// Внешний интерфейс (все методы объекта db.*) остался ТЕМ ЖЕ САМЫМ, что и в
// JSON-версии — поэтому весь остальной код бота (adminFlow.js, passengerFlow.js,
// keyboards.js и т.д.) не нужно менять ни на строчку, он просто продолжает
// вызывать db.addBooking(...), db.getBooking(...) и т.п. как раньше.
//
// Если бот раньше работал на JSON (data.json) — при первом запуске этой версии
// данные автоматически переносятся в SQLite один раз, старый файл при этом не
// удаляется, а переименовывается в data.json.bak (на всякий случай).

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const fmt = require('./format');

// На bothost.ru (и подобных хостингах) обычная файловая система контейнера стирается
// при каждой пересборке/перезапуске — переживает перезапуски только специальная папка,
// путь к которой передаётся через переменную DATA_DIR (на bothost.ru это /app/data).
// Локально (на телефоне в Termux) DATA_DIR не задан — тогда используем папку проекта,
// как и раньше, ничего не меняя для уже работающей установки.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
const DB_PATH = path.join(DATA_DIR, 'data.db');
const LEGACY_JSON_PATH = path.join(DATA_DIR, 'data.json');
const isFreshDb = !fs.existsSync(DB_PATH);

console.log(
  `[store] Файл базы данных: ${DB_PATH} (DATA_DIR ${process.env.DATA_DIR ? 'задан из окружения' : 'не задан, используется папка проекта'})`
);

const conn = new Database(DB_PATH);
conn.pragma('journal_mode = WAL');

conn.exec(`
  CREATE TABLE IF NOT EXISTS schedule (
    id TEXT PRIMARY KEY,
    direction TEXT NOT NULL,
    time TEXT NOT NULL,
    weekdays TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS schedule_overrides (
    date TEXT NOT NULL,
    template_id TEXT NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0,
    time TEXT,
    PRIMARY KEY (date, template_id)
  );

  CREATE TABLE IF NOT EXISTS bookings (
    id TEXT PRIMARY KEY,
    scheduleId TEXT,
    date TEXT,
    direction TEXT,
    time TEXT,
    village TEXT,
    address TEXT,
    name TEXT,
    phone TEXT,
    seats INTEGER NOT NULL DEFAULT 0,
    note TEXT,
    userId INTEGER,
    status TEXT NOT NULL DEFAULT 'new',
    source TEXT NOT NULL DEFAULT 'bot',
    kind TEXT NOT NULL DEFAULT 'passenger',
    rideConfirmed TEXT,
    createdAt INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_bookings_trip ON bookings(scheduleId, date);
  CREATE INDEX IF NOT EXISTS idx_bookings_date_dir ON bookings(date, direction);
  CREATE INDEX IF NOT EXISTS idx_bookings_user ON bookings(userId, source);

  CREATE TABLE IF NOT EXISTS extra_cars (
    id TEXT PRIMARY KEY,
    date TEXT NOT NULL,
    direction TEXT NOT NULL,
    time TEXT NOT NULL,
    capacity INTEGER NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    createdAt INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_extracars_date ON extra_cars(date);

  CREATE TABLE IF NOT EXISTS auto_notified (key TEXT PRIMARY KEY);
  CREATE TABLE IF NOT EXISTS group_notified (key TEXT PRIMARY KEY);
  CREATE TABLE IF NOT EXISTS daily_broadcast_sent (key TEXT PRIMARY KEY);

  CREATE TABLE IF NOT EXISTS group_broadcast_messages (
    chatId INTEGER NOT NULL,
    date TEXT NOT NULL,
    messageId TEXT,
    signature TEXT,
    PRIMARY KEY (chatId, date)
  );

  -- Лист ожидания: кто просил сообщить, если на полностью занятый рейс
  -- освободится место. platform нужен, потому что userId у MAX и у ВК —
  -- разные пространства номеров (могут случайно совпасть как числа).
  CREATE TABLE IF NOT EXISTS waitlist (
    id TEXT PRIMARY KEY,
    scheduleId TEXT NOT NULL,
    date TEXT NOT NULL,
    direction TEXT,
    time TEXT,
    platform TEXT NOT NULL,
    userId TEXT NOT NULL,
    name TEXT,
    phone TEXT,
    createdAt INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_waitlist_trip ON waitlist(scheduleId, date);

  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
`);

// Миграция: число мест для конкретного рейса на конкретную дату (NULL — как обычно,
// из MAX_SEATS). Для уже существующей базы колонку добавляем один раз.
try {
  const cols = conn.prepare('PRAGMA table_info(schedule_overrides)').all();
  if (!cols.some((c) => c.name === 'capacity')) {
    conn.exec('ALTER TABLE schedule_overrides ADD COLUMN capacity INTEGER');
  }
} catch (e) {
  console.error('[store] Не удалось добавить колонку capacity:', e);
}

// --- Счётчики id (аналог nextBookingId/nextScheduleId/nextExtraCarId из JSON) ---

const stmtGetMeta = conn.prepare('SELECT value FROM meta WHERE key = ?');
const stmtSetMeta = conn.prepare(
  'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
);

function getMeta(key, defaultValue) {
  const row = stmtGetMeta.get(key);
  return row ? Number(row.value) : defaultValue;
}

function setMeta(key, value) {
  stmtSetMeta.run(key, String(value));
}

// --- Разовый перенос данных из старого data.json (если он есть) ---

function migrateFromJsonIfNeeded() {
  if (!fs.existsSync(LEGACY_JSON_PATH)) return;
  console.log('[store] Обнаружен старый data.json — переношу данные в SQLite...');
  let legacy;
  try {
    legacy = JSON.parse(fs.readFileSync(LEGACY_JSON_PATH, 'utf8'));
  } catch (e) {
    console.error('[store] Не удалось прочитать старый data.json, миграция пропущена:', e);
    return;
  }

  const insertSchedule = conn.prepare(
    'INSERT INTO schedule (id, direction, time, weekdays, active) VALUES (?,?,?,?,?)'
  );
  const insertOverride = conn.prepare(
    'INSERT INTO schedule_overrides (date, template_id, deleted, time) VALUES (?,?,?,?)'
  );
  const insertBooking = conn.prepare(`
    INSERT INTO bookings
      (id, scheduleId, date, direction, time, village, address, name, phone, seats, note, userId, status, source, kind, rideConfirmed, createdAt)
    VALUES
      (@id, @scheduleId, @date, @direction, @time, @village, @address, @name, @phone, @seats, @note, @userId, @status, @source, @kind, @rideConfirmed, @createdAt)
  `);
  const insertExtraCar = conn.prepare(
    'INSERT INTO extra_cars (id, date, direction, time, capacity, active, createdAt) VALUES (?,?,?,?,?,?,?)'
  );
  const insertKey = (table) => conn.prepare(`INSERT OR IGNORE INTO ${table} (key) VALUES (?)`);
  const insertAutoNotified = insertKey('auto_notified');
  const insertGroupNotified = insertKey('group_notified');
  const insertDailyBroadcastSent = insertKey('daily_broadcast_sent');
  const insertBroadcastMessage = conn.prepare(
    'INSERT OR REPLACE INTO group_broadcast_messages (chatId, date, messageId, signature) VALUES (?,?,?,?)'
  );

  const tx = conn.transaction(() => {
    (legacy.schedule || []).forEach((s) => {
      insertSchedule.run(
        s.id,
        s.direction,
        s.time,
        JSON.stringify(Array.isArray(s.weekdays) ? s.weekdays : [0, 1, 2, 3, 4, 5, 6]),
        s.active ? 1 : 0
      );
    });
    (legacy.scheduleOverrides || []).forEach((o) => {
      insertOverride.run(o.date, o.templateId, o.deleted ? 1 : 0, o.time || null);
    });
    (legacy.bookings || []).forEach((b) => {
      insertBooking.run({
        id: b.id,
        scheduleId: b.scheduleId || null,
        date: b.date || null,
        direction: b.direction || null,
        time: b.time || null,
        village: b.village || null,
        address: b.address || null,
        name: b.name || null,
        phone: b.phone || null,
        seats: b.seats || 0,
        note: b.note || null,
        userId: b.userId || null,
        status: b.status || 'new',
        source: b.source || 'bot',
        kind: b.kind || 'passenger',
        rideConfirmed: b.rideConfirmed || null,
        createdAt: b.createdAt || Date.now(),
      });
    });
    (legacy.extraCars || []).forEach((c) => {
      insertExtraCar.run(c.id, c.date, c.direction, c.time, c.capacity, c.active ? 1 : 0, c.createdAt || Date.now());
    });
    (legacy.autoNotified || []).forEach((k) => insertAutoNotified.run(k));
    (legacy.groupNotified || []).forEach((k) => insertGroupNotified.run(k));
    (legacy.dailyBroadcastSent || []).forEach((k) => insertDailyBroadcastSent.run(k));
    (legacy.groupBroadcastMessages || []).forEach((m) => {
      insertBroadcastMessage.run(m.chatId, m.date, m.messageId, m.signature || null);
    });
    setMeta('nextBookingId', legacy.nextBookingId || 1);
    setMeta('nextScheduleId', legacy.nextScheduleId || 13);
    setMeta('nextExtraCarId', legacy.nextExtraCarId || 1);
  });
  tx();

  try {
    fs.renameSync(LEGACY_JSON_PATH, `${LEGACY_JSON_PATH}.bak`);
    console.log('[store] Миграция завершена. Старый файл сохранён как data.json.bak на всякий случай.');
  } catch (e) {
    console.error('[store] Данные перенесены, но не удалось переименовать старый data.json в .bak:', e);
  }
}

// Расписание-шаблон по умолчанию для полностью нового бота (ни JSON, ни SQLite
// данных ещё не было). Совпадает с тем, что раньше было в defaultData() у
// JSON-версии. direction: 'YA_UFA' (Акьяр → Уфа) или 'UFA_YA' (Уфа → Акьяр).
//
// Расписание единое на каждый день недели (без разбивки на будни/выходные) —
// по актуальной афише конкурента-образца: 5 рейсов Акьяр→Уфа и 7 рейсов
// Уфа→Акьяр, ежедневно. Ночной рейс записан как "24:00" (как на афише), поэтому
// при сортировке по времени он идёт ПОСЛЕДНИМ в списке дня — после 21:00.
const DEFAULT_SCHEDULE = [
  // Акьяр → Уфа
  { id: 's1', direction: 'YA_UFA', time: '09:00', weekdays: [0, 1, 2, 3, 4, 5, 6], active: true },
  { id: 's2', direction: 'YA_UFA', time: '12:00', weekdays: [0, 1, 2, 3, 4, 5, 6], active: true },
  { id: 's3', direction: 'YA_UFA', time: '15:00', weekdays: [0, 1, 2, 3, 4, 5, 6], active: true },
  { id: 's4', direction: 'YA_UFA', time: '18:00', weekdays: [0, 1, 2, 3, 4, 5, 6], active: true },
  { id: 's5', direction: 'YA_UFA', time: '24:00', weekdays: [0, 1, 2, 3, 4, 5, 6], active: true },
  // Уфа → Акьяр
  { id: 's6', direction: 'UFA_YA', time: '06:00', weekdays: [0, 1, 2, 3, 4, 5, 6], active: true },
  { id: 's7', direction: 'UFA_YA', time: '09:00', weekdays: [0, 1, 2, 3, 4, 5, 6], active: true },
  { id: 's8', direction: 'UFA_YA', time: '12:00', weekdays: [0, 1, 2, 3, 4, 5, 6], active: true },
  { id: 's9', direction: 'UFA_YA', time: '13:00', weekdays: [0, 1, 2, 3, 4, 5, 6], active: true },
  { id: 's10', direction: 'UFA_YA', time: '15:00', weekdays: [0, 1, 2, 3, 4, 5, 6], active: true },
  { id: 's11', direction: 'UFA_YA', time: '18:00', weekdays: [0, 1, 2, 3, 4, 5, 6], active: true },
  { id: 's12', direction: 'UFA_YA', time: '21:00', weekdays: [0, 1, 2, 3, 4, 5, 6], active: true },
];

function seedDefaultScheduleIfEmpty() {
  const count = conn.prepare('SELECT COUNT(*) AS c FROM schedule').get().c;
  if (count > 0) return;
  const insertSchedule = conn.prepare(
    'INSERT INTO schedule (id, direction, time, weekdays, active) VALUES (?,?,?,?,?)'
  );
  const tx = conn.transaction(() => {
    DEFAULT_SCHEDULE.forEach((s) => {
      insertSchedule.run(s.id, s.direction, s.time, JSON.stringify(s.weekdays), s.active ? 1 : 0);
    });
    setMeta('nextScheduleId', 13);
  });
  tx();
}

// Разовая миграция расписания на новый тайминг (Акьяр ↔ Уфа по актуальной
// афише). В отличие от seedDefaultScheduleIfEmpty выше, эта функция трогает
// таблицу, даже если в ней УЖЕ есть записи — потому что для уже работающей
// установки (не пустая база) обычный seed ничего не сделает. Флаг в meta не
// даёт запускать её повторно на каждом старте бота (например, если админ
// потом сам поправит время рейса вручную — это не должно откатываться назад).
// Старые записи schedule_overrides (правки/удаления конкретных дат для
// старых id рейсов) тоже удаляются — они всё равно ссылались на id, которых
// больше нет. На уже прошедшие заявки (bookings) это не влияет: там дата,
// направление, время и число мест сохранены прямо в самой заявке, отдельно
// от таблицы schedule.
function migrateScheduleAkyarV2IfNeeded() {
  if (getMeta('scheduleMigratedAkyarV2', 0)) return;
  const insertSchedule = conn.prepare(
    'INSERT INTO schedule (id, direction, time, weekdays, active) VALUES (?,?,?,?,?)'
  );
  const tx = conn.transaction(() => {
    conn.prepare('DELETE FROM schedule_overrides').run();
    conn.prepare('DELETE FROM schedule').run();
    DEFAULT_SCHEDULE.forEach((s) => {
      insertSchedule.run(s.id, s.direction, s.time, JSON.stringify(s.weekdays), s.active ? 1 : 0);
    });
    setMeta('nextScheduleId', 13);
    setMeta('scheduleMigratedAkyarV2', 1);
  });
  tx();
  console.log('[store] Расписание обновлено на новый тайминг Акьяр ↔ Уфа (по афише).');
}

migrateScheduleAkyarV2IfNeeded();

// Разовая миграция: время "00:00" -> "24:00" везде (шаблон расписания, правки
// на даты, доп. машины, заявки, лист ожидания), чтобы ночной рейс шёл в списке
// после 21:00, а не первым. Флаг в meta — повторно не запускается.
function migrateMidnightTo2400IfNeeded() {
  if (getMeta('migratedMidnightTo2400', 0)) return;
  const tx = conn.transaction(() => {
    ['schedule', 'schedule_overrides', 'extra_cars', 'bookings', 'waitlist'].forEach((table) => {
      conn.prepare(`UPDATE ${table} SET time = '24:00' WHERE time IN ('00:00', '0:00')`).run();
    });
    setMeta('migratedMidnightTo2400', 1);
  });
  tx();
  console.log('[store] Время 00:00 заменено на 24:00.');
}

migrateMidnightTo2400IfNeeded();

if (isFreshDb) {
  migrateFromJsonIfNeeded();
  seedDefaultScheduleIfEmpty();
  if (!stmtGetMeta.get('nextBookingId')) setMeta('nextBookingId', 1);
  if (!stmtGetMeta.get('nextExtraCarId')) setMeta('nextExtraCarId', 1);
}

// --- Преобразование строк SQLite в те же объекты, что отдавала JSON-версия ---

function rowToScheduleItem(row) {
  if (!row) return null;
  return {
    id: row.id,
    direction: row.direction,
    time: row.time,
    weekdays: JSON.parse(row.weekdays),
    active: !!row.active,
  };
}

function rowToOverride(row) {
  if (!row) return null;
  return {
    date: row.date,
    templateId: row.template_id,
    deleted: !!row.deleted,
    time: row.time,
    capacity: row.capacity || null,
  };
}

function rowToExtraCar(row) {
  if (!row) return null;
  return {
    id: row.id,
    date: row.date,
    direction: row.direction,
    time: row.time,
    capacity: row.capacity,
    active: !!row.active,
    createdAt: row.createdAt,
  };
}

function rowToBroadcastMessage(row) {
  if (!row) return null;
  return { chatId: row.chatId, date: row.date, messageId: row.messageId, signature: row.signature };
}

// Бронирования (bookings) хранятся почти 1-в-1 с исходным объектом — колонки
// названы так же, как поля в JS, поэтому дополнительного маппинга не нужно,
// кроме превращения "нет строки" в null (в SQLite .get() и так возвращает
// undefined, приводим к null для единообразия с прежним API).
function rowToBooking(row) {
  return row || null;
}

// --- Подготовленные запросы ---

const stmt = {
  allSchedule: conn.prepare('SELECT * FROM schedule'),
  getScheduleItem: conn.prepare('SELECT * FROM schedule WHERE id = ?'),
  insertSchedule: conn.prepare('INSERT INTO schedule (id, direction, time, weekdays, active) VALUES (?,?,?,?,?)'),
  updateSchedule: conn.prepare('UPDATE schedule SET direction=?, time=?, weekdays=?, active=? WHERE id=?'),
  deleteSchedule: conn.prepare('DELETE FROM schedule WHERE id = ?'),
  deleteOverridesByTemplate: conn.prepare('DELETE FROM schedule_overrides WHERE template_id = ?'),

  getOverride: conn.prepare('SELECT * FROM schedule_overrides WHERE date = ? AND template_id = ?'),
  upsertOverride: conn.prepare(`
    INSERT INTO schedule_overrides (date, template_id, deleted, time, capacity) VALUES (?,?,?,?,?)
    ON CONFLICT(date, template_id) DO UPDATE SET deleted = excluded.deleted, time = excluded.time, capacity = excluded.capacity
  `),
  deleteOverride: conn.prepare('DELETE FROM schedule_overrides WHERE date = ? AND template_id = ?'),

  getBooking: conn.prepare('SELECT * FROM bookings WHERE id = ?'),
  getBookingsForTrip: conn.prepare('SELECT * FROM bookings WHERE scheduleId = ? AND date = ?'),
  getBookingsByDateDirection: conn.prepare(
    "SELECT * FROM bookings WHERE date = ? AND direction = ? AND status != 'cancelled'"
  ),
  // source разделяет MAX ('bot') и ВК ('vk') — у этих двух платформ независимые
  // числовые пространства userId, одно и то же число может принадлежать разным
  // людям на разных площадках, поэтому без source получилась бы путаница
  // (и потенциально можно было бы увидеть/отменить чужую заявку с другой
  // платформы, если id случайно совпали).
  getBookingsByUserId: conn.prepare('SELECT * FROM bookings WHERE userId = ? AND source = ? ORDER BY date DESC, time DESC'),
  insertBooking: conn.prepare(`
    INSERT INTO bookings
      (id, scheduleId, date, direction, time, village, address, name, phone, seats, note, userId, status, source, kind, rideConfirmed, createdAt)
    VALUES
      (@id, @scheduleId, @date, @direction, @time, @village, @address, @name, @phone, @seats, @note, @userId, @status, @source, @kind, @rideConfirmed, @createdAt)
  `),
  updateBooking: conn.prepare(`
    UPDATE bookings SET
      scheduleId=@scheduleId, date=@date, direction=@direction, time=@time, village=@village,
      address=@address, name=@name, phone=@phone, seats=@seats, note=@note, userId=@userId,
      status=@status, source=@source, kind=@kind, rideConfirmed=@rideConfirmed, createdAt=@createdAt
    WHERE id=@id
  `),

  getExtraCar: conn.prepare('SELECT * FROM extra_cars WHERE id = ?'),
  getExtraCarsForDate: conn.prepare('SELECT * FROM extra_cars WHERE date = ? AND active = 1'),
  insertExtraCar: conn.prepare(
    'INSERT INTO extra_cars (id, date, direction, time, capacity, active, createdAt) VALUES (?,?,?,?,?,?,?)'
  ),
  updateExtraCar: conn.prepare(
    'UPDATE extra_cars SET date=?, direction=?, time=?, capacity=?, active=?, createdAt=? WHERE id=?'
  ),
  deleteExtraCar: conn.prepare('DELETE FROM extra_cars WHERE id = ?'),

  insertWaitlist: conn.prepare(`
    INSERT INTO waitlist (id, scheduleId, date, direction, time, platform, userId, name, phone, createdAt)
    VALUES (@id, @scheduleId, @date, @direction, @time, @platform, @userId, @name, @phone, @createdAt)
  `),
  getWaitlistForTrip: conn.prepare(
    'SELECT * FROM waitlist WHERE scheduleId = ? AND date = ? ORDER BY createdAt ASC'
  ),
  getWaitlistTrips: conn.prepare('SELECT DISTINCT scheduleId, date FROM waitlist'),
  findWaitlistEntry: conn.prepare(
    'SELECT * FROM waitlist WHERE scheduleId = ? AND date = ? AND platform = ? AND userId = ?'
  ),
  deleteWaitlistEntry: conn.prepare('DELETE FROM waitlist WHERE id = ?'),
  deleteWaitlistForTrip: conn.prepare('DELETE FROM waitlist WHERE scheduleId = ? AND date = ?'),

  hasKey: (table) => conn.prepare(`SELECT 1 FROM ${table} WHERE key = ?`),
  insertKey: (table) => conn.prepare(`INSERT OR IGNORE INTO ${table} (key) VALUES (?)`),
  pruneKeys: (table) => conn.prepare(`DELETE FROM ${table} WHERE key NOT LIKE ? AND key NOT LIKE ?`),

  getBroadcastMessage: conn.prepare('SELECT * FROM group_broadcast_messages WHERE chatId = ? AND date = ?'),
  upsertBroadcastMessage: conn.prepare(`
    INSERT INTO group_broadcast_messages (chatId, date, messageId, signature) VALUES (?,?,?,?)
    ON CONFLICT(chatId, date) DO UPDATE SET messageId = excluded.messageId, signature = excluded.signature
  `),
  deleteBroadcastMessage: conn.prepare('DELETE FROM group_broadcast_messages WHERE chatId = ? AND date = ?'),
  allBroadcastMessages: conn.prepare('SELECT * FROM group_broadcast_messages'),
};

const hasAutoNotified = stmt.hasKey('auto_notified');
const insertAutoNotified = stmt.insertKey('auto_notified');
const pruneAutoNotified = stmt.pruneKeys('auto_notified');

const hasGroupNotified = stmt.hasKey('group_notified');
const insertGroupNotified = stmt.insertKey('group_notified');
const pruneGroupNotified = stmt.pruneKeys('group_notified');

const hasDailyBroadcastSent = stmt.hasKey('daily_broadcast_sent');
const insertDailyBroadcastSent = stmt.insertKey('daily_broadcast_sent');
const pruneDailyBroadcastSent = conn.prepare('DELETE FROM daily_broadcast_sent WHERE key NOT LIKE ?');

// --- Публичный интерфейс — те же методы, что были у JSON-версии store.js ---

const db = {
  getSchedule(direction) {
    return stmt.allSchedule.all().map(rowToScheduleItem).filter((s) => !direction || s.direction === direction);
  },

  getScheduleItem(id) {
    return rowToScheduleItem(stmt.getScheduleItem.get(id));
  },

  addScheduleItem(direction, time, weekdays) {
    const nextId = getMeta('nextScheduleId', 13);
    const id = `s${nextId}`;
    setMeta('nextScheduleId', nextId + 1);
    const wd = Array.isArray(weekdays) && weekdays.length ? weekdays : [0, 1, 2, 3, 4, 5, 6];
    stmt.insertSchedule.run(id, direction, time, JSON.stringify(wd), 1);
    return db.getScheduleItem(id);
  },

  updateScheduleItem(id, patch) {
    const item = db.getScheduleItem(id);
    if (!item) return null;
    const merged = { ...item, ...patch };
    stmt.updateSchedule.run(merged.direction, merged.time, JSON.stringify(merged.weekdays), merged.active ? 1 : 0, id);
    return merged;
  },

  deleteScheduleItem(id) {
    stmt.deleteSchedule.run(id);
    // Заодно убираем все исключения на конкретные даты, которые ссылались на этот рейс
    stmt.deleteOverridesByTemplate.run(id);
  },

  // Рейсы шаблона (без учёта исключений), которые актуальны для дня недели данной даты
  getScheduleForWeekday(date, direction) {
    const weekday = new Date(`${date}T00:00:00`).getDay();
    return db
      .getSchedule(direction)
      .filter((s) => s.active && s.weekdays.includes(weekday));
  },

  // Рейсы на конкретную дату с учётом исключений (изменённое время / отмена на этот день)
  getScheduleForDate(date, direction) {
    return db
      .getScheduleForWeekday(date, direction)
      .map((s) => {
        const ov = db.getOverride(date, s.id);
        if (ov && ov.deleted) return null;
        return {
          ...s,
          time: ov && ov.time ? ov.time : s.time,
          overridden: !!(ov && ov.time),
          capacity: ov && ov.capacity ? ov.capacity : null,
        };
      })
      .filter(Boolean);
  },

  // --- Исключения из шаблона на конкретную дату ---

  getOverride(date, templateId) {
    return rowToOverride(stmt.getOverride.get(date, templateId));
  },

  setOverrideTime(date, templateId, time) {
    const existing = db.getOverride(date, templateId);
    stmt.upsertOverride.run(date, templateId, 0, time, existing ? existing.capacity : null);
    return db.getOverride(date, templateId);
  },

  // Число мест в рейсе ТОЛЬКО на эту дату (шаблон и другие дни не меняются).
  // capacity = null — вернуть обычное число мест (MAX_SEATS).
  setOverrideCapacity(date, templateId, capacity) {
    const existing = db.getOverride(date, templateId);
    stmt.upsertOverride.run(
      date,
      templateId,
      existing && existing.deleted ? 1 : 0,
      existing ? existing.time : null,
      capacity
    );
    return db.getOverride(date, templateId);
  },

  setOverrideDeleted(date, templateId) {
    const existing = db.getOverride(date, templateId);
    stmt.upsertOverride.run(date, templateId, 1, existing ? existing.time : null, existing ? existing.capacity : null);
    return db.getOverride(date, templateId);
  },

  // Убирает исключение на эту дату (и отмену, и изменённое время) — рейс снова
  // идёт как в обычном шаблоне
  clearOverride(date, templateId) {
    stmt.deleteOverride.run(date, templateId);
  },

  // --- Авто-уведомление водителя перед рейсом (DRIVER_AUTO_NOTIFY_MINUTES) ---

  wasAutoNotified(date, carId) {
    return !!hasAutoNotified.get(`${date}|${carId}`);
  },

  markAutoNotified(date, carId) {
    const key = `${date}|${carId}`;
    insertAutoNotified.run(key);
    // Заодно чистим отметки за прошлые дни, чтобы таблица не росла бесконечно —
    // оставляем только сегодняшние и завтрашние (единственные даты, которые
    // вообще проверяются на автоотправку).
    const today = fmt.todayISO();
    const tomorrow = fmt.tomorrowISO();
    pruneAutoNotified.run(`${today}|%`, `${tomorrow}|%`);
  },

  // --- Автообъявление в группу о свободных местах (GROUP_AUTO_NOTIFY_MINUTES) ---

  wasGroupNotified(date, carId) {
    return !!hasGroupNotified.get(`${date}|${carId}`);
  },

  markGroupNotified(date, carId) {
    const key = `${date}|${carId}`;
    insertGroupNotified.run(key);
    const today = fmt.todayISO();
    const tomorrow = fmt.tomorrowISO();
    pruneGroupNotified.run(`${today}|%`, `${tomorrow}|%`);
  },

  // --- Ежедневная автоматическая рассылка о свободных местах (DAILY_BROADCAST_TIME) ---

  // key различает рассылку за "сегодня" и за "завтра" в рамках одного запуска —
  // это два отдельных сообщения, поэтому и отметки о них должны быть раздельными.
  wasDailyBroadcastSent(triggerDate, key) {
    return !!hasDailyBroadcastSent.get(`${triggerDate}|${key}`);
  },

  markDailyBroadcastSent(triggerDate, key) {
    const entry = `${triggerDate}|${key}`;
    insertDailyBroadcastSent.run(entry);
    // Чистим старые отметки — оставляем только сегодняшнюю дату запуска, чтобы
    // таблица не росла бесконечно.
    const today = fmt.todayISO();
    pruneDailyBroadcastSent.run(`${today}|%`);
  },

  // --- "Живые" объявления о свободных местах в группах (для замены устаревших) ---

  getGroupBroadcastMessage(chatId, date) {
    return rowToBroadcastMessage(stmt.getBroadcastMessage.get(Number(chatId), date));
  },

  setGroupBroadcastMessage(chatId, date, messageId, signature) {
    // Просроченные записи (за вчера и раньше) чистит cleanupExpiredGroupBroadcasts
    // в groupUtil.js — она сначала удаляет само сообщение в группе, и только
    // потом убирает запись отсюда. Здесь специально не чистим по дате, чтобы
    // не потерять отметку о сообщении, которое ещё не успели удалить.
    stmt.upsertBroadcastMessage.run(Number(chatId), date, messageId, signature || null);
  },

  clearGroupBroadcastMessage(chatId, date) {
    stmt.deleteBroadcastMessage.run(Number(chatId), date);
  },

  // Для периодической чистки просроченных (вчерашних и старее) объявлений —
  // см. cleanupExpiredGroupBroadcasts в groupUtil.js.
  getAllGroupBroadcastMessages() {
    return stmt.allBroadcastMessages.all().map(rowToBroadcastMessage);
  },

  // --- Универсальное хранилище "ключ → значение" (использует ту же таблицу
  // meta, что и счётчики id) — нужно другим ботам (например, ВК-боту), у
  // которых нет прямого доступа к файлу базы: через внутреннее API (см.
  // internalApi.js) они могут хранить здесь своё состояние (например, id
  // последнего поста на стене ВК), не заводя для этого отдельную базу.
  getKV(key) {
    const raw = stmtGetMeta.get(`kv:${key}`);
    if (!raw) return null;
    try {
      return JSON.parse(raw.value);
    } catch (e) {
      return raw.value;
    }
  },

  setKV(key, value) {
    setMeta(`kv:${key}`, JSON.stringify(value));
  },

  // date в формате YYYY-MM-DD
  getBookingsForTrip(scheduleId, date) {
    return stmt.getBookingsForTrip.all(scheduleId, date).map(rowToBooking);
  },

  getActiveBookingsForTrip(scheduleId, date) {
    // Посылки показываем после пассажиров — так админ и водитель сначала видят людей,
    // а посылки идут отдельным блоком внизу списка.
    return db
      .getBookingsForTrip(scheduleId, date)
      .filter((b) => b.status !== 'cancelled')
      .sort((a, b) => (a.kind === 'parcel' ? 1 : 0) - (b.kind === 'parcel' ? 1 : 0));
  },

  // Посылка не занимает место в машине — даже если рейс полностью укомплектован
  // пассажирами, машина всё равно должна взять посылку. Поэтому в подсчёт занятых
  // мест идут только пассажирские заявки.
  occupiedSeats(scheduleId, date) {
    return db
      .getActiveBookingsForTrip(scheduleId, date)
      .filter((b) => b.kind !== 'parcel')
      .reduce((sum, b) => sum + b.seats, 0);
  },

  getBooking(id) {
    return rowToBooking(stmt.getBooking.get(id));
  },

  addBooking(booking) {
    const nextId = getMeta('nextBookingId', 1);
    const id = `b${nextId}`;
    setMeta('nextBookingId', nextId + 1);
    const full = {
      id,
      scheduleId: null,
      date: null,
      direction: null,
      time: null,
      village: null,
      address: null,
      name: null,
      phone: null,
      seats: 0,
      note: null,
      userId: null,
      status: 'new', // new | confirmed | cancelled | sent
      source: 'bot', // bot | manual
      kind: 'passenger', // passenger | parcel
      // Подтверждение самим пассажиром, что он точно едет (не путать со status
      // 'confirmed' — тем админ подтверждает саму заявку). null — ещё не спрашивали
      // или пассажир не ответил; 'yes' — подтвердил; 'no' — сказал, что не едет.
      rideConfirmed: null,
      createdAt: Date.now(),
      ...booking,
    };
    stmt.insertBooking.run(full);
    return full;
  },

  updateBooking(id, patch) {
    const b = db.getBooking(id);
    if (!b) return null;
    const merged = { ...b, ...patch };
    stmt.updateBooking.run(merged);
    return merged;
  },

  getBookingsByDateDirection(date, direction) {
    return stmt.getBookingsByDateDirection.all(date, direction).map(rowToBooking);
  },

  // "Мои заказы": все заявки конкретного человека (поездки и посылки вместе) —
  // source обязателен, чтобы не перепутать людей с одинаковым числовым id на
  // MAX и на ВК (см. комментарий у getBookingsByUserId в списке stmt выше).
  getBookingsByUserId(userId, source) {
    return stmt.getBookingsByUserId.all(Number(userId), source).map(rowToBooking);
  },

  // --- Дополнительные машины (попутки) на конкретную дату ---

  getExtraCarsForDate(date, direction) {
    return stmt.getExtraCarsForDate
      .all(date)
      .map(rowToExtraCar)
      .filter((c) => !direction || c.direction === direction);
  },

  getExtraCar(id) {
    return rowToExtraCar(stmt.getExtraCar.get(id));
  },

  addExtraCar(date, direction, time, capacity) {
    const nextId = getMeta('nextExtraCarId', 1);
    const id = `x${nextId}`;
    setMeta('nextExtraCarId', nextId + 1);
    const createdAt = Date.now();
    stmt.insertExtraCar.run(id, date, direction, time, capacity, 1, createdAt);
    return { id, date, direction, time, capacity, active: true, createdAt };
  },

  updateExtraCar(id, patch) {
    const car = db.getExtraCar(id);
    if (!car) return null;
    const merged = { ...car, ...patch };
    stmt.updateExtraCar.run(
      merged.date,
      merged.direction,
      merged.time,
      merged.capacity,
      merged.active ? 1 : 0,
      merged.createdAt,
      id
    );
    return merged;
  },

  deleteExtraCar(id) {
    stmt.deleteExtraCar.run(id);
  },

  // --- Лист ожидания на полностью занятые рейсы ---

  // Возвращает существующую запись (если уже стоит в очереди на этот рейс)
  // или null — используется, чтобы не добавлять одного и того же человека
  // в очередь дважды.
  findWaitlistEntry(scheduleId, date, platform, userId) {
    return stmt.findWaitlistEntry.get(scheduleId, date, platform, String(userId)) || null;
  },

  addWaitlistEntry({ scheduleId, date, direction, time, platform, userId, name, phone }) {
    const nextId = getMeta('nextWaitlistId', 1);
    const id = `w${nextId}`;
    setMeta('nextWaitlistId', nextId + 1);
    const entry = {
      id,
      scheduleId,
      date,
      direction: direction || null,
      time: time || null,
      platform,
      userId: String(userId),
      name: name || null,
      phone: phone || null,
      createdAt: Date.now(),
    };
    stmt.insertWaitlist.run(entry);
    return entry;
  },

  getWaitlistForTrip(scheduleId, date) {
    return stmt.getWaitlistForTrip.all(scheduleId, date);
  },

  // Список всех рейсов, на которые сейчас хоть кто-то стоит в очереди —
  // нужен фоновой проверке (waitlistAutoNotify.js), чтобы не сканировать
  // всё расписание целиком, а смотреть только туда, где вообще есть смысл.
  getWaitlistTrips() {
    return stmt.getWaitlistTrips.all();
  },

  removeWaitlistEntry(id) {
    stmt.deleteWaitlistEntry.run(id);
  },

  // Вызывается после того, как всех в очереди на этот рейс уже оповестили —
  // одно оповещение на человека, повторно в очередь он попадёт, только если
  // запишется сам ещё раз (см. w:join / p:waitlist в ботах).
  clearWaitlistForTrip(scheduleId, date) {
    stmt.deleteWaitlistForTrip.run(scheduleId, date);
  },

  // --- Тумблер автоматического запроса "точно едете?" (см. rideConfirmAutoNotify.js) ---
  // Хранится отдельно от RIDE_CONFIRM_AUTO_MINUTES в .env: переменная окружения задаёт
  // ЗА СКОЛЬКО минут спрашивать, а этот тумблер в главном меню админки позволяет жене
  // поставить функцию на паузу/включить обратно на лету, без перезапуска бота. По
  // умолчанию (пока никто не трогал кнопку) — включено.
  isRideConfirmAutoEnabled() {
    return getMeta('rideConfirmAutoEnabled', 1) !== 0;
  },

  setRideConfirmAutoEnabled(enabled) {
    setMeta('rideConfirmAutoEnabled', enabled ? 1 : 0);
  },
};

module.exports = db;
