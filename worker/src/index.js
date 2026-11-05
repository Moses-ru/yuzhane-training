import crypto from 'node:crypto';
import { botApi, escapeHtml } from './telegram.js';
import { importFromSheets, importContent } from './sheets-import.js';

// ---------- helpers ----------

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });

function pick(obj, fields) {
  const out = {};
  for (const f of fields) if (obj?.[f] !== undefined) out[f] = obj[f];
  return out;
}

const displayName = a => a.name || a.login;

// Тонкая обёртка над D1: позиционные параметры, как в SQLite
function makeDb(DB) {
  return {
    DB,
    stmt: (sql, ...a) => DB.prepare(sql).bind(...a),
    all: async (sql, ...a) => (await DB.prepare(sql).bind(...a).all()).results,
    first: (sql, ...a) => DB.prepare(sql).bind(...a).first(),
    run: (sql, ...a) => DB.prepare(sql).bind(...a).run(),
    batch: stmts => DB.batch(stmts),
    async insert(table, data) {
      const keys = Object.keys(data);
      const r = await DB.prepare(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`)
        .bind(...keys.map(k => data[k])).run();
      return r.meta.last_row_id;
    },
    async update(table, id, data) {
      const keys = Object.keys(data);
      if (!keys.length) return;
      await DB.prepare(`UPDATE ${table} SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`)
        .bind(...keys.map(k => data[k]), id).run();
    }
  };
}

async function getSettings(db) {
  const out = {};
  for (const r of await db.all('SELECT key, value FROM settings')) out[r.key] = r.value;
  return out;
}

async function sessionSecret(env, db) {
  if (env.SESSION_SECRET) return env.SESSION_SECRET;
  let row = await db.first("SELECT value FROM settings WHERE key = '_session_secret'");
  if (!row) {
    await db.run("INSERT OR IGNORE INTO settings (key, value) VALUES ('_session_secret', ?)", crypto.randomBytes(32).toString('hex'));
    row = await db.first("SELECT value FROM settings WHERE key = '_session_secret'");
  }
  return row.value;
}

function sign(secret, payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${crypto.createHmac('sha256', secret).update(body).digest('base64url')}`;
}

function unsign(secret, token) {
  if (!token || !token.includes('.')) return null;
  const [body, mac] = token.split('.');
  const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  if (mac.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    return payload.exp > Date.now() ? payload : null;
  } catch { return null; }
}

// ---------- пароли ----------

// PBKDF2-SHA256 с солью. Число итераций ограничено лимитом CPU бесплатного тарифа Workers.
const PBKDF2_ITERATIONS = 20000;

async function pbkdf2(password, salt, iterations) {
  const key = await globalThis.crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  return Buffer.from(await globalThis.crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256));
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

async function verifyPassword(password, stored) {
  const [scheme, iter, salt, hash] = String(stored || '').split('$');
  if (scheme !== 'pbkdf2') return false;
  const actual = await pbkdf2(password, Buffer.from(salt, 'base64'), Number(iter));
  const expected = Buffer.from(hash, 'base64');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

const LOGIN_RE = /^[\p{L}\p{N}._-]{3,32}$/u;
function validateCredentials(login, password) {
  if (!LOGIN_RE.test(login)) throw new HttpError(400, 'Логин: от 3 до 32 символов — буквы, цифры, точка, дефис или подчёркивание');
  if (String(password || '').length < 6) throw new HttpError(400, 'Пароль должен быть не короче 6 символов');
}

const ROLES = ['waiter', 'manager', 'admin'];
const ACCOUNT_PUBLIC = ['id', 'login', 'name', 'role', 'position', 'must_change_password'];

// ---------- seed ----------

let seedChecked = false;
async function ensureSeed(db) {
  if (seedChecked) return;
  // Первый вход в кабинет: admin / admin, пароль нужно сменить сразу после входа
  if (!(await db.first("SELECT id FROM accounts WHERE role = 'admin' LIMIT 1"))) {
    await db.run(
      "INSERT OR IGNORE INTO accounts (login, password_hash, name, role, must_change_password) VALUES ('admin', ?, 'Администратор', 'admin', 1)",
      await hashPassword('admin'));
  }
  if ((await db.first('SELECT COUNT(*) AS n FROM blocks')).n === 0 && !(await db.first("SELECT value FROM settings WHERE key = '_seeded'"))) {
    const id = await db.insert('blocks', { title: 'Первый блок', icon: '📘', description: 'Пример — отредактируйте в кабинете', sort: 0 });
    await db.batch([
      db.stmt('INSERT INTO lessons (block_id, sort, title, text) VALUES (?, 0, ?, ?)', id, 'Добро пожаловать', 'Здесь будет материал урока.'),
      db.stmt('INSERT INTO questions (block_id, sort, text, options, correct, explanation) VALUES (?, 0, ?, ?, 0, ?)', id, 'Пример вопроса', JSON.stringify(['Правильный ответ', 'Неправильный']), 'Пояснение к ответу')
    ]);
    await db.run("INSERT OR IGNORE INTO settings (key, value) VALUES ('_seeded', '1')");
  }
  seedChecked = true;
}

// ---------- domain ----------

const publishedBlocks = db => db.all('SELECT * FROM blocks WHERE published = 1 ORDER BY sort, id');

// Статусы блоков для сотрудника: passed / available / locked
async function blockStatuses(db, userId) {
  const sequential = (await getSettings(db)).sequential === '1';
  const rows = await db.all(`
    SELECT block_id, MAX(percent) AS best, MAX(passed) AS passed, COUNT(*) AS attempts
    FROM attempts WHERE user_id = ? AND finished_at IS NOT NULL GROUP BY block_id`, userId);
  const best = Object.fromEntries(rows.map(r => [r.block_id, r]));
  let prevPassed = true;
  return (await publishedBlocks(db)).map(b => {
    const r = best[b.id];
    const passed = !!(r && r.passed);
    const status = passed ? 'passed' : (!sequential || prevPassed ? 'available' : 'locked');
    prevPassed = passed;
    return { block: b, status, best: r ? r.best : null, attempts: r ? r.attempts : 0 };
  });
}

async function loadAvailableBlock(db, userId, blockId) {
  const entry = (await blockStatuses(db, userId)).find(s => s.block.id === Number(blockId));
  if (!entry) throw new HttpError(404, 'Блок не найден');
  if (entry.status === 'locked') throw new HttpError(403, 'Сначала пройдите предыдущий блок');
  return entry.block;
}

const BLOCK_PUBLIC = ['id', 'title', 'description', 'icon', 'cover', 'pass_percent'];
const BLOCK_FIELDS = ['title', 'description', 'icon', 'cover', 'pass_percent', 'published'];
const LESSON_FIELDS = ['title', 'text', 'image'];
const QUESTION_FIELDS = ['text', 'image', 'options', 'correct', 'explanation'];
const CATEGORY_FIELDS = ['title', 'icon'];
const ITEM_FIELDS = ['title', 'body', 'image'];
const REORDERABLE = { blocks: 'blocks', lessons: 'lessons', questions: 'questions', 'ref-categories': 'ref_categories', 'ref-items': 'ref_items' };

function normalizeQuestion(body) {
  const data = pick(body, QUESTION_FIELDS);
  if (data.options !== undefined) {
    const opts = (Array.isArray(data.options) ? data.options : []).map(o => String(o).trim()).filter(Boolean);
    if (opts.length < 2) throw new HttpError(400, 'Нужно минимум 2 варианта ответа');
    data.options = JSON.stringify(opts);
    data.correct = Math.max(0, Math.min(Number(data.correct) || 0, opts.length - 1));
  }
  return data;
}

const nextSort = async (db, table, where = '', ...a) =>
  (await db.first(`SELECT COALESCE(MAX(sort), -1) + 1 AS s FROM ${table} ${where}`, ...a)).s;

const parseQ = q => ({ ...q, options: JSON.parse(q.options) });

// ---------- routes ----------
// auth: null — без входа; 'user' — любая учётная запись; 'manager' — менеджер или админ; 'admin' — только админ

const routes = [];
const route = (method, path, auth, handler) => {
  const keys = [];
  const re = new RegExp('^' + path.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
  routes.push({ method, re, keys, auth, handler });
};

// --- вход и регистрация ---

const SESSION_SHORT_HOURS = 12;
const SESSION_LONG_DAYS = 30;

function issueSession(secret, account, remember) {
  const ttl = remember ? SESSION_LONG_DAYS * 86400e3 : SESSION_SHORT_HOURS * 3600e3;
  return {
    token: sign(secret, { kind: 'acc', id: account.id, v: account.token_version || 0, exp: Date.now() + ttl }),
    remember: !!remember,
    account: pick(account, ACCOUNT_PUBLIC)
  };
}

route('GET', '/api/config', null, async ({ db }) => {
  const s = await getSettings(db);
  return { app_title: s.app_title, allow_registration: s.allow_registration !== '0' };
});

route('POST', '/api/auth/register', null, async ({ db, body, secret }) => {
  if ((await getSettings(db)).allow_registration === '0') throw new HttpError(403, 'Регистрация закрыта. Обратитесь к менеджеру.');
  const login = String(body.login || '').trim();
  const name = String(body.name || '').trim();
  validateCredentials(login, body.password);
  if (name.length < 2) throw new HttpError(400, 'Укажите имя и фамилию');
  if (await db.first('SELECT id FROM accounts WHERE login = ?', login)) throw new HttpError(409, 'Такой логин уже занят');
  const id = await db.insert('accounts', { login, name, password_hash: await hashPassword(body.password), role: 'waiter', last_seen: sqlNow() });
  return issueSession(secret, await db.first('SELECT * FROM accounts WHERE id = ?', id), body.remember);
});

const LOCK_AFTER = 5;
const LOCK_MINUTES = 5;
const sqlNow = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString().replace('T', ' ').slice(0, 19);

route('POST', '/api/auth/login', null, async ({ db, body, secret }) => {
  const login = String(body.login || '').trim();
  const account = await db.first('SELECT * FROM accounts WHERE login = ?', login);
  const fail = new HttpError(401, 'Неверный логин или пароль');
  if (!account) throw fail;
  if (account.locked_until && account.locked_until > sqlNow()) {
    throw new HttpError(429, `Слишком много неудачных попыток. Попробуйте через ${LOCK_MINUTES} минут.`);
  }
  if (!(await verifyPassword(String(body.password || ''), account.password_hash))) {
    const failed = account.failed_logins + 1;
    await db.run('UPDATE accounts SET failed_logins = ?, locked_until = ? WHERE id = ?',
      failed >= LOCK_AFTER ? 0 : failed, failed >= LOCK_AFTER ? sqlNow(LOCK_MINUTES * 60e3) : null, account.id);
    throw fail;
  }
  await db.run('UPDATE accounts SET failed_logins = 0, locked_until = NULL, last_seen = ? WHERE id = ?', sqlNow(), account.id);
  return issueSession(secret, account, body.remember);
});

route('GET', '/api/auth/me', 'user', ({ account }) => pick(account, ACCOUNT_PUBLIC));

route('POST', '/api/auth/password', 'user', async ({ db, account, body, secret }) => {
  if (!(await verifyPassword(String(body.old_password || ''), account.password_hash))) throw new HttpError(400, 'Текущий пароль указан неверно');
  if (String(body.new_password || '').length < 6) throw new HttpError(400, 'Новый пароль должен быть не короче 6 символов');
  if (body.new_password === body.old_password) throw new HttpError(400, 'Новый пароль должен отличаться от текущего');
  // Смена пароля завершает все остальные сессии
  await db.run('UPDATE accounts SET password_hash = ?, must_change_password = 0, token_version = token_version + 1 WHERE id = ?',
    await hashPassword(body.new_password), account.id);
  return issueSession(secret, await db.first('SELECT * FROM accounts WHERE id = ?', account.id), body.remember);
});

// --- сотрудник ---

route('GET', '/api/app', 'user', async ({ db, account }) => {
  const settings = await getSettings(db);
  const statuses = await blockStatuses(db, account.id);
  const counts = Object.fromEntries((await db.all(`
    SELECT b.id, (SELECT COUNT(*) FROM lessons WHERE block_id = b.id) AS lessons,
                 (SELECT COUNT(*) FROM questions WHERE block_id = b.id) AS questions FROM blocks b`)).map(r => [r.id, r]));
  const cats = await db.all('SELECT * FROM ref_categories ORDER BY sort, id');
  const items = await db.all('SELECT id, category_id, title, body, image FROM ref_items ORDER BY sort, id');
  const history = await db.all(`
    SELECT id, block_id, block_title, correct, total, percent, passed, finished_at
    FROM attempts WHERE user_id = ? AND finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 30`, account.id);
  const allPassed = statuses.length && statuses.every(s => s.status === 'passed');
  return {
    settings: pick(settings, ['app_title', 'welcome_text', 'certificate_title', 'certificate_text', 'certificate_signature']),
    user: pick(account, ACCOUNT_PUBLIC),
    isAdmin: account.role !== 'waiter',
    blocks: statuses.map(({ block: b, status, best, attempts }) => ({
      ...pick(b, BLOCK_PUBLIC), lessons: counts[b.id].lessons, questions: counts[b.id].questions, status, best, attempts
    })),
    completedAt: allPassed ? (await db.first('SELECT MAX(finished_at) AS t FROM attempts WHERE user_id = ? AND passed = 1', account.id)).t : null,
    references: cats.map(c => ({ ...c, items: items.filter(i => i.category_id === c.id) })),
    history
  };
});

route('GET', '/api/blocks/:id', 'user', async ({ db, account, params }) => {
  const block = await loadAvailableBlock(db, account.id, params.id);
  const lessons = await db.all('SELECT id, title, text, image FROM lessons WHERE block_id = ? ORDER BY sort, id', block.id);
  const viewed = new Set((await db.all('SELECT lesson_id FROM lesson_views WHERE user_id = ?', account.id)).map(r => r.lesson_id));
  return { block: pick(block, BLOCK_PUBLIC), lessons: lessons.map(l => ({ ...l, viewed: viewed.has(l.id) })) };
});

route('POST', '/api/lessons/:id/view', 'user', async ({ db, account, params }) => {
  await db.run('INSERT OR IGNORE INTO lesson_views (user_id, lesson_id) VALUES (?, ?)', account.id, Number(params.id));
  return { ok: true };
});

route('POST', '/api/attempts', 'user', async ({ db, account, body }) => {
  const block = await loadAvailableBlock(db, account.id, body.block_id);
  const questions = await db.all('SELECT id, text, image, options FROM questions WHERE block_id = ? ORDER BY sort, id', block.id);
  if (!questions.length) throw new HttpError(400, 'В блоке пока нет вопросов');
  await db.run('DELETE FROM attempts WHERE user_id = ? AND block_id = ? AND finished_at IS NULL', account.id, block.id);
  const attemptId = await db.insert('attempts', {
    user_id: account.id, block_id: block.id, block_title: block.title, pass_percent: block.pass_percent, total: questions.length
  });
  return { attempt_id: attemptId, pass_percent: block.pass_percent, questions: questions.map(parseQ) };
});

async function loadOpenAttempt(db, account, id) {
  const attempt = await db.first('SELECT * FROM attempts WHERE id = ? AND user_id = ?', Number(id), account.id);
  if (!attempt) throw new HttpError(404, 'Попытка не найдена');
  if (attempt.finished_at) throw new HttpError(400, 'Тест уже завершён');
  return attempt;
}

route('POST', '/api/attempts/:id/answer', 'user', async ({ db, account, params, body }) => {
  const attempt = await loadOpenAttempt(db, account, params.id);
  const q = await db.first('SELECT * FROM questions WHERE id = ? AND block_id = ?', Number(body.question_id), attempt.block_id);
  if (!q) throw new HttpError(404, 'Вопрос не найден');
  const options = JSON.parse(q.options);
  const selected = Number(body.selected);
  if (!Number.isInteger(selected) || selected < 0 || selected >= options.length) throw new HttpError(400, 'Неверный вариант ответа');
  const existing = await db.first('SELECT * FROM attempt_answers WHERE attempt_id = ? AND question_id = ?', attempt.id, q.id);
  if (!existing) {
    await db.insert('attempt_answers', {
      attempt_id: attempt.id, question_id: q.id, question_text: q.text, selected,
      selected_text: options[selected] ?? '', correct_text: options[q.correct] ?? '', is_correct: selected === q.correct ? 1 : 0
    });
  }
  // Засчитывается только первый ответ на вопрос
  const first = existing ? existing.selected : selected;
  return { is_correct: first === q.correct, correct: q.correct, selected: first, explanation: q.explanation };
});

route('POST', '/api/attempts/:id/finish', 'user', async ({ db, env, ctx, account, params }) => {
  const attempt = await loadOpenAttempt(db, account, params.id);
  const correct = (await db.first('SELECT COUNT(*) AS n FROM attempt_answers WHERE attempt_id = ? AND is_correct = 1', attempt.id)).n;
  const percent = attempt.total ? Math.round((correct / attempt.total) * 100) : 0;
  const passed = percent >= attempt.pass_percent ? 1 : 0;
  await db.run("UPDATE attempts SET correct = ?, percent = ?, passed = ?, finished_at = datetime('now') WHERE id = ?", correct, percent, passed, attempt.id);
  const statuses = await blockStatuses(db, account.id);
  const allPassed = statuses.length > 0 && statuses.every(s => s.status === 'passed');

  ctx.waitUntil(notifyOwners(env, db,
    `${passed ? '✅' : '❌'} <b>${escapeHtml(displayName(account))}</b>${account.position ? ' · ' + escapeHtml(account.position) : ''}\n` +
    `Блок «${escapeHtml(attempt.block_title)}»: ${correct}/${attempt.total} (${percent}%)` +
    (allPassed && passed ? '\n🏆 Всё обучение пройдено!' : '')));

  return { correct, total: attempt.total, percent, passed: !!passed, pass_percent: attempt.pass_percent, all_passed: allPassed };
});

// Уведомления о результатах — в Telegram владельцам из ADMIN_IDS (если бот подключён)
async function notifyOwners(env, db, text) {
  if (!env.BOT_TOKEN || (await getSettings(db)).notify_admins !== '1') return;
  const ids = String(env.ADMIN_IDS || '').split(/[,\s]+/).filter(Boolean);
  await Promise.all(ids.map(id =>
    botApi(env.BOT_TOKEN, 'sendMessage', { chat_id: id, text, parse_mode: 'HTML' }).catch(() => {})));
}

// --- картинки (хранятся в KV) ---

route('GET', '/img/:key', null, async ({ env, params }) => {
  const { value, metadata } = await env.IMAGES.getWithMetadata(params.key, 'arrayBuffer');
  if (!value) return new Response('Not found', { status: 404 });
  return new Response(value, { headers: { 'Content-Type': metadata?.type || 'image/jpeg', 'Cache-Control': 'public, max-age=31536000, immutable' } });
});

// --- кабинет: статистика и результаты ---

// Служебная учётная запись admin в статистике сотрудников не участвует
const STAFF = "role != 'admin'";

route('GET', '/api/admin/stats', 'manager', async ({ db }) => {
  const blocks = await publishedBlocks(db);
  const users = await db.all(`SELECT id FROM accounts WHERE ${STAFF}`);
  const staff = new Set(users.map(u => u.id));
  const passedByUser = {};
  for (const r of await db.all('SELECT DISTINCT user_id, block_id FROM attempts WHERE passed = 1')) {
    if (staff.has(r.user_id)) (passedByUser[r.user_id] ||= new Set()).add(r.block_id);
  }
  const completed = users.filter(u => blocks.length && blocks.every(b => passedByUser[u.id]?.has(b.id))).length;
  const fin = await db.first('SELECT AVG(percent) AS avg, AVG(passed) AS rate FROM attempts WHERE finished_at IS NOT NULL');
  const week = (await db.first("SELECT COUNT(*) AS n FROM attempts WHERE finished_at >= datetime('now', '-7 days')")).n;

  const act = await db.all(`SELECT date(finished_at) AS d, COUNT(*) AS attempts, SUM(passed) AS passed
    FROM attempts WHERE finished_at >= date('now', '-29 days') GROUP BY d`);
  const nu = await db.all(`SELECT date(created_at) AS d, COUNT(*) AS n FROM accounts WHERE created_at >= date('now', '-29 days') GROUP BY d`);
  const activity = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400e3).toISOString().slice(0, 10);
    const a = act.find(r => r.d === d);
    activity.push({ date: d, attempts: a?.attempts || 0, passed: a?.passed || 0, new_users: nu.find(r => r.d === d)?.n || 0 });
  }

  const bs = Object.fromEntries((await db.all(`
    SELECT block_id, COUNT(DISTINCT user_id) AS started, COUNT(*) AS attempts, AVG(percent) AS avg,
           COUNT(DISTINCT CASE WHEN passed = 1 THEN user_id END) AS passed
    FROM attempts WHERE finished_at IS NOT NULL GROUP BY block_id`)).map(r => [r.block_id, r]));

  return {
    totals: {
      users: users.length, completed,
      in_progress: Object.keys(passedByUser).length - completed,
      attempts_week: week,
      avg_percent: fin.avg == null ? null : Math.round(fin.avg),
      pass_rate: fin.rate == null ? null : Math.round(fin.rate * 100),
      blocks: blocks.length
    },
    activity,
    blocks: blocks.map(b => {
      const s = bs[b.id] || { started: 0, attempts: 0, avg: null, passed: 0 };
      return { id: b.id, title: b.title, icon: b.icon, started: s.started, attempts: s.attempts, passed: s.passed, avg: s.avg == null ? null : Math.round(s.avg) };
    }),
    hardest: await db.all(`
      SELECT aa.question_id, MAX(aa.question_text) AS text, MAX(a.block_title) AS block_title,
             COUNT(*) AS answers, SUM(1 - aa.is_correct) AS wrong
      FROM attempt_answers aa JOIN attempts a ON a.id = aa.attempt_id
      WHERE a.finished_at IS NOT NULL GROUP BY aa.question_id HAVING wrong > 0
      ORDER BY CAST(wrong AS REAL) / COUNT(*) DESC, COUNT(*) DESC LIMIT 6`),
    recent: await db.all(`
      SELECT a.*, u.name, u.login, u.position
      FROM attempts a JOIN accounts u ON u.id = a.user_id
      WHERE a.finished_at IS NOT NULL ORDER BY a.finished_at DESC LIMIT 8`)
  };
});

async function bestByUser(db) {
  const best = {};
  for (const r of await db.all(`
    SELECT user_id, block_id, MAX(percent) AS best, MAX(passed) AS passed, COUNT(*) AS attempts
    FROM attempts WHERE finished_at IS NOT NULL GROUP BY user_id, block_id`)) (best[r.user_id] ||= {})[r.block_id] = r;
  return best;
}

const ACCOUNT_ADMIN_VIEW = 'id, login, name, role, position, note, created_at, last_seen, must_change_password';

route('GET', '/api/admin/users', 'manager', async ({ db }) => {
  const blocks = await publishedBlocks(db);
  const best = await bestByUser(db);
  const users = (await db.all(`SELECT ${ACCOUNT_ADMIN_VIEW} FROM accounts ORDER BY COALESCE(last_seen, created_at) DESC`)).map(u => {
    const r = best[u.id] || {};
    const per = blocks.map(b => ({ id: b.id, best: r[b.id]?.best ?? null, passed: !!r[b.id]?.passed }));
    const tried = per.filter(p => p.best != null);
    return {
      ...u,
      passed_count: per.filter(p => p.passed).length,
      total_blocks: blocks.length,
      avg_best: tried.length ? Math.round(tried.reduce((s, p) => s + p.best, 0) / tried.length) : null,
      attempts: Object.values(r).reduce((s, x) => s + x.attempts, 0),
      blocks: per
    };
  });
  return { users, blocks: blocks.map(b => pick(b, ['id', 'title', 'icon'])) };
});

async function loadAccount(db, id) {
  const a = await db.first('SELECT * FROM accounts WHERE id = ?', Number(id));
  if (!a) throw new HttpError(404, 'Сотрудник не найден');
  return a;
}

// Менеджер управляет только официантами; админ — всеми
function assertCanManage(actor, target) {
  if (actor.role !== 'admin' && target.role !== 'waiter') throw new HttpError(403, 'Это может сделать только администратор');
}

route('POST', '/api/admin/users', 'manager', async ({ db, account, body }) => {
  const login = String(body.login || '').trim();
  const name = String(body.name || '').trim();
  const role = ROLES.includes(body.role) ? body.role : 'waiter';
  if (role !== 'waiter' && account.role !== 'admin') throw new HttpError(403, 'Назначать менеджеров может только администратор');
  validateCredentials(login, body.password);
  if (!name) throw new HttpError(400, 'Укажите имя');
  if (await db.first('SELECT id FROM accounts WHERE login = ?', login)) throw new HttpError(409, 'Такой логин уже занят');
  const id = await db.insert('accounts', {
    login, name, role, position: String(body.position || ''),
    password_hash: await hashPassword(body.password), must_change_password: body.must_change_password ? 1 : 0
  });
  return { id };
});

route('GET', '/api/admin/users/:id', 'manager', async ({ db, params }) => {
  const user = await loadAccount(db, params.id);
  const statuses = await blockStatuses(db, user.id);
  const lessonCounts = Object.fromEntries((await db.all('SELECT block_id, COUNT(*) AS n FROM lessons GROUP BY block_id')).map(r => [r.block_id, r.n]));
  const viewed = Object.fromEntries((await db.all(`
    SELECT l.block_id, COUNT(*) AS n FROM lesson_views v JOIN lessons l ON l.id = v.lesson_id
    WHERE v.user_id = ? GROUP BY l.block_id`, user.id)).map(r => [r.block_id, r.n]));
  return {
    user: pick(user, ACCOUNT_ADMIN_VIEW.split(', ')),
    blocks: statuses.map(s => ({
      id: s.block.id, title: s.block.title, icon: s.block.icon, status: s.status, best: s.best, attempts: s.attempts,
      lessons_total: lessonCounts[s.block.id] || 0, lessons_viewed: viewed[s.block.id] || 0
    })),
    attempts: await db.all('SELECT * FROM attempts WHERE user_id = ? AND finished_at IS NOT NULL ORDER BY finished_at DESC', user.id)
  };
});

route('PATCH', '/api/admin/users/:id', 'manager', async ({ db, account, params, body }) => {
  const target = await loadAccount(db, params.id);
  if (target.id !== account.id) assertCanManage(account, target);
  const data = pick(body, ['name', 'position', 'note']);
  for (const k of Object.keys(data)) data[k] = String(data[k]).trim();
  await db.update('accounts', target.id, data);
  return { ok: true };
});

route('PATCH', '/api/admin/users/:id/role', 'admin', async ({ db, account, params, body }) => {
  const target = await loadAccount(db, params.id);
  if (!ROLES.includes(body.role)) throw new HttpError(400, 'Неизвестная роль');
  if (target.id === account.id) throw new HttpError(400, 'Нельзя изменить собственную роль');
  if (target.role === 'admin' && body.role !== 'admin' &&
      (await db.first("SELECT COUNT(*) AS n FROM accounts WHERE role = 'admin'")).n <= 1) {
    throw new HttpError(400, 'Должен остаться хотя бы один администратор');
  }
  // Смена роли завершает сессии этого человека — новые права применятся при следующем входе
  await db.run('UPDATE accounts SET role = ?, token_version = token_version + 1 WHERE id = ?', body.role, target.id);
  return { ok: true };
});

route('POST', '/api/admin/users/:id/password', 'manager', async ({ db, account, params, body }) => {
  const target = await loadAccount(db, params.id);
  assertCanManage(account, target);
  if (String(body.password || '').length < 6) throw new HttpError(400, 'Пароль должен быть не короче 6 символов');
  await db.run('UPDATE accounts SET password_hash = ?, must_change_password = 1, token_version = token_version + 1, failed_logins = 0, locked_until = NULL WHERE id = ?',
    await hashPassword(body.password), target.id);
  return { ok: true };
});

route('DELETE', '/api/admin/users/:id/progress', 'manager', async ({ db, account, params }) => {
  const target = await loadAccount(db, params.id);
  if (target.id !== account.id) assertCanManage(account, target);
  await db.batch([
    db.stmt('DELETE FROM attempt_answers WHERE attempt_id IN (SELECT id FROM attempts WHERE user_id = ?)', target.id),
    db.stmt('DELETE FROM attempts WHERE user_id = ?', target.id),
    db.stmt('DELETE FROM lesson_views WHERE user_id = ?', target.id)
  ]);
  return { ok: true };
});

route('DELETE', '/api/admin/users/:id', 'admin', async ({ db, account, params }) => {
  const target = await loadAccount(db, params.id);
  if (target.id === account.id) throw new HttpError(400, 'Нельзя удалить собственную учётную запись');
  if (target.role === 'admin' && (await db.first("SELECT COUNT(*) AS n FROM accounts WHERE role = 'admin'")).n <= 1) {
    throw new HttpError(400, 'Должен остаться хотя бы один администратор');
  }
  await db.batch([
    db.stmt('DELETE FROM attempt_answers WHERE attempt_id IN (SELECT id FROM attempts WHERE user_id = ?)', target.id),
    db.stmt('DELETE FROM attempts WHERE user_id = ?', target.id),
    db.stmt('DELETE FROM lesson_views WHERE user_id = ?', target.id),
    db.stmt('DELETE FROM accounts WHERE id = ?', target.id)
  ]);
  return { ok: true };
});

route('GET', '/api/admin/attempts', 'manager', async ({ db, query }) => {
  const where = ['a.finished_at IS NOT NULL'];
  const args = [];
  if (query.get('block_id')) { where.push('a.block_id = ?'); args.push(Number(query.get('block_id'))); }
  if (['0', '1'].includes(query.get('passed'))) { where.push('a.passed = ?'); args.push(Number(query.get('passed'))); }
  if (query.get('q')) {
    where.push("(u.name || ' ' || u.login || ' ' || u.position) LIKE ?");
    args.push(`%${query.get('q')}%`);
  }
  const limit = Math.min(Number(query.get('limit')) || 200, 500);
  return db.all(`
    SELECT a.*, u.name, u.login, u.position
    FROM attempts a JOIN accounts u ON u.id = a.user_id
    WHERE ${where.join(' AND ')} ORDER BY a.finished_at DESC LIMIT ${limit}`, ...args);
});

route('GET', '/api/admin/attempts/:id', 'manager', async ({ db, params }) => {
  const attempt = await db.first(`
    SELECT a.*, u.name, u.login, u.position
    FROM attempts a JOIN accounts u ON u.id = a.user_id WHERE a.id = ?`, Number(params.id));
  if (!attempt) throw new HttpError(404, 'Попытка не найдена');
  return { attempt, answers: await db.all('SELECT * FROM attempt_answers WHERE attempt_id = ? ORDER BY answered_at', attempt.id) };
});

const ROLE_TITLES = { waiter: 'Сотрудник', manager: 'Менеджер', admin: 'Администратор' };

route('GET', '/api/admin/export/results.csv', 'manager', async ({ db }) => {
  const blocks = await publishedBlocks(db);
  const best = await bestByUser(db);
  const cell = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [['Имя', 'Логин', 'Должность', 'Роль', ...blocks.map(b => b.title), 'Пройдено блоков', 'Последняя активность'].map(cell).join(';')];
  for (const u of await db.all(`SELECT * FROM accounts WHERE ${STAFF} ORDER BY name`)) {
    const r = best[u.id] || {};
    lines.push([
      displayName(u), u.login, u.position, ROLE_TITLES[u.role],
      ...blocks.map(b => r[b.id] ? `${r[b.id].best}%${r[b.id].passed ? ' ✓' : ''}` : '—'),
      `${blocks.filter(b => r[b.id]?.passed).length}/${blocks.length}`, u.last_seen || ''
    ].map(cell).join(';'));
  }
  return new Response('﻿' + lines.join('\r\n'), { headers: { 'Content-Type': 'text/csv; charset=utf-8' } });
});

// --- кабинет: контент ---

route('GET', '/api/admin/blocks', 'manager', ({ db }) => db.all(`
  SELECT b.*,
    (SELECT COUNT(*) FROM lessons WHERE block_id = b.id) AS lessons_count,
    (SELECT COUNT(*) FROM questions WHERE block_id = b.id) AS questions_count,
    (SELECT COUNT(DISTINCT user_id) FROM attempts WHERE block_id = b.id AND passed = 1) AS passed_users
  FROM blocks b ORDER BY sort, id`));

route('POST', '/api/admin/blocks', 'manager', async ({ db, body }) => {
  const data = pick(body, BLOCK_FIELDS);
  if (!data.title) throw new HttpError(400, 'Укажите название блока');
  const id = await db.insert('blocks', { ...data, sort: await nextSort(db, 'blocks') });
  return db.first('SELECT * FROM blocks WHERE id = ?', id);
});

route('GET', '/api/admin/blocks/:id', 'manager', async ({ db, params }) => {
  const block = await db.first('SELECT * FROM blocks WHERE id = ?', Number(params.id));
  if (!block) throw new HttpError(404, 'Блок не найден');
  return {
    block,
    lessons: await db.all('SELECT * FROM lessons WHERE block_id = ? ORDER BY sort, id', block.id),
    questions: (await db.all('SELECT * FROM questions WHERE block_id = ? ORDER BY sort, id', block.id)).map(parseQ)
  };
});

route('PUT', '/api/admin/blocks/:id', 'manager', async ({ db, params, body }) => {
  await db.update('blocks', Number(params.id), { ...pick(body, BLOCK_FIELDS), updated_at: sqlNow() });
  return db.first('SELECT * FROM blocks WHERE id = ?', Number(params.id));
});

route('DELETE', '/api/admin/blocks/:id', 'manager', async ({ db, params }) => {
  const id = Number(params.id);
  await db.batch([
    db.stmt('DELETE FROM lessons WHERE block_id = ?', id),
    db.stmt('DELETE FROM questions WHERE block_id = ?', id),
    db.stmt('DELETE FROM blocks WHERE id = ?', id)
  ]);
  return { ok: true };
});

route('POST', '/api/admin/blocks/:id/lessons', 'manager', async ({ db, params, body }) => {
  const blockId = Number(params.id);
  const id = await db.insert('lessons', { ...pick(body, LESSON_FIELDS), block_id: blockId, sort: await nextSort(db, 'lessons', 'WHERE block_id = ?', blockId) });
  return db.first('SELECT * FROM lessons WHERE id = ?', id);
});
route('PUT', '/api/admin/lessons/:id', 'manager', async ({ db, params, body }) => {
  await db.update('lessons', Number(params.id), pick(body, LESSON_FIELDS));
  return db.first('SELECT * FROM lessons WHERE id = ?', Number(params.id));
});
route('DELETE', '/api/admin/lessons/:id', 'manager', async ({ db, params }) => {
  await db.run('DELETE FROM lessons WHERE id = ?', Number(params.id));
  return { ok: true };
});

route('POST', '/api/admin/blocks/:id/questions', 'manager', async ({ db, params, body }) => {
  const blockId = Number(params.id);
  const data = normalizeQuestion(body);
  if (!data.text) throw new HttpError(400, 'Укажите текст вопроса');
  const id = await db.insert('questions', { ...data, block_id: blockId, sort: await nextSort(db, 'questions', 'WHERE block_id = ?', blockId) });
  return parseQ(await db.first('SELECT * FROM questions WHERE id = ?', id));
});
route('PUT', '/api/admin/questions/:id', 'manager', async ({ db, params, body }) => {
  await db.update('questions', Number(params.id), normalizeQuestion(body));
  return parseQ(await db.first('SELECT * FROM questions WHERE id = ?', Number(params.id)));
});
route('DELETE', '/api/admin/questions/:id', 'manager', async ({ db, params }) => {
  await db.run('DELETE FROM questions WHERE id = ?', Number(params.id));
  return { ok: true };
});

route('GET', '/api/admin/refs', 'manager', async ({ db }) => {
  const cats = await db.all('SELECT * FROM ref_categories ORDER BY sort, id');
  const items = await db.all('SELECT * FROM ref_items ORDER BY sort, id');
  return cats.map(c => ({ ...c, items: items.filter(i => i.category_id === c.id) }));
});
route('POST', '/api/admin/ref-categories', 'manager', async ({ db, body }) => {
  const data = pick(body, CATEGORY_FIELDS);
  if (!data.title) throw new HttpError(400, 'Укажите название');
  return { id: await db.insert('ref_categories', { ...data, sort: await nextSort(db, 'ref_categories') }) };
});
route('PUT', '/api/admin/ref-categories/:id', 'manager', async ({ db, params, body }) => {
  await db.update('ref_categories', Number(params.id), pick(body, CATEGORY_FIELDS));
  return { ok: true };
});
route('DELETE', '/api/admin/ref-categories/:id', 'manager', async ({ db, params }) => {
  const id = Number(params.id);
  await db.batch([db.stmt('DELETE FROM ref_items WHERE category_id = ?', id), db.stmt('DELETE FROM ref_categories WHERE id = ?', id)]);
  return { ok: true };
});
route('POST', '/api/admin/ref-categories/:id/items', 'manager', async ({ db, params, body }) => {
  const catId = Number(params.id);
  const data = pick(body, ITEM_FIELDS);
  if (!data.title) throw new HttpError(400, 'Укажите название');
  return { id: await db.insert('ref_items', { ...data, category_id: catId, sort: await nextSort(db, 'ref_items', 'WHERE category_id = ?', catId) }) };
});
route('PUT', '/api/admin/ref-items/:id', 'manager', async ({ db, params, body }) => {
  await db.update('ref_items', Number(params.id), pick(body, ITEM_FIELDS));
  return { ok: true };
});
route('DELETE', '/api/admin/ref-items/:id', 'manager', async ({ db, params }) => {
  await db.run('DELETE FROM ref_items WHERE id = ?', Number(params.id));
  return { ok: true };
});

route('POST', '/api/admin/reorder/:kind', 'manager', async ({ db, params, body }) => {
  const table = REORDERABLE[params.kind];
  if (!table || !Array.isArray(body.ids)) throw new HttpError(400, 'Bad request');
  if (body.ids.length) await db.batch(body.ids.map((id, i) => db.stmt(`UPDATE ${table} SET sort = ? WHERE id = ?`, i, Number(id))));
  return { ok: true };
});

route('POST', '/api/admin/upload', 'manager', async ({ env, request, url }) => {
  const form = await request.formData();
  const file = form.get('file');
  if (!file || typeof file === 'string' || !/^image\/(png|jpe?g|webp|gif)$/.test(file.type)) {
    throw new HttpError(400, 'Можно загрузить только изображение (JPG, PNG, WEBP, GIF)');
  }
  if (file.size > 5 * 1024 * 1024) throw new HttpError(400, 'Файл больше 5 МБ');
  const key = `${Date.now().toString(36)}-${crypto.randomBytes(6).toString('hex')}`;
  await env.IMAGES.put(key, await file.arrayBuffer(), { metadata: { type: file.type } });
  return { url: `${url.origin}/img/${key}` };
});

// --- кабинет: настройки, импорт, бот (только администратор) ---

route('GET', '/api/admin/settings', 'admin', async ({ db }) =>
  Object.fromEntries(Object.entries(await getSettings(db)).filter(([k]) => !k.startsWith('_'))));

route('PUT', '/api/admin/settings', 'admin', async ({ db, body }) => {
  const stmts = Object.entries(body || {}).filter(([k]) => !k.startsWith('_')).map(([k, v]) =>
    db.stmt('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', k, String(v)));
  if (stmts.length) await db.batch(stmts);
  return { ok: true };
});

route('POST', '/api/admin/import/sheets', 'admin', async ({ env, body }) => {
  const match = String(body.sheet || '').match(/[-\w]{25,}/);
  if (!match) throw new HttpError(400, 'Вставьте ссылку на таблицу или её ID');
  return importFromSheets(env.DB, match[0], { replace: !!body.replace });
});

// Те же листы, уже разобранные из Excel-файла в JSON: { texts, questions, menu, wine, allergens }
route('POST', '/api/admin/import/content', 'admin', async ({ env, body }) =>
  importContent(env.DB, body.data || {}, { replace: !!body.replace }));

const webhookSecret = secret => crypto.createHmac('sha256', secret).update('tg-webhook').digest('hex').slice(0, 48);

// Подключает бота: вебхук на этот Worker, кнопку меню и команды
route('POST', '/api/admin/bot/setup', 'admin', async ({ env, url, secret }) => {
  if (!env.BOT_TOKEN) throw new HttpError(400, 'BOT_TOKEN не задан в Cloudflare');
  const webapp = String(env.WEBAPP_URL || '').replace(/\/$/, '');
  await botApi(env.BOT_TOKEN, 'setWebhook', { url: `${url.origin}/bot`, secret_token: webhookSecret(secret), allowed_updates: ['message'] });
  await botApi(env.BOT_TOKEN, 'setChatMenuButton', { menu_button: { type: 'web_app', text: 'Обучение', web_app: { url: `${webapp}/` } } });
  await botApi(env.BOT_TOKEN, 'setMyCommands', { commands: [
    { command: 'start', description: 'Начать обучение' },
    { command: 'admin', description: 'Кабинет менеджера' }
  ] });
  const me = await botApi(env.BOT_TOKEN, 'getMe');
  return { ok: true, bot: me.username, webapp };
});

// --- вебхук бота: открывает приложение, вход по логину и паролю уже внутри ---

route('POST', '/bot', null, async ({ env, db, request, body, secret }) => {
  if (request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== webhookSecret(secret)) throw new HttpError(403, 'Forbidden');
  const msg = body.message;
  if (!msg?.text) return { ok: true };
  const webapp = String(env.WEBAPP_URL || '').replace(/\/$/, '');
  const send = payload => botApi(env.BOT_TOKEN, 'sendMessage', { chat_id: msg.chat.id, ...payload });
  const text = msg.text.trim();
  if (text.startsWith('/start')) {
    const s = await getSettings(db);
    await send({
      text: `👋 Привет, ${escapeHtml(msg.from.first_name)}!\n\n${escapeHtml(s.welcome_text)}`,
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '🎓 Начать обучение', web_app: { url: `${webapp}/` } }]] }
    });
  } else if (text.startsWith('/admin')) {
    await send({
      text: '🗂 Кабинет менеджера — вход по логину и паролю',
      reply_markup: { inline_keyboard: [
        [{ text: '📱 Открыть здесь', web_app: { url: `${webapp}/admin/` } }],
        [{ text: '💻 Открыть в браузере', url: `${webapp}/admin/` }]
      ] }
    });
  }
  return { ok: true };
});

