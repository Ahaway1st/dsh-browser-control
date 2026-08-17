// DSH Browser Control — popup（配对 / 状态 / 授权管理）

const $ = (id) => document.getElementById(id);

const STATUS_TEXT = {
  connected: ['#1a7f37', '已连接'],
  connecting: ['#d29922', '连接中…'],
  disconnected: ['#57606a', '未连接'],
  'auth-failed': ['#cf222e', '配对失败：令牌无效'],
  'version-mismatch': ['#cf222e', '协议版本不匹配'],
  'no-token': ['#57606a', '未配置令牌'],
};

async function refresh() {
  let state;
  try {
    state = await chrome.runtime.sendMessage({ type: 'getState' });
  } catch (e) {
    return;
  }
  const [color, label] = STATUS_TEXT[state.status] || ['#57606a', state.status];
  $('status-dot').style.background = color;
  $('status-text').textContent = label;
  $('session-id').textContent = state.sessionId ? '会话 ' + String(state.sessionId).slice(0, 8) : '';
  $('ws-url').value = state.wsUrl || '';
  $('token').value = state.token || '';
  $('version').textContent = state.version || '—';
  $('cur-tab').textContent = (state.tab && state.tab.url) || '—';

  const list = $('consent-list');
  list.textContent = '';
  const domains = Object.keys(state.consentedDomains || {});
  if (!domains.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = '（无）';
    list.appendChild(li);
  }
  for (const d of domains) {
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.textContent = d;
    li.appendChild(span);
    const btn = document.createElement('button');
    btn.textContent = '清除';
    btn.addEventListener('click', async () => {
      await chrome.runtime.sendMessage({ type: 'clearConsent', domain: d });
      refresh();
    });
    li.appendChild(btn);
    list.appendChild(li);
  }

  // 待授权请求
  let consent = null;
  try {
    consent = await chrome.runtime.sendMessage({ type: 'getConsent' });
  } catch (e) {}
  const card = $('consent-card');
  if (consent) {
    card.style.display = '';
    $('consent-text').textContent = `在 ${consent.domain} 上执行 ${consent.commandName}，是否允许？`;
  } else {
    card.style.display = 'none';
  }
}

$('consent-allow').addEventListener('click', async () => {
  const consent = await chrome.runtime.sendMessage({ type: 'getConsent' });
  if (consent) await chrome.runtime.sendMessage({ type: 'decideConsent', id: consent.id, granted: true });
  setTimeout(refresh, 200);
});

$('consent-deny').addEventListener('click', async () => {
  const consent = await chrome.runtime.sendMessage({ type: 'getConsent' });
  if (consent) await chrome.runtime.sendMessage({ type: 'decideConsent', id: consent.id, granted: false });
  setTimeout(refresh, 200);
});

$('connect-btn').addEventListener('click', async () => {
  $('connect-btn').disabled = true;
  await chrome.runtime.sendMessage({
    type: 'connect',
    token: $('token').value.trim(),
    wsUrl: $('ws-url').value.trim(),
  });
  setTimeout(() => { $('connect-btn').disabled = false; refresh(); }, 400);
});

$('disconnect-btn').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'disconnect' });
  setTimeout(refresh, 200);
});

refresh();
