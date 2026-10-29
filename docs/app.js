const tg = window.Telegram?.WebApp;
tg?.ready();
tg?.expand();

const $ = id => document.getElementById(id);
let state = null;          // ответ /api/app
let lesson = null;         // { block, lessons, index }
let test = null;           // { blockId, attemptId, questions, index, answered, correct }
let refCategory = null;

// ---------- utils ----------

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Простое форматирование текста уроков: **жирный**, ссылки
function formatText(s) {
  return esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
}

// Внутри Telegram пользователя подтверждает initData, в браузере — токен после входа через Telegram
const inTelegram = !!tg?.initData;
const session = {
  get: () => { try { return localStorage.getItem('user_token'); } catch { return null; } },
  set: t => { try { t ? localStorage.setItem('user_token', t) : localStorage.removeItem('user_token'); } catch {} }
};

async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': tg?.initData || '' };
  if (!inTelegram && session.get()) headers.Authorization = `Bearer ${session.get()}`;
  const res = await fetch(window.APP_CONFIG.API_URL + '/api' + path, {
    ...options,
    headers: { ...headers, ...options.headers },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Ошибка ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function toast(text) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = text;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}

const haptic = type => {
  try { tg?.HapticFeedback?.notificationOccurred(type); } catch {}
};

function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
}

function formatDate(sqlDate, opts = { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) {
  if (!sqlDate) return '';
  return new Date(sqlDate.replace(' ', 'T') + 'Z').toLocaleString('ru-RU', opts);
}

// ---------- theme ----------

function applyTheme(theme) {
  document.body.dataset.theme = theme;
  $('themeToggle').innerHTML = `<i class="fas fa-${theme === 'dark' ? 'sun' : 'moon'}"></i>`;
  try {
    tg?.setHeaderColor(theme === 'dark' ? '#1e1e1e' : '#ffffff');
    tg?.setBackgroundColor(theme === 'dark' ? '#121212' : '#f4f2f0');
  } catch {}
}
let savedTheme = null;
try { savedTheme = localStorage.getItem('theme'); } catch {}
applyTheme(savedTheme || tg?.colorScheme || 'dark');
$('themeToggle').onclick = () => {
  const next = document.body.dataset.theme === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  try { localStorage.setItem('theme', next); } catch {}
};

// ---------- navigation ----------

function switchScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === id));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.screen === id));
  document.querySelector('.main-container').scrollTop = 0;
}
document.querySelectorAll('.nav-item').forEach(n => (n.onclick = () => switchScreen(n.dataset.screen)));

const overlayStack = [];
function openOverlay(id) {
  $(id).classList.add('active');
  if (!overlayStack.includes(id)) overlayStack.push(id);
  tg?.BackButton?.show();
}
function closeOverlay(id) {
  $(id).classList.remove('active');
  const i = overlayStack.indexOf(id);
  if (i >= 0) overlayStack.splice(i, 1);
  if (!overlayStack.length) tg?.BackButton?.hide();
}
tg?.BackButton?.onClick(() => {
  const top = overlayStack[overlayStack.length - 1];
  if (top === 'testView') confirmCloseTest(); else if (top) closeOverlay(top);
});
document.querySelector('#lessonView [data-close]').onclick = () => closeOverlay('lessonView');
document.querySelector('#testView [data-close]').onclick = () => confirmCloseTest();

function confirmCloseTest() {
  const close = () => { closeOverlay('testView'); test = null; };
  if (!test || test.finished || test.answered === 0) return close();
  const msg = 'Выйти из теста? Прогресс попытки не сохранится.';
  if (tg?.showConfirm && tg.initData) tg.showConfirm(msg, ok => ok && close());
  else if (confirm(msg)) close();
}

// ---------- render: home ----------

