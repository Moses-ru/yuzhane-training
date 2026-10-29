CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS admins (
  tg_id    INTEGER PRIMARY KEY,
  name     TEXT DEFAULT '',
  added_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS blocks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  title        TEXT NOT NULL,
  description  TEXT DEFAULT '',
  icon         TEXT DEFAULT '📘',
  cover        TEXT DEFAULT '',
  pass_percent INTEGER DEFAULT 80,
  sort         INTEGER DEFAULT 0,
  published    INTEGER DEFAULT 1,
  created_at   TEXT DEFAULT (datetime('now')),
  updated_at   TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS lessons (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  block_id INTEGER NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
  sort     INTEGER DEFAULT 0,
  title    TEXT DEFAULT '',
  text     TEXT DEFAULT '',
  image    TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS questions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  block_id    INTEGER NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
  sort        INTEGER DEFAULT 0,
  text        TEXT NOT NULL,
  image       TEXT DEFAULT '',
  options     TEXT NOT NULL DEFAULT '[]',
  correct     INTEGER DEFAULT 0,
  explanation TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS ref_categories (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  icon  TEXT DEFAULT '📄',
  sort  INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS ref_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id INTEGER NOT NULL REFERENCES ref_categories(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  body        TEXT DEFAULT '',
  image       TEXT DEFAULT '',
  sort        INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS users (
  tg_id      INTEGER PRIMARY KEY,
  first_name TEXT DEFAULT '',
  last_name  TEXT DEFAULT '',
  username   TEXT DEFAULT '',
  photo_url  TEXT DEFAULT '',
  position   TEXT DEFAULT '',
  note       TEXT DEFAULT '',
  first_seen TEXT DEFAULT (datetime('now')),
  last_seen  TEXT DEFAULT (datetime('now'))
);

-- Попытки хранят снимок названия блока и текстов вопросов,
-- чтобы история не ломалась при редактировании контента.
CREATE TABLE IF NOT EXISTS attempts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(tg_id) ON DELETE CASCADE,
  block_id     INTEGER NOT NULL,
  block_title  TEXT DEFAULT '',
  pass_percent INTEGER DEFAULT 80,
  total        INTEGER DEFAULT 0,
  correct      INTEGER DEFAULT 0,
  percent      INTEGER DEFAULT 0,
  passed       INTEGER DEFAULT 0,
  started_at   TEXT DEFAULT (datetime('now')),
  finished_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_attempts_user ON attempts(user_id);
CREATE INDEX IF NOT EXISTS idx_attempts_block ON attempts(block_id);

CREATE TABLE IF NOT EXISTS attempt_answers (
  attempt_id    INTEGER NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  question_id   INTEGER NOT NULL,
  question_text TEXT DEFAULT '',
  selected      INTEGER,
  selected_text TEXT DEFAULT '',
  correct_text  TEXT DEFAULT '',
  is_correct    INTEGER DEFAULT 0,
  answered_at   TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (attempt_id, question_id)
);

CREATE TABLE IF NOT EXISTS lesson_views (
  user_id   INTEGER NOT NULL REFERENCES users(tg_id) ON DELETE CASCADE,
  lesson_id INTEGER NOT NULL,
  viewed_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, lesson_id)
);

INSERT OR IGNORE INTO settings (key, value) VALUES
  ('app_title', 'Южане Обучение'),
  ('welcome_text', 'Пройди все блоки обучения и стань настоящим Южанином!'),
  ('sequential', '1'),
  ('certificate_title', 'СЕРТИФИКАТ'),
  ('certificate_text', 'Прошёл все блоки обучения и стал настоящим ЮЖАНИНОМ'),
  ('certificate_signature', 'Дато, основатель'),
  ('notify_admins', '1');
