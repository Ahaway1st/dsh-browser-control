// DSH Browser Control — content script（注入页面）
// 协议契约：docs/protocol.md v1.0 附录 A/B
// 职责：可交互元素树提取、点击/输入/按键/滚动（按需注入，幂等）

(() => {
  if (window.__dshContentLoaded) return;
  window.__dshContentLoaded = true;

  const REDACT_RE = /(sk-[A-Za-z0-9_-]{8,}|token[=:][^\s&"'<>]{6,}|password[=:][^\s&"'<>]{6,})/gi;
  const MAX_ENTRIES = 400;
  const MAX_TEXT = 500;
  // 语义标签 + 可聚焦；结合 cursor:pointer 启发覆盖 div/span 自绘 UI（如 QQ 邮箱新版）
  const SELECTOR = 'a[href],button,input,select,textarea,[role],[tabindex],[onclick],h1,h2,h3,h4,h5,h6,nav,img,[contenteditable],summary,label,audio,video';
  let lastTree = [];
  let lastElements = []; // ref -> DOM 元素（与 lastTree 并行，供 click/type 定位）

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.type !== 'dsh-op') return;
    run(msg.op, msg.args || {})
      .then((data) => sendResponse({ ok: true, data }))
      .catch((e) => sendResponse({ ok: false, error: { code: e.code || 'EUNKNOWN', message: e.message || String(e) } }));
    return true; // 异步响应
  });

  // SW 保活（双层，仅主 frame 建立——子 frame 无需重复保活）：
  if (window.top === window.self) {
    // 1) 长连接 Port（Chrome 116+：活跃 Port 保持 SW 不终止；页面进 bfcache 会断开 → 重连）
    let keepalivePort = null;
    const connectPort = () => {
      try {
        keepalivePort = chrome.runtime.connect({ name: 'dsh-keepalive' });
        keepalivePort.onDisconnect.addListener(() => {
          // bfcache/扩展更新导致断开：稍后重连（页面恢复可见/活跃时）
          setTimeout(connectPort, 2000);
        });
      } catch (e) {}
    };
    connectPort();
    // 2) 定期消息（前台页面时有效，作为补充）
    setInterval(() => {
      try { chrome.runtime.sendMessage({ type: 'dsh-keepalive' }); } catch (e) {}
    }, 10000);
  }

  function fail(code, message) {
    const e = new Error(message);
    e.code = code;
    throw e;
  }

  function isVisible(el) {
    if (!(el instanceof Element)) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0
      && rect.bottom > 0 && rect.top < window.innerHeight
      && rect.right > 0 && rect.left < window.innerWidth;
  }

  function cleanText(s) {
    if (!s) return '';
    let t = String(s).replace(/\s+/g, ' ').trim();
    t = t.replace(REDACT_RE, '<redacted>');
    if (t.length > MAX_TEXT) t = t.slice(0, MAX_TEXT) + '…';
    return t;
  }

  function elementType(el) {
    const tag = el.tagName;
    const inputType = ((el.getAttribute && el.getAttribute('type')) || '').toLowerCase();
    if (tag === 'BUTTON') return 'button';
    if (tag === 'A') return 'link';
    if (tag === 'SELECT') return 'select';
    if (tag === 'TEXTAREA') return 'textbox';
    if (tag === 'INPUT') return (inputType === 'checkbox' || inputType === 'radio') ? 'checkbox' : 'input';
    if (/^H[1-6]$/.test(tag)) return 'heading';
    if (tag === 'NAV') return 'nav';
    if (tag === 'IMG') return 'img';
    return 'other';
  }

  function entryFor(el) {
    const tag = el.tagName;
    const inputType = ((el.getAttribute && el.getAttribute('type')) || '').toLowerCase();
    const rect = el.getBoundingClientRect();
    const entry = {
      type: elementType(el),
      text: cleanText(el.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || (tag === 'IMG' ? el.getAttribute('alt') : '')),
      role: el.getAttribute('role') || undefined,
      ref: -1,
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      w: Math.round(rect.width),
      h: Math.round(rect.height),
    };
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      if (inputType !== 'password') entry.value = cleanText(el.value);
    }
    if (el.placeholder) entry.placeholder = cleanText(el.placeholder);
    if (el.href) entry.href = el.href;
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') entry.disabled = true;
    return entry;
  }

  function buildTree() {
    // 覆盖自绘 UI（div/span + JS 事件，如 QQ 邮箱新版）：
    // 匹配 = 语义/可聚焦标签 ∪ cursor:pointer 元素；
    // 噪音过滤：无可读标识且非表单容器的纯装饰元素跳过
    const entries = [];
    const domEls = [];
    const seen = new WeakSet();
    const all = document.getElementsByTagName('*');
    const total = all.length;
    for (let i = 0; i < total; i++) {
      if (entries.length >= MAX_ENTRIES) break;
      const el = all[i];
      if (!(el instanceof Element)) continue;
      if (seen.has(el)) continue;
      if (!isVisible(el)) continue;
      let isCandidate = false;
      try {
        if (el.matches(SELECTOR)) isCandidate = true;
        if (!isCandidate && (el.hasAttribute('tabindex') || el.hasAttribute('onclick'))) isCandidate = true;
        if (!isCandidate) {
          const cursor = getComputedStyle(el).cursor;
          if (cursor === 'pointer') isCandidate = true;
        }
      } catch (e) {}
      if (!isCandidate) continue;
      if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE' || el.tagName === 'META' || el.tagName === 'NOSCRIPT') continue;
      // 噪音过滤：无文本/无 aria-label/title 的容器
      const label = el.getAttribute('aria-label') || el.getAttribute('title');
      const hasText = !!cleanText(el.innerText);
      const isForm = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.tagName === 'BUTTON' || el.tagName === 'A';
      if (!hasText && !label && !isForm && el.tagName !== 'IMG' && el.tagName !== 'NAV' && !(el.hasAttribute('role') && el.getAttribute('role') !== 'presentation')) {
        continue; // 纯装饰
      }
      if (el.tagName === 'LABEL' && !hasText && !el.htmlFor) continue;
      seen.add(el);
      const e = entryFor(el);
      e.ref = entries.length;
      entries.push(e);
      domEls.push(el);
    }
    lastTree = entries;
    lastElements = domEls;
    return entries;
  }

  function findTarget(args) {
    if (args.ref !== undefined && args.ref !== null) {
      const el = lastElements[args.ref];
      if (!el) fail('ENOTFOUND', '元素不存在: ref=' + args.ref);
      return el;
    }
    if (args.selector) {
      const el = document.querySelector(args.selector);
      if (!el) fail('ENOTFOUND', '选择器未命中: ' + args.selector);
      return el;
    }
    fail('ENOTFOUND', '缺少 ref 或 selector');
  }

  function focusVisible(el) {
    if (!isVisible(el)) el.scrollIntoView({ block: 'center', inline: 'center' });
    el.focus();
  }

  function dispatchClick(el) {
    const opts = { bubbles: true, cancelable: true, view: window, composed: true };
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      try {
        el.dispatchEvent(new PointerEvent(type, opts));
      } catch (e) {
        el.dispatchEvent(new MouseEvent(type, opts));
      }
    }
  }

  function summary() {
    return { ok: true, tabId: null, url: location.href, title: document.title, message: '' };
  }

  async function run(op, args) {
    switch (op) {
      case 'read_page': {
        // debug：DOM 结构诊断（排查 iframe/shadow DOM/非 DOM 渲染）
        const iframes = Array.from(document.querySelectorAll('iframe'));
        const mainDiv = document.body ? document.body.firstElementChild : null;
        let visibleCount = 0;
        const allEls = document.getElementsByTagName('*');
        for (let i = 0; i < allEls.length && i < 20000; i++) {
          try { if (isVisible(allEls[i])) visibleCount++; } catch (e) {}
        }
        const debug = {
          iframeCount: iframes.length,
          bodyHtmlLen: document.body ? document.body.innerHTML.length : 0,
          mainDivTag: mainDiv ? mainDiv.tagName : null,
          mainDivHtmlLen: mainDiv ? mainDiv.innerHTML.length : 0,
          mainDivChildCount: mainDiv ? mainDiv.children.length : 0,
          totalElements: allEls.length,
          visibleElementCount: visibleCount,
          docW: document.documentElement.scrollWidth,
          docH: document.documentElement.scrollHeight,
          viewW: window.innerWidth,
          viewH: window.innerHeight,
          canvases: Array.from(document.querySelectorAll('canvas')).length,
          bodyChildren: Array.from(document.body ? document.body.children : []).slice(0, 10).map((el) => el.tagName + ':' + el.innerHTML.length),
        };
        return { url: location.href, title: document.title, elements: buildTree(), debug };
      }

      case 'click': {
        const el = findTarget(args);
        focusVisible(el);
        dispatchClick(el);
        return summary();
      }

      case 'type': {
        const el = findTarget(args);
        focusVisible(el);
        const text = String(args.text == null ? '' : args.text);
        const isForm = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA';
        if (isForm) {
          const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
          const start = args.clear ? 0 : (el.selectionStart || el.value.length);
          const end = args.clear ? el.value.length : (el.selectionEnd || el.value.length);
          setter.call(el, el.value.slice(0, start) + text + el.value.slice(end));
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        } else if (el.isContentEditable) {
          if (args.clear) el.textContent = '';
          const ok = document.execCommand('insertText', false, text);
          if (!ok) el.textContent = (el.textContent || '') + text;
          el.dispatchEvent(new Event('input', { bubbles: true }));
        } else {
          fail('ENOTFOUND', '目标不是可输入元素');
        }
        return summary();
      }

      case 'press': {
        const key = String(args.key || '');
        if (!key) fail('EUNKNOWN', '缺少 key');
        const mods = args.modifiers || [];
        const opts = {
          key,
          bubbles: true,
          cancelable: true,
          composed: true,
          ctrlKey: mods.indexOf('Control') >= 0,
          altKey: mods.indexOf('Alt') >= 0,
          shiftKey: mods.indexOf('Shift') >= 0,
          metaKey: mods.indexOf('Meta') >= 0,
        };
        // 合成事件的 keyCode 默认为 0，补上兼容依赖 keyCode 的站点逻辑
        const keyCodeMap = { Enter: 13, Escape: 27, Tab: 9, Backspace: 8, Delete: 46, Space: 32, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Home: 36, End: 35, PageUp: 33, PageDown: 34 };
        const keyCode = keyCodeMap[key] || 0;
        const fire = (type) => {
          const ev = new KeyboardEvent(type, opts);
          if (keyCode) {
            Object.defineProperty(ev, 'keyCode', { get: () => keyCode });
            Object.defineProperty(ev, 'which', { get: () => keyCode });
          }
          target.dispatchEvent(ev);
        };
        const target = document.activeElement || document.body;
        fire('keydown');
        fire('keyup');
        // 合成事件不会触发浏览器默认行为（如表单提交），Enter 且焦点在表单内时直接提交
        if (key === 'Enter' && mods.length === 0) {
          const form = target.closest && target.closest('form');
          if (form) {
            try { form.requestSubmit(); } catch (e) {
              try { form.submit(); } catch (e2) {}
            }
          }
        }
        return summary();
      }

      case 'scroll': {
        const dir = args.direction || 'down';
        const delta = Number(args.delta) || 600;
        if (dir === 'top') window.scrollTo({ top: 0, behavior: 'smooth' });
        else if (dir === 'bottom') window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' });
        else if (dir === 'up') window.scrollBy({ top: -delta, behavior: 'smooth' });
        else window.scrollBy({ top: delta, behavior: 'smooth' });
        return summary();
      }

      default:
        fail('EUNKNOWN', '未知操作: ' + op);
    }
  }
})();
