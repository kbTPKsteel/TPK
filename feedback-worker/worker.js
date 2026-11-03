// TPK Warehouse — feedback relay and site password (Cloudflare Worker).
//
// The site sends the feedback form here; the worker posts it to Slack with the
// bot token that lives only in the worker's secrets. No tokens in the browser.
//
// Downloads and feedback need the organisation password. The site posts it to
// /login and keeps the signed token it gets back. The password is changed with
// the /tpk-warehouse-password slash command in the feedback channel: the worker makes a
// random one, stores only its hash in KV and posts the password to the channel.
//
// Required settings (Cloudflare → Worker → Settings):
//   SLACK_BOT_TOKEN       (secret)  Bot User OAuth Token, scopes: chat:write, files:write, commands
//   SLACK_SIGNING_SECRET  (secret)  Slack app → Basic Information → Signing Secret
//   SLACK_CHANNEL         (text)    channel ID, e.g. C05092Y0B5X (the bot must be a member)
//   ALLOWED_ORIGIN        (text)    https://kbtpksteel.github.io
//   TPK_KV                (KV namespace binding) stores the password hash and login fail counters
//
// Routes:
//   POST /login    {password} → {ok, token}
//   GET  /session  Authorization: Bearer <token> → 200 if the token is valid, 401 otherwise
//   POST /         feedback form (needs the token)
//   POST /slack    Slack slash command /tpk-warehouse-password

const MAX_FILES = 5;
const MAX_FILE_SIZE = 5 * 1024 * 1024;
const MAX_MESSAGE = 4000;
const MAX_NAME = 100;
const MAX_PRODUCT = 200;

const HASH_KEY = 'password_hash';
const PASSWORD_ITERATIONS = 20000;   // kept low to stay within the Workers CPU limit
const TOKEN_DAYS = 180;
const LOGIN_MAX_FAILS = 10;
const LOGIN_WINDOW_SEC = 15 * 60;

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    // Slack calls this route directly (no Origin header); it is checked by signature instead.
    if (path === '/slack') return slackCommand(request, env);

    const origin = request.headers.get('Origin') || '';
    const cors = {
      'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Vary': 'Origin',
    };
    const reply = (status, body) =>
      new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

    if (origin !== env.ALLOWED_ORIGIN) return reply(403, { ok: false, error: 'forbidden origin' });
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    if (path === '/login' && request.method === 'POST') return login(request, env, reply);
    if (path === '/session' && request.method === 'GET')
      return (await tokenValid(request, env))
        ? reply(200, { ok: true })
        : reply(401, { ok: false, error: 'Нужен пароль.' });
    if (path !== '/' || request.method !== 'POST') return reply(405, { ok: false, error: 'method not allowed' });

    if (!(await tokenValid(request, env))) return reply(401, { ok: false, error: 'Нужен пароль.' });

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
    const mention = isSlackUserId(slackUserId) ? `<@${slackUserId}> ` : '';
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

