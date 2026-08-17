# DSH Browser Control

[中文版](./README.md)

Let [DeepSeek Harness](https://github.com/deepseek-ai/dsh) (DSH) agents drive your **real browser** —
an OpenClaw-style browser bridge. The extension installs into Chrome/Edge and talks to DSH over a
local WebSocket, so agents can navigate, click, type, screenshot, and read pages **with your login
state and cookies** to complete real tasks.

```
┌─ Your Chrome/Edge ────────────────┐       ┌─ DSH (localhost:127.0.0.1:3080) ─────────────┐
│  DSH Browser Control ext (MV3)    │       │  browser-control plugin (dynamic Cordis)     │
│  ├─ content script: page ops      │  WebSocket  │  ├─ WebSocket bridge (/dsh/browser)    │
│  │   (click/type/read DOM/scroll) │◄───────►│  ├─ pairing token (config file/random)    │
│  ├─ background: tabs/CDP screenshot│ JSON cmd  │  ├─ browser_* dynamic tools (for agents)│
│  └─ popup: pairing/consent mgmt   │  /events │  ├─ sensitive-site consent gate          │
└───────────────────────────────────┘       │  └─ screenshots saved as session attachments│
                                             └──────────────────────┬─────────────────────┘
                                                                    │ tools
                                                            ┌───────▼────────┐
                                                            │  Model (Agent)  │
                                                            └────────────────┘
```

## ✨ Features

- **Drive your real browser** — with your login state/cookies: navigate, click, type, press keys,
  scroll, switch tabs
- **Text-based page perception** — interactive element tree (buttons/links/inputs/headings + ref
  indexes), no vision model required
- **CDP screenshot** — works even for background windows, auto-saved as a DSH session attachment
- **Sensitive-site consent gate** — operations on bank/payment/government domains require your
  confirmation in the browser (system notification + popup dual channel); consent is remembered
  per-domain and can be cleared anytime
- **GUI overlay panel** — pairing code + connection status in the DSH UI (shell.overlay)
- **Chrome & Edge** — Manifest V3, zero build dependencies, load as unpacked extension
- **Stable connection** — text-message heartbeat + SW Port keepalive, exponential backoff reconnect

## ⚙️ Requirements

- DSH (DeepSeek Harness) running, web GUI at `127.0.0.1:3080`
- Chrome **≥ 116** or Edge ≥ 116 (SW Port keepalive; older versions may have unstable connections)

## 🚀 Quick Start (~3 minutes)

### Step 1: Install the browser extension (1 min)

1. Open `chrome://extensions` (Edge: `edge://extensions`)
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** → select the `extension` folder of this repo
4. Confirm the permission prompt (needs access to all website data — the necessary cost of browser control)

### Step 2: Install the DSH plugin (1 min)

Paste this whole paragraph into a DSH session (replace `<repo-path>` with where you cloned this repo):

```
Please install the browser-control plugin: read <repo-path>\plugin\plugin.js as the Host code,
read <repo-path>\plugin\client.js as the Client code, create and run it with cordis_define,
then call browser_pairing_code and tell me the pairing code.
```

The DSH agent will define and run the plugin automatically. **After it runs, approve the run card
in the conversation with the double-checkmark (✓✓)** — only needed once.

### Step 3: Pair (1 min)

1. Copy the pairing code the agent gives you (e.g. `dsh-xxxx...`; if not given, just ask "what is the pairing code?")
2. Click the extension icon in the toolbar → paste the token → click **Connect**
3. Done when the popup shows **Connected** and the DSH overlay panel turns green ✅

### Try it

In a DSH session:

- "Open https://example.com"
- "What's on the current page?"
- "Click the search box, type xxx, press Enter"
- "Take a screenshot"

## 🛠 Agent Tools

| Tool | Description |
|---|---|
| `browser_navigate` | Navigate to a URL (consent gate on sensitive sites) |
| `browser_read_page` | Read the interactive element tree (ref indexes for targeting) |
| `browser_click` | Click an element (ref or CSS selector) |
| `browser_type` | Type text (optional clear; password values never echoed back) |
| `browser_press` | Press keys (Enter/Escape/Tab/arrows + modifiers) |
| `browser_scroll` | Scroll the page |
| `browser_list_tabs` / `browser_switch_tab` | Tab management |
| `browser_screenshot` | CDP screenshot, saved as a session attachment |
| `browser_run_js` | Execute arbitrary JS (**denied by default policy**, EPOLICY) |
| `browser_pairing_code` | Query the pairing token & connection status |

## ❓ FAQ

**The plugin disappears after a DSH restart?**
Dynamic plugins are process-local. After a DSH restart, re-run Step 2 (reinstall + re-approve).
(Roadmap: host-composition integration so DSH loads it automatically.)

**A "debugging this browser" banner appears during screenshots?**
Normal. Screenshots use the CDP protocol (debugger permission) so they work for background
windows; the banner appears only while capturing.

**Can't read/operate on `chrome://` internal pages?**
Normal. Content scripts cannot be injected into internal pages; navigate to a normal web page
to resume.

**Pressing Enter doesn't submit the form?**
Some SPA sites (e.g. Bing homepage) ignore synthetic key events; click the search/submit button
instead. Regular forms are covered by a `requestSubmit()` fallback.

**Where is the pairing code?**
Ask the agent in a DSH session ("what is the pairing code?" → `browser_pairing_code` tool), or check
the plugin log. The token is never hardcoded: on first run it is randomly generated and written to
`TOKEN_FILE` (default `.dsh-browser-token`, relative to the DSH working directory; set an absolute
path at the top of `plugin/plugin.js` if needed). To pin a token, pre-create that file.

## 📦 Repository Layout

```
dsh-browser-control/
├── docs/              protocol, requirements, development notes (pitfalls)
├── extension/         Chrome/Edge MV3 extension (zero build, load unpacked)
│   ├── manifest.json
│   ├── background.js  SW: connection/command routing/CDP screenshot/consent/keepalive
│   ├── content.js     page ops: element tree/click/type/keys/scroll
│   └── popup.*        pairing, connection status, consent management
├── plugin/            DSH dynamic Cordis plugin (Host half + Client half)
│   ├── plugin.js      WebSocket bridge, browser_* tools, consent gate, attachments
│   ├── client.js      GUI overlay panel (shell.overlay)
│   └── test/          verification scripts (SHA1/base64, frame parsing, heartbeat probe, sim…)
└── README.md
```

## 🔒 Security Model

- **Pairing token**: never hardcoded; randomly generated, stored only in a local token file
- **Consent gate**: operations on sensitive domains (bank/payment/government — extensible constant
  in source) require your confirmation in the browser (notification buttons or extension popup);
  consent is remembered per domain and can be cleared
- **Data minimization**: `read_page` returns a text element tree only; password values are never
  echoed; text containing secret-like patterns is redacted
- **High-risk commands**: `browser_run_js` is denied by default (EPOLICY); requires a policy change to enable
- **Local loop**: the extension only connects to your local DSH address; page data never leaves your machine

## 🧪 Development & Verification

- Protocol contract: `docs/protocol.md` (v1.0)
- Requirements & decisions: `docs/requirements.md`
- Pitfalls & verification tools: `docs/DEVELOPMENT.md`, `plugin/test/`
- Zero build: the extension has no dependencies; the plugin has no npm dependencies
  (SHA1/base64 are hand-written, asserted in `plugin/test/check.js`)

## 📄 License

[MIT](./LICENSE)
