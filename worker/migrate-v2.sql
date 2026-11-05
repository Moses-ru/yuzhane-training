-- Переход с Telegram-профилей на логин/пароль (v1 -> v2).
-- Старые профили и их попытки удаляются: привязать их к новым учётным записям не к чему.
-- После этого выполните schema.sql — он создаст новые таблицы.
DROP TABLE IF EXISTS attempt_answers;
DROP TABLE IF EXISTS attempts;
DROP TABLE IF EXISTS lesson_views;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS admins;