function render() {
  const { settings, user, blocks, history } = state;
  document.title = settings.app_title;
  $('appTitle').textContent = settings.app_title;
  $('hello').innerHTML = `<b>Привет, ${esc(user.first_name || 'коллега')}! 👋</b>${esc(settings.welcome_text)}`;

  const passed = blocks.filter(b => b.status === 'passed').length;
  const percent = blocks.length ? Math.round((passed / blocks.length) * 100) : 0;
  const tried = blocks.filter(b => b.best != null);
  $('progressPercent').textContent = `${percent}%`;
  $('progressBar').style.width = `${percent}%`;
  $('statPassed').textContent = passed;
  $('statTotal').textContent = blocks.length;
  $('statAttempts').textContent = history.length;
  $('statAvg').textContent = tried.length ? Math.round(tried.reduce((s, b) => s + b.best, 0) / tried.length) + '%' : '—';

  $('chapters').innerHTML = blocks.length ? blocks.map((b, i) => {
    const badge = {
      passed: '<span class="badge badge-done">✅ Пройдено</span>',
      available: b.attempts ? '<span class="badge badge-fail">↻ Пересдать</span>' : '<span class="badge badge-current">📖 Доступно</span>',
      locked: '<span class="badge badge-lock">🔒</span>'
    }[b.status];
    return `
      <button class="chapter ${b.status}" data-block="${b.id}">
        ${b.cover ? `<div class="chapter-cover" style="background-image:url('${esc(b.cover)}')"></div>` : ''}
        <div class="chapter-body">
          <div class="chapter-icon">${esc(b.icon || '📘')}</div>
          <div class="chapter-info">
            <div class="chapter-title">Блок ${i + 1}: ${esc(b.title)}</div>
            ${b.description ? `<div class="chapter-desc">${esc(b.description)}</div>` : ''}
            <div class="chapter-meta">
              <span><i class="fas fa-file-lines"></i> ${b.lessons} ${plural(b.lessons, 'урок', 'урока', 'уроков')}</span>
              <span><i class="fas fa-circle-question"></i> ${b.questions} ${plural(b.questions, 'вопрос', 'вопроса', 'вопросов')}</span>
              ${b.best != null ? `<span><i class="fas fa-star"></i> ${b.best}%</span>` : ''}
            </div>
          </div>
          ${badge}
        </div>
      </button>`;
  }).join('') : '<div class="empty">Блоки обучения скоро появятся</div>';
  document.querySelectorAll('.chapter').forEach(el => (el.onclick = () => openBlock(Number(el.dataset.block))));

  if (state.completedAt) {
    $('certificateSection').hidden = false;
    $('certificate').innerHTML = certificateHtml();
  } else {
    $('certificateSection').hidden = true;
  }

  renderReferences();
  renderProfile();
}

function certificateHtml() {
  const { settings, user, blocks } = state;
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ') || 'Южанин';
  const avg = Math.round(blocks.reduce((s, b) => s + (b.best || 0), 0) / blocks.length);
  return `
    <div class="certificate">
      <div class="cert-shine"></div>
      <div class="cert-icon"><i class="fas fa-trophy"></i></div>
      <div class="cert-title">${esc(settings.certificate_title)}</div>
      <div class="cert-subtitle">подтверждает успешное завершение обучения</div>
      <div class="cert-name">${esc(name)}</div>
      <div class="cert-text">${esc(settings.certificate_text)}</div>
      <div class="cert-stats">
        <div class="cert-stat"><b>${blocks.length}</b><span>${plural(blocks.length, 'блок', 'блока', 'блоков')}</span></div>
        <div class="cert-stat"><b>${avg}%</b><span>средний балл</span></div>
      </div>
      <div class="cert-date"><i class="fas fa-calendar-alt"></i> Выдан: ${formatDate(state.completedAt, { year: 'numeric', month: 'long', day: 'numeric' })}</div>
      <div class="cert-footer">
        <div class="cert-sign">${esc(settings.certificate_signature)}</div>
        <div class="cert-seal"><i class="fas fa-utensils"></i></div>
      </div>
      <div class="cert-hint">Сделайте скриншот, чтобы сохранить сертификат</div>
    </div>`;
}

function startConfetti() {
  const colors = ['#D4AF37', '#F4D06F', '#722F37', '#9e4650', '#ffffff'];
  for (let i = 0; i < 60; i++) {
    setTimeout(() => {
      const c = document.createElement('div');
      c.className = 'confetti';
      c.style.left = Math.random() * 100 + 'vw';
      c.style.background = colors[i % colors.length];
      c.style.animationDuration = 2 + Math.random() * 2 + 's';
      document.body.appendChild(c);
      setTimeout(() => c.remove(), 4200);
    }, i * 40);
  }
}

