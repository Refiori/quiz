'use strict';
// ============================================================
//  Сервер викторины: комнаты, роли, раунды, модификации.
//  Вся игровая логика живёт здесь, клиентам не доверяем.
// ============================================================
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const XLSX = require('xlsx');

// ---------- Настройки ----------
const PORT = process.env.PORT || 3000;
const QUESTIONS_FILE = path.join(__dirname, 'questions.xlsx');
const MODS_PER_ROUND = 4;                      // сколько клеток в раунде — модификации
const MOD_AMOUNTS = [500, 1000, 1500, 2000];   // суммы для бонуса/штрафа
const MOD_KINDS = ['flip', 'bonus', 'penalty', 'swap', 'pass'];
const VALUES = [                               // номиналы по раундам
  [100, 200, 300, 400, 500],
  [200, 400, 600, 800, 1000],
  [300, 500, 800, 1000, 1500],
];
const MODIFIER_SHOW_MS = 4000;                 // сколько висит надпись «МОДИФИКАЦИЯ»

// ---------- Утилиты ----------
const pick = (a) => a[Math.floor(Math.random() * a.length)];
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
const cleanNick = (n) => String(n || '').trim().slice(0, 20);
const sameNick = (a, b) => a.toLowerCase() === b.toLowerCase();
const newToken = () => crypto.randomBytes(16).toString('hex');
function modLabel(kind, n) {
  return {
    flip: 'МИНУС: знак очков меняется',
    bonus: `БОНУС +${n}`,
    penalty: `ШТРАФ −${n}`,
    swap: 'ОБМЕН ОЧКАМИ',
    pass: 'ПЕРЕДАЧА ХОДА',
  }[kind];
}

// ---------- Чтение Excel ----------
// Колонка A — тема (5 строк подряд = 5 уровней сложности).
// Дальше пары колонок «вопрос — ответ»: запасные варианты для каждого уровня.
function loadQuestions() {
  if (!fs.existsSync(QUESTIONS_FILE)) {
    throw new Error('Не найден файл questions.xlsx рядом с server.js (создать пример: npm run sample)');
  }
  const wb = XLSX.readFile(QUESTIONS_FILE);
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' });
  const themes = [];
  for (const row of rows) {
    const name = String(row[0] ?? '').trim();
    if (!name || name.toLowerCase() === 'тема') continue;       // пустые строки и шапку пропускаем
    let t = themes[themes.length - 1];
    if (!t || t.name !== name) { t = { name, levels: [] }; themes.push(t); }
    const variants = [];
    for (let c = 1; c < row.length; c += 2) {
      const q = String(row[c] ?? '').trim();
      const a = String(row[c + 1] ?? '').trim();
      if (q) variants.push({ q, a });
    }
    t.levels.push(variants);
  }
  const ok = themes.filter((t) => t.levels.length >= 5 && t.levels.slice(0, 5).every((v) => v.length > 0));
  if (ok.length < 15) {
    throw new Error(`Нужно минимум 15 полных тем (по 5 строк с вопросами), найдено: ${ok.length}`);
  }
  return ok;
}

// 3 раунда × 5 тем × 5 уровней; часть клеток превращается в модификации
function buildRounds(themes) {
  const chosen = shuffle([...themes]).slice(0, 15);
  let id = 0;
  return [0, 1, 2].map((r) => {
    const cols = chosen.slice(r * 5, r * 5 + 5).map((t) => ({
      name: t.name,
      cells: t.levels.slice(0, 5).map((variants, lvl) => {
        const v = pick(variants);
        return { id: id++, value: VALUES[r][lvl], used: false, kind: 'question', q: v.q, a: v.a };
      }),
    }));
    const all = cols.flatMap((c) => c.cells);
    shuffle([...all]).slice(0, MODS_PER_ROUND).forEach((c) => {
      c.kind = pick(MOD_KINDS);
      c.n = pick(MOD_AMOUNTS);
      c.q = c.a = '';
    });
    return cols;
  });
}

