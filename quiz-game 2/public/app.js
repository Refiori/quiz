'use strict';
// Клиент викторины: один экран, перерисовывается при каждом событии «state» от сервера.
const socket = io();
const $app = document.getElementById('app');
const $banner = document.getElementById('banner');
const KEY = 'quiz-session';           // sessionStorage: у каждой вкладки своя сессия (удобно тестировать)
let S = null, err = '', nickVal = '', codeVal = '', lastRound = null, bannerTimer = null;
let pending = !!sessionStorage.getItem(KEY);   // идёт попытка вернуться в комнату

const saved = () => { try { return JSON.parse(sessionStorage.getItem(KEY)); } catch { return null; } };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => Number(n).toLocaleString('ru-RU');
const isHost = () => S.role === 'host';
const byId = (id) => S.players.find((p) => p.id === id);
const nm = (id) => (byId(id) ? esc(byId(id).nick) : '—');

function flash(text) {
  $banner.textContent = text; $banner.hidden = false;
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => { $banner.hidden = true; }, 2200);
}

// ---------- Подключение ----------
socket.on('connect', () => {
  const s = saved();
  if (!s) { pending = false; return render(); }
  socket.emit('rejoin', s, (r) => {
    if (!r.ok) { sessionStorage.removeItem(KEY); S = null; }
    pending = false; render();
  });
});
socket.on('state', (s) => {
  if (s.state === 'lobby') lastRound = null;
  else {
    if ((S && S.state === 'lobby' && s.state === 'board') || (lastRound !== null && s.round !== lastRound && s.state === 'board')) flash(`Раунд ${s.round}`);
    lastRound = s.round;
  }
  S = s; pending = false; render();
});

function login(kind) {
  nickVal = document.getElementById('nick').value.trim();
  codeVal = document.getElementById('code').value.trim().toUpperCase();
  socket.emit(kind === 'create' ? 'create_room' : 'join_room', { nick: nickVal, code: codeVal }, (r) => {
    if (!r.ok) { err = r.error; return render(); }
    err = '';
    sessionStorage.setItem(KEY, JSON.stringify({ code: r.code, token: r.token }));
  });
}

// ---------- Экраны ----------
const loginView = () => `
<section class="login">
  <h1>Викторина</h1>
  <form id="f" autocomplete="off">
    <label>Ваш ник<input id="nick" maxlength="20" value="${esc(nickVal)}" required></label>
    <label>Код комнаты<input id="code" maxlength="4" value="${esc(codeVal)}" placeholder="Например, KLMN"></label>
    ${err ? `<p class="err" role="alert">${esc(err)}</p>` : ''}
    <button class="primary">Войти в комнату</button>
    <button type="button" class="ghost" data-act="create">Создать комнату и стать ведущим</button>
  </form>
</section>`;

const top = (withRound) => `
<header class="top">
  <span>${withRound ? `Раунд ${S.round} из 3` : isHost() ? 'Вы ведущий' : `Ведущий: ${esc(S.host)}`}</span>
  <span class="code" title="Код комнаты">${S.code}</span>
  <button class="link" data-act="leave">Выйти</button>
</header>${S.hostConnected ? '' : '<p class="warn">Ведущий не в сети, игра ждёт его возвращения</p>'}`;

const strip = () => `<ul class="players">${S.players.map((p) => {
  const q = S.question;
  const cls = [p.id === S.meId ? 'me' : '', p.id === S.chooserId && S.state === 'board' ? 'turn' : '', p.connected ? '' : 'off',
    q && q.buzzerId === p.id ? 'buzz' : '', q && q.answeredIds.includes(p.id) ? 'done' : ''].join(' ');
  return `<li class="${cls}"><span>${esc(p.nick)}</span><b class="${p.score < 0 ? 'neg' : ''}">${fmt(p.score)}</b>${
    isHost() && S.state !== 'lobby' ? `<button data-act="adjust" data-id="${p.id}" title="Изменить счёт вручную">±</button>` : ''}</li>`;
}).join('')}</ul>`;

function lobbyView() {
  return `${top(false)}<section class="lobby">
    <p>Код комнаты</p><div class="bignum">${S.code}</div>
    ${S.players.length ? strip() : '<p>Пока никого нет. Сообщите игрокам код.</p>'}
    ${isHost() ? `<button class="primary" data-act="start" ${S.players.length ? '' : 'disabled'}>Начать игру</button>`
      : '<p>Ждём, пока ведущий начнёт игру.</p>'}
  </section>`;
}

function boardView() {
  const ch = byId(S.chooserId);
  const hint = !ch ? '' : isHost() ? `Выбирает: <b>${esc(ch.nick)}</b>. Откройте клетку, которую он назовёт.`
    : S.chooserId === S.meId ? '<b>Ваш выбор!</b> Назовите ведущему тему и сумму.' : `Выбирает: <b>${esc(ch.nick)}</b>`;
  return `<p class="hint">${hint}</p><div class="board">${S.board.map((col) => `<div class="col">
    <div class="theme">${esc(col.name)}</div>${col.cells.map((c) => c.used ? '<div class="cell used"></div>'
      : isHost() ? `<button class="cell" data-act="open" data-id="${c.id}">${c.value}</button>` : `<div class="cell">${c.value}</div>`).join('')}
  </div>`).join('')}</div>`;
}