// ---------- references ----------

function renderReferences() {
  const cats = state.references;
  if (!refCategory || !cats.some(c => c.id === refCategory)) refCategory = cats[0]?.id ?? null;
  const query = $('refSearch').value.trim().toLowerCase();

  $('refChips').innerHTML = cats.map(c =>
    `<button class="chip ${!query && c.id === refCategory ? 'active' : ''}" data-cat="${c.id}">${esc(c.icon)} ${esc(c.title)}</button>`).join('');
  $('refChips').querySelectorAll('.chip').forEach(ch => (ch.onclick = () => {
    refCategory = Number(ch.dataset.cat);
    $('refSearch').value = '';
    renderReferences();
  }));

  // При поиске ищем по всем справочникам сразу
  const items = query
    ? cats.flatMap(c => c.items.filter(i => (i.title + ' ' + i.body).toLowerCase().includes(query)).map(i => ({ ...i, cat: c })))
    : (cats.find(c => c.id === refCategory)?.items || []).map(i => ({ ...i }));

  $('refResults').innerHTML = items.length ? items.slice(0, 100).map(i => `
    <div class="item">
      <div class="item-key">${esc(i.title)}${i.cat ? `<small>${esc(i.cat.icon)} ${esc(i.cat.title)}</small>` : ''}</div>
      ${i.body ? `<div class="item-value">${formatText(i.body)}</div>` : ''}
      ${i.image ? `<img src="${esc(i.image)}" alt="" loading="lazy">` : ''}
    </div>`).join('') : `<div class="empty">${cats.length ? 'Ничего не найдено' : 'Справочники пока пусты'}</div>`;
}
$('refSearch').addEventListener('input', renderReferences);

// ---------- profile ----------

function renderProfile() {
  const { user, blocks, history, isAdmin } = state;
  $('profileName').textContent = [user.first_name, user.last_name].filter(Boolean).join(' ') || 'Сотрудник';
  $('profileSub').textContent = [user.position, user.username ? '@' + user.username : '', `ID ${user.tg_id}`].filter(Boolean).join(' · ');
  $('profileAvatar').innerHTML = user.photo_url ? `<img src="${esc(user.photo_url)}" alt="">` : '<i class="fas fa-user"></i>';
  $('adminLink').hidden = !isAdmin;
  $('logoutBtn').hidden = inTelegram || !session.get();

  $('blockStats').innerHTML = blocks.map((b, i) => `
    <div class="item">
      <div class="item-key">${esc(b.icon)} Блок ${i + 1}: ${esc(b.title)}
        <small>${b.status === 'passed' ? '✅' : b.status === 'locked' ? '🔒' : ''}</small></div>
      <div class="item-value">Лучший результат: ${b.best != null ? b.best + '%' : '—'} · Попыток: ${b.attempts}</div>
    </div>`).join('') || '<div class="empty">Нет блоков</div>';

  $('history').innerHTML = history.length ? history.map(h => `
    <div class="item">
      <div class="item-key">${esc(h.block_title)} <small>${formatDate(h.finished_at)}</small></div>
      <div class="item-value">${h.passed ? '✅ Сдано' : '❌ Не сдано'} — ${h.correct}/${h.total} (${h.percent}%)</div>
    </div>`).join('') : '<div class="empty">Вы ещё не проходили тесты</div>';
}

// ---------- lessons ----------

async function openBlock(blockId) {
  const b = state.blocks.find(x => x.id === blockId);
  if (!b) return;
  if (b.status === 'locked') { haptic('warning'); return toast('🔒 Сначала пройдите предыдущий блок'); }
  try {
    const data = await api(`/blocks/${blockId}`);
    if (!data.lessons.length) return startTest(blockId);
    lesson = { block: data.block, lessons: data.lessons, index: 0 };
    showLesson();
    openOverlay('lessonView');
  } catch (e) { toast(e.message); }
}

