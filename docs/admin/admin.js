const API = window.APP_CONFIG.API_URL;
const tg = window.Telegram?.WebApp;
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const view = () => $('#view');

// ---------- storage / theme ----------

const store = {
  get: k => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} }
};

function applyTheme(t) {
  document.body.dataset.theme = t;
  $('#themeBtn').innerHTML = `<i class="fas fa-${t === 'dark' ? 'sun' : 'moon'}"></i>`;
}
applyTheme(store.get('adm_theme') || (tg?.initData ? tg.colorScheme : null) ||
  (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
$('#themeBtn').onclick = () => {
  const t = document.body.dataset.theme === 'dark' ? 'light' : 'dark';
  applyTheme(t);
  store.set('adm_theme', t);
};

// ---------- utils ----------

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function api(path, { method = 'GET', body, raw } = {}) {
  const headers = { Authorization: `Bearer ${store.get('adm_token') || ''}` };
  if (body && !(body instanceof FormData)) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${API}/api/admin${path}`, {
    method, headers, body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined
  });
  if (res.status === 401 && !path.startsWith('/auth')) {
    store.set('adm_token', null);
    showLogin();
    throw new Error('Сессия истекла, войдите снова');
  }
  if (raw && res.ok) return res;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Ошибка ${res.status}`);
  return data;
}

function toast(text, type = 'ok') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<i class="fas fa-${type === 'ok' ? 'circle-check' : 'circle-exclamation'}"></i><span>${esc(text)}</span>`;
  $('#toastRoot').appendChild(el);
  setTimeout(() => el.remove(), 3500);
}
const fail = e => toast(e.message, 'err');

const fullName = u => [u.first_name, u.last_name].filter(Boolean).join(' ') || (u.username ? '@' + u.username : `ID ${u.tg_id ?? u.user_id}`);
const initials = u => (fullName(u).replace('@', '').split(' ').map(s => s[0]).join('').slice(0, 2) || '?').toUpperCase();
const avatar = (u, cls = '') => `<div class="ava ${cls}">${u.photo_url ? `<img src="${esc(u.photo_url)}" alt="" onerror="this.remove()">` : ''}${u.photo_url ? '' : esc(initials(u))}</div>`;
const person = (u, sub) => `<div class="person">${avatar(u)}<div style="min-width:0"><b>${esc(fullName(u))}</b><span>${esc(sub ?? (u.username ? '@' + u.username : 'ID ' + (u.tg_id ?? u.user_id)))}</span></div></div>`;

function parseDate(s) { return s ? new Date(s.replace(' ', 'T') + (s.includes('Z') ? '' : 'Z')) : null; }
function fmtDate(s, withTime = true) {
  const d = parseDate(s);
  if (!d) return '—';
  return d.toLocaleString('ru-RU', withTime ? { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' } : { day: 'numeric', month: 'long', year: 'numeric' });
}
function ago(s) {
  const d = parseDate(s);
  if (!d) return '—';
  const m = Math.round((Date.now() - d) / 60000);
  if (m < 2) return 'только что';
  if (m < 60) return `${m} мин назад`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} ч назад`;
  const days = Math.round(h / 24);
  if (days < 30) return `${days} дн назад`;
  return fmtDate(s, false);
}
const scoreHtml = (p, passed) => p == null ? '<span class="muted">—</span>' : `<span class="score ${passed ? 'ok' : 'bad'}">${p}%</span>`;
const loader = () => '<div class="loader"><i class="fas fa-circle-notch"></i></div>';
const empty = (icon, text) => `<div class="empty"><i class="fas fa-${icon}"></i>${text}</div>`;

// ---------- modal ----------

function modal({ title, body, saveText = 'Сохранить', wide, onSave, onOpen, danger, hideSave }) {
  const root = document.createElement('div');
  root.className = 'modal-bg';
  root.innerHTML = `
    <form class="modal ${wide ? 'wide' : ''}" novalidate>
      <div class="modal-head"><h3>${esc(title)}</h3><button type="button" class="icon-btn" data-x><i class="fas fa-xmark"></i></button></div>
      <div class="modal-body">${body}</div>
      <div class="modal-foot">
        <button type="button" class="btn" data-x>${hideSave ? 'Закрыть' : 'Отмена'}</button>
        ${hideSave ? '' : `<button type="submit" class="btn ${danger ? 'btn-danger' : 'btn-primary'}">${esc(saveText)}</button>`}
      </div>
    </form>`;
  const close = () => root.remove();
  root.addEventListener('mousedown', e => { if (e.target === root) close(); });
  $$('[data-x]', root).forEach(b => (b.onclick = close));
  const form = $('form', root);
  form.onsubmit = async e => {
    e.preventDefault();
    const btn = $('[type=submit]', form);
    btn.disabled = true;
    try {
      if ((await onSave?.(form)) !== false) close();
    } catch (err) { fail(err); } finally { btn.disabled = false; }
  };
  $('#modalRoot').appendChild(root);
  bindImageFields(root);
  onOpen?.(form);
  setTimeout(() => $('input[type=text], textarea', form)?.focus(), 50);
  return { root, form, close };
}

const confirmDialog = (text, okText = 'Удалить') => new Promise(resolve => {
  let ok = false;
  const m = modal({ title: 'Подтверждение', body: `<p>${text}</p>`, saveText: okText, danger: true, onSave: () => { ok = true; } });
  new MutationObserver((_, obs) => { if (!m.root.isConnected) { obs.disconnect(); resolve(ok); } }).observe($('#modalRoot'), { childList: true });
});

function formValues(form) {
  const out = {};
  $$('[name]', form).forEach(el => {
    if (el.type === 'radio') { if (el.checked) out[el.name] = el.value; }
    else if (el.type === 'checkbox') out[el.name] = el.checked ? 1 : 0;
    else if (el.type === 'number') out[el.name] = Number(el.value);
    else out[el.name] = el.value;
  });
  return out;
}

// ---------- image field ----------

function imageField(name, value, label = 'Изображение') {
  return `
    <div class="field"><span>${label}</span>
      <div class="img-field" data-img>
        <div class="img-preview">${value ? `<img src="${esc(value)}" alt="">` : '<i class="fas fa-image"></i>'}</div>
        <div class="img-controls">
          <div class="btns">
            <label class="btn btn-sm"><i class="fas fa-upload"></i> Загрузить<input type="file" accept="image/*" hidden></label>
            <button type="button" class="btn btn-sm btn-ghost" data-clear><i class="fas fa-trash"></i></button>
          </div>
          <input type="text" name="${name}" value="${esc(value)}" placeholder="или вставьте ссылку на картинку">
        </div>
      </div>
    </div>`;
}

function bindImageFields(root) {
  $$('[data-img]', root).forEach(box => {
    const input = $('input[type=text]', box);
    const preview = $('.img-preview', box);
    const show = url => (preview.innerHTML = url ? `<img src="${esc(url)}" alt="">` : '<i class="fas fa-image"></i>');
    input.oninput = () => show(input.value.trim());
    $('[data-clear]', box).onclick = () => { input.value = ''; show(''); };
    $('input[type=file]', box).onchange = async e => {
      const file = e.target.files[0];
      if (!file) return;
      preview.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i>';
      try {
        const fd = new FormData();
        fd.append('file', await shrinkImage(file));
        const { url } = await api('/upload', { method: 'POST', body: fd });
        input.value = url;
        show(url);
      } catch (err) { fail(err); show(input.value); }
      e.target.value = '';
    };
  });
}

