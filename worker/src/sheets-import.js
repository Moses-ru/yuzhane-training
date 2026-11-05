// Импорт контента в формате старого проекта: листы Texts, Questions, Menu, Wine, Allergens.
// Источник — Google-таблица (по ссылке) или те же листы, уже разобранные в JSON (из Excel-файла).

function parseCSV(text) {
  const rows = [];
  let row = [], cell = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else inQuotes = false;
      } else cell += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { row.push(cell.trim()); cell = ''; }
    else if (ch === '\n') {
      row.push(cell.trim());
      if (row.some(c => c !== '')) rows.push(row);
      row = []; cell = '';
    } else if (ch !== '\r') cell += ch;
  }
  row.push(cell.trim());
  if (row.some(c => c !== '')) rows.push(row);
  if (rows.length < 2) return [];
  const headers = rows[0].map(h => h.toLowerCase().replace(/[^a-z0-9]/g, '_'));
  return rows.slice(1).map(r => Object.fromEntries(headers.map((h, i) => [h, r[i] || ''])));
}

async function fetchSheet(sheetId, name) {
  const url = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(sheetId)}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(name)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Лист ${name}: HTTP ${res.status}`);
  return parseCSV(await res.text());
}

const DEFAULT_BLOCKS = {
  1: { title: 'Легенды Южан', icon: '🏠', description: 'История и философия' },
  2: { title: 'Сервис', icon: '🤝', description: 'Стандарты обслуживания' },
  3: { title: 'Кухня', icon: '🍳', description: 'Меню и блюда' },
  4: { title: 'Бар и вино', icon: '🍷', description: 'Винная карта' }
};

function parseCorrect(raw) {
  const s = String(raw || '').trim().toUpperCase();
  if (/^[A-J]$/.test(s)) return s.charCodeAt(0) - 65;
  const n = parseInt(s, 10);
  return Number.isNaN(n) ? 0 : n;
}

const str = v => String(v ?? '').trim();
const num = v => Number(str(v)) || 0;

export async function importFromSheets(DB, sheetId, opts) {
  const [texts, questions, menu, wine, allergens] = await Promise.all(
    ['Texts', 'Questions', 'Menu', 'Wine', 'Allergens'].map(n => fetchSheet(sheetId, n).catch(() => []))
  );
  return importContent(DB, { texts, questions, menu, wine, allergens }, opts);
}

export async function importContent(DB, data, { replace }) {
  const texts = Array.isArray(data.texts) ? data.texts : [];
  const questions = Array.isArray(data.questions) ? data.questions : [];
  if (!texts.length && !questions.length) {
    throw new Error('Не найдены уроки и вопросы (листы Texts/Questions). Таблица должна быть открыта по ссылке.');
  }
  const stats = { blocks: 0, lessons: 0, questions: 0, refs: 0 };

  if (replace) {
    await DB.batch(['lessons', 'questions', 'blocks', 'ref_items', 'ref_categories'].map(t => DB.prepare(`DELETE FROM ${t}`)));
  }

  const chapterOf = r => parseInt(str(r.chapter), 10) || 1;
  const chapters = [...new Set([...texts, ...questions].map(chapterOf))].sort((a, b) => a - b);
  let sort = (await DB.prepare('SELECT COALESCE(MAX(sort), -1) + 1 AS s FROM blocks').first()).s;
  const blockIds = {};
  for (const ch of chapters) {
    const meta = DEFAULT_BLOCKS[ch] || { title: `Блок ${ch}`, icon: '📘', description: '' };
    const r = await DB.prepare('INSERT INTO blocks (title, icon, description, sort) VALUES (?, ?, ?, ?)')
      .bind(meta.title, meta.icon, meta.description, sort++).run();
    blockIds[ch] = r.meta.last_row_id;
    stats.blocks++;
  }

  // Порядок внутри блока — по колонкам index / q_index, если они есть
  const byIndex = key => (a, b) => chapterOf(a) - chapterOf(b) || num(a[key]) - num(b[key]);
  const stmts = [];
  const counters = {};
  const next = key => (counters[key] = (counters[key] ?? -1) + 1);

  for (const r of [...texts].sort(byIndex('index'))) {
    const ch = chapterOf(r);
    if (!str(r.text)) continue;
    stmts.push(DB.prepare('INSERT INTO lessons (block_id, sort, title, text, image) VALUES (?, ?, ?, ?, ?)')
      .bind(blockIds[ch], next(`l${ch}`), '', str(r.text), /^https?:/.test(str(r.image)) ? str(r.image) : ''));
    stats.lessons++;
  }
  for (const r of [...questions].sort(byIndex('q_index'))) {
    const ch = chapterOf(r);
    const options = [];
    for (let i = 1; i <= 10; i++) {
      const opt = str(r[`option_${i}`] ?? r[`option${i}`]);
      if (opt) options.push(opt);
    }
    if (!str(r.question) || options.length < 2) continue;
    stmts.push(DB.prepare('INSERT INTO questions (block_id, sort, text, options, correct, explanation) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(blockIds[ch], next(`q${ch}`), str(r.question), JSON.stringify(options),
        Math.min(parseCorrect(r.correct), options.length - 1), str(r.explanation)));
    stats.questions++;
  }
  // D1 ограничивает размер одного batch — отправляем частями
  for (let i = 0; i < stmts.length; i += 50) await DB.batch(stmts.slice(i, i + 50));

  let refSort = (await DB.prepare('SELECT COALESCE(MAX(sort), -1) + 1 AS s FROM ref_categories').first()).s;
  for (const [title, icon, rows] of [['Меню', '🍽️', data.menu], ['Вино', '🍷', data.wine], ['Аллергены', '⚠️', data.allergens]]) {
    const items = (Array.isArray(rows) ? rows : []).filter(r => str(r.key) && str(r.value));
    if (!items.length) continue;
    const c = await DB.prepare('INSERT INTO ref_categories (title, icon, sort) VALUES (?, ?, ?)').bind(title, icon, refSort++).run();
    const itemStmts = items.map((r, j) =>
      DB.prepare('INSERT INTO ref_items (category_id, title, body, sort) VALUES (?, ?, ?, ?)')
        .bind(c.meta.last_row_id, capitalize(str(r.key)), str(r.value), j));
    for (let i = 0; i < itemStmts.length; i += 50) await DB.batch(itemStmts.slice(i, i + 50));
    stats.refs += items.length;
  }
  return stats;
}

// В старой таблице ключи справочников написаны строчными («хинкали») — для поиска; в карточке показываем с заглавной
function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