function showLesson() {
  const { block, lessons, index } = lesson;
  const l = lessons[index];
  const isLast = index === lessons.length - 1;
  $('lessonTitle').textContent = `${block.title} · ${index + 1}/${lessons.length}`;
  $('lessonDots').innerHTML = lessons.map((_, i) => `<span class="${i <= index ? 'on' : ''}"></span>`).join('');
  $('lessonContent').innerHTML = `
    ${l.image ? `<img src="${esc(l.image)}" class="lesson-image" alt="">` : ''}
    ${l.title ? `<div class="lesson-heading">${esc(l.title)}</div>` : ''}
    <div class="lesson-text">${formatText(l.text)}</div>
    <div class="nav-row">
      ${index > 0 ? '<button class="btn btn-secondary" id="lessonPrev"><i class="fas fa-arrow-left"></i> Назад</button>' : ''}
      <button class="btn btn-primary" id="lessonNext">${isLast ? '📋 К тесту' : 'Дальше <i class="fas fa-arrow-right"></i>'}</button>
    </div>`;
  $('lessonContent').scrollTop = 0;
  if (!l.viewed) { l.viewed = true; api(`/lessons/${l.id}/view`, { method: 'POST' }).catch(() => {}); }
  if ($('lessonPrev')) $('lessonPrev').onclick = () => { lesson.index--; showLesson(); };
  $('lessonNext').onclick = () => {
    if (isLast) startTest(block.id);
    else { lesson.index++; showLesson(); }
  };
}

// ---------- test ----------

async function startTest(blockId) {
  try {
    const data = await api('/attempts', { method: 'POST', body: { block_id: blockId } });
    test = { blockId, attemptId: data.attempt_id, questions: data.questions, passPercent: data.pass_percent, index: 0, answered: 0, correct: 0 };
    closeOverlay('lessonView');
    showQuestion();
    openOverlay('testView');
  } catch (e) { toast(e.message); }
}

function showQuestion() {
  const q = test.questions[test.index];
  const n = test.questions.length;
  $('testCounter').textContent = `${test.index + 1}/${n}`;
  $('testBar').style.width = `${(test.index / n) * 100}%`;
  $('testContent').innerHTML = `
    ${q.image ? `<img src="${esc(q.image)}" class="question-image" alt="">` : ''}
    <div class="question">${esc(q.text)}</div>
    <div class="options" id="options">
      ${q.options.map((o, i) => `<button class="option" data-i="${i}"><span class="letter">${String.fromCharCode(65 + i)}</span><span>${esc(o)}</span></button>`).join('')}
    </div>
    <div id="feedback"></div>`;
  $('testContent').scrollTop = 0;
  $('options').querySelectorAll('.option').forEach(btn => (btn.onclick = () => answer(Number(btn.dataset.i))));
}

