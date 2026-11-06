// Собирает docs/vendor/icons.css — только используемые иконки Font Awesome (SVG в CSS-масках)
// вместо полного набора (260 КБ стилей и шрифта). Разметка не меняется: <i class="fas fa-house"></i>.
// Запуск после добавления новых иконок:  node tools/build-icons.js
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const fa = path.join(root, 'node_modules', '@fortawesome', 'fontawesome-free');
if (!fs.existsSync(fa)) {
  console.error('Сначала: npm install --no-save @fortawesome/fontawesome-free@6.5.1');
  process.exit(1);
}
const meta = require(path.join(fa, 'metadata', 'icon-families.json'));
const alias = {};
for (const [name, m] of Object.entries(meta)) for (const a of m.aliases?.names || []) alias[a] = name;

const sources = ['docs/index.html', 'docs/app.js', 'docs/admin/index.html', 'docs/admin/admin.js']
  .map(f => fs.readFileSync(path.join(root, f), 'utf8')).join('\n');

const UTILITY = new Set(['spin', 'solid', 'regular', 'brands', 'fw']);
// Имена, которые подставляются в код динамически: fa-${...}, empty('...'), '-slash'
const DYNAMIC = ['circle-check', 'circle-exclamation', 'eye-slash', 'sun', 'moon', 'book-open', 'circle-question', 'face-smile',
  'file-lines', 'hourglass', 'layer-group', 'list', 'magnifying-glass', 'triangle-exclamation', 'user-slash'];

const used = { solid: new Set(DYNAMIC), regular: new Set(), brands: new Set() };
for (const m of sources.matchAll(/\b(fa[srb])\s+fa-([a-z0-9-]+)/g)) {
  used[{ fas: 'solid', far: 'regular', fab: 'brands' }[m[1]]].add(m[2]);
}
for (const m of sources.matchAll(/fa-([a-z0-9]+(?:-[a-z0-9]+)*)/g)) if (!UTILITY.has(m[1])) used.solid.add(m[1]);

function svgData(style, name) {
  const real = alias[name] || name;
  const file = path.join(fa, 'svgs', style, `${real}.svg`);
  if (!fs.existsSync(file)) return null;
  const svg = fs.readFileSync(file, 'utf8').replace(/<!--.*?-->/gs, '').replace(/\s+/g, ' ').trim();
  return `url("data:image/svg+xml,${encodeURIComponent(svg).replace(/%20/g, ' ').replace(/%3D/g, '=').replace(/%3A/g, ':').replace(/%2F/g, '/')}")`;
}

const rules = [];
const missing = [];
for (const [style, names] of Object.entries(used)) {
  const prefix = { solid: '', regular: '.far', brands: '.fab' }[style];
  for (const name of [...names].sort()) {
    const data = svgData(style, name);
    if (data) rules.push(`${prefix}.fa-${name}{--fa:${data}}`);
    else if (style !== 'solid' || !sources.includes(`fa-${name}`) || !name.includes('$')) missing.push(`${style}/${name}`);
  }
}

const css = `/* Сгенерировано tools/build-icons.js из Font Awesome Free 6.5.1 (лицензия — vendor/fontawesome-LICENSE.txt) */
.fas,.far,.fab{display:inline-block;width:1em;height:1em;vertical-align:-.125em;flex-shrink:0;background-color:currentColor;-webkit-mask:var(--fa) center/contain no-repeat;mask:var(--fa) center/contain no-repeat}
.fa-spin{animation:fa-spin 1s linear infinite}@keyframes fa-spin{to{transform:rotate(360deg)}}
${rules.join('\n')}
`;
fs.writeFileSync(path.join(root, 'docs', 'vendor', 'icons.css'), css);
console.log(`icons.css: ${rules.length} иконок, ${Buffer.byteLength(css)} байт`);
const unknown = missing.filter(m => !/^solid\/(fa|[a-z]+-\$)/.test(m));
if (unknown.length) console.log('не найдены (проверьте имя):', unknown.join(', '));
