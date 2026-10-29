import crypto from 'node:crypto';

const INIT_DATA_MAX_AGE = 7 * 24 * 3600;

function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
export function verifyWebAppInitData(botToken, initData) {
  if (!botToken || !initData) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  params.delete('hash');
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
  if (!safeEqualHex(expected, hash)) return null;
  const authDate = Number(params.get('auth_date'));
  if (!authDate || Date.now() / 1000 - authDate > INIT_DATA_MAX_AGE) return null;
  try {
    return JSON.parse(params.get('user'));
  } catch {
    return null;
  }
}

// https://core.telegram.org/widgets/login#checking-authorization
export function verifyLoginWidget(botToken, data) {
  if (!botToken || !data || !data.hash) return null;
  const { hash, ...fields } = data;
  const dataCheckString = Object.keys(fields)
    .filter(k => fields[k] !== undefined && fields[k] !== null)
    .sort()
    .map(k => `${k}=${fields[k]}`)
    .join('\n');
  const secret = crypto.createHash('sha256').update(botToken).digest();
  const expected = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
  if (!safeEqualHex(expected, String(hash))) return null;
  if (Date.now() / 1000 - Number(fields.auth_date) > 24 * 3600) return null;
  return { ...fields, id: Number(fields.id) };
}

export async function botApi(botToken, method, payload = {}) {
  if (!botToken) return null;
  const res = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`${method}: ${json.description}`);
  return json.result;
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}
