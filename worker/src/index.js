import crypto from 'node:crypto';
import { verifyWebAppInitData, verifyLoginWidget, botApi, escapeHtml } from './telegram.js';
import { importFromSheets } from './sheets-import.js';

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

function userName(u) {
  return [u.first_name, u.last_name].filter(Boolean).join(' ') || (u.username ? '@' + u.username : `ID ${u.tg_id}`);
}

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
    async update(table, id, data, idCol = 'id') {
      const keys = Object.keys(data);
      if (!keys.length) return;
      await DB.prepare(`UPDATE ${table} SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE ${idCol} = ?`)
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
    row = { value: crypto.randomBytes(32).toString('hex') };
    await db.run("INSERT OR IGNORE INTO settings (key, value) VALUES ('_session_secret', ?)", row.value);
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

const envAdminIds = env => String(env.ADMIN_IDS || '').split(/[,\s]+/).filter(Boolean).map(Number);

async function adminIds(env, db) {
  const fromDb = (await db.all('SELECT tg_id FROM admins')).map(r => Number(r.tg_id));
  return [...new Set([...envAdminIds(env), ...fromDb])];
}

// ---------- seed ----------

let seedChecked = false;
async function seedIfEmpty(db) {
  if (seedChecked) return;
  seedChecked = true;
  if ((await db.first('SELECT COUNT(*) AS n FROM blocks')).n > 0) return;
  if ((await db.first("SELECT value FROM settings WHERE key = '_seeded'"))) return;
  const seed = [
    ['Легенды Южан', '🏠', 'История и философия', 'Семья Южан', '18+ — это эталон хинкали с 18 складками.', 'Почему 18+?', ['Цензура', 'Эталон хинкали', 'Просто число'], 1, 'У эталонного хинкали 18 складок.'],
    ['Сервис', '🤝', 'Стандарты обслуживания', 'Сервис', 'Гость всегда прав.', 'Гость всегда прав?', ['Да', 'Нет'], 0, 'Да!'],
    ['Кухня', '🍳', 'Меню и блюда', 'Кухня', 'Хинкали едят руками.', 'Чем едят хинкали?', ['Вилкой', 'Руками'], 1, 'Руками!'],
    ['Бар и вино', '🍷', 'Винная карта', 'Бар и вино', 'Вино подбирается под блюдо.', 'Как подбирают вино?', ['Под блюдо', 'Случайно'], 0, 'Под блюдо!']
  ];
  for (const [i, [title, icon, desc, lt, ltext, qt, opts, correct, expl]] of seed.entries()) {
    const id = await db.insert('blocks', { title, icon, description: desc, sort: i });
    await db.batch([
      db.stmt('INSERT INTO lessons (block_id, sort, title, text) VALUES (?, 0, ?, ?)', id, lt, ltext),
      db.stmt('INSERT INTO questions (block_id, sort, text, options, correct, explanation) VALUES (?, 0, ?, ?, ?, ?)', id, qt, JSON.stringify(opts), correct, expl)
    ]);
  }
  const refs = [['Меню', '🍽️', [['Хинкали', '🥟 18 складок'], ['Хачапури', '🧀 Сыр']]],
    ['Вино', '🍷', [['Стейк', '🍷 Красное'], ['Рыба', '🥂 Белое']]],
    ['Аллергены', '⚠️', [['Орехи', '⚠️ Орехи'], ['Глютен', '⚠️ Глютен']]]];
  for (const [i, [title, icon, items]] of refs.entries()) {
    const id = await db.insert('ref_categories', { title, icon, sort: i });
    await db.batch(items.map(([t, b], j) => db.stmt('INSERT INTO ref_items (category_id, title, body, sort) VALUES (?, ?, ?, ?)', id, t, b, j)));
  }
  await db.run("INSERT OR IGNORE INTO settings (key, value) VALUES ('_seeded', '1')");
}

// ---------- domain ----------

const publishedBlocks = db => db.all('SELECT * FROM blocks WHERE published = 1 ORDER BY sort, id');

// Статусы блоков для сотрудника: passed / available / locked
async function blockStatuses(db, userId) {
  const settings = await getSettings(db);
  const sequential = settings.sequential === '1';
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

async function upsertUser(db, u) {
  await db.run(`
    INSERT INTO users (tg_id, first_name, last_name, username, photo_url) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(tg_id) DO UPDATE SET
      first_name = excluded.first_name, last_name = excluded.last_name, username = excluded.username,
      photo_url = CASE WHEN excluded.photo_url != '' THEN excluded.photo_url ELSE users.photo_url END,
      last_seen = datetime('now')`,
    u.id, u.first_name || '', u.last_name || '', u.username || '', u.photo_url || '');
  return db.first('SELECT * FROM users WHERE tg_id = ?', u.id);
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

const routes = [];
const route = (method, path, auth, handler) => {
  const keys = [];
  const re = new RegExp('^' + path.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
  routes.push({ method, re, keys, auth, handler });
};

// --- сотрудник (Telegram WebApp) ---

route('GET', '/api/app', 'user', async ({ db, user, isAdmin }) => {
  const settings = await getSettings(db);
  const statuses = await blockStatuses(db, user.tg_id);
  const counts = Object.fromEntries((await db.all(`
    SELECT b.id, (SELECT COUNT(*) FROM lessons WHERE block_id = b.id) AS lessons,
                 (SELECT COUNT(*) FROM questions WHERE block_id = b.id) AS questions FROM blocks b`)).map(r => [r.id, r]));
  const cats = await db.all('SELECT * FROM ref_categories ORDER BY sort, id');
  const items = await db.all('SELECT id, category_id, title, body, image FROM ref_items ORDER BY sort, id');
  const history = await db.all(`
    SELECT id, block_id, block_title, correct, total, percent, passed, finished_at
    FROM attempts WHERE user_id = ? AND finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 30`, user.tg_id);
  const allPassed = statuses.length && statuses.every(s => s.status === 'passed');
  return {
    settings: pick(settings, ['app_title', 'welcome_text', 'certificate_title', 'certificate_text', 'certificate_signature']),
    user, isAdmin: await isAdmin(user.tg_id),
    blocks: statuses.map(({ block: b, status, best, attempts }) => ({
      ...pick(b, BLOCK_PUBLIC), lessons: counts[b.id].lessons, questions: counts[b.id].questions, status, best, attempts
    })),
    completedAt: allPassed ? (await db.first('SELECT MAX(finished_at) AS t FROM attempts WHERE user_id = ? AND passed = 1', user.tg_id)).t : null,
    references: cats.map(c => ({ ...c, items: items.filter(i => i.category_id === c.id) })),
    history
  };
});

route('GET', '/api/blocks/:id', 'user', async ({ db, user, params }) => {
  const block = await loadAvailableBlock(db, user.tg_id, params.id);
  const lessons = await db.all('SELECT id, title, text, image FROM lessons WHERE block_id = ? ORDER BY sort, id', block.id);
  const viewed = new Set((await db.all('SELECT lesson_id FROM lesson_views WHERE user_id = ?', user.tg_id)).map(r => r.lesson_id));
  return { block: pick(block, BLOCK_PUBLIC), lessons: lessons.map(l => ({ ...l, viewed: viewed.has(l.id) })) };
});

route('POST', '/api/lessons/:id/view', 'user', async ({ db, user, params }) => {
  await db.run('INSERT OR IGNORE INTO lesson_views (user_id, lesson_id) VALUES (?, ?)', user.tg_id, Number(params.id));
  return { ok: true };
});

route('POST', '/api/attempts', 'user', async ({ db, user, body }) => {
  const block = await loadAvailableBlock(db, user.tg_id, body.block_id);
  const questions = await db.all('SELECT id, text, image, options FROM questions WHERE block_id = ? ORDER BY sort, id', block.id);
  if (!questions.length) throw new HttpError(400, 'В блоке пока нет вопросов');
  await db.run('DELETE FROM attempts WHERE user_id = ? AND block_id = ? AND finished_at IS NULL', user.tg_id, block.id);
  const attemptId = await db.insert('attempts', {
    user_id: user.tg_id, block_id: block.id, block_title: block.title, pass_percent: block.pass_percent, total: questions.length
  });
  return { attempt_id: attemptId, pass_percent: block.pass_percent, questions: questions.map(parseQ) };
});

async function loadOpenAttempt(db, user, id) {
  const attempt = await db.first('SELECT * FROM attempts WHERE id = ? AND user_id = ?', Number(id), user.tg_id);
  if (!attempt) throw new HttpError(404, 'Попытка не найдена');
  if (attempt.finished_at) throw new HttpError(400, 'Тест уже завершён');
  return attempt;
}

route('POST', '/api/attempts/:id/answer', 'user', async ({ db, user, params, body }) => {
  const attempt = await loadOpenAttempt(db, user, params.id);
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

route('POST', '/api/attempts/:id/finish', 'user', async ({ db, env, ctx, user, params }) => {
  const attempt = await loadOpenAttempt(db, user, params.id);
  const correct = (await db.first('SELECT COUNT(*) AS n FROM attempt_answers WHERE attempt_id = ? AND is_correct = 1', attempt.id)).n;
  const percent = attempt.total ? Math.round((correct / attempt.total) * 100) : 0;
  const passed = percent >= attempt.pass_percent ? 1 : 0;
  await db.run("UPDATE attempts SET correct = ?, percent = ?, passed = ?, finished_at = datetime('now') WHERE id = ?", correct, percent, passed, attempt.id);
  const statuses = await blockStatuses(db, user.tg_id);
  const allPassed = statuses.length > 0 && statuses.every(s => s.status === 'passed');

  ctx.waitUntil(notifyAdmins(env, db,
    `${passed ? '✅' : '❌'} <b>${escapeHtml(userName(user))}</b>${user.username ? ' (@' + escapeHtml(user.username) + ')' : ''}\n` +
    `Блок «${escapeHtml(attempt.block_title)}»: ${correct}/${attempt.total} (${percent}%)` +
    (allPassed && passed ? '\n🏆 Всё обучение пройдено!' : '')));

  return { correct, total: attempt.total, percent, passed: !!passed, pass_percent: attempt.pass_percent, all_passed: allPassed };
});

async function notifyAdmins(env, db, text) {
  if (!env.BOT_TOKEN || (await getSettings(db)).notify_admins !== '1') return;
  await Promise.all((await adminIds(env, db)).map(id =>
    botApi(env.BOT_TOKEN, 'sendMessage', { chat_id: id, text, parse_mode: 'HTML' }).catch(() => {}))); // админ мог не запускать бота
}

// --- картинки (хранятся в KV) ---

route('GET', '/img/:key', null, async ({ env, params }) => {
  const { value, metadata } = await env.IMAGES.getWithMetadata(params.key, 'arrayBuffer');
  if (!value) return new Response('Not found', { status: 404 });
  return new Response(value, { headers: { 'Content-Type': metadata?.type || 'image/jpeg', 'Cache-Control': 'public, max-age=31536000, immutable' } });
});

// --- вход в кабинет ---

const SESSION_DAYS = 30;
const issueToken = (secret, u) => ({
  token: sign(secret, { id: u.id, name: [u.first_name, u.last_name].filter(Boolean).join(' '), photo: u.photo_url || '', exp: Date.now() + SESSION_DAYS * 86400e3 })
});

route('GET', '/api/admin/config', null, async ({ env }) => {
  let bot = null;
  if (env.BOT_TOKEN) bot = await botApi(env.BOT_TOKEN, 'getMe').catch(() => null);
  return { bot_username: bot?.username || null, dev_mode: env.DEV_MODE === '1' };
});

route('POST', '/api/admin/auth/telegram', null, async ({ env, body, secret, isAdmin }) => {
  const u = verifyLoginWidget(env.BOT_TOKEN, pick(body, ['id', 'first_name', 'last_name', 'username', 'photo_url', 'auth_date', 'hash']));
  if (!u) throw new HttpError(401, 'Не удалось проверить вход через Telegram');
  if (!(await isAdmin(u.id))) throw new HttpError(403, `Нет доступа. Ваш Telegram ID: ${u.id} — передайте его владельцу.`);
  return issueToken(secret, u);
});

route('POST', '/api/admin/auth/webapp', null, async ({ env, body, secret, isAdmin }) => {
  const u = verifyWebAppInitData(env.BOT_TOKEN, body.initData);
  if (!u) throw new HttpError(401, 'Не удалось проверить данные Telegram');
  if (!(await isAdmin(u.id))) throw new HttpError(403, `Нет доступа. Ваш Telegram ID: ${u.id}`);
  return issueToken(secret, u);
});

route('POST', '/api/admin/auth/dev', null, async ({ env, secret }) => {
  if (env.DEV_MODE !== '1') throw new HttpError(404, 'Not found');
  return issueToken(secret, { id: 1, first_name: 'Dev', last_name: 'Manager' });
});

route('GET', '/api/admin/me', 'admin', ({ admin }) => admin);

// Вход сотрудника с компьютера (вне Telegram) через Telegram Login Widget
const USER_SESSION_DAYS = 90;
route('POST', '/api/auth/telegram', null, async ({ env, db, body, secret }) => {
  const u = verifyLoginWidget(env.BOT_TOKEN, pick(body, ['id', 'first_name', 'last_name', 'username', 'photo_url', 'auth_date', 'hash']));
  if (!u) throw new HttpError(401, 'Не удалось проверить вход через Telegram');
  await upsertUser(db, u);
  return {
    token: sign(secret, {
      kind: 'user',
      u: pick(u, ['id', 'first_name', 'last_name', 'username', 'photo_url']),
      exp: Date.now() + USER_SESSION_DAYS * 86400e3
    })
  };
});

// --- кабинет: статистика и результаты ---

route('GET', '/api/admin/stats', 'admin', async ({ db }) => {
  const blocks = await publishedBlocks(db);
  const users = await db.all('SELECT tg_id FROM users');
  const passedByUser = {};
  for (const r of await db.all('SELECT DISTINCT user_id, block_id FROM attempts WHERE passed = 1')) (passedByUser[r.user_id] ||= new Set()).add(r.block_id);
  const completed = users.filter(u => blocks.length && blocks.every(b => passedByUser[u.tg_id]?.has(b.id))).length;
  const fin = await db.first('SELECT AVG(percent) AS avg, AVG(passed) AS rate FROM attempts WHERE finished_at IS NOT NULL');
  const week = (await db.first("SELECT COUNT(*) AS n FROM attempts WHERE finished_at >= datetime('now', '-7 days')")).n;

  const act = await db.all(`SELECT date(finished_at) AS d, COUNT(*) AS attempts, SUM(passed) AS passed
    FROM attempts WHERE finished_at >= date('now', '-29 days') GROUP BY d`);
  const nu = await db.all(`SELECT date(first_seen) AS d, COUNT(*) AS n FROM users WHERE first_seen >= date('now', '-29 days') GROUP BY d`);
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
      SELECT a.*, u.first_name, u.last_name, u.username, u.photo_url
      FROM attempts a JOIN users u ON u.tg_id = a.user_id
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

route('GET', '/api/admin/users', 'admin', async ({ db }) => {
  const blocks = await publishedBlocks(db);
  const best = await bestByUser(db);
  const users = (await db.all('SELECT * FROM users ORDER BY last_seen DESC')).map(u => {
    const r = best[u.tg_id] || {};
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

route('GET', '/api/admin/users/:id', 'admin', async ({ db, env, params, isAdmin }) => {
  const user = await db.first('SELECT * FROM users WHERE tg_id = ?', Number(params.id));
  if (!user) throw new HttpError(404, 'Сотрудник не найден');
  const statuses = await blockStatuses(db, user.tg_id);
  const lessonCounts = Object.fromEntries((await db.all('SELECT block_id, COUNT(*) AS n FROM lessons GROUP BY block_id')).map(r => [r.block_id, r.n]));
  const viewed = Object.fromEntries((await db.all(`
    SELECT l.block_id, COUNT(*) AS n FROM lesson_views v JOIN lessons l ON l.id = v.lesson_id
    WHERE v.user_id = ? GROUP BY l.block_id`, user.tg_id)).map(r => [r.block_id, r.n]));
  return {
    user, is_admin: await isAdmin(user.tg_id), is_owner: envAdminIds(env).includes(user.tg_id),
    blocks: statuses.map(s => ({
      id: s.block.id, title: s.block.title, icon: s.block.icon, status: s.status, best: s.best, attempts: s.attempts,
      lessons_total: lessonCounts[s.block.id] || 0, lessons_viewed: viewed[s.block.id] || 0
    })),
    attempts: await db.all('SELECT * FROM attempts WHERE user_id = ? AND finished_at IS NOT NULL ORDER BY finished_at DESC', user.tg_id)
  };
});

route('PATCH', '/api/admin/users/:id', 'admin', async ({ db, params, body }) => {
  await db.update('users', Number(params.id), pick(body, ['position', 'note']), 'tg_id');
  return { ok: true };
});

route('DELETE', '/api/admin/users/:id/progress', 'admin', async ({ db, params }) => {
  const id = Number(params.id);
  await db.batch([
    db.stmt('DELETE FROM attempt_answers WHERE attempt_id IN (SELECT id FROM attempts WHERE user_id = ?)', id),
    db.stmt('DELETE FROM attempts WHERE user_id = ?', id),
    db.stmt('DELETE FROM lesson_views WHERE user_id = ?', id)
  ]);
  return { ok: true };
});

route('DELETE', '/api/admin/users/:id', 'admin', async ({ db, params }) => {
  const id = Number(params.id);
  await db.batch([
    db.stmt('DELETE FROM attempt_answers WHERE attempt_id IN (SELECT id FROM attempts WHERE user_id = ?)', id),
    db.stmt('DELETE FROM attempts WHERE user_id = ?', id),
    db.stmt('DELETE FROM lesson_views WHERE user_id = ?', id),
    db.stmt('DELETE FROM users WHERE tg_id = ?', id)
  ]);
  return { ok: true };
});

route('GET', '/api/admin/attempts', 'admin', async ({ db, query }) => {
  const where = ['a.finished_at IS NOT NULL'];
  const args = [];
  if (query.get('block_id')) { where.push('a.block_id = ?'); args.push(Number(query.get('block_id'))); }
  if (['0', '1'].includes(query.get('passed'))) { where.push('a.passed = ?'); args.push(Number(query.get('passed'))); }
  if (query.get('q')) {
    where.push("(u.first_name || ' ' || u.last_name || ' ' || u.username || ' ' || u.tg_id) LIKE ?");
    args.push(`%${query.get('q')}%`);
  }
  const limit = Math.min(Number(query.get('limit')) || 200, 500);
  return db.all(`
    SELECT a.*, u.first_name, u.last_name, u.username, u.photo_url, u.position
    FROM attempts a JOIN users u ON u.tg_id = a.user_id
    WHERE ${where.join(' AND ')} ORDER BY a.finished_at DESC LIMIT ${limit}`, ...args);
});

route('GET', '/api/admin/attempts/:id', 'admin', async ({ db, params }) => {
  const attempt = await db.first(`
    SELECT a.*, u.first_name, u.last_name, u.username, u.photo_url
    FROM attempts a JOIN users u ON u.tg_id = a.user_id WHERE a.id = ?`, Number(params.id));
  if (!attempt) throw new HttpError(404, 'Попытка не найдена');
  return { attempt, answers: await db.all('SELECT * FROM attempt_answers WHERE attempt_id = ? ORDER BY answered_at', attempt.id) };
});

route('GET', '/api/admin/export/results.csv', 'admin', async ({ db }) => {
  const blocks = await publishedBlocks(db);
  const best = await bestByUser(db);
  const cell = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [['Telegram ID', 'Имя', 'Username', 'Должность', ...blocks.map(b => b.title), 'Пройдено блоков', 'Последняя активность'].map(cell).join(';')];
  for (const u of await db.all('SELECT * FROM users ORDER BY first_name')) {
    const r = best[u.tg_id] || {};
    lines.push([
      u.tg_id, userName(u), u.username ? '@' + u.username : '', u.position,
      ...blocks.map(b => r[b.id] ? `${r[b.id].best}%${r[b.id].passed ? ' ✓' : ''}` : '—'),
      `${blocks.filter(b => r[b.id]?.passed).length}/${blocks.length}`, u.last_seen
    ].map(cell).join(';'));
  }
  return new Response('﻿' + lines.join('\r\n'), { headers: { 'Content-Type': 'text/csv; charset=utf-8' } });
});

// --- кабинет: контент ---

route('GET', '/api/admin/blocks', 'admin', ({ db }) => db.all(`
  SELECT b.*,
    (SELECT COUNT(*) FROM lessons WHERE block_id = b.id) AS lessons_count,
    (SELECT COUNT(*) FROM questions WHERE block_id = b.id) AS questions_count,
    (SELECT COUNT(DISTINCT user_id) FROM attempts WHERE block_id = b.id AND passed = 1) AS passed_users
  FROM blocks b ORDER BY sort, id`));

route('POST', '/api/admin/blocks', 'admin', async ({ db, body }) => {
  const data = pick(body, BLOCK_FIELDS);
  if (!data.title) throw new HttpError(400, 'Укажите название блока');
  const id = await db.insert('blocks', { ...data, sort: await nextSort(db, 'blocks') });
  return db.first('SELECT * FROM blocks WHERE id = ?', id);
});

route('GET', '/api/admin/blocks/:id', 'admin', async ({ db, params }) => {
  const block = await db.first('SELECT * FROM blocks WHERE id = ?', Number(params.id));
  if (!block) throw new HttpError(404, 'Блок не найден');
  return {
    block,
    lessons: await db.all('SELECT * FROM lessons WHERE block_id = ? ORDER BY sort, id', block.id),
    questions: (await db.all('SELECT * FROM questions WHERE block_id = ? ORDER BY sort, id', block.id)).map(parseQ)
  };
});

route('PUT', '/api/admin/blocks/:id', 'admin', async ({ db, params, body }) => {
  await db.update('blocks', Number(params.id), { ...pick(body, BLOCK_FIELDS), updated_at: new Date().toISOString().replace('T', ' ').slice(0, 19) });
  return db.first('SELECT * FROM blocks WHERE id = ?', Number(params.id));
});

route('DELETE', '/api/admin/blocks/:id', 'admin', async ({ db, params }) => {
  const id = Number(params.id);
  await db.batch([
    db.stmt('DELETE FROM lessons WHERE block_id = ?', id),
    db.stmt('DELETE FROM questions WHERE block_id = ?', id),
    db.stmt('DELETE FROM blocks WHERE id = ?', id)
  ]);
  return { ok: true };
});

route('POST', '/api/admin/blocks/:id/lessons', 'admin', async ({ db, params, body }) => {
  const blockId = Number(params.id);
  const id = await db.insert('lessons', { ...pick(body, LESSON_FIELDS), block_id: blockId, sort: await nextSort(db, 'lessons', 'WHERE block_id = ?', blockId) });
  return db.first('SELECT * FROM lessons WHERE id = ?', id);
});
route('PUT', '/api/admin/lessons/:id', 'admin', async ({ db, params, body }) => {
  await db.update('lessons', Number(params.id), pick(body, LESSON_FIELDS));
  return db.first('SELECT * FROM lessons WHERE id = ?', Number(params.id));
});
route('DELETE', '/api/admin/lessons/:id', 'admin', async ({ db, params }) => {
  await db.run('DELETE FROM lessons WHERE id = ?', Number(params.id));
  return { ok: true };
});

route('POST', '/api/admin/blocks/:id/questions', 'admin', async ({ db, params, body }) => {
  const blockId = Number(params.id);
  const data = normalizeQuestion(body);
  if (!data.text) throw new HttpError(400, 'Укажите текст вопроса');
  const id = await db.insert('questions', { ...data, block_id: blockId, sort: await nextSort(db, 'questions', 'WHERE block_id = ?', blockId) });
  return parseQ(await db.first('SELECT * FROM questions WHERE id = ?', id));
});
route('PUT', '/api/admin/questions/:id', 'admin', async ({ db, params, body }) => {
  await db.update('questions', Number(params.id), normalizeQuestion(body));
  return parseQ(await db.first('SELECT * FROM questions WHERE id = ?', Number(params.id)));
});
route('DELETE', '/api/admin/questions/:id', 'admin', async ({ db, params }) => {
  await db.run('DELETE FROM questions WHERE id = ?', Number(params.id));
  return { ok: true };
});

route('GET', '/api/admin/refs', 'admin', async ({ db }) => {
  const cats = await db.all('SELECT * FROM ref_categories ORDER BY sort, id');
  const items = await db.all('SELECT * FROM ref_items ORDER BY sort, id');
  return cats.map(c => ({ ...c, items: items.filter(i => i.category_id === c.id) }));
});
route('POST', '/api/admin/ref-categories', 'admin', async ({ db, body }) => {
  const data = pick(body, CATEGORY_FIELDS);
  if (!data.title) throw new HttpError(400, 'Укажите название');
  return { id: await db.insert('ref_categories', { ...data, sort: await nextSort(db, 'ref_categories') }) };
});
route('PUT', '/api/admin/ref-categories/:id', 'admin', async ({ db, params, body }) => {
  await db.update('ref_categories', Number(params.id), pick(body, CATEGORY_FIELDS));
  return { ok: true };
});
route('DELETE', '/api/admin/ref-categories/:id', 'admin', async ({ db, params }) => {
  const id = Number(params.id);
  await db.batch([db.stmt('DELETE FROM ref_items WHERE category_id = ?', id), db.stmt('DELETE FROM ref_categories WHERE id = ?', id)]);
  return { ok: true };
});
route('POST', '/api/admin/ref-categories/:id/items', 'admin', async ({ db, params, body }) => {
  const catId = Number(params.id);
  const data = pick(body, ITEM_FIELDS);
  if (!data.title) throw new HttpError(400, 'Укажите название');
  return { id: await db.insert('ref_items', { ...data, category_id: catId, sort: await nextSort(db, 'ref_items', 'WHERE category_id = ?', catId) }) };
});
route('PUT', '/api/admin/ref-items/:id', 'admin', async ({ db, params, body }) => {
  await db.update('ref_items', Number(params.id), pick(body, ITEM_FIELDS));
  return { ok: true };
});
route('DELETE', '/api/admin/ref-items/:id', 'admin', async ({ db, params }) => {
  await db.run('DELETE FROM ref_items WHERE id = ?', Number(params.id));
  return { ok: true };
});

route('POST', '/api/admin/reorder/:kind', 'admin', async ({ db, params, body }) => {
  const table = REORDERABLE[params.kind];
  if (!table || !Array.isArray(body.ids)) throw new HttpError(400, 'Bad request');
  if (body.ids.length) await db.batch(body.ids.map((id, i) => db.stmt(`UPDATE ${table} SET sort = ? WHERE id = ?`, i, Number(id))));
  return { ok: true };
});

// --- кабинет: настройки, менеджеры, загрузка, импорт, бот ---

route('GET', '/api/admin/settings', 'admin', async ({ db }) =>
  Object.fromEntries(Object.entries(await getSettings(db)).filter(([k]) => !k.startsWith('_'))));

route('PUT', '/api/admin/settings', 'admin', async ({ db, body }) => {
  const stmts = Object.entries(body || {}).filter(([k]) => !k.startsWith('_')).map(([k, v]) =>
    db.stmt('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', k, String(v)));
  if (stmts.length) await db.batch(stmts);
  return { ok: true };
});

route('GET', '/api/admin/admins', 'admin', async ({ db, env }) => {
  const list = await db.all('SELECT a.*, u.first_name, u.last_name, u.username, u.photo_url FROM admins a LEFT JOIN users u ON u.tg_id = a.tg_id');
  const owners = [];
  for (const id of envAdminIds(env).filter(id => !list.some(a => a.tg_id === id))) {
    const u = (await db.first('SELECT * FROM users WHERE tg_id = ?', id)) || {};
    owners.push({ tg_id: id, name: 'Владелец', locked: true, first_name: u.first_name, last_name: u.last_name, username: u.username, photo_url: u.photo_url });
  }
  return [...owners, ...list];
});
route('POST', '/api/admin/admins', 'admin', async ({ db, body }) => {
  const id = Number(String(body.tg_id || '').trim());
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'Укажите числовой Telegram ID');
  await db.run('INSERT OR REPLACE INTO admins (tg_id, name) VALUES (?, ?)', id, String(body.name || ''));
  return { ok: true };
});
route('DELETE', '/api/admin/admins/:id', 'admin', async ({ db, params, admin }) => {
  const id = Number(params.id);
  if (id === Number(admin.id)) throw new HttpError(400, 'Нельзя удалить самого себя');
  await db.run('DELETE FROM admins WHERE tg_id = ?', id);
  return { ok: true };
});

route('POST', '/api/admin/upload', 'admin', async ({ env, request, url }) => {
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

route('POST', '/api/admin/import/sheets', 'admin', async ({ env, body }) => {
  const match = String(body.sheet || '').match(/[-\w]{25,}/);
  if (!match) throw new HttpError(400, 'Вставьте ссылку на таблицу или её ID');
  return importFromSheets(env.DB, match[0], { replace: !!body.replace });
});

const webhookSecret = secret => crypto.createHmac('sha256', secret).update('tg-webhook').digest('hex').slice(0, 48);

// Подключает бота: вебхук на этот Worker, кнопку меню и команды
route('POST', '/api/admin/bot/setup', 'admin', async ({ env, url, secret }) => {
  if (!env.BOT_TOKEN) throw new HttpError(400, 'BOT_TOKEN не задан в Cloudflare');
  const webapp = String(env.WEBAPP_URL || '').replace(/\/$/, '');
  await botApi(env.BOT_TOKEN, 'setWebhook', { url: `${url.origin}/bot`, secret_token: webhookSecret(secret), allowed_updates: ['message'] });
  await botApi(env.BOT_TOKEN, 'setChatMenuButton', { menu_button: { type: 'web_app', text: 'Обучение', web_app: { url: `${webapp}/` } } });
  await botApi(env.BOT_TOKEN, 'setMyCommands', { commands: [
    { command: 'start', description: 'Начать обучение' },
    { command: 'admin', description: 'Кабинет менеджера' },
    { command: 'id', description: 'Узнать свой Telegram ID' }
  ] });
  const me = await botApi(env.BOT_TOKEN, 'getMe');
  return { ok: true, bot: me.username, webapp };
});

// --- вебхук бота ---

route('POST', '/bot', null, async ({ env, db, request, body, secret, isAdmin }) => {
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
    if (!(await isAdmin(msg.from.id))) {
      await send({ text: `Ваш Telegram ID: ${msg.from.id}\nПередайте его владельцу, чтобы получить доступ к кабинету.` });
    } else {
      await send({
        text: '🗂 Кабинет менеджера',
        reply_markup: { inline_keyboard: [
          [{ text: '📱 Открыть здесь', web_app: { url: `${webapp}/admin/` } }],
          [{ text: '💻 Открыть в браузере', url: `${webapp}/admin/` }]
        ] }
      });
    }
  } else if (text.startsWith('/id')) {
    await send({ text: `Ваш Telegram ID: ${msg.from.id}` });
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
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Telegram-Init-Data, X-Dev-User',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin'
  } : { Vary: 'Origin' };
}

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
  await seedIfEmpty(db);
  const secret = await sessionSecret(env, db);
  let ids = null;
  const isAdmin = async id => (ids ||= await adminIds(env, db)).includes(Number(id));

  const c = { request, env, ctx, url, params, query: url.searchParams, db, secret, isAdmin, body: {} };
  const type = request.headers.get('Content-Type') || '';
  if (request.method !== 'GET' && type.includes('application/json')) c.body = await request.json().catch(() => ({}));

  const bearer = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (r.auth === 'user') {
    let tgUser = verifyWebAppInitData(env.BOT_TOKEN, request.headers.get('X-Telegram-Init-Data'));
    if (!tgUser && bearer) {
      const session = unsign(secret, bearer);
      if (session?.kind === 'user') tgUser = session.u;
    }
    if (!tgUser && env.DEV_MODE === '1') {
      tgUser = { id: 100001, first_name: 'Тестовый', last_name: 'Сотрудник', username: 'test_user' };
      try { const d = request.headers.get('X-Dev-User'); if (d) tgUser = JSON.parse(d); } catch {}
    }
    if (!tgUser) throw new HttpError(401, 'Войдите через Telegram');
    c.user = await upsertUser(db, tgUser);
  } else if (r.auth === 'admin') {
    const session = unsign(secret, bearer);
    // Токен сотрудника не даёт доступа к кабинету, даже если сотрудник — менеджер
    if (!session || session.kind === 'user' || !((await isAdmin(session.id)) || (env.DEV_MODE === '1' && session.id === 1))) {
      throw new HttpError(401, 'Требуется вход');
    }
    c.admin = session;
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
