// Кэш приложения: со второго открытия страница показывается сразу,
// даже если github.io отвечает медленно.
const CACHE = 'yuzhane-v1';
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

// Иконки и шрифты не меняются — берём из кэша
async function cacheFirst(req) {
  return (await caches.match(req)) || putInCache(req, await fetch(req));
}

// Код приложения: свежая версия, если сеть успевает; иначе — из кэша
async function networkFirst(req) {
  const network = fetch(req).then(res => putInCache(req, res));
  const cached = await caches.match(req, { ignoreSearch: req.mode === 'navigate' });
  if (!cached) return network;
  const timeout = new Promise(resolve => setTimeout(() => resolve(cached), NETWORK_TIMEOUT));
  return Promise.race([network.catch(() => cached), timeout]);
}

self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);
  // API и сторонние сайты (Telegram, Cloudflare) не трогаем
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith(url.pathname.includes('/vendor/') ? cacheFirst(req) : networkFirst(req));
});
