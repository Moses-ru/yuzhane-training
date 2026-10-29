// Адрес API (Cloudflare Worker). Замените на свой после `npm run deploy`.
window.APP_CONFIG = {
  API_URL: ['localhost', '127.0.0.1'].includes(location.hostname)
    ? 'http://localhost:8787'
    : 'https://yuzhane-api.iiko-miniapp-proxy.workers.dev'
};