async function answer(selected) {
  const box = $('options');
  if (box.classList.contains('answered')) return;
  box.classList.add('answered');
  const q = test.questions[test.index];
  try {
    const r = await api(`/attempts/${test.attemptId}/answer`, { method: 'POST', body: { question_id: q.id, selected } });
    const opts = box.querySelectorAll('.option');
    opts[r.correct]?.classList.add('correct');
    if (!r.is_correct) opts[r.selected]?.classList.add('wrong');
    test.answered++;
    if (r.is_correct) test.correct++;
    haptic(r.is_correct ? 'success' : 'error');
    const isLast = test.index === test.questions.length - 1;
    $('feedback').innerHTML = `
      <div class="feedback ${r.is_correct ? '' : 'bad'}">
        <b>${r.is_correct ? '✅ Правильно!' : '❌ Ошибка'}</b>${esc(r.explanation)}
      </div>
      <button class="btn btn-primary" id="nextQ" style="margin-top:18px">${isLast ? 'Завершить тест' : 'Дальше'} <i class="fas fa-arrow-right"></i></button>`;
    $('nextQ').onclick = () => {
      if (isLast) finishTest();
      else { test.index++; showQuestion(); }
    };
    $('nextQ').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (e) {
    box.classList.remove('answered');
    toast(e.message);
  }
}

async function finishTest() {
  $('nextQ').disabled = true;
  try {
    const r = await api(`/attempts/${test.attemptId}/finish`, { method: 'POST' });
    test.finished = true;
    $('testBar').style.width = '100%';
    const color = r.passed ? 'var(--success)' : 'var(--danger)';
    const C = 2 * Math.PI * 70;
    $('testContent').innerHTML = `
      <div class="result">
        <div class="ring">
          <svg width="160" height="160"><circle cx="80" cy="80" r="70" stroke="var(--line)" stroke-width="12" fill="none"/>
            <circle cx="80" cy="80" r="70" stroke="${color}" stroke-width="12" fill="none" stroke-linecap="round"
              stroke-dasharray="${C}" stroke-dashoffset="${C}" id="ringArc" style="transition: stroke-dashoffset 1s ease"/></svg>
          <div class="ring-value" style="color:${color}">${r.percent}%</div>
        </div>
        <h3>${r.passed ? (r.all_passed ? '🏆 Обучение завершено!' : '🎉 Блок пройден!') : 'Почти получилось'}</h3>
        <p>Правильных ответов: ${r.correct} из ${r.total}.<br>${r.passed
          ? (r.all_passed ? 'Поздравляем! Сертификат ждёт тебя на главной.' : 'Следующий блок уже открыт.')
          : `Для прохождения нужно ${r.pass_percent}%. Перечитай материал и попробуй снова.`}</p>
        ${r.passed ? '' : '<button class="btn btn-secondary" id="retryLesson"><i class="fas fa-book"></i> Повторить материал</button><button class="btn btn-primary" id="retryTest"><i class="fas fa-rotate-right"></i> Пройти тест заново</button>'}
        ${r.passed ? '<button class="btn btn-primary" id="toHome">Продолжить <i class="fas fa-arrow-right"></i></button>' : ''}
      </div>`;
    requestAnimationFrame(() => setTimeout(() => ($('ringArc').style.strokeDashoffset = C * (1 - r.percent / 100)), 50));
    haptic(r.passed ? 'success' : 'warning');

    state = await api('/app');
    render();
    const blockId = test.blockId;
    if ($('toHome')) $('toHome').onclick = () => { closeOverlay('testView'); test = null; if (r.all_passed) { switchScreen('homeScreen'); startConfetti(); setTimeout(() => $('certificate').scrollIntoView({ behavior: 'smooth' }), 300); } };
    if ($('retryTest')) $('retryTest').onclick = () => startTest(blockId);
    if ($('retryLesson')) $('retryLesson').onclick = () => { closeOverlay('testView'); test = null; openBlock(blockId); };
  } catch (e) {
    $('nextQ').disabled = false;
    toast(e.message);
  }
}

// ---------- init ----------

function showLogin() {
  $('loading').classList.remove('hidden');
  document.querySelector('.loading-icon').style.animation = 'none';
  document.querySelector('.loading-text').textContent = 'Обучение «Южане»';
  $('loadingError').innerHTML = '';
  $('loginBox').hidden = false;
  if ($('loginWidget').childElementCount) return;
  fetch(window.APP_CONFIG.API_URL + '/api/admin/config').then(r => r.json()).then(cfg => {
    if (!cfg.bot_username) {
      $('loginError').textContent = 'Бот ещё не настроен.';
      return;
    }
    const s = document.createElement('script');
    s.async = true;
    s.src = 'https://telegram.org/js/telegram-widget.js?22';
    s.dataset.telegramLogin = cfg.bot_username;
    s.dataset.size = 'large';
    s.dataset.radius = '12';
    s.dataset.onauth = 'onTelegramAuth(user)';
    $('loginWidget').appendChild(s);
  }).catch(() => ($('loginError').textContent = 'Сервер недоступен, попробуйте позже.'));
}

window.onTelegramAuth = async user => {
  $('loginError').textContent = '';
  try {
    const { token } = await api('/auth/telegram', { method: 'POST', body: user });
    session.set(token);
    $('loginBox').hidden = true;
    document.querySelector('.loading-text').textContent = 'Загрузка обучения...';
    await init();
  } catch (e) {
    $('loginError').textContent = e.message;
  }
};

$('logoutBtn').onclick = () => {
  session.set(null);
  location.reload();
};

async function init() {
  try {
    state = await api('/app');
    render();
    $('loading').classList.add('hidden');
  } catch (e) {
    if (e.status === 401 && !inTelegram) {
      session.set(null);
      return showLogin();
    }
    $('loadingError').innerHTML = `${esc(e.message)}
      <br><button class="btn btn-primary" onclick="location.reload()"><i class="fas fa-rotate-right"></i> Попробовать снова</button>`;
  }
}
init();