// ---------- Комнаты ----------
const rooms = new Map();
function newCode() {
  const L = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let c;
  do { c = Array.from({ length: 4 }, () => pick([...L])).join(''); } while (rooms.has(c));
  return c;
}
const playerById = (room, id) => room.players.find((p) => p.id === id);
const randomPlayer = (room) => pick(room.players);
function nextPlayer(room, id) {
  const i = room.players.findIndex((p) => p.id === id);
  return room.players[(i + 1) % room.players.length];
}
const roundCells = (room) => room.rounds[room.round].flatMap((c) => c.cells);

// Что видит конкретный участник. Правильный ответ — только ведущий!
function snapshot(room, role, me) {
  const s = {
    code: room.code, state: room.state, round: room.round + 1,
    role, host: room.host.nick, hostConnected: room.host.connected,
    meId: me ? me.id : null, chooserId: room.chooser,
    players: room.players.map((p) => ({ id: p.id, nick: p.nick, score: p.score, connected: p.connected })),
  };
  if (['board', 'question', 'modifier'].includes(room.state)) {
    s.board = room.rounds[room.round].map((c) => ({
      name: c.name,
      cells: c.cells.map((x) => ({ id: x.id, value: x.value, used: x.used })), // тип клетки скрыт
    }));
  }
  const cur = room.current;
  if (cur && room.state === 'question') {
    s.question = {
      theme: cur.theme, value: cur.cell.value, text: cur.cell.q,
      buzzerId: cur.buzzer, answeredIds: [...cur.done],
    };
    if (role === 'host') s.question.answer = cur.cell.a;
    if (role === 'player') s.question.canBuzz = cur.buzzer === null && !cur.done.has(me.id);
  }
  if (cur && room.state === 'modifier') {
    s.modifier = {
      kind: cur.kind, label: modLabel(cur.kind, cur.n),
      playerId: cur.playerId, waiting: cur.waiting, swapWithId: cur.swapWithId || null,
    };
    if (role === 'host' && cur.waiting) {
      s.modifier.targets = room.players.filter((p) => p.id !== cur.playerId).map((p) => p.id);
    }
  }
  if (room.state === 'finished') {
    const sorted = [...room.players].sort((a, b) => b.score - a.score);
    s.results = sorted.map((p) => ({ id: p.id, nick: p.nick, score: p.score }));
    s.winners = sorted.filter((p) => p.score === sorted[0].score).map((p) => p.nick);
  }
  return s;
}

// ---------- Сервер ----------
const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static(path.join(__dirname, 'public')));  // только public/, Excel наружу не отдаём

function broadcast(room) {
  for (const m of [room.host, ...room.players]) {
    if (!m.sid) continue;
    const isHost = m === room.host;
    io.to(m.sid).emit('state', snapshot(room, isHost ? 'host' : 'player', isHost ? null : m));
  }
}

// Закрыть клетку; переход в следующий раунд / финал
function afterCellClosed(room) {
  if (roundCells(room).some((c) => !c.used)) return;
  if (room.round < 2) room.round++;
  else room.state = 'finished';
}
function closeQuestion(room, winnerId) {
  room.current.cell.used = true;
  room.current = null;
  room.state = 'board';
  room.chooser = winnerId ?? randomPlayer(room).id;  // никто не ответил верно — выбирает случайный игрок
  afterCellClosed(room);
}
function checkAllDone(room) {
  const cur = room.current;
  if (room.players.every((p) => cur.done.has(p.id))) closeQuestion(room, null);
}
function scheduleAfterModifier(room) {
  clearTimeout(room.timer);
  room.timer = setTimeout(() => {
    room.timer = null;
    if (room.state !== 'modifier') return;
    room.current = null;
    room.state = 'board';
    afterCellClosed(room);
    broadcast(room);
  }, MODIFIER_SHOW_MS);
}

