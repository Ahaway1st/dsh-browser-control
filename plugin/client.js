// DSH Browser Control — Client 半：GUI 常驻面板（shell.overlay）
// 显示配对令牌、连接状态，支持一键复制；折叠为右下角小圆钮。

return {
  inject: ['timer'],
  apply(ctx) {
    const slots = ctx.get('slots');
    if (slots === undefined) return;

    const stopStyle = styles.insert(`
      .dshbc-panel {
        position: fixed; right: 16px; bottom: 16px; z-index: 9999;
        width: 300px; background: #ffffff; color: #24292f;
        border: 1px solid #e1e4e8; border-radius: 10px;
        box-shadow: 0 8px 24px rgba(0,0,0,0.14);
        font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
        font-size: 13px; pointer-events: auto; overflow: hidden;
      }
      .dshbc-collapsed { width: auto; background: transparent; border: none; box-shadow: none; }
      .dshbc-toggle { background: #2563eb; color: #fff; border: none; border-radius: 50%;
        width: 42px; height: 42px; font-size: 18px; cursor: pointer;
        box-shadow: 0 4px 12px rgba(0,0,0,0.25); }
      .dshbc-head { display: flex; align-items: center; gap: 8px; padding: 10px 12px;
        border-bottom: 1px solid #eef1f4; font-weight: 600; }
      .dshbc-title { flex: 1; }
      .dshbc-dot { width: 9px; height: 9px; border-radius: 50%; }
      .dshbc-dot.on { background: #1a7f37; }
      .dshbc-dot.off { background: #cf222e; }
      .dshbc-status { font-weight: 400; color: #57606a; font-size: 12px; }
      .dshbc-x { border: none; background: #f6f8fa; border-radius: 4px; cursor: pointer;
        padding: 2px 8px; color: #57606a; line-height: 1; }
      .dshbc-body { padding: 10px 12px; }
      .dshbc-row { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
      .dshbc-label { color: #57606a; font-size: 12px; white-space: nowrap; }
      .dshbc-code { flex: 1; background: #f6f8fa; border: 1px solid #e1e4e8; border-radius: 5px;
        padding: 4px 6px; font-family: ui-monospace, Consolas, monospace; font-size: 11px;
        user-select: all; word-break: break-all; }
      .dshbc-copy { border: none; background: #2563eb; color: #fff; border-radius: 5px;
        padding: 4px 10px; cursor: pointer; font-size: 12px; }
      .dshbc-foot { color: #8b949e; font-size: 11px; margin-top: 6px; }
    `);

    function Panel() {
      const [info, setInfo] = React.useState(null);
      const [collapsed, setCollapsed] = React.useState(false);
      const [copied, setCopied] = React.useState(false);

      const refresh = () => {
        host.call('get-pairing-info')
          .then((d) => setInfo(d))
          .catch(() => setInfo({ pairingCode: '(不可用)', connected: false }));
      };

      React.useEffect(() => {
        refresh();
        const stop = ctx.interval(refresh, 3000);
        return stop;
      }, []);

      const copy = () => {
        const text = info && info.pairingCode;
        if (!text) return;
        const done = () => {
          setCopied(true);
          ctx.timeout(() => setCopied(false), 1500);
        };
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(done).catch(done);
          } else { done(); }
        } catch (e) { done(); }
      };

      if (collapsed) {
        return React.createElement('div', { className: 'dshbc-panel dshbc-collapsed' },
          React.createElement('button', { className: 'dshbc-toggle', onClick: () => setCollapsed(false), title: '展开 DSH 浏览器控制面板' }, '\uD83D\uDDA5'),
        );
      }

      const connected = !!(info && info.connected);
      return React.createElement('div', { className: 'dshbc-panel' },
        React.createElement('div', { className: 'dshbc-head' },
          React.createElement('span', { className: 'dshbc-title' }, 'DSH 浏览器控制'),
          React.createElement('span', { className: 'dshbc-dot ' + (connected ? 'on' : 'off') }),
          React.createElement('span', { className: 'dshbc-status' }, connected ? '已连接' : '未连接'),
          React.createElement('button', { className: 'dshbc-x', onClick: () => setCollapsed(true), title: '折叠' }, '\u2013'),
        ),
        React.createElement('div', { className: 'dshbc-body' },
          React.createElement('div', { className: 'dshbc-row' },
            React.createElement('span', { className: 'dshbc-label' }, '配对令牌'),
            React.createElement('code', { className: 'dshbc-code' }, info ? info.pairingCode : '加载中…'),
            React.createElement('button', { className: 'dshbc-copy', onClick: copy }, copied ? '已复制' : '复制'),
          ),
          React.createElement('div', { className: 'dshbc-foot' }, '把令牌粘贴到浏览器扩展 popup 中，点「连接」即可配对'),
        ),
      );
    }

    slots.inject('shell.overlay', () => slots.register(
      { name: 'shell.overlay', id: 'dsh-browser-control-panel', order: 100, label: 'DSH Browser Control' },
      () => React.createElement(Panel),
    ));

    ctx.effect(() => () => { stopStyle(); }, 'browser-control.client.cleanup');
  },
};
