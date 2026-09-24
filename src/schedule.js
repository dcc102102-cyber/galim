const db = require('./store');
const config = require('./config');
const fmt = require('./format');

// Рейс считается "прошедшим", если дата — сегодня, а время выезда уже наступило/прошло.
// Используем fmt.nowHM() (см. src/format.js) вместо new Date().getHours()/getMinutes()
// напрямую — те завязаны на то, что процесс правильно понимает TZ, а это не всегда
// верно на некоторых хостингах.
function isPastTrip(date, time) {
  return date === fmt.todayISO() && time <= fmt.nowHM();
}

// Идентификатор "машины" (carId) бывает двух видов:
//  - "s1", "s2", ...  — рейс из повторяющегося расписания (вместимость = config.maxSeats)
//  - "x1", "x2", ...  — разовая дополнительная машина на конкретную дату
//                       (вместимость задаётся вручную при добавлении)
// Само число мест хранится либо в config.maxSeats (для "s"), либо в объекте
// extraCar.capacity (для "x") — см. store.js.

function isExtraCarId(carId) {
  return typeof carId === 'string' && carId.startsWith('x');
}

// Возвращает {direction, time, capacity, isExtra} для любого carId, либо null.
// Если передана дата — время учитывает возможное исключение (изменённое время)
// именно на эту дату; без даты возвращается время из шаблона по умолчанию.
function carInfo(carId, date) {
  if (isExtraCarId(carId)) {
    const car = db.getExtraCar(carId);
    if (!car) return null;
    return { direction: car.direction, time: car.time, capacity: car.capacity, isExtra: true };
  }
  const item = db.getScheduleItem(carId);
  if (!item) return null;
  let time = item.time;
  if (date) {
    const ov = db.getOverride(date, carId);
    if (ov && ov.time) time = ov.time;
  }
  let capacity = config.maxSeats;
  if (date) {
    const ov = db.getOverride(date, carId);
    if (ov && ov.capacity) capacity = ov.capacity;
  }
  return { direction: item.direction, time, capacity, isExtra: false };
}

function capacityOf(carId, date) {
  const info = carInfo(carId, date);
  return info ? info.capacity : 0;
}

// Список рейсов (основных + доп. машин) на дату для одного направления, с учётом свободных мест.
// Основные рейсы берутся из шаблона по дню недели даты, с применением исключений на эту дату
// (изменённое время / отмена рейса именно в этот день — сам шаблон при этом не меняется).
function availableTrips(direction, date) {
  const scheduled = db
    .getScheduleForDate(date, direction)
    .filter((s) => !isPastTrip(date, s.time))
    .map((s) => {
      const occupied = db.occupiedSeats(s.id, date);
      const cap = s.capacity || config.maxSeats;
      return {
        id: s.id,
        time: s.time,
        occupied,
        max: cap,
        free: Math.max(0, cap - occupied),
        isExtra: false,
      };
    });

  const extra = db
    .getExtraCarsForDate(date, direction)
    .filter((c) => !isPastTrip(date, c.time))
    .map((c) => {
      const occupied = db.occupiedSeats(c.id, date);
      return {
        id: c.id,
        time: c.time,
        occupied,
        max: c.capacity,
        free: Math.max(0, c.capacity - occupied),
        isExtra: true,
      };
    });

  return [...scheduled, ...extra].sort((a, b) => a.time.localeCompare(b.time));
}

// Все рейсы (оба направления, основные + доп. машины) на дату — для админ-панели и водителя.
// В отличие от availableTrips, показывает рейсы независимо от того, прошло их время или нет —
// это нужно, чтобы жена/водитель видели весь день целиком.
function allTripsForDate(date) {
  const scheduled = db.getScheduleForDate(date).map((s) => {
    const occupied = db.occupiedSeats(s.id, date);
    const cap = s.capacity || config.maxSeats;
    return {
      id: s.id,
      direction: s.direction,
      time: s.time,
      occupied,
      max: cap,
      free: Math.max(0, cap - occupied),
      isExtra: false,
      overridden: s.overridden,
    };
  });

  const extra = db.getExtraCarsForDate(date).map((c) => {
    const occupied = db.occupiedSeats(c.id, date);
    return {
      id: c.id,
      direction: c.direction,
      time: c.time,
      occupied,
      max: c.capacity,
      free: Math.max(0, c.capacity - occupied),
      isExtra: true,
    };
  });

  // Сортируем строго по времени выезда — так список отражает реальный порядок дня одной
  // машины (утром выезд из деревни в Уфу, затем обратно, и так далее), а не группировку
  // по направлению.
  return [...scheduled, ...extra].sort((a, b) => a.time.localeCompare(b.time));
}

module.exports = { availableTrips, allTripsForDate, carInfo, capacityOf, isExtraCarId, isPastTrip };
