// Храним состояние многошаговых диалогов (ожидание имени/телефона/кол-ва мест и т.п.)
// в памяти процесса, по userId. Для семейного бота с низкой нагрузкой этого достаточно —
// если бот перезапустится посреди заполнения формы, пользователь просто начнёт её заново.

const sessions = new Map();

function get(userId) {
  return sessions.get(userId) || null;
}

function set(userId, state) {
  sessions.set(userId, state);
}

function clear(userId) {
  sessions.delete(userId);
}

module.exports = { get, set, clear };
