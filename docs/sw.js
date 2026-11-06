// Кэш приложения: со второго открытия страница показывается сразу,
// даже если github.io отвечает медленно.
const CACHE = 'yuzhane-v2';
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

// Свежая версия, если сеть успевает ответить; иначе — из кэша
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
  // API на Cloudflare не кэшируем — только файлы самого сайта
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith(networkFirst(req));
});