// Уменьшаем большие фото перед загрузкой — быстрее открываются у сотрудников
async function shrinkImage(file, max = 1600) {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type) || file.size < 400 * 1024) return file;
  try {
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * k);
    c.height = Math.round(bmp.height * k);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.85));
    return blob && blob.size < file.size ? new File([blob], 'image.jpg', { type: 'image/jpeg' }) : file;
  } catch { return file; }
}

// ---------- drag & drop сортировка ----------

function makeSortable(list, kind, onDone) {
  let dragged = null;
  $$('.list-item', list).forEach(item => {
    const handle = $('.handle', item);
    if (!handle) return;
    handle.onmousedown = handle.ontouchstart = () => (item.draggable = true);
    item.ondragstart = e => { dragged = item; item.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; };
    item.ondragend = async () => {
      item.draggable = false;
      item.classList.remove('dragging');
      $$('.list-item', list).forEach(i => i.classList.remove('drop-before', 'drop-after'));
      if (!dragged) return;
      dragged = null;
      const ids = $$('.list-item', list).map(i => Number(i.dataset.id));
      try { await api(`/reorder/${kind}`, { method: 'POST', body: { ids } }); toast('Порядок сохранён'); onDone?.(); } catch (e) { fail(e); }
    };
    item.ondragover = e => {
      if (!dragged || dragged === item) return;
      e.preventDefault();
      const after = e.clientY > item.getBoundingClientRect().top + item.offsetHeight / 2;
      $$('.list-item', list).forEach(i => i.classList.remove('drop-before', 'drop-after'));
      item.classList.add(after ? 'drop-after' : 'drop-before');
    };
    item.ondrop = e => {
      e.preventDefault();
      if (!dragged || dragged === item) return;
      const after = item.classList.contains('drop-after');
      item.parentNode.insertBefore(dragged, after ? item.nextSibling : item);
    };
  });
}

// Кнопки ↑↓ для телефона, где drag&drop неудобен
function moveItem(list, id, dir, kind, onDone) {
  const items = $$('.list-item', list);
  const i = items.findIndex(x => Number(x.dataset.id) === id);
  const j = i + dir;
  if (j < 0 || j >= items.length) return;
  const ids = items.map(x => Number(x.dataset.id));
  [ids[i], ids[j]] = [ids[j], ids[i]];
  api(`/reorder/${kind}`, { method: 'POST', body: { ids } }).then(onDone).catch(fail);
}

// ---------- auth ----------

function showLogin(errorText) {
  $('#shell').hidden = true;
  $('#login').hidden = false;
  if (errorText) $('#loginError').textContent = errorText;
  renderLoginWidget();
}

let loginRendered = false;
async function renderLoginWidget() {
  if (loginRendered) return;
  loginRendered = true;
  const box = $('#loginWidget');
  box.innerHTML = loader();
  try {
    const cfg = await fetch(`${API}/api/admin/config`).then(r => r.json());
    box.innerHTML = '';
    if (cfg.bot_username) {
      const s = document.createElement('script');
      s.async = true;
      s.src = 'https://telegram.org/js/telegram-widget.js?22';
      s.dataset.telegramLogin = cfg.bot_username;
      s.dataset.size = 'large';
      s.dataset.radius = '12';
      s.dataset.onauth = 'onTelegramAuth(user)';
      s.dataset.requestAccess = 'write';
      box.appendChild(s);
      $('#loginHint').innerHTML = `Войдите через Telegram. Доступ есть только у менеджеров.<br>Узнать свой ID: команда <span class="code">/id</span> в боте @${esc(cfg.bot_username)}`;
    } else if (!cfg.dev_mode) {
      box.innerHTML = '<p class="muted">Бот не настроен: задайте BOT_TOKEN в Cloudflare.</p>';
    }
    if (cfg.dev_mode) {
      const b = document.createElement('button');
      b.className = 'btn btn-gold';
      b.innerHTML = '<i class="fas fa-code"></i> Войти (режим разработки)';
      b.onclick = () => doLogin('/auth/dev', {});
      box.appendChild(b);
    }
  } catch {
    box.innerHTML = '<p class="login-error">API недоступен. Проверьте адрес в config.js</p>';
    loginRendered = false;
  }
}

async function doLogin(path, body) {
  $('#loginError').textContent = '';
  try {
    const { token } = await api(path, { method: 'POST', body });
    store.set('adm_token', token);
    await boot();
  } catch (e) {
    $('#loginError').textContent = e.message;
  }
}
window.onTelegramAuth = user => doLogin('/auth/telegram', user);

$('#logoutBtn').onclick = () => { store.set('adm_token', null); location.hash = ''; showLogin(); };
$('#menuBtn').onclick = () => { $('#sidebar').classList.add('open'); $('#backdrop').classList.add('open'); };
$('#backdrop').onclick = () => { $('#sidebar').classList.remove('open'); $('#backdrop').classList.remove('open'); };

let me = null;
async function boot() {
  if (!store.get('adm_token') && tg?.initData) {
    // Открыто из Telegram — входим автоматически
    try {
      const { token } = await api('/auth/webapp', { method: 'POST', body: { initData: tg.initData } });
      store.set('adm_token', token);
      tg.ready(); tg.expand();
    } catch (e) { return showLogin(e.message); }
  }
  if (!store.get('adm_token')) return showLogin();
  try { me = await api('/me'); } catch { return; }
  $('#login').hidden = true;
  $('#shell').hidden = false;
  $('#me').innerHTML = `${avatar({ first_name: me.name, photo_url: me.photo })}<div><b>${esc(me.name || 'Менеджер')}</b><span>ID ${me.id}</span></div>`;
  router();
}

// ---------- router ----------