io.on('connection', (socket) => {
  const attach = (code, token) => { socket.join(code); socket.data.code = code; socket.data.token = token; };
  const ctx = () => {
    const room = rooms.get(socket.data.code);
    if (!room) return {};
    if (room.host.token === socket.data.token) return { room, role: 'host', m: room.host };
    const p = room.players.find((x) => x.token === socket.data.token);
    return p ? { room, role: 'player', m: p, p } : {};
  };

  // --- Вход ---
  socket.on('create_room', ({ nick } = {}, cb) => {
    nick = cleanNick(nick);
    if (!nick) return cb({ ok: false, error: 'Введите ник' });
    let themes;
    try { themes = loadQuestions(); } catch (e) { return cb({ ok: false, error: e.message }); }
    const token = newToken();
    const room = {
      code: newCode(), host: { token, nick, sid: socket.id, connected: true },
      players: [], nextId: 1, themes, rounds: null, round: 0,
      state: 'lobby', chooser: null, current: null, timer: null,
    };
    rooms.set(room.code, room);
    attach(room.code, token);
    cb({ ok: true, code: room.code, token });
    broadcast(room);
  });

  socket.on('join_room', ({ code, nick } = {}, cb) => {
    const room = rooms.get(String(code || '').trim().toUpperCase());
    nick = cleanNick(nick);
    if (!room) return cb({ ok: false, error: 'Комната не найдена' });
    if (!nick) return cb({ ok: false, error: 'Введите ник' });
    if (sameNick(nick, room.host.nick)) return cb({ ok: false, error: 'Этот ник занят' });
    const same = room.players.find((p) => sameNick(p.nick, nick));
    if (same) {
      if (same.connected) return cb({ ok: false, error: 'Этот ник занят' });
      same.sid = socket.id; same.connected = true;       // возврат по нику, если токен потерян
      attach(room.code, same.token);
      cb({ ok: true, code: room.code, token: same.token });
      return broadcast(room);
    }
    if (room.state !== 'lobby') return cb({ ok: false, error: 'Игра уже идёт' });
    const p = { id: room.nextId++, token: newToken(), nick, score: 0, sid: socket.id, connected: true };
    room.players.push(p);
    attach(room.code, p.token);
    cb({ ok: true, code: room.code, token: p.token });
    broadcast(room);
  });

  socket.on('rejoin', ({ code, token } = {}, cb) => {
    const room = rooms.get(String(code || '').trim().toUpperCase());
    if (!room) return cb({ ok: false });
    const m = room.host.token === token ? room.host : room.players.find((p) => p.token === token);
    if (!m) return cb({ ok: false });
    attach(room.code, token);
    m.sid = socket.id; m.connected = true;
    cb({ ok: true, code: room.code, role: m === room.host ? 'host' : 'player' });
    broadcast(room);
  });

  socket.on('disconnect', () => {
    const { room, m } = ctx();
    if (room && m.sid === socket.id) { m.sid = null; m.connected = false; broadcast(room); }
  });

  // --- Действия ведущего ---
  socket.on('start_game', () => {
    const { room, role } = ctx();
    if (role !== 'host' || room.state !== 'lobby' || room.players.length < 1) return;
    room.rounds = buildRounds(room.themes);
    room.round = 0;
    room.state = 'board';
    room.chooser = randomPlayer(room).id;
    broadcast(room);
  });

  socket.on('open_cell', ({ id } = {}) => {
    const { room, role } = ctx();
    if (role !== 'host' || room.state !== 'board') return;
    const theme = room.rounds[room.round].find((c) => c.cells.some((x) => x.id === id));
    const cell = theme && theme.cells.find((x) => x.id === id);
    if (!cell || cell.used) return;

    if (cell.kind === 'question') {
      room.state = 'question';
      room.current = { cell, theme: theme.name, buzzer: null, done: new Set() };
      return broadcast(room);
    }
    // Модификация: вопрос пропускается, эффект получает выбравший игрок
    const chooser = playerById(room, room.chooser);
    cell.used = true;
    const cur = { cell, kind: cell.kind, n: cell.n, playerId: chooser.id, waiting: false };
    room.current = cur;
    room.state = 'modifier';
    if (cur.kind === 'flip') chooser.score = 0 - chooser.score;
    else if (cur.kind === 'bonus') chooser.score += cur.n;
    else if (cur.kind === 'penalty') chooser.score -= cur.n;
    else if (cur.kind === 'pass') room.chooser = nextPlayer(room, chooser.id).id;
    else if (cur.kind === 'swap' && room.players.length > 1) cur.waiting = true;  // ждём выбор от ведущего
    if (!cur.waiting) scheduleAfterModifier(room);
    broadcast(room);
  });

  socket.on('pick_swap_target', ({ id } = {}) => {
    const { room, role } = ctx();
    if (role !== 'host' || room.state !== 'modifier' || !room.current.waiting) return;
    const cur = room.current;
    const a = playerById(room, cur.playerId), b = playerById(room, id);
    if (!b || b.id === a.id) return;
    [a.score, b.score] = [b.score, a.score];
    cur.waiting = false;
    cur.swapWithId = b.id;
    scheduleAfterModifier(room);
    broadcast(room);
  });

  socket.on('skip_modifier', () => {   // если обмен не нужен
    const { room, role } = ctx();
    if (role !== 'host' || room.state !== 'modifier' || !room.current.waiting) return;
    room.current.waiting = false;
    scheduleAfterModifier(room);
    broadcast(room);
  });

  socket.on('judge', ({ correct } = {}) => {
    const { room, role } = ctx();
    if (role !== 'host' || room.state !== 'question' || room.current.buzzer === null) return;
    const cur = room.current;
    const p = playerById(room, cur.buzzer);
    if (correct) {
      p.score += cur.cell.value;
      closeQuestion(room, p.id);                // верно — этот игрок выбирает следующий вопрос
    } else {
      p.score -= cur.cell.value;
      cur.done.add(p.id);                       // отвечать повторно нельзя
      cur.buzzer = null;
      checkAllDone(room);
    }
    broadcast(room);
  });

  socket.on('end_question', () => {
    const { room, role } = ctx();
    if (role !== 'host' || room.state !== 'question') return;
    closeQuestion(room, null);
    broadcast(room);
  });

  socket.on('adjust_score', ({ id, delta } = {}) => {
    const { room, role } = ctx();
    const p = room && playerById(room, id);
    if (role !== 'host' || !p || !Number.isFinite(Number(delta))) return;
    p.score += Number(delta);
    broadcast(room);
  });

  socket.on('new_game', () => {
    const { room, role } = ctx();
    if (role !== 'host' || room.state !== 'finished') return;
    try { room.themes = loadQuestions(); } catch (e) { /* оставляем прежние вопросы */ }
    room.players.forEach((p) => { p.score = 0; });
    Object.assign(room, { rounds: null, round: 0, state: 'lobby', chooser: null, current: null });
    broadcast(room);
  });

  // --- Действия игроков ---
  socket.on('buzz', () => {
    const { room, role, p } = ctx();
    if (role !== 'player' || room.state !== 'question') return;
    const cur = room.current;
    if (cur.buzzer !== null || cur.done.has(p.id)) return;   // первым считается тот, чей сигнал пришёл раньше
    cur.buzzer = p.id;
    broadcast(room);
  });

  socket.on('abstain', () => {
    const { room, role, p } = ctx();
    if (role !== 'player' || room.state !== 'question') return;
    const cur = room.current;
    if (cur.buzzer === p.id || cur.done.has(p.id)) return;
    cur.done.add(p.id);
    checkAllDone(room);
    broadcast(room);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\nСервер запущен. На этом компьютере: http://localhost:${PORT}`);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list) if (i.family === 'IPv4' && !i.internal) console.log(`В вашей Wi-Fi сети:  http://${i.address}:${PORT}`);
  }
  console.log('Остановить сервер: Ctrl+C\n');
});
