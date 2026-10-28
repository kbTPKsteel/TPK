// TPK Warehouse — feedback relay (Cloudflare Worker).
//
// The site sends the feedback form here; the worker posts it to Slack with the
// bot token that lives only in the worker's secrets. No tokens in the browser.
//
// Required settings (Cloudflare → Worker → Settings → Variables and Secrets):
//   SLACK_BOT_TOKEN  (secret)  Bot User OAuth Token, scopes: chat:write, files:write
//   SLACK_CHANNEL    (text)    channel ID, e.g. C05092Y0B5X (the bot must be a member)
//   ALLOWED_ORIGIN   (text)    https://kbtpksteel.github.io

const MAX_FILES = 5;
const MAX_FILE_SIZE = 5 * 1024 * 1024;
const MAX_MESSAGE = 4000;
const MAX_NAME = 100;
const MAX_PRODUCT = 200;

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const cors = {
      'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Vary': 'Origin',
    };
    const reply = (status, body) =>
      new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

    if (origin !== env.ALLOWED_ORIGIN) return reply(403, { ok: false, error: 'forbidden origin' });
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST') return reply(405, { ok: false, error: 'method not allowed' });

    let form;
    try {
      form = await request.formData();
    } catch {
      return reply(400, { ok: false, error: 'bad form data' });
    }

    const message = (form.get('message') || '').toString().trim();
    const name = (form.get('name') || '').toString().trim() || 'Аноним';
    const product = (form.get('product') || '').toString().trim();
    const slackUserId = (form.get('slackUserId') || '').toString().trim();
    const files = form.getAll('files').filter(f => typeof f === 'object' && f.size > 0);

    if (!message) return reply(400, { ok: false, error: 'Заполните сообщение.' });
    if (message.length > MAX_MESSAGE || name.length > MAX_NAME || product.length > MAX_PRODUCT)
      return reply(400, { ok: false, error: 'Слишком длинный текст.' });
    if (files.length > MAX_FILES) return reply(400, { ok: false, error: `Не больше ${MAX_FILES} файлов.` });
    if (files.some(f => f.size > MAX_FILE_SIZE)) return reply(400, { ok: false, error: 'Файл больше 5 МБ.' });

    // Only a real Slack user ID can be mentioned; user text is escaped so it
    // cannot inject <!channel>, <@someone> or links.
    const mention = /^[UW][A-Z0-9]{6,20}$/.test(slackUserId) ? `<@${slackUserId}> ` : '';
    const text = `${mention}📦 *${esc(product)}*\n👤 ${esc(name)}\n\n${esc(message)}`;

    try {
      if (files.length === 0) {
        await slack(env, 'chat.postMessage', { channel: env.SLACK_CHANNEL, text });
      } else {
        const uploaded = [];
        for (const f of files) uploaded.push(await uploadFile(env, f));
        await slack(env, 'files.completeUploadExternal', {
          files: uploaded, channel_id: env.SLACK_CHANNEL, initial_comment: text,
        });
      }
      return reply(200, { ok: true });
    } catch (err) {
      console.error(err);
      return reply(502, { ok: false, error: 'Slack недоступен, попробуйте позже.' });
    }
  },
};

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function slack(env, method, body) {
  const resp = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  });
  const json = await resp.json();
  if (!json.ok) throw new Error(`${method}: ${json.error}`);
  return json;
}

// Slack's current upload flow: get an upload URL, send the bytes, then complete.
async function uploadFile(env, file) {
  const filename = file.name || 'file';
  const params = new URLSearchParams({ filename, length: String(file.size) });
  const resp = await fetch(`https://slack.com/api/files.getUploadURLExternal?${params}`, {
    headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },
  });
  const json = await resp.json();
  if (!json.ok) throw new Error(`files.getUploadURLExternal: ${json.error}`);

  const up = await fetch(json.upload_url, { method: 'POST', body: await file.arrayBuffer() });
  if (!up.ok) throw new Error(`upload ${filename}: HTTP ${up.status}`);
  return { id: json.file_id, title: filename };
}
