# Южане · Обучение

Telegram WebApp для обучения сотрудников + кабинет менеджера.

- **Сотрудник** открывает приложение из бота, читает уроки, сдаёт тесты, получает сертификат. Кто он — определяется автоматически по Telegram (подписанные данные `initData`).
- **Менеджер** заходит с ПК через «Войти через Telegram» (или из бота командой `/admin`): редактирует блоки, уроки, вопросы, картинки и справочники, видит каждого сотрудника и его ответы, выгружает результаты в Excel, получает уведомления о сданных тестах.

## Как устроено

```
docs/            → GitHub Pages (статический фронтенд)
  index.html       приложение сотрудника
  admin/           кабинет менеджера
  config.js        адрес API  ← поменять после деплоя
worker/          → Cloudflare Worker (API)
  src/index.js     API, проверка подписи Telegram, вебхук бота
  schema.sql       схема базы D1
wrangler.toml    настройки Worker
```

GitHub Pages умеет отдавать только статические файлы — базу данных и секретный токен бота там держать нельзя. Поэтому API живёт на **Cloudflare Workers** (бесплатный тариф: 100 000 запросов в день, не засыпает), данные — в **D1** (SQLite), картинки — в **KV**.

## Развёртывание

Понадобятся: аккаунт GitHub, аккаунт Cloudflare (бесплатный), Node.js 18+.

### 1. Бот

1. В [@BotFather](https://t.me/BotFather) создайте бота (`/newbot`) и сохраните токен.
2. Узнайте свой Telegram ID — например, у [@userinfobot](https://t.me/userinfobot).

### 2. API на Cloudflare

```bash
npm install
npx wrangler login
npx wrangler d1 create yuzhane
npx wrangler kv namespace create IMAGES
```

Скопируйте `database_id` и `id` из вывода команд в `wrangler.toml`. Там же укажите:

- `WEBAPP_URL` — адрес GitHub Pages, например `https://ivanov.github.io/yuzhane`
- `ADMIN_IDS` — ваш Telegram ID (через запятую, если владельцев несколько)

Задайте токен бота (значение вводится после команды):

```bash
npx wrangler secret put BOT_TOKEN
```

Создайте таблицы и опубликуйте Worker:

```bash
npm run db:init
npm run deploy
```

В конце появится адрес вида `https://yuzhane-api.<ваш-поддомен>.workers.dev`.

### 3. Фронтенд на GitHub Pages

1. Впишите адрес Worker в `docs/config.js`.
2. Загрузите проект в репозиторий GitHub.
3. В репозитории: **Settings → Pages → Build and deployment → Deploy from a branch**, ветка `main`, папка `/docs`.

### 4. Последние шаги

1. В @BotFather: `/setdomain` → выберите бота → укажите `ivanov.github.io` (ваш домен Pages без пути). Без этого не появится кнопка «Войти через Telegram».
2. Откройте `https://ivanov.github.io/yuzhane/admin/`, войдите через Telegram.
3. **Настройки → «Настроить бота»** — подключит вебхук, кнопку «Обучение» в меню и команды `/start`, `/admin`, `/id`.
4. По желанию: **Настройки → Импорт из Google Таблицы** — перенесёт контент из старой таблицы.

Добавить других менеджеров: **Настройки → Менеджеры**, по Telegram ID (человек узнаёт его командой `/id` в боте).

## Локальная разработка

```bash
npm install
npx wrangler d1 execute yuzhane --local --file=worker/schema.sql
npx wrangler dev          # API на http://localhost:8787
npm run web               # фронтенд на http://localhost:5500
```

Файл `.dev.vars` с `DEV_MODE=1` включает вход без Telegram (тестовый сотрудник и кнопка «Войти (режим разработки)» в кабинете). Он не попадает в git и не используется при деплое.

> На Windows при очень длинном пути к проекту локальная база может не открыться (`SQLITE_CANTOPEN`). Добавьте к командам `--persist-to C:\yz-db`.

## Безопасность

- Личность сотрудника проверяется на сервере по подписи `initData` с токеном бота — подделать чужой ID нельзя.
- Правильные ответы не отправляются в приложение заранее: сервер проверяет каждый ответ, засчитывает только первый и сам считает итог.
- Кабинет доступен только Telegram ID из `ADMIN_IDS` и из списка менеджеров.
- История попыток хранит тексты вопросов и ответов на момент прохождения, поэтому правка или удаление вопросов её не ломает.
