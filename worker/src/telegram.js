// Бот используется только чтобы открывать приложение и присылать уведомления;
// вход — по логину и паролю.

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