function isSlackUserId(s) {
  return /^[UW][A-Z0-9]{6,20}$/.test(s);
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

/* ── Site password ── */

async function login(request, env, reply) {
  const hash = await env.TPK_KV.get(HASH_KEY);
  if (!hash) return reply(503, { ok: false, error: 'Пароль ещё не задан: выполните /tpk-warehouse-password в Slack-канале.' });

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const failKey = `fail:${ip}`;
  const fails = Number(await env.TPK_KV.get(failKey)) || 0;
  if (fails >= LOGIN_MAX_FAILS) return reply(429, { ok: false, error: 'Слишком много попыток, подождите 15 минут.' });

  let password = '';
  try {
    password = String((await request.json()).password || '').trim();
  } catch {}
  if (!password || !(await checkPassword(password, hash))) {
    await env.TPK_KV.put(failKey, String(fails + 1), { expirationTtl: LOGIN_WINDOW_SEC });
    return reply(401, { ok: false, error: 'Неверный пароль.' });
  }
  if (fails) await env.TPK_KV.delete(failKey);
  return reply(200, { ok: true, token: await makeToken(hash) });
}

// The token is signed with the current password hash, so changing the password
// makes every issued token invalid at once — no separate session secret needed.
async function makeToken(hash) {
  const exp = Date.now() + TOKEN_DAYS * 24 * 3600 * 1000;
  return `${exp}.${b64url(await hmac(hash, `site:${exp}`))}`;
}

async function tokenValid(request, env) {
  const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const [exp, sig] = token.split('.');
  if (!sig || !(Number(exp) > Date.now())) return false;
  const hash = await env.TPK_KV.get(HASH_KEY);
  if (!hash) return false;
  return safeEqual(sig, b64url(await hmac(hash, `site:${exp}`)));
}

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await pbkdf2(password, salt, PASSWORD_ITERATIONS);
  return `pbkdf2$${PASSWORD_ITERATIONS}$${b64(salt)}$${b64(bits)}`;
}

async function checkPassword(password, stored) {
  const [kind, iterations, salt, hash] = stored.split('$');
  if (kind !== 'pbkdf2' || !iterations || !salt || !hash) return false;
  return safeEqual(b64(await pbkdf2(password, unb64(salt), Number(iterations))), hash);
}

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256));
}

async function hmac(key, message) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(message)));
}

// XXXXXX-XXXXXX-XXXXXX without look-alike characters (no 0/O, 1/I/L).
function newPassword() {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let out = '';
  while (out.length < 18) {
    for (const b of crypto.getRandomValues(new Uint8Array(32))) {
      // 248 = 8 * 31: skip the tail so every character is equally likely.
      if (b < 248 && out.length < 18) out += alphabet[b % alphabet.length];
    }
  }
  return out.match(/.{6}/g).join('-');
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function b64(bytes) {
  return btoa(String.fromCharCode(...bytes));
}

function unb64(s) {
  return Uint8Array.from(atob(s), c => c.charCodeAt(0));
}

function b64url(bytes) {
  return b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/* ── Slack slash command /tpk-warehouse-password ── */

async function slackCommand(request, env) {
  if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
  const body = await request.text();
  if (!(await slackSignatureOk(request, body, env))) return new Response('bad signature', { status: 401 });

  const params = new URLSearchParams(body);
  const answer = (response_type, text) =>
    new Response(JSON.stringify({ response_type, text }), { headers: { 'Content-Type': 'application/json' } });

  // Anyone in the feedback channel can change the password, as with /adminpass
  // in IFC_viewer: membership of the channel is the access control.
  if (params.get('channel_id') !== env.SLACK_CHANNEL)
    return answer('ephemeral', 'Пароль сайта меняется только в канале обратной связи TPK Warehouse.');

  const password = newPassword();
  await env.TPK_KV.put(HASH_KEY, await hashPassword(password));
  const userId = params.get('user_id') || '';
  const who = isSlackUserId(userId) ? ` (сменил(а) <@${userId}>)` : '';
  return answer('in_channel',
    `🔑 Новый пароль TPK Warehouse${who}:\n\`${password}\`\n\n`
    + `Он нужен для скачивания и сообщений разработчикам. Прежний пароль больше не действует, всем нужно ввести новый.`);
}

// https://api.slack.com/authentication/verifying-requests-from-slack
async function slackSignatureOk(request, body, env) {
  const ts = request.headers.get('X-Slack-Request-Timestamp') || '';
  const sig = request.headers.get('X-Slack-Signature') || '';
  if (!env.SLACK_SIGNING_SECRET || !ts || Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const mac = await hmac(env.SLACK_SIGNING_SECRET, `v0:${ts}:${body}`);
  const expected = 'v0=' + [...mac].map(b => b.toString(16).padStart(2, '0')).join('');
  return safeEqual(sig, expected);
}
