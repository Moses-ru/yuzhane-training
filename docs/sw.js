// Кэш приложения: со второго открытия страница показывается сразу,
// даже если github.io отвечает медленно.
// Скрипты и стили подключаются с ?v=версия (tools/stamp.js), поэтому страница из кэша
// всегда получает свои же файлы — старая и новая версии не смешиваются.
const CACHE = 'yuzhane-202611061323';
const NETWORK_TIMEOUT = 2500;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

async function putInCache(req, res) {
  if (res && res.ok) (await caches.open(CACHE)).put(req, res.clone());
  return res;
}

// Файлы с версией в адресе не меняются — сначала кэш
async function cacheFirst(req) {
  return (await caches.match(req)) || putInCache(req, await fetch(req));
}

// Страницы: свежая версия, если сеть успевает ответить; иначе — из кэша
async function networkFirst(req) {
  const network = fetch(req).then(res => putInCache(req, res));
  const cached = await caches.match(req, { ignoreSearch: true });
  if (!cached) return network;
  const timeout = new Promise(resolve => setTimeout(() => resolve(cached), NETWORK_TIMEOUT));
  return Promise.race([network.catch(() => cached), timeout]);
}

self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);
  // API на Cloudflare не кэшируем — только файлы самого сайта
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.endsWith('/check.html')) return;   // страница проверки связи — всегда из сети
  e.respondWith(url.searchParams.has('v') ? cacheFirst(req) : networkFirst(req));
});