// ---------- entry ----------

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin');
  let allowed = null;
  if (origin) {
    const webappOrigin = (() => { try { return new URL(env.WEBAPP_URL).origin; } catch { return null; } })();
    const extra = String(env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
    if (origin === webappOrigin || extra.includes(origin) || (env.DEV_MODE === '1' && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin))) {
      allowed = origin;
    }
  }
  return allowed ? {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin'
  } : { Vary: 'Origin' };
}

const AUTH_LEVEL = { user: ['waiter', 'manager', 'admin'], manager: ['manager', 'admin'], admin: ['admin'] };

async function handle(request, env, ctx) {
  const url = new URL(request.url);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204 });

  let params = null;
  const r = routes.find(rt => {
    if (rt.method !== request.method) return false;
    const m = url.pathname.match(rt.re);
    if (!m) return false;
    params = Object.fromEntries(rt.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
    return true;
  });
  if (!r) {
    if (url.pathname === '/') return new Response('Yuzhane API is running', { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    throw new HttpError(404, 'Not found');
  }

  const db = makeDb(env.DB);
  await ensureSeed(db);
  const secret = await sessionSecret(env, db);

  const c = { request, env, ctx, url, params, query: url.searchParams, db, secret, body: {} };
  const type = request.headers.get('Content-Type') || '';
  if (request.method !== 'GET' && type.includes('application/json')) c.body = await request.json().catch(() => ({}));

  if (r.auth) {
    const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    const session = unsign(secret, token);
    const account = session?.kind === 'acc' ? await db.first('SELECT * FROM accounts WHERE id = ?', session.id) : null;
    // token_version меняется при смене пароля или роли — старые сессии перестают действовать
    if (!account || (account.token_version || 0) !== session.v) throw new HttpError(401, 'Войдите в систему');
    if (!AUTH_LEVEL[r.auth].includes(account.role)) throw new HttpError(403, 'Недостаточно прав');
    if (account.must_change_password && !['/api/auth/password', '/api/auth/me'].includes(url.pathname)) {
      throw new HttpError(403, 'Сначала смените пароль');
    }
    c.account = account;
    ctx.waitUntil(db.run("UPDATE accounts SET last_seen = datetime('now') WHERE id = ? AND (last_seen IS NULL OR last_seen < datetime('now', '-5 minutes'))", account.id));
  }

  const result = await r.handler(c);
  return result instanceof Response ? result : json(result);
}

export default {
  async fetch(request, env, ctx) {
    let res;
    try {
      res = await handle(request, env, ctx);
    } catch (err) {
      const status = err.status || 500;
      if (status === 500) console.error(err.stack || err);
      res = json({ error: status === 500 ? 'Внутренняя ошибка сервера' : err.message }, status);
    }
    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries(corsHeaders(request, env))) headers.set(k, v);
    return new Response(res.body, { status: res.status, headers });
  }
};