const pages = {};
function router() {
  const [, section = '', id, sub] = (location.hash.replace(/^#/, '') || '/').split('/');
  const name = { '': 'dashboard', users: 'users', results: 'results', content: 'content', refs: 'refs', settings: 'settings' }[section] || 'dashboard';
  $$('.menu a').forEach(a => a.classList.toggle('active', a.dataset.route === name));
  $('#sidebar').classList.remove('open');
  $('#backdrop').classList.remove('open');
  view().innerHTML = loader();
  window.scrollTo(0, 0);
  const fn = id ? pages[name + 'Detail'] : pages[name];
  Promise.resolve(fn(id ? decodeURIComponent(id) : undefined, sub)).catch(e => {
    view().innerHTML = empty('triangle-exclamation', esc(e.message));
  });
}
window.addEventListener('hashchange', () => me && router());

// ---------- dashboard ----------

pages.dashboard = async () => {
  const s = await api('/stats');
  const t = s.totals;
  const max = Math.max(1, ...s.activity.map(a => a.attempts));
  const W = 600, H = 180, bw = W / s.activity.length;
  const bars = s.activity.map((a, i) => {
    const h = (a.attempts / max) * (H - 20), hp = (a.passed / max) * (H - 20);
    const d = new Date(a.date);
    return `<g><title>${d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })}: попыток ${a.attempts}, сдано ${a.passed}, новых ${a.new_users}</title>
      <rect class="bar-a" x="${i * bw + 2}" y="${H - h}" width="${bw - 4}" height="${h}" rx="3"/>
      <rect class="bar-p" x="${i * bw + 2}" y="${H - hp}" width="${bw - 4}" height="${hp}" rx="3"/>
      ${i % 5 === 4 ? `<text class="axis" x="${i * bw + bw / 2}" y="${H + 14}" text-anchor="middle">${d.getDate()}.${String(d.getMonth() + 1).padStart(2, '0')}</text>` : ''}</g>`;
  }).join('');

  view().innerHTML = `
    <div class="page-head"><div><h1>Обзор</h1><p>Как идёт обучение команды</p></div>
      <div class="actions"><a class="btn" href="#/users"><i class="fas fa-users"></i> Все сотрудники</a></div></div>
    <div class="grid kpis mb">
      <div class="card kpi"><div class="label"><i class="fas fa-users"></i>Сотрудников</div><div class="value">${t.users}</div><div class="sub">открывали приложение</div></div>
      <div class="card kpi"><div class="label"><i class="fas fa-trophy"></i>Прошли всё</div><div class="value">${t.completed}</div><div class="sub">${t.users ? Math.round(t.completed / t.users * 100) : 0}% от всех · ${t.blocks} блоков</div></div>
      <div class="card kpi"><div class="label"><i class="fas fa-bolt"></i>Попыток за 7 дней</div><div class="value">${t.attempts_week}</div><div class="sub">сдаётся с первого раза: ${t.pass_rate ?? '—'}${t.pass_rate != null ? '%' : ''}</div></div>
      <div class="card kpi"><div class="label"><i class="fas fa-star"></i>Средний балл</div><div class="value">${t.avg_percent ?? '—'}${t.avg_percent != null ? '%' : ''}</div><div class="sub">по всем попыткам</div></div>
    </div>
    <div class="grid two mb">
      <div class="card">
        <div class="card-head"><h3>Активность за 30 дней</h3></div>
        <div class="chart"><svg viewBox="0 -4 ${W} ${H + 20}" preserveAspectRatio="none">
          <line class="grid-line" x1="0" x2="${W}" y1="${H}" y2="${H}"/>${bars}</svg></div>
        <div class="legend"><span style="--c:var(--wine-2)">Попытки</span><span style="--c:var(--gold)">Сдано</span></div>
      </div>
      <div class="card">
        <div class="card-head"><h3>Прохождение блоков</h3></div>
        ${s.blocks.length ? s.blocks.map(b => `
          <div class="bstat">
            <div class="bstat-top"><b>${esc(b.icon)} ${esc(b.title)}</b><span class="muted">${b.passed}/${t.users} · ср. ${b.avg ?? '—'}${b.avg != null ? '%' : ''}</span></div>
            <div class="track ok"><div style="width:${t.users ? b.passed / t.users * 100 : 0}%"></div></div>
          </div>`).join('') : empty('layer-group', 'Нет опубликованных блоков')}
      </div>
    </div>
    <div class="grid half">
      <div class="card">
        <div class="card-head"><h3>Последние результаты</h3><a href="#/results" class="small">Все →</a></div>
        ${s.recent.length ? `<div class="table-wrap"><table><tbody>${s.recent.map(a => `
          <tr class="click" data-user="${a.user_id}">
            <td>${person(a, a.block_title)}</td>
            <td>${scoreHtml(a.percent, a.passed)} <span class="muted small">${a.correct}/${a.total}</span></td>
            <td class="muted small" style="text-align:right">${ago(a.finished_at)}</td>
          </tr>`).join('')}</tbody></table></div>` : empty('hourglass', 'Пока никто не проходил тесты')}
      </div>
      <div class="card">
        <div class="card-head"><h3>Самые сложные вопросы</h3></div>
        ${s.hardest.length ? s.hardest.map(h => `
          <div class="hard"><div class="rate">${Math.round(h.wrong / h.answers * 100)}%</div>
            <div style="min-width:0"><b>${esc(h.text)}</b><div class="muted small">${esc(h.block_title)} · ошибок ${h.wrong} из ${h.answers}</div></div></div>`).join('')
          : empty('face-smile', 'Ошибок пока нет')}
        <div class="muted small" style="padding:10px 20px 16px">Доля неправильных ответов — подсказка, какой материал стоит объяснить лучше.</div>
      </div>
    </div>`;
  $$('[data-user]').forEach(tr => (tr.onclick = () => (location.hash = `#/users/${tr.dataset.user}`)));
};

// ---------- users ----------

let usersFilter = { q: '', status: 'all' };
pages.users = async () => {
  const { users, blocks } = await api('/users');
  view().innerHTML = `
    <div class="page-head"><div><h1>Сотрудники</h1><p>Все, кто открывал приложение через бота</p></div>
      <div class="actions"><button class="btn" id="exportBtn"><i class="fas fa-file-excel"></i> Выгрузить в Excel</button></div></div>
    <div class="card">
      <div class="toolbar">
        <div class="search"><i class="fas fa-search"></i><input type="search" id="q" placeholder="Имя, @username, должность или ID" value="${esc(usersFilter.q)}"></div>
        <div class="tabs" id="statusTabs">
          ${[['all', 'Все'], ['done', 'Прошли всё'], ['progress', 'В процессе'], ['new', 'Не начали']].map(([k, l]) =>
            `<button data-s="${k}" class="${usersFilter.status === k ? 'active' : ''}">${l}</button>`).join('')}
        </div>
      </div>
      <div class="table-wrap"><table>
        <thead><tr><th>Сотрудник</th><th>Должность</th><th>Прогресс</th><th>Средний</th><th>Попыток</th><th>Активность</th></tr></thead>
        <tbody id="usersBody"></tbody></table></div>
    </div>`;

  const draw = () => {
    const q = usersFilter.q.toLowerCase();
    const list = users.filter(u => {
      if (q && !`${fullName(u)} ${u.username} ${u.position} ${u.tg_id}`.toLowerCase().includes(q)) return false;
      const st = u.total_blocks && u.passed_count === u.total_blocks ? 'done' : u.attempts ? 'progress' : 'new';
      return usersFilter.status === 'all' || usersFilter.status === st;
    });
    $('#usersBody').innerHTML = list.length ? list.map(u => `
      <tr class="click" data-id="${u.tg_id}">
        <td>${person(u)}</td>
        <td>${u.position ? esc(u.position) : '<span class="muted">—</span>'}</td>
        <td><div style="display:flex;align-items:center;gap:10px">
          <div class="segs" title="${blocks.map((b, i) => `${b.title}: ${u.blocks[i].best != null ? u.blocks[i].best + '%' : '—'}`).join('\n')}">
            ${u.blocks.map(b => `<i class="${b.passed ? 'ok' : b.best != null ? 'try' : ''}"></i>`).join('')}</div>
          <span class="small muted">${u.passed_count}/${u.total_blocks}</span>
          ${u.total_blocks && u.passed_count === u.total_blocks ? '<span class="pill gold">🏆</span>' : ''}</div></td>
        <td>${u.avg_best != null ? `<b>${u.avg_best}%</b>` : '<span class="muted">—</span>'}</td>
        <td>${u.attempts}</td>
        <td class="muted small">${ago(u.last_seen)}</td>
      </tr>`).join('') : `<tr><td colspan="6">${empty('user-slash', users.length ? 'Никого не найдено' : 'Сотрудники появятся здесь, когда откроют приложение в боте')}</td></tr>`;
    $$('#usersBody tr[data-id]').forEach(tr => (tr.onclick = () => (location.hash = `#/users/${tr.dataset.id}`)));
  };
  draw();
  $('#q').oninput = e => { usersFilter.q = e.target.value; draw(); };
  $$('#statusTabs button').forEach(b => (b.onclick = () => {
    usersFilter.status = b.dataset.s;
    $$('#statusTabs button').forEach(x => x.classList.toggle('active', x === b));
    draw();
  }));
  $('#exportBtn').onclick = exportCsv;
};

async function exportCsv() {
  try {
    const res = await api('/export/results.csv', { raw: true });
    const url = URL.createObjectURL(await res.blob());
    const a = Object.assign(document.createElement('a'), { href: url, download: `results-${new Date().toISOString().slice(0, 10)}.csv` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (e) { fail(e); }
}

pages.usersDetail = async id => {
  const d = await api(`/users/${id}`);
  const u = d.user;
  const passed = d.blocks.filter(b => b.status === 'passed').length;
  view().innerHTML = `
    <a class="back" href="#/users"><i class="fas fa-arrow-left"></i> Сотрудники</a>
    <div class="card mb"><div class="profile">
      ${avatar(u, 'lg')}
      <div style="flex:1;min-width:220px">
        <h2>${esc(fullName(u))} ${d.is_admin ? '<span class="pill gold">менеджер</span>' : ''}</h2>
        <div class="meta">
          ${u.username ? `<a href="https://t.me/${esc(u.username)}" target="_blank"><i class="fab fa-telegram"></i> @${esc(u.username)}</a>` : ''}
          <span>ID ${u.tg_id}</span>
          <span><i class="far fa-calendar"></i> с ${fmtDate(u.first_seen, false)}</span>
          <span><i class="far fa-clock"></i> был(а) ${ago(u.last_seen)}</span>
        </div>
      </div>
      <div style="text-align:right">
        <div style="font-size:28px;font-weight:800">${passed}/${d.blocks.length}</div>
        <div class="muted small">блоков пройдено</div>
      </div>
    </div></div>

    <div class="grid two mb">
      <div class="card">
        <div class="card-head"><h3>Прогресс по блокам</h3></div>
        <div class="card-pad"><div class="block-tiles">${d.blocks.map(b => `
          <div class="tile">
            <div class="tile-top"><div class="emoji" style="width:36px;height:36px;font-size:18px">${esc(b.icon)}</div><b>${esc(b.title)}</b></div>
            ${{ passed: '<span class="pill ok"><i class="fas fa-check"></i> Пройден</span>', available: b.attempts ? '<span class="pill bad">Не сдан</span>' : '<span class="pill warn">Доступен</span>', locked: '<span class="pill mute"><i class="fas fa-lock"></i> Закрыт</span>' }[b.status]}
            <div class="tile-stats"><span>Лучший: <b style="color:var(--text)">${b.best != null ? b.best + '%' : '—'}</b></span><span>Попыток: ${b.attempts}</span></div>
            <div class="tile-stats"><span>Прочитано уроков</span><span>${b.lessons_viewed}/${b.lessons_total}</span></div>
          </div>`).join('') || empty('layer-group', 'Нет блоков')}</div></div>
      </div>
      <div class="card">
        <div class="card-head"><h3>Карточка сотрудника</h3></div>
        <form class="card-pad" id="userForm">
          <label class="field"><span>Должность</span><input type="text" name="position" value="${esc(u.position)}" placeholder="Официант, бармен, повар..."></label>
          <label class="field"><span>Заметка</span><textarea name="note" placeholder="Видна только менеджерам">${esc(u.note)}</textarea></label>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button class="btn btn-primary" type="submit"><i class="fas fa-check"></i> Сохранить</button>
            <button class="btn btn-danger" type="button" id="resetBtn"><i class="fas fa-rotate-left"></i> Сбросить прогресс</button>
          </div>
          <div style="margin-top:16px;padding-top:16px;border-top:1px solid var(--line)">
            ${d.is_owner ? '<span class="muted small"><i class="fas fa-crown"></i> Владелец — полный доступ к кабинету</span>'
              : d.is_admin ? '<button class="btn" type="button" id="adminToggle" data-on="1"><i class="fas fa-user-minus"></i> Убрать из менеджеров</button>'
              : '<button class="btn btn-gold" type="button" id="adminToggle"><i class="fas fa-user-shield"></i> Сделать менеджером</button>'}
            ${d.is_owner ? '' : '<div class="muted small" style="margin-top:8px">Менеджер видит все результаты и редактирует контент. Входит через «Войти через Telegram» на странице кабинета.</div>'}
          </div>
        </form>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h3>История попыток</h3><span class="muted small">${d.attempts.length}</span></div>
      ${d.attempts.length ? `<div class="table-wrap"><table>
        <thead><tr><th>Дата</th><th>Блок</th><th>Результат</th><th>Статус</th><th></th></tr></thead>
        <tbody>${d.attempts.map(a => `
          <tr class="click" data-attempt="${a.id}">
            <td>${fmtDate(a.finished_at)}</td><td>${esc(a.block_title)}</td>
            <td>${scoreHtml(a.percent, a.passed)} <span class="muted small">${a.correct}/${a.total}</span></td>
            <td>${a.passed ? '<span class="pill ok">Сдано</span>' : '<span class="pill bad">Не сдано</span>'}</td>
            <td style="text-align:right"><span class="btn btn-sm">Ответы <i class="fas fa-chevron-right"></i></span></td>
          </tr>`).join('')}</tbody></table></div>` : empty('hourglass', 'Ещё не проходил(а) тесты')}
    </div>`;

  $('#userForm').onsubmit = async e => {
    e.preventDefault();
    try { await api(`/users/${u.tg_id}`, { method: 'PATCH', body: formValues(e.target) }); toast('Сохранено'); } catch (err) { fail(err); }
  };
  $('#resetBtn').onclick = async () => {
    if (!(await confirmDialog(`Удалить все результаты сотрудника <b>${esc(fullName(u))}</b>? Он начнёт обучение заново.`, 'Сбросить'))) return;
    try { await api(`/users/${u.tg_id}/progress`, { method: 'DELETE' }); toast('Прогресс сброшен'); router(); } catch (err) { fail(err); }
  };
  $$('[data-attempt]').forEach(tr => (tr.onclick = () => showAttempt(tr.dataset.attempt)));
  if ($('#adminToggle')) $('#adminToggle').onclick = async e => {
    const on = !!e.currentTarget.dataset.on;
    if (on && !(await confirmDialog(`Убрать у <b>${esc(fullName(u))}</b> доступ к кабинету?`, 'Убрать'))) return;
    try {
      if (on) await api(`/admins/${u.tg_id}`, { method: 'DELETE' });
      else await api('/admins', { method: 'POST', body: { tg_id: u.tg_id, name: u.position || '' } });
      toast(on ? 'Доступ к кабинету убран' : `${fullName(u)} теперь менеджер`);
      router();
    } catch (err) { fail(err); }
  };
};

async function showAttempt(id) {
  try {
    const { attempt: a, answers } = await api(`/attempts/${id}`);
    const answered = new Set(answers.map(x => x.question_id));
    modal({
      title: `${a.block_title} — ${a.percent}%`, wide: true, hideSave: true,
      body: `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;gap:10px;flex-wrap:wrap">
          ${person(a)}
          <div style="text-align:right">${a.passed ? '<span class="pill ok">Сдано</span>' : '<span class="pill bad">Не сдано</span>'}
            <div class="muted small" style="margin-top:4px">${a.correct}/${a.total} · порог ${a.pass_percent}% · ${fmtDate(a.finished_at)}</div></div>
        </div>
        <div class="answers">${answers.map((x, i) => `
          <div class="answer ${x.is_correct ? '' : 'wrong'}">
            <b>${i + 1}. ${esc(x.question_text)}</b>
            <div class="a">${x.is_correct ? '✅' : '❌'} Ответ: <b style="display:inline;color:var(--text)">${esc(x.selected_text)}</b>
            ${x.is_correct ? '' : `<br>Правильно: ${esc(x.correct_text)}`}</div>
          </div>`).join('')}
          ${a.total > answered.size ? `<div class="muted small">Без ответа: ${a.total - answered.size} ${a.total - answered.size === 1 ? 'вопрос' : 'вопроса(ов)'} (засчитаны как ошибка)</div>` : ''}
        </div>`
    });
  } catch (e) { fail(e); }
}

// ---------- results ----------

let resultsFilter = { block_id: '', passed: '', q: '' };
pages.results = async () => {
  const blocks = await api('/blocks');
  view().innerHTML = `
    <div class="page-head"><div><h1>Результаты</h1><p>Все завершённые попытки тестов</p></div>
      <div class="actions"><button class="btn" id="exportBtn"><i class="fas fa-file-excel"></i> Выгрузить в Excel</button></div></div>
    <div class="card">
      <div class="toolbar">
        <div class="search"><i class="fas fa-search"></i><input type="search" id="q" placeholder="Поиск по сотруднику" value="${esc(resultsFilter.q)}"></div>
        <select id="fBlock" style="width:auto"><option value="">Все блоки</option>${blocks.map(b => `<option value="${b.id}" ${String(b.id) === resultsFilter.block_id ? 'selected' : ''}>${esc(b.title)}</option>`).join('')}</select>
        <select id="fPassed" style="width:auto">
          <option value="">Любой результат</option>
          <option value="1" ${resultsFilter.passed === '1' ? 'selected' : ''}>Сдано</option>
          <option value="0" ${resultsFilter.passed === '0' ? 'selected' : ''}>Не сдано</option>
        </select>
      </div>
      <div class="table-wrap"><table>
        <thead><tr><th>Сотрудник</th><th>Блок</th><th>Результат</th><th>Статус</th><th>Дата</th></tr></thead>
        <tbody id="resBody"><tr><td colspan="5">${loader()}</td></tr></tbody></table></div>
    </div>`;
  let timer;
  const load = async () => {
    const qs = new URLSearchParams(Object.entries(resultsFilter).filter(([, v]) => v !== ''));
    try {
      const rows = await api(`/attempts?${qs}`);
      $('#resBody').innerHTML = rows.length ? rows.map(a => `
        <tr class="click" data-attempt="${a.id}">
          <td>${person(a, a.position || (a.username ? '@' + a.username : ''))}</td>
          <td>${esc(a.block_title)}</td>
          <td>${scoreHtml(a.percent, a.passed)} <span class="muted small">${a.correct}/${a.total}</span></td>
          <td>${a.passed ? '<span class="pill ok">Сдано</span>' : '<span class="pill bad">Не сдано</span>'}</td>
          <td class="muted small">${fmtDate(a.finished_at)}</td>
        </tr>`).join('') : `<tr><td colspan="5">${empty('magnifying-glass', 'Ничего не найдено')}</td></tr>`;
      $$('[data-attempt]').forEach(tr => (tr.onclick = () => showAttempt(tr.dataset.attempt)));
    } catch (e) { fail(e); }
  };
  load();
  $('#q').oninput = e => { resultsFilter.q = e.target.value; clearTimeout(timer); timer = setTimeout(load, 300); };
  $('#fBlock').onchange = e => { resultsFilter.block_id = e.target.value; load(); };
  $('#fPassed').onchange = e => { resultsFilter.passed = e.target.value; load(); };
  $('#exportBtn').onclick = exportCsv;
};

// ---------- content: blocks ----------

const blockForm = (b = {}) => `
  <div class="row-3">
    <label class="field"><span>Иконка</span><input type="text" name="icon" value="${esc(b.icon ?? '📘')}" maxlength="4" style="text-align:center;font-size:20px"></label>
    <label class="field"><span>Название</span><input type="text" name="title" value="${esc(b.title)}" required placeholder="Например: Сервис"></label>
    <label class="field"><span>Порог сдачи, %</span><input type="number" name="pass_percent" min="0" max="100" value="${b.pass_percent ?? 80}"></label>
  </div>
  <label class="field"><span>Короткое описание</span><input type="text" name="description" value="${esc(b.description)}" placeholder="Видно в списке блоков"></label>
  ${imageField('cover', b.cover || '', 'Обложка блока')}
  <label class="check"><input type="checkbox" name="published" ${b.published ?? 1 ? 'checked' : ''}> Опубликован (виден сотрудникам)</label>`;

pages.content = async () => {
  const blocks = await api('/blocks');
  view().innerHTML = `
    <div class="page-head"><div><h1>Блоки и тесты</h1><p>Перетаскивайте блоки за <i class="fas fa-grip-vertical"></i>, чтобы поменять порядок прохождения</p></div>
      <div class="actions"><button class="btn btn-primary" id="addBlock"><i class="fas fa-plus"></i> Новый блок</button></div></div>
    <div class="card"><div class="list" id="blocksList">
      ${blocks.length ? blocks.map((b, i) => `
        <div class="list-item" data-id="${b.id}">
          <span class="handle"><i class="fas fa-grip-vertical"></i></span>
          <div class="emoji">${esc(b.icon)}</div>
          <div class="list-main"><b>${i + 1}. ${esc(b.title)}</b><div class="desc">${esc(b.description) || '<span class="muted">без описания</span>'}</div></div>
          <div class="list-meta">
            <span class="pill mute"><i class="fas fa-file-lines"></i> ${b.lessons_count}</span>
            <span class="pill mute"><i class="fas fa-circle-question"></i> ${b.questions_count}</span>
            <span class="pill mute">≥ ${b.pass_percent}%</span>
            <span class="pill ok" title="Сотрудников сдали"><i class="fas fa-user-check"></i> ${b.passed_users}</span>
            <label class="switch" title="Опубликован"><input type="checkbox" data-pub="${b.id}" ${b.published ? 'checked' : ''}><span></span></label>
          </div>
          <div class="list-actions">
            <button class="icon-btn" data-up="${b.id}" title="Выше"><i class="fas fa-arrow-up"></i></button>
            <a class="btn btn-sm" href="#/content/${b.id}"><i class="fas fa-pen"></i> Редактировать</a>
          </div>
        </div>`).join('') : empty('layer-group', 'Блоков пока нет. Создайте первый!')}
    </div></div>
    <div class="muted small" style="margin-top:12px"><i class="fas fa-circle-info"></i> Если включено последовательное прохождение (Настройки), следующий блок открывается только после сдачи предыдущего.</div>`;

  makeSortable($('#blocksList'), 'blocks', router);
  $$('[data-up]').forEach(b => (b.onclick = () => moveItem($('#blocksList'), Number(b.dataset.up), -1, 'blocks', router)));
  $$('[data-pub]').forEach(cb => (cb.onchange = async () => {
    try { await api(`/blocks/${cb.dataset.pub}`, { method: 'PUT', body: { published: cb.checked ? 1 : 0 } }); toast(cb.checked ? 'Блок опубликован' : 'Блок скрыт'); }
    catch (e) { fail(e); cb.checked = !cb.checked; }
  }));
  $('#addBlock').onclick = () => modal({
    title: 'Новый блок', body: blockForm(), saveText: 'Создать',
    onSave: async form => {
      const b = await api('/blocks', { method: 'POST', body: formValues(form) });
      location.hash = `#/content/${b.id}`;
    }
  });
};

let blockTab = 'lessons';
pages.contentDetail = async id => {
  const { block: b, lessons, questions } = await api(`/blocks/${id}`);
  view().innerHTML = `
    <a class="back" href="#/content"><i class="fas fa-arrow-left"></i> Все блоки</a>
    <div class="page-head">
      <div style="display:flex;gap:14px;align-items:center"><div class="emoji">${esc(b.icon)}</div>
        <div><h1>${esc(b.title)}</h1><p>${b.published ? '<span class="pill ok">Опубликован</span>' : '<span class="pill mute">Скрыт</span>'} · порог ${b.pass_percent}%</p></div></div>
      <div class="actions">
        <button class="btn" id="editBlock"><i class="fas fa-sliders"></i> Настройки блока</button>
        <button class="btn btn-danger" id="delBlock"><i class="fas fa-trash"></i></button>
      </div>
    </div>
    <div class="tabs big mb" id="blockTabs" style="display:inline-flex">
      <button data-t="lessons" class="${blockTab === 'lessons' ? 'active' : ''}"><i class="fas fa-file-lines"></i> Уроки (${lessons.length})</button>
      <button data-t="questions" class="${blockTab === 'questions' ? 'active' : ''}"><i class="fas fa-circle-question"></i> Вопросы теста (${questions.length})</button>
    </div>
    <div id="tabBody"></div>`;

  const reload = () => pages.contentDetail(id);

  const drawLessons = () => {
    $('#tabBody').innerHTML = `
      <div class="card">
        <div class="card-head"><h3>Уроки</h3><button class="btn btn-primary btn-sm" id="addLesson"><i class="fas fa-plus"></i> Добавить урок</button></div>
        <div class="list" id="lessonsList">${lessons.length ? lessons.map((l, i) => `
          <div class="list-item" data-id="${l.id}">
            <span class="handle"><i class="fas fa-grip-vertical"></i></span>
            <span class="num">${i + 1}</span>
            ${l.image ? `<img class="thumb" src="${esc(l.image)}" alt="">` : ''}
            <div class="list-main"><b>${esc(l.title || 'Без заголовка')}</b><div class="desc">${esc(l.text)}</div></div>
            <div class="list-actions">
              <button class="icon-btn" data-up="${l.id}" title="Выше"><i class="fas fa-arrow-up"></i></button>
              <button class="icon-btn" data-edit="${l.id}" title="Изменить"><i class="fas fa-pen"></i></button>
              <button class="icon-btn danger" data-del="${l.id}" title="Удалить"><i class="fas fa-trash"></i></button>
            </div>
          </div>`).join('') : empty('file-lines', 'Уроков нет. Сотрудник сразу перейдёт к тесту.')}</div>
      </div>
      <div class="muted small" style="margin-top:10px">Уроки — это слайды, которые сотрудник листает перед тестом. Поддерживается <span class="code">**жирный**</span> текст и ссылки.</div>`;
    const lessonModal = (l = {}) => modal({
      title: l.id ? 'Редактировать урок' : 'Новый урок', wide: true,
      body: `
        <label class="field"><span>Заголовок</span><input type="text" name="title" value="${esc(l.title)}" placeholder="Необязательно"></label>
        <label class="field"><span>Текст</span><textarea name="text" rows="10" placeholder="Материал урока...">${esc(l.text)}</textarea>
          <small>Переносы строк сохраняются. **так** — жирный текст.</small></label>
        ${imageField('image', l.image || '')}`,
      onSave: async form => {
        const v = formValues(form);
        if (!v.text.trim() && !v.image) throw new Error('Добавьте текст или картинку');
        await api(l.id ? `/lessons/${l.id}` : `/blocks/${id}/lessons`, { method: l.id ? 'PUT' : 'POST', body: v });
        toast('Урок сохранён');
        reload();
      }
    });
    $('#addLesson').onclick = () => lessonModal();
    $$('[data-edit]').forEach(btn => (btn.onclick = () => lessonModal(lessons.find(l => l.id === Number(btn.dataset.edit)))));
    $$('[data-del]').forEach(btn => (btn.onclick = async () => {
      if (!(await confirmDialog('Удалить урок?'))) return;
      try { await api(`/lessons/${btn.dataset.del}`, { method: 'DELETE' }); toast('Урок удалён'); reload(); } catch (e) { fail(e); }
    }));
    makeSortable($('#lessonsList'), 'lessons', reload);
    $$('[data-up]').forEach(btn => (btn.onclick = () => moveItem($('#lessonsList'), Number(btn.dataset.up), -1, 'lessons', reload)));
  };

  const drawQuestions = () => {
    $('#tabBody').innerHTML = `
      <div class="card">
        <div class="card-head"><h3>Вопросы теста</h3><button class="btn btn-primary btn-sm" id="addQ"><i class="fas fa-plus"></i> Добавить вопрос</button></div>
        <div class="list" id="qList">${questions.length ? questions.map((q, i) => `
          <div class="list-item" data-id="${q.id}">
            <span class="handle"><i class="fas fa-grip-vertical"></i></span>
            <span class="num">${i + 1}</span>
            ${q.image ? `<img class="thumb" src="${esc(q.image)}" alt="">` : ''}
            <div class="list-main"><b>${esc(q.text)}</b>
              <div class="opts">${q.options.map((o, j) => `<span class="${j === q.correct ? 'right' : ''}">${j === q.correct ? '✓ ' : ''}${esc(o)}</span>`).join('')}</div></div>
            <div class="list-actions">
              <button class="icon-btn" data-up="${q.id}" title="Выше"><i class="fas fa-arrow-up"></i></button>
              <button class="icon-btn" data-edit="${q.id}" title="Изменить"><i class="fas fa-pen"></i></button>
              <button class="icon-btn danger" data-del="${q.id}" title="Удалить"><i class="fas fa-trash"></i></button>
            </div>
          </div>`).join('') : empty('circle-question', 'Вопросов нет — без них блок нельзя сдать.')}</div>
      </div>
      <div class="muted small" style="margin-top:10px">Для сдачи нужно ответить правильно минимум на ${b.pass_percent}% вопросов. Ответы проверяются на сервере — правильный вариант сотрудник видит только после ответа.</div>`;

    const qModal = (q = { options: ['', ''], correct: 0 }) => {
      const m = modal({
        title: q.id ? 'Редактировать вопрос' : 'Новый вопрос', wide: true,
        body: `
          <label class="field"><span>Вопрос</span><textarea name="text" rows="2" placeholder="Текст вопроса">${esc(q.text)}</textarea></label>
          <div class="field"><span>Варианты ответа <small style="font-weight:400">— отметьте правильный</small></span><div id="opts"></div>
            <button type="button" class="btn btn-sm" id="addOpt" style="align-self:flex-start"><i class="fas fa-plus"></i> Вариант</button></div>
          <label class="field"><span>Пояснение</span><textarea name="explanation" rows="2" placeholder="Показывается после ответа">${esc(q.explanation)}</textarea></label>
          ${imageField('image', q.image || '', 'Картинка к вопросу')}`,
        onSave: async form => {
          const options = $$('.opt-row input[type=text]', form).map(i => i.value.trim());
          const checked = $$('.opt-row input[type=radio]', form).findIndex(r => r.checked);
          const filled = options.map((o, i) => ({ o, i })).filter(x => x.o);
          if (!form.text.value.trim()) throw new Error('Введите текст вопроса');
          if (filled.length < 2) throw new Error('Нужно минимум 2 варианта ответа');
          const correct = filled.findIndex(x => x.i === checked);
          if (correct < 0) throw new Error('Отметьте правильный вариант');
          await api(q.id ? `/questions/${q.id}` : `/blocks/${id}/questions`, {
            method: q.id ? 'PUT' : 'POST',
            body: { text: form.text.value.trim(), explanation: form.explanation.value.trim(), image: form.image.value.trim(), options: filled.map(x => x.o), correct }
          });
          toast('Вопрос сохранён');
          reload();
        }
      });
      const box = $('#opts', m.root);
      const addRow = (val = '', checked = false) => {
        const row = document.createElement('div');
        row.className = 'opt-row' + (checked ? ' is-right' : '');
        row.innerHTML = `<input type="radio" name="correct_opt" ${checked ? 'checked' : ''} title="Правильный ответ">
          <input type="text" value="${esc(val)}" placeholder="Вариант ${String.fromCharCode(65 + box.children.length)}">
          <button type="button" class="icon-btn danger"><i class="fas fa-xmark"></i></button>`;
        $('input[type=radio]', row).onchange = () => $$('.opt-row', box).forEach(r => r.classList.toggle('is-right', $('input[type=radio]', r).checked));
        $('button', row).onclick = () => { if (box.children.length > 2) row.remove(); };
        box.appendChild(row);
      };
      q.options.forEach((o, i) => addRow(o, i === q.correct));
      $('#addOpt', m.root).onclick = () => { if (box.children.length < 8) addRow(); };
    };
    $('#addQ').onclick = () => qModal();
    $$('[data-edit]').forEach(btn => (btn.onclick = () => qModal(questions.find(q => q.id === Number(btn.dataset.edit)))));
    $$('[data-del]').forEach(btn => (btn.onclick = async () => {
      if (!(await confirmDialog('Удалить вопрос? Уже пройденные попытки сохранятся в истории.'))) return;
      try { await api(`/questions/${btn.dataset.del}`, { method: 'DELETE' }); toast('Вопрос удалён'); reload(); } catch (e) { fail(e); }
    }));
    makeSortable($('#qList'), 'questions', reload);
    $$('[data-up]').forEach(btn => (btn.onclick = () => moveItem($('#qList'), Number(btn.dataset.up), -1, 'questions', reload)));
  };

  const draw = () => (blockTab === 'lessons' ? drawLessons() : drawQuestions());
  draw();
  $$('#blockTabs button').forEach(t => (t.onclick = () => {
    blockTab = t.dataset.t;
    $$('#blockTabs button').forEach(x => x.classList.toggle('active', x === t));
    draw();
  }));
  $('#editBlock').onclick = () => modal({
    title: 'Настройки блока', body: blockForm(b),
    onSave: async form => { await api(`/blocks/${id}`, { method: 'PUT', body: formValues(form) }); toast('Блок сохранён'); reload(); }
  });
  $('#delBlock').onclick = async () => {
    if (!(await confirmDialog(`Удалить блок «${esc(b.title)}» со всеми уроками и вопросами? История результатов сотрудников сохранится.`))) return;
    try { await api(`/blocks/${id}`, { method: 'DELETE' }); toast('Блок удалён'); location.hash = '#/content'; } catch (e) { fail(e); }
  };
};

// ---------- references ----------

let refCat = null;
pages.refs = async () => {
  const cats = await api('/refs');
  if (!cats.some(c => c.id === refCat)) refCat = cats[0]?.id ?? null;
  const cat = cats.find(c => c.id === refCat);
  view().innerHTML = `
    <div class="page-head"><div><h1>Справочники</h1><p>Меню, винная карта, аллергены — всё, что сотрудник может быстро найти</p></div>
      <div class="actions"><button class="btn btn-primary" id="addCat"><i class="fas fa-plus"></i> Раздел</button></div></div>
    <div class="split">
      <div class="card"><div class="list" id="catList">${cats.map(c => `
        <div class="list-item cat-item ${c.id === refCat ? 'active' : ''}" data-id="${c.id}">
          <span class="handle"><i class="fas fa-grip-vertical"></i></span>
          <span style="font-size:18px">${esc(c.icon)}</span><b>${esc(c.title)}</b><span class="muted small">${c.items.length}</span>
        </div>`).join('') || empty('book-open', 'Нет разделов')}</div></div>
      <div class="card">${cat ? `
        <div class="card-head"><h3>${esc(cat.icon)} ${esc(cat.title)}</h3>
          <div style="display:flex;gap:6px">
            <button class="btn btn-sm" id="editCat"><i class="fas fa-pen"></i></button>
            <button class="btn btn-sm btn-danger" id="delCat"><i class="fas fa-trash"></i></button>
            <button class="btn btn-sm btn-primary" id="addItem"><i class="fas fa-plus"></i> Запись</button>
          </div></div>
        <div class="toolbar"><div class="search"><i class="fas fa-search"></i><input type="search" id="itemQ" placeholder="Поиск в разделе"></div></div>
        <div class="list" id="itemList">${cat.items.map(i => `
          <div class="list-item" data-id="${i.id}" data-search="${esc((i.title + ' ' + i.body).toLowerCase())}">
            <span class="handle"><i class="fas fa-grip-vertical"></i></span>
            ${i.image ? `<img class="thumb" src="${esc(i.image)}" alt="">` : ''}
            <div class="list-main"><b>${esc(i.title)}</b><div class="desc">${esc(i.body)}</div></div>
            <div class="list-actions">
              <button class="icon-btn" data-edit="${i.id}"><i class="fas fa-pen"></i></button>
              <button class="icon-btn danger" data-del="${i.id}"><i class="fas fa-trash"></i></button>
            </div>
          </div>`).join('') || empty('list', 'Пусто — добавьте первую запись')}</div>` : empty('book-open', 'Создайте раздел справочника')}
      </div>
    </div>`;

  const catModal = (c = {}) => modal({
    title: c.id ? 'Раздел' : 'Новый раздел',
    body: `<div class="row-3" style="grid-template-columns:90px 1fr">
      <label class="field"><span>Иконка</span><input type="text" name="icon" value="${esc(c.icon ?? '📄')}" maxlength="4" style="text-align:center;font-size:20px"></label>
      <label class="field"><span>Название</span><input type="text" name="title" value="${esc(c.title)}" placeholder="Например: Меню"></label></div>`,
    onSave: async form => {
      const v = formValues(form);
      const r = await api(c.id ? `/ref-categories/${c.id}` : '/ref-categories', { method: c.id ? 'PUT' : 'POST', body: v });
      if (!c.id) refCat = r.id;
      pages.refs();
    }
  });
  const itemModal = (i = {}) => modal({
    title: i.id ? 'Запись' : 'Новая запись',
    body: `
      <label class="field"><span>Название</span><input type="text" name="title" value="${esc(i.title)}" placeholder="Например: Хинкали"></label>
      <label class="field"><span>Описание</span><textarea name="body" rows="5" placeholder="Состав, подача, рекомендации...">${esc(i.body)}</textarea></label>
      ${imageField('image', i.image || '')}`,
    onSave: async form => {
      await api(i.id ? `/ref-items/${i.id}` : `/ref-categories/${refCat}/items`, { method: i.id ? 'PUT' : 'POST', body: formValues(form) });
      toast('Сохранено');
      pages.refs();
    }
  });

  $('#addCat').onclick = () => catModal();
  $$('#catList .cat-item').forEach(el => (el.onclick = e => { if (!e.target.closest('.handle')) { refCat = Number(el.dataset.id); pages.refs(); } }));
  makeSortable($('#catList'), 'ref-categories');
  if (!cat) return;
  $('#editCat').onclick = () => catModal(cat);
  $('#delCat').onclick = async () => {
    if (!(await confirmDialog(`Удалить раздел «${esc(cat.title)}» и все записи в нём?`))) return;
    try { await api(`/ref-categories/${cat.id}`, { method: 'DELETE' }); refCat = null; pages.refs(); } catch (e) { fail(e); }
  };
  $('#addItem').onclick = () => itemModal();
  $$('#itemList [data-edit]').forEach(b => (b.onclick = () => itemModal(cat.items.find(i => i.id === Number(b.dataset.edit)))));
  $$('#itemList [data-del]').forEach(b => (b.onclick = async () => {
    if (!(await confirmDialog('Удалить запись?'))) return;
    try { await api(`/ref-items/${b.dataset.del}`, { method: 'DELETE' }); pages.refs(); } catch (e) { fail(e); }
  }));
  makeSortable($('#itemList'), 'ref-items');
  $('#itemQ').oninput = e => {
    const q = e.target.value.toLowerCase();
    $$('#itemList .list-item').forEach(el => (el.hidden = q && !el.dataset.search.includes(q)));
  };
};

// ---------- settings ----------

pages.settings = async () => {
  const [s, admins] = await Promise.all([api('/settings'), api('/admins')]);
  view().innerHTML = `
    <div class="page-head"><div><h1>Настройки</h1><p>Тексты приложения, доступ менеджеров и бот</p></div></div>
    <div class="grid half">
      <form class="card" id="settingsForm">
        <div class="card-head"><h3>Приложение</h3><button class="btn btn-primary btn-sm" type="submit"><i class="fas fa-check"></i> Сохранить</button></div>
        <div class="card-pad">
          <label class="field"><span>Название</span><input type="text" name="app_title" value="${esc(s.app_title)}"></label>
          <label class="field"><span>Приветствие на главной</span><textarea name="welcome_text" rows="2">${esc(s.welcome_text)}</textarea></label>
          <label class="check"><input type="checkbox" name="sequential" ${s.sequential === '1' ? 'checked' : ''}> Последовательное прохождение блоков</label>
          <label class="check"><input type="checkbox" name="notify_admins" ${s.notify_admins === '1' ? 'checked' : ''}> Присылать менеджерам в Telegram результаты тестов</label>
          <div class="menu-label" style="padding-left:0;color:var(--muted)">Сертификат</div>
          <label class="field"><span>Заголовок</span><input type="text" name="certificate_title" value="${esc(s.certificate_title)}"></label>
          <label class="field"><span>Текст</span><textarea name="certificate_text" rows="2">${esc(s.certificate_text)}</textarea></label>
          <label class="field"><span>Подпись</span><input type="text" name="certificate_signature" value="${esc(s.certificate_signature)}"></label>
        </div>
      </form>
      <div>
        <div class="card mb">
          <div class="card-head"><h3>Менеджеры</h3></div>
          <div class="list">${admins.map(a => `
            <div class="list-item">
              ${person({ ...a, first_name: a.first_name || a.name || 'Без имени' }, `ID ${a.tg_id}${a.name && a.first_name ? ' · ' + a.name : ''}`)}
              <div style="flex:1"></div>
              ${a.locked ? '<span class="pill gold">владелец</span>' : `<button class="icon-btn danger" data-deladm="${a.tg_id}" title="Убрать доступ"><i class="fas fa-user-minus"></i></button>`}
            </div>`).join('') || empty('user-shield', 'Нет менеджеров')}</div>
          <form class="card-pad" id="adminForm" style="border-top:1px solid var(--line)">
            <div class="row">
              <label class="field"><span>Telegram ID</span><input type="text" name="tg_id" placeholder="123456789" inputmode="numeric"></label>
              <label class="field"><span>Подпись</span><input type="text" name="name" placeholder="Управляющий, Невский"></label>
            </div>
            <button class="btn btn-sm" type="submit"><i class="fas fa-user-plus"></i> Дать доступ</button>
            <div class="muted small" style="margin-top:10px">ID человек узнаёт командой <span class="code">/id</span> в боте или видит при попытке входа.</div>
          </form>
        </div>
        <div class="card mb">
          <div class="card-head"><h3>Telegram-бот</h3></div>
          <div class="card-pad">
            <p class="muted" style="margin-bottom:12px">Подключит вебхук, кнопку «Обучение» в меню бота и команды /start, /admin, /id. Нажмите один раз после деплоя.</p>
            <button class="btn btn-gold" id="botSetup"><i class="fab fa-telegram"></i> Настроить бота</button>
            <div id="botResult" class="small" style="margin-top:10px"></div>
          </div>
        </div>
        <form class="card" id="importForm">
          <div class="card-head"><h3>Импорт из Google Таблицы</h3></div>
          <div class="card-pad">
            <label class="field"><span>Ссылка на таблицу</span><input type="text" name="sheet" placeholder="https://docs.google.com/spreadsheets/d/..."></label>
            <label class="check"><input type="checkbox" name="replace"> Заменить весь текущий контент</label>
            <button class="btn btn-sm" type="submit"><i class="fas fa-file-import"></i> Импортировать</button>
            <div class="muted small" style="margin-top:10px">Листы Texts, Questions, Menu, Wine, Allergens — как в старой версии. Таблица должна быть доступна по ссылке.</div>
          </div>
        </form>
      </div>
    </div>`;

  $('#settingsForm').onsubmit = async e => {
    e.preventDefault();
    const v = formValues(e.target);
    v.sequential = String(v.sequential);
    v.notify_admins = String(v.notify_admins);
    try { await api('/settings', { method: 'PUT', body: v }); toast('Настройки сохранены'); } catch (err) { fail(err); }
  };
  $('#adminForm').onsubmit = async e => {
    e.preventDefault();
    try { await api('/admins', { method: 'POST', body: formValues(e.target) }); toast('Доступ выдан'); pages.settings(); } catch (err) { fail(err); }
  };
  $$('[data-deladm]').forEach(b => (b.onclick = async () => {
    if (!(await confirmDialog('Убрать доступ к кабинету?', 'Убрать'))) return;
    try { await api(`/admins/${b.dataset.deladm}`, { method: 'DELETE' }); pages.settings(); } catch (err) { fail(err); }
  }));
  $('#botSetup').onclick = async e => {
    e.target.disabled = true;
    try {
      const r = await api('/bot/setup', { method: 'POST' });
      $('#botResult').innerHTML = `<span class="pill ok"><i class="fas fa-check"></i> Готово</span> Бот @${esc(r.bot)} открывает ${esc(r.webapp)}`;
    } catch (err) { $('#botResult').innerHTML = `<span style="color:var(--bad)">${esc(err.message)}</span>`; }
    e.target.disabled = false;
  };
  $('#importForm').onsubmit = async e => {
    e.preventDefault();
    const v = formValues(e.target);
    if (v.replace && !(await confirmDialog('Текущие блоки, уроки, вопросы и справочники будут удалены. Продолжить?', 'Заменить'))) return;
    const btn = $('[type=submit]', e.target);
    btn.disabled = true;
    try {
      const r = await api('/import/sheets', { method: 'POST', body: v });
      toast(`Импортировано: блоков ${r.blocks}, уроков ${r.lessons}, вопросов ${r.questions}, записей ${r.refs}`);
    } catch (err) { fail(err); }
    btn.disabled = false;
  };
};

boot();

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('../sw.js').catch(() => {});
}
