// TPK Warehouse — organisation password for downloads and feedback.
//
// Viewing the catalog needs no password. Download links marked with
// data-auth-download and the feedback form ask for it once; the token the
// feedback-worker returns is kept in localStorage so the password is not asked
// again until it is changed in Slack (/tpk-warehouse-password).
//
// Note: download files themselves are public on GitHub, so for downloads this
// is a gate in the interface only. Feedback is checked by the worker.
const TpkAuth = (() => {
  const WORKER_URL = 'https://tpk-feedback.poluhovamaria.workers.dev';
  const TOKEN_KEY = 'tpkAuthToken';
  let checked = null;   // Promise<boolean>: is the stored token still valid (checked once per page)
  let pending = null;   // Promise<string|null> of the open password dialog

  const style = document.createElement('style');
  style.textContent = `
    .tpk-auth-overlay {
      display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 300;
      align-items: center; justify-content: center; padding: 24px;
    }
    .tpk-auth-overlay.open { display: flex; }
    .tpk-auth-modal {
      background: white; border-radius: 12px; max-width: 400px; width: 100%; padding: 24px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #1a2332;
    }
    .tpk-auth-title {
      font-size: 1.1rem; font-weight: 600; margin-bottom: 12px; padding-bottom: 12px; border-bottom: 1px solid #e2e8f0;
    }
    .tpk-auth-hint { font-size: 0.85rem; color: #475569; line-height: 1.5; margin-bottom: 12px; }
    .tpk-auth-input {
      width: 100%; padding: 8px 12px; border: 1.5px solid #cbd5e1; border-radius: 8px;
      font-size: 0.9rem; font-family: monospace; color: #1a2332; outline: none;
    }
    .tpk-auth-input:focus { border-color: #1e3a5f; }
    .tpk-auth-status { font-size: 0.85rem; min-height: 1.2em; color: #dc2626; margin-top: 8px; }
    .tpk-auth-buttons { display: flex; gap: 8px; margin-top: 12px; }
    .tpk-auth-buttons button {
      flex: 1; padding: 8px 20px; border: 1.5px solid #1e3a5f; border-radius: 8px;
      cursor: pointer; font-size: 0.9rem; font-family: inherit;
    }
    .tpk-auth-cancel { background: white; color: #1e3a5f; }
    .tpk-auth-cancel:hover { background: #f0f4f8; }
    .tpk-auth-ok { background: #1e3a5f; color: white; }
    .tpk-auth-ok:hover { background: #2d6a9f; border-color: #2d6a9f; }
    .tpk-auth-ok:disabled { background: #94a3b8; border-color: #94a3b8; cursor: not-allowed; }
  `;
  document.head.appendChild(style);

  const overlay = document.createElement('div');
  overlay.className = 'tpk-auth-overlay';
  overlay.innerHTML = `
    <form class="tpk-auth-modal">
      <div class="tpk-auth-title">Пароль организации</div>
      <div class="tpk-auth-hint">Для скачивания и сообщений разработчикам нужен пароль. Его можно узнать в Slack-канале TPK Warehouse.</div>
      <input type="password" class="tpk-auth-input" autocomplete="current-password" placeholder="XXXXXX-XXXXXX-XXXXXX">
      <div class="tpk-auth-status"></div>
      <div class="tpk-auth-buttons">
        <button type="button" class="tpk-auth-cancel">Отмена</button>
        <button type="submit" class="tpk-auth-ok">Войти</button>
      </div>
    </form>`;
  document.body.appendChild(overlay);

  const form     = overlay.querySelector('form');
  const input    = overlay.querySelector('.tpk-auth-input');
  const statusEl = overlay.querySelector('.tpk-auth-status');
  const okBtn    = overlay.querySelector('.tpk-auth-ok');
  let resolveDialog = null;

  function getToken() {
    try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
  }

  function forget() {
    try { localStorage.removeItem(TOKEN_KEY); } catch {}
    checked = null;
  }

  function authHeaders() {
    const token = getToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  async function storedTokenValid(token) {
    try {
      const r = await fetch(`${WORKER_URL}/session`, { headers: { Authorization: `Bearer ${token}` } });
      return r.status !== 401;
    } catch {
      return true;   // worker unreachable: don't lock people out of downloads
    }
  }

  function closeDialog(token) {
    overlay.classList.remove('open');
    pending = null;
    resolveDialog(token);
  }

  function askPassword() {
    if (pending) return pending;
    input.value = '';
    statusEl.textContent = '';
    okBtn.disabled = false;
    overlay.classList.add('open');
    input.focus();
    pending = new Promise(resolve => { resolveDialog = resolve; });
    return pending;
  }

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const password = input.value.trim();
    if (!password) { statusEl.textContent = 'Введите пароль.'; return; }
    okBtn.disabled = true;
    statusEl.textContent = '';
    try {
      const resp = await fetch(`${WORKER_URL}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const json = await resp.json().catch(() => ({}));
      if (resp.ok && json.token) {
        try { localStorage.setItem(TOKEN_KEY, json.token); } catch {}
        checked = Promise.resolve(true);
        closeDialog(json.token);
        return;
      }
      statusEl.textContent = json.error || `Ошибка ${resp.status}`;
    } catch (err) {
      statusEl.textContent = 'Сервер недоступен, попробуйте позже.';
    }
    okBtn.disabled = false;
    input.select();
  });

  overlay.querySelector('.tpk-auth-cancel').addEventListener('click', () => closeDialog(null));
  overlay.addEventListener('click', e => { if (e.target === overlay) closeDialog(null); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && overlay.classList.contains('open')) closeDialog(null);
  });

  // Resolves to the token, or null if the user cancelled.
  async function require() {
    const token = getToken();
    if (token) {
      checked ||= storedTokenValid(token);
      if (await checked) return token;
      forget();
    }
    return askPassword();
  }

  // Download links: ask for the password first, then follow the link.
  document.addEventListener('click', async e => {
    const link = e.target.closest('a[data-auth-download]');
    if (!link || e.button !== 0) return;
    e.preventDefault();
    if (await require()) window.location.href = link.href;
  });

  return { WORKER_URL, require, forget, authHeaders };
})();