function questionView() {
  const q = S.question, who = q.buzzerId !== null ? byId(q.buzzerId) : null;
  const card = `<div class="qcard"><div class="qmeta"><span>${esc(q.theme)}</span><b>${q.value}</b></div>
    <p class="qtext">${esc(q.text)}</p>${isHost() ? `<div class="answer">Правильный ответ: <b>${esc(q.answer)}</b></div>` : ''}</div>`;
  if (isHost()) {
    return `${card}<p class="status">${who ? `Отвечает: ${esc(who.nick)}` : 'Ждём, кто нажмёт кнопку'}</p>
      <div class="row"><button class="ok" data-act="judge" data-v="1" ${who ? '' : 'disabled'}>Верно</button>
      <button class="bad" data-act="judge" data-v="0" ${who ? '' : 'disabled'}>Неверно</button>
      <button class="ghost" data-act="end">Завершить вопрос</button></div>`;
  }
  const out = q.answeredIds.includes(S.meId), mine = q.buzzerId === S.meId;
  const status = mine ? 'Отвечайте ведущему вслух' : who ? `Отвечает: ${esc(who.nick)}` : out ? 'Вы выбыли из этого вопроса' : 'Нажмите кнопку, чтобы ответить';
  return `${card}<p class="status">${status}</p>
    <button class="buzz" data-act="buzz" ${q.canBuzz ? '' : 'disabled'}>Ответить</button>
    ${!out && !mine ? '<div class="center"><button class="ghost" data-act="abstain">Воздержаться</button></div>' : ''}`;
}

function modifierView() {
  const m = S.modifier;
  let extra = '';
  if (m.waiting && isHost()) {
    extra = `<p>Кого выбрал игрок для обмена?</p><div class="row" style="justify-content:center">${m.targets.map((id) =>
      `<button data-act="swap" data-id="${id}">${nm(id)}</button>`).join('')}<button class="ghost" data-act="skipmod">Без обмена</button></div>`;
  } else if (m.waiting) extra = '<p>Ждём, с кем поменяются очками.</p>';
  else if (m.swapWithId) extra = `<p>Очками поменялись с игроком ${nm(m.swapWithId)}</p>`;
  else if (m.kind === 'pass') extra = `<p>Следующую клетку выбирает ${nm(S.chooserId)}</p>`;
  return `<div class="mod"><p>Модификация</p><div class="mlabel">${esc(m.label)}</div><p>Эффект получает: <b>${nm(m.playerId)}</b></p>${extra}</div>`;
}

const gameView = () => `${top(true)}${strip()}<main>${S.state === 'modifier' ? modifierView() : S.state === 'question' ? questionView() : boardView()}</main>`;

function finishedView() {
  const w = S.winners;
  return `${top(false)}<div class="win">${w.length > 1 ? 'Победители' : 'Победитель'}: ${w.map(esc).join(', ')}</div>
    <table>${S.results.map((r, i) => `<tr><td>${i + 1}</td><td>${esc(r.nick)}</td><td class="${r.score < 0 ? 'neg' : ''}">${fmt(r.score)}</td></tr>`).join('')}</table>
    ${isHost() ? '<div class="center"><button class="primary" data-act="newgame">Новая игра</button></div>' : ''}`;
}

function render() {
  if (!S) { $app.innerHTML = pending ? '<p class="center" style="margin-top:20vh">Подключаемся…</p>' : loginView(); return; }
  $app.innerHTML = { lobby: lobbyView, board: gameView, question: gameView, modifier: gameView, finished: finishedView }[S.state]();
}

// ---------- Действия ----------
$app.addEventListener('submit', (e) => { e.preventDefault(); login('join'); });
$app.addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]');
  if (!b || b.disabled) return;
  const id = Number(b.dataset.id);
  switch (b.dataset.act) {
    case 'create': login('create'); break;
    case 'start': socket.emit('start_game'); break;
    case 'open': socket.emit('open_cell', { id }); break;
    case 'judge': socket.emit('judge', { correct: b.dataset.v === '1' }); break;
    case 'end': socket.emit('end_question'); break;
    case 'buzz': socket.emit('buzz'); break;
    case 'abstain': socket.emit('abstain'); break;
    case 'swap': socket.emit('pick_swap_target', { id }); break;
    case 'skipmod': socket.emit('skip_modifier'); break;
    case 'newgame': socket.emit('new_game'); break;
    case 'adjust': {
      const d = prompt('Изменить счёт игрока на сколько? Например, 200 или -200');
      const n = Number(String(d || '').replace(',', '.'));
      if (d && Number.isFinite(n) && n !== 0) socket.emit('adjust_score', { id, delta: n });
      break;
    }
    case 'leave':
      if (confirm('Выйти из комнаты? Вернуться можно будет под тем же ником.')) { sessionStorage.removeItem(KEY); location.reload(); }
      break;
  }
});

render();
