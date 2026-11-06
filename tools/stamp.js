// Проставляет версию в ссылки на css/js во всех страницах (app.js?v=…).
// Так кэш браузера никогда не смешает новую страницу со старым скриптом.
// Запускать перед каждой выкладкой сайта:  node tools/stamp.js
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', 'docs');
const version = new Date().toISOString().replace(/\D/g, '').slice(0, 12);
const pages = ['index.html', 'admin/index.html', 'check.html'].filter(p => fs.existsSync(path.join(root, p)));

for (const page of pages) {
  const file = path.join(root, page);
  const html = fs.readFileSync(file, 'utf8')
    .replace(/((?:href|src)="(?!https?:)[^"?]+\.(?:css|js))(?:\?v=[^"]*)?"/g, `$1?v=${version}"`);
  fs.writeFileSync(file, html);
}

// Версия кэша service worker тоже меняется — старый кэш удалится у всех
const sw = path.join(root, 'sw.js');
fs.writeFileSync(sw, fs.readFileSync(sw, 'utf8').replace(/const CACHE = '[^']*'/, `const CACHE = 'yuzhane-${version}'`));
console.log(`версия ${version}: ${pages.join(', ')}, sw.js`);
