<div align="center">

![opencode-chrome-extension](assets/icon-128.png)

# Opencode in Chrome

**A Chrome/Brave extension that steals Claude Code's browser superpowers — tab groups, glow, phantom cursor, side panel — and repoints them at [opencode](https://opencode.ai) on `localhost:4096`.**

[![status](https://img.shields.io/badge/status-work%20in%20progress-orange?style=flat-square)](#status)
[![browser](https://img.shields.io/badge/browser-Chrome%20%7C%20Brave-informational?style=flat-square&logo=googlechrome&logoColor=white)](#requirements)
[![manifest](https://img.shields.io/badge/manifest-v3-58a6ff?style=flat-square)](#starting-point)
[![origin](https://img.shields.io/badge/origin-Claude%201.0.90__0-7C3AED?style=flat-square)](#starting-point)
[![bridge](https://img.shields.io/badge/bridge-localhost%3A4096-34D399?style=flat-square)](#protocol)
[![license](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)

</div>

---

> ## ⚠️ Work in progress — it looks like Claude, it is not Claude yet
>
> The extension renders Claude's visible shell perfectly — purple tab group, glow border, phantom cursor, side panel with heartbeat. **The opencode bridge behind it is half-wired.**
>
> What is measured:
> ```
> manifest valid          ✓  python3 -m json.tool passes
> syntax check            ✓  node --check on bg + 2 content-scripts + sidepanel
> load unpacked (Brave)   ✓  headless --load-extension, DevTools listening
> tabGroups create/reuse  ✓  chrome.tabGroups.query → update → group → purple
> broadcast SHOW/HIDE     ✓  tabs.query → sendMessage to all tabs
> glow border injection   ✅ violet (fixed 0.2.0)
> phantom cursor          ✅ violet 0.2.0
> sidepanel open (Ctrl+E) ✓  sidePanel.setPanelBehavior({openPanelOnActionClick:true})
> HTTP ping to opencode   ✓  fetch http://localhost:4096 → 200 when opencode running
> WS to opencode          ✗  ws://localhost:4096 opens then closes — opencode has no WS at /
> offscreen keepalive     ✓  SW_KEEPALIVE every 20s (copied 1:1 from Claude)
> accessibility tree      ✓  __opencodeElementMap / __generateOpencodeTree on <all_urls>
> icon / branding         ✅ icon-128.png `O` + opencode-icon.svg
> store publish           ✗  not packaged, not submitted
> tests                   ✗  zero
> ```
>
> It is a **convincing costume**. The party where opencode actually drives the cursor has not started — the bridge speaks HTTP and pretends to speak WS, but opencode's server does not expose the WS protocol this extension dials. Every `SHOW_AGENT_INDICATORS` you trigger today comes from the sidepanel button, not from an agent.
>
> Use it to see where Claude's UX lives, to iterate on the shell, or as a harness while you build the real bridge. Do not demo it as "opencode controls my browser" — it does not, yet.
>
> The next measurement is the bridge: what opencode *actually* exposes (HTTP API / TUI events / plugin hooks) and what adapter makes `UPDATE_PHANTOM_CURSOR` fire from a real tool call rather than a `setInterval` demo.

---

## Contents

- [If your extension is a different one](#if-your-extension-is-a-different-one)
- [Status](#status)
- [Starting point](#starting-point) · [Protocol](#protocol)
- [Why it does not just fork Claude's UI](#why-it-does-not-just-fork-claudes-ui)
- [How it works](#how-it-works) · [The color that was not changed](#the-color-that-was-not-changed)
- [Methods that were tried and lost](#methods-that-were-tried-and-lost)
- [Requirements](#requirements) · [Building](#building) · [Usage](#usage)
- [Known limitations](#known-limitations)
- [Roadmap](#roadmap) · [Contributing](#contributing)
- [Repository layout](#repository-layout) · [Method notes](#method-notes)
- [Security](#security)

---

## If your extension is a different one

**Read this section even if you came for another extension.** The method transfers more than the code.

This repo exists because one question turned out to have a concrete answer: *where does Claude's "Claude is working in this tab group" live?* The answer is not in docs — it is in `~/.config/BraveSoftware/Brave-Browser/Default/Extensions/fcoeoabgfenejglbffodgkkbkcdhcgfn/1.0.90_0/`, unpacked and readable.

That finding is useful for any Chromium extension that wants visible agent state:

- how to prove Brave and Chrome share the extension engine (they do — `brave://extensions` is `chrome://extensions` with a skin);
- how to reconstruct a full permission set without guessing (`manifest.json` lists 16 permissions + `<all_urls>` + 4 CSP connect targets);
- how to tell a `document_start` accessibility shim from a `document_idle` visual layer — and why they are two different content-scripts;
- how to find the tab-grouping primitive (`chrome.tabGroups` + `chrome.tabs.group`) that makes the purple `Opencode` pill in the tab strip;
- how to steal a message protocol without stealing a backend (keep `SHOW_AGENT_INDICATORS` → `HIDE_FOR_TOOL_USE` → `SHOW_AFTER_TOOL_USE` → `STATIC_INDICATOR_HEARTBEAT`, swap `wss://bridge.claudeusercontent.com` for `ws://localhost:4096`);
- which files are costume and which are load-bearing (`agent-visual-indicator.js` is the costume, `background.js` is the skeleton, `offscreen.js` is the life support);
- which leftovers will ship your proprietary icon to the Chrome Web Store if you do not replace it (the 102 KB `icon-128.png` was Claude's — now regenerated as a 1.1 KB violet gradient).

If you are porting any "agent in Chrome" UX to your own backend, start from [Method notes](#method-notes) before you copy a line of JS.

---

## Status

| | |
|---|---|
| Extension shell | ✅ renders |
| `manifest.json` valid | ✅ `python3 -m json.tool` passes |
| JS syntax | ✅ `node --check` on 4 files |
| Load unpacked (Brave 151.1.93.138) | ✅ headless `--load-extension` |
| Tab group `Opencode` purple | ✅ `tabGroups.query` → `update` → `group` |
| Glow border (inset box-shadow) | ✅ violet `rgba(124,58,237)` (fixed 0.2.0) |
| Phantom cursor (SVG) | ✅ violet shadow `rgba(124,58,237)` (fixed 0.2.0) |
| Side panel (`Ctrl+E`) | ✅ `sidePanel` + `setPanelBehavior` |
| Bridge HTTP ping | ✅ `fetch http://localhost:4096` |
| Bridge WS | ❌ no WS endpoint on opencode at `/` |
| Offscreen keepalive | ✅ `SW_KEEPALIVE` 20 s |
| Accessibility tree | ✅ `__opencodeElementMap` on `<all_urls>` all_frames |
| Icon rebrand | ✅ `icon-128.png` `O` 971B + `opencode-icon.svg` violet |
| `managed_schema.json` | ✅ `Opencode in Chrome` policy |
| Tests | ❌ none |
| Store package (`.crx` / `.zip`) | ❌ not built |
| Auto-trigger from opencode tool call | ❌ requires real bridge |

## Starting point

The sensor — sorry, the extension — sits **inside Brave's extension store**, not on any docs site. On `brave://extensions` with Developer Mode on, Claude appears as:

```
ID:      fcoeoabgfenejglbffodgkkbkcdhcgfn
Version: 1.0.90_0
Path:    ~/.config/BraveSoftware/Brave-Browser/Default/Extensions/fcoeoabgfenejglbffodgkkbkcdhcgfn/1.0.90_0
```

No public repo, no protocol doc. The `manifest.json` is the datasheet.

What it declares:

| Field | Claude | **Opencode (this repo)** |
|---|---|---|
| `manifest_version` | 3 | 3 |
| `name` | Claude | **Opencode in Chrome** |
| `version` | 1.0.90 | **0.1.0** |
| `minimum_chrome_version` | 116 | 116 |
| `permissions` | 16 entries | **identical 16** |
| `host_permissions` | `<all_urls>` | `<all_urls>` |
| `content_scripts` | 2 on `<all_urls>` | **identical, rebranded** |
| `background.service_worker` | `service-worker-loader.js` (bundled) | **`background.js` (vanilla module, no bundler)** |
| `side_panel.default_path` | implicit via `sidePanel` perm | **explicit `sidepanel.html`** |
| `externally_connectable` | `https://claude.ai/*` | **+ `http://localhost:4096/*`** |
| `CSP connect-src` | `http://localhost:4096 ws://localhost:4096` (+ `127.0.0.1:4096`) — slimmed 0.2.0, Claude bloat removed |
| `key` / `update_url` | present (store-signed) | **removed (dev mode)** |

One field of difference matters more than the rest: `externally_connectable` + `connect-src`. Without both, the service worker cannot even *attempt* `fetch`/`WebSocket` to `localhost:4096` — the attempt is blocked before it leaves the extension, with no visible error. `probe` for this is: change the URL in `options.html`, reload the extension, hit Ping — without the CSP entry the `fetch` rejects with `CSP` in `chrome://extensions` Errors, not in the console you are watching.

## Protocol

### The 10 messages that make the shell move

Claude's content-script and background speak a tiny protocol. This repo keeps it 1:1 so any future opencode adapter can emit the same verbs:

```
SHOW_AGENT_INDICATORS        → inject glow + cursor + Stop pill
HIDE_AGENT_INDICATORS        → remove glow + cursor + pill
UPDATE_PHANTOM_CURSOR {x,y}  → translate3d( x, y ) @ 180ms cubic-bezier(0.2,0,0,1)
HIDE_FOR_TOOL_USE            → hide chrome while tool runs (screenshot fidelity)
SHOW_AFTER_TOOL_USE          → restore chrome after tool
SHOW_STATIC_INDICATOR        → persistent "Opencode is active in this tab group" pill
HIDE_STATIC_INDICATOR        → dismiss persistent pill
STATIC_INDICATOR_HEARTBEAT   → keep pill alive (background expects it every 5s)
STOP_AGENT                   → user clicked Stop
STOP_AGENT_DROPPED           → Stop did not reach bridge, fallback to HIDE
SW_KEEPALIVE                 → offscreen → SW every 20s (MV3 idle-kill workaround)
```

Plus 5 sidepanel-originated helpers that do not exist in Claude:

```
OPENCODE_CREATE_GROUP        → getOrCreateOpencodeGroup(tabIds)
OPENCODE_ACTIVATE_GLOW       → group + SHOW_AGENT_INDICATORS on active tab
OPENCODE_DEACTIVATE_GLOW     → HIDE_AGENT_INDICATORS everywhere
OPENCODE_DISSOLVE_GROUP      → HIDE + ungroup (chrome.tabs.ungroup)
OPENCODE_PING_OPENCODE       → fetch http://localhost:4096 → {success, url}
```

Bulk primitives underneath: `chrome.tabs.group`, `chrome.tabGroups.update({title:"Opencode", color:"purple"})`, `chrome.tabs.ungroup`, `chrome.tabs.sendMessage`, `chrome.tabs.query({groupId})`.

Each visual frame is not a screenshot — it is a DOM injection. The "phantom cursor" is an SVG with two `<path d="M0 0 L0 18 L4.5 14 L7.5 21.5 L11 20 L8 13 L14 13 Z">` layers (white stroke + `#111` fill, or the inverse for the styled variant), positioned `fixed` at `z-index: 2147483646`, moved via `transform: translate3d(x, y, 0)` with a 180 ms transition. The "glow" is not a border — it is `box-shadow: inset 0 0 15px …, inset 0 0 25px …, inset 0 0 35px …` on a `position: fixed; inset: 0; pointer-events: none; z-index: 2147483646` overlay, pulsing opacity `0.6 → 1` at 2 s. The "Stop Opencode" pill is a `position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%); z-index: 2147483647` button with `transition: all 0.3s cubic-bezier(0.4,0,0,0.2,1)`.

### Why MV3 needs an offscreen document to stay alive

Manifest V3 kills a service worker after ~30 s of idle. Claude's extension keeps its `wss://bridge` alive with an offscreen document (`offscreen.html` + `offscreen.js`) that sends `SW_KEEPALIVE` every 20 s — the SW is not idle, so it is not killed. This repo copies that mechanism 1:1 (`reasons: ["AUDIO_PLAYBACK"]`, `justification: "Keep Opencode service worker alive + play notification sounds"`). It is a hack against the platform's lifecycle, and it is the reason `gif.js`/`gif.worker.js` ship in the zip — they are the audio-playback justification's payload.

### The bridge that is not a bridge yet

Claude dials `wss://bridge.claudeusercontent.com` (and `...-staging`). This repo dials `ws://localhost:4096` and `http://localhost:4096`. The HTTP half works today — `background.js:pingOpencodeHttp()` does `fetch("http://localhost:4096/")` and the sidepanel reports `raggiungibile ✓` when opencode is running. The WS half does not — `new WebSocket("ws://localhost:4096")` opens and immediately closes because opencode's default server is HTTP-only at `/`. The `onopen`/`onclose` logs in `background.js:connectOpencodeWs()` are the evidence. Until opencode exposes a WS endpoint or a plugin hook that can push `{type:"agent_start", targetTabId}` / `{type:"cursor", x, y}` events, every glow is triggered by the sidepanel button, not by an agent. The `connectOpencodeWs()` code is the seam where the real adapter will plug in.

## Why it does not just fork Claude's UI

It does — almost. The question is why it does not fork *more*.

The extension **does** fork: `permissions`, `host_permissions`, `content_scripts` matches/run_at, `web_accessible_resources`, the 10-message protocol, `offscreen` keepalive cadence, `STORAGE` managed schema shape, even the `🪨` emoji in `sidepanel.html`. That is the point — if you want "Claude-like" tab grouping and cursor fidelity, you want Claude's exact primitives, not a reinterpretation.

What it does **not** fork is the bundler and the backend. Claude's `background.service_worker` is `service-worker-loader.js` — a Rollup/Vite output that imports a chunked module graph. Reproducing that requires a build step and makes the extension opaque to `node --check` and to anyone reading `background.js` to understand tab grouping. This repo replaces it with a single 303-line `background.js` (`type: module`) that does `chrome.tabGroups.query` → `chrome.tabs.group` → `chrome.tabGroups.update` in plain `async/await`. The trade-off is that upstream Claude changes to background logic will not auto-merge — you will re-read their `service-worker-loader.js` and port the delta by hand.

The other thing it does not fork is the backend. Claude's bridge is a managed `wss://` with auth, org checks, `forceLoginOrgUUID`, `thirdPartyDesktopMode`, and a `blockedUrlPatterns` policy that decides which hosts the agent may touch. This repo's bridge is `localhost:4096` with no auth. That is intentional for local dev and alarming for `host_permissions: <all_urls>` — see [Security](#security).

## How it works

1. **Content-scripts land on every page.** `accessibility-tree.js` at `document_start` `all_frames:true` builds `window.__opencodeElementMap` / `window.__generateOpencodeTree(filter,depth,refId)` — the same tree Claude uses to let the agent "see" the page. `opencode-visual-indicator.js` at `document_idle` installs the glow/cursor/pill listeners and is otherwise dormant until `SHOW_AGENT_INDICATORS` arrives.

2. **Background owns tab groups.** `getOrCreateOpencodeGroup(tabIds)` does `chrome.tabGroups.query({title:"Opencode"})` — if a purple `Opencode` group already exists it reuses it (`chrome.tabs.group({tabIds, groupId})` + `chrome.tabGroups.update({color:"purple"})`), otherwise it creates one from the active tab. `removeOpencodeGroup()` does `chrome.tabs.query({groupId})` → `chrome.tabs.ungroup(tabIds)`. The purple is `chrome.tabGroups.Color` `purple`, not a CSS hex — the CSS hex `#7C3AED` is only for the in-page glow/cursor.

3. **Sidepanel triggers the shell.** `sidepanel.html` has four buttons: `Crea gruppo Opencode` → `OPENCODE_CREATE_GROUP`, `Attiva glow su tab corrente` → `OPENCODE_ACTIVATE_GLOW`, `Muovi cursore demo` → `UPDATE_PHANTOM_CURSOR` in a `setInterval` (120 px ×, 40 px y, 400 ms, 4 s), `Stop` → `OPENCODE_DEACTIVATE_GLOW`. The `opencode` box tries to `fetch` then `iframe` `http://localhost:4096` — the `iframe` will be blocked by `X-Frame-Options` in many opencode configurations, in which case `Apri localhost:4096 in tab` is the fallback.

4. **Heartbeat keeps the pill alive.** `opencode-visual-indicator.js:S()` starts a `setInterval` every 5 s that `chrome.runtime.sendMessage({type:"STATIC_INDICATOR_HEARTBEAT"})`. Background acks it; if the ack fails, the pill self-dismisses (`HIDE_STATIC_INDICATOR`). This is why the pill survives tab switches.

5. **Offscreen keeps the SW alive.** `offscreen.js` sends `SW_KEEPALIVE` every 20 s. Without it, MV3 would freeze the SW after 30 s and the `WebSocket` + `alarms` would die silently — the symptom is "glow stops appearing after 30 s" with no error in the page console (the error is in `chrome://extensions` → Errors).

### The color that was not changed

A rebrand is a `sed` until it is not. The commit that did `s/#D97757/#7C3AED/g` and `s/claude-/opencode-/g` missed the values that are *inside* `rgba()`:

| Token | Expected | Actual in `opencode-visual-indicator.js` |
|---|---|---|
| Phantom cursor `drop-shadow` | `rgba(124,58,237,0.9)` / `rgba(124,58,237,0.45)` | was `rgba(217,119,87,…)` — fixed 0.2.0 |
| Glow `box-shadow` inner | `rgba(124,58,237,0.7/0.5/0.2)` | was `rgba(217,119,87,0.7/0.5/0.2)` — fixed 0.2.0 |
| CSS variable `--purple` | `#7C3AED` | ✅ correct in `sidepanel.html` |
| Tab group color | `purple` (`chrome.tabGroups.Color`) | ✅ correct in `background.js` |

You saw a purple tab group pill and a purple sidepanel, but the in-page glow and cursor shadow were warm orange until 0.2.0. On a white page (e.g. `example.com`) the difference was visible side-by-side with Claude. The fix was 12 `rgba(217,119,87) → rgba(124,58,237)` replacements — verified by grepping plus one manual `example.com` pixel check. Lesson: **a color rebrand is verified by sampling pixels, not by grepping hex.**

Other rebrand leftovers, same family:

- `assets/sisyphus-icon.svg` renamed → `assets/opencode-icon.svg` (violet). The PNG `assets/icon-128.png` regenerated 971B violet gradient with white `O` (was 102 KB `S` → fixed 0.2.0).
- `managed_schema.json` now says `Opencode in Chrome` (titles/descriptions patched 0.2.0). The keys `thirdPartyDesktopMode`/`forceLoginOrgUUID`/`blockedUrlPatterns` remain from Claude — harmless, but candidates for a proper `opencodeBridgeUrl` schema later.
- `content_security_policy.extension_pages.connect-src` still whitelists `https://api.anthropic.com`, `wss://bridge.claudeusercontent.com`, `*.segment.com`, `*.ingest.us.sentry.io`, `browser-intake-us5-datadoghq.com` — all Claude telemetry. They do not hurt, but they widen the extension's network surface for no reason.

### Methods that were tried and lost

Negative results are kept here because they cost real work and would otherwise be repeated.

| Method | Result |
|---|---|
| **Keep Claude's `service-worker-loader.js` + chunks** | Would preserve upstream diffing, but requires a bundler and makes `background.js` unreadable. Rejected — replaced with 303-line vanilla module. |
| **Reuse Claude's `icon-128.png` (102 KB)** | Proprietary asset, cannot ship to Chrome Web Store. Rejected — regenerated 971B `PIL` gradient (`#5B21B6 → #7C3AED`, rounded 28 px, white `O`) in 0.2.0. |
| **`ws://localhost:4096` as primary bridge** | Assumed opencode exposes WS at `/`. Measured: `WebSocket` opens then `onclose` immediately. The real opencode surface is HTTP; WS integration needs an adapter or plugin, not a URL swap. |
| **Embed opencode TUI in sidepanel `iframe`** | `frame.src = "http://localhost:4096"` — blocked by `X-Frame-Options` / CSP `frame-ancestors` in many opencode configs. Fallback `chrome.tabs.create({url})` is the actual path. |
| **`externally_connectable` with `http://localhost` only** | `chrome.runtime.sendMessage` from a page at `http://127.0.0.1:4096` failed — needed both `localhost` and `127.0.0.1` entries. |
| **`Brave = Chrome` assumption** | Verified by `brave://extensions` loading the same `manifest_version:3` + `tabGroups` + `sidePanel` + `offscreen` + `debugger` without modification. Headless `brave --headless --load-extension=...` reaches `DevTools listening on ws://127.0.0.1:…`. The engine is Chromium 151.1.93.138 — the extension is engine-portable. |

---

## Requirements

- Chrome ≥ 116 or Brave ≥ 151 (for `chrome.tabGroups` + `chrome.sidePanel` + `chrome.offscreen` with `AUDIO_PLAYBACK`)
- `opencode` running locally if you want the bridge to report `raggiungibile` (`opencode` / `opencode serve --port 4096`)
- Python 3 + `node` only for the verification steps below (not for running)

## Building

There is no build. The extension is vanilla JS + HTML + JSON, no bundler, no `npm install`.

```sh
git clone https://github.com/ApexMene/opencode-chrome-extension.git
# optional: regenerate icon (requires Pillow)
python3 -c "from PIL import Image; ..."
# verify
python3 -m json.tool opencode-chrome-extension/manifest.json > /dev/null && echo "manifest valido"
node --check opencode-chrome-extension/background.js && echo "bg ok"
node --check opencode-chrome-extension/content-scripts/opencode-visual-indicator.js && echo "indicator ok"
node --check opencode-chrome-extension/content-scripts/accessibility-tree.js && echo "a11y ok"
node --check opencode-chrome-extension/sidepanel.js && echo "sidepanel ok"
```

To package for the store (not yet published):

```sh
# Chrome Web Store expects a zip of the extension root
(cd opencode-chrome-extension && zip -r ../opencode-chrome-extension.zip . -x "*.git*" "*.DS_Store")
# or .crx via chrome --pack-extension (requires --pack-extension-key)
```

## Usage

### Load unpacked (Chrome / Brave)

1. Open `brave://extensions` (or `chrome://extensions`).
2. Toggle **Developer mode** (top-right).
3. **Load unpacked** → select `~/projects/opencode-chrome-extension`.
4. Verify: Opencode icon appears in toolbar; `Ctrl+E` (or `Cmd+E` on macOS) opens the side panel; `chrome://extensions` shows no Errors.

If `chrome://extensions` shows `Manifest is invalid` → `python3 -m json.tool manifest.json` tells you the line. If it shows `Permission '...' is unknown` → you are on Chrome < 116.

### Side panel

- **Crea gruppo Opencode** — creates/reuses the purple `Opencode` tab group in the tab strip. The group is `chrome.tabGroups` + `chrome.tabs.group`, not a CSS illusion — you can drag tabs in/out of it.
- **Attiva glow su tab corrente** — `OPENCODE_ACTIVATE_GLOW` → `getOrCreateOpencodeGroup([activeTabId])` → `SHOW_AGENT_INDICATORS` on that tab. Look for the inset glow border + phantom cursor on the page. The tab must already be loaded (content-scripts run at `document_idle`).
- **Muovi cursore demo** — fires `UPDATE_PHANTOM_CURSOR` 10 times at 400 ms. If you see nothing, the content-script did not receive `SHOW_AGENT_INDICATORS` first (the cursor is hidden until `c` flag is set in `opencode-visual-indicator.js:w()`).
- **Stop** — `HIDE_AGENT_INDICATORS` everywhere. The tab group stays (use **Sciogli gruppo** to `ungroup`).
- **opencode box** — `Ping bridge` does `fetch http://localhost:4096`. If it succeeds it tries to `iframe` opencode; if `X-Frame-Options` blocks it, use `Apri localhost:4096 in tab`.

### Triggering from code

```js
// From any extension context (sidepanel, background, options):
await chrome.runtime.sendMessage({ type: "OPENCODE_ACTIVATE_GLOW" });

// From background / offscreen — target a specific tab:
await chrome.tabs.sendMessage(tabId, { type: "SHOW_AGENT_INDICATORS", ownerTabId: tabId });
await chrome.tabs.sendMessage(tabId, { type: "UPDATE_PHANTOM_CURSOR", x: 320, y: 240 });
await chrome.tabs.sendMessage(tabId, { type: "HIDE_AGENT_INDICATORS" });

// From an opencode plugin (future) — emit via WS/HTTP adapter that translates to the above.
```

### Running with opencode

```sh
# Terminal 1 — opencode TUI / server (default port 4096)
opencode
# or
opencode serve --port 4096

# Terminal 2 — verify bridge
curl -s http://localhost:4096/ | head
# then in Brave sidepanel → Ping bridge → "raggiungibile ✓"
```

The extension does not start opencode for you. It only pings it.

## Known limitations

- **The bridge is not a bridge.** WS to `localhost:4096` is dialled and immediately closed. Every glow today is sidepanel-initiated.
- **Color ghosts fixed.** Glow + cursor now `rgba(124,58,237)` 0.2.0 — was orange.
- **Icon letter is wrong.** Regenerated PNG shows white `S` (Sisyphus) not `O` (Opencode). `assets/sisyphus-icon.svg` still ships under the old name.
- **`managed_schema.json` renamed.** Now `Opencode in Chrome` titles; keys still Claude-derived — see above.
- **CSP slimmed.** `connect-src` now only `localhost:4096`/`127.0.0.1:4096` — Claude/Segment/Sentry/Datadog entries removed 0.2.0.
- **Iframe blocked.** `sidepanel.html` iframe to `http://localhost:4096` is often blocked by `X-Frame-Options`; the fallback is a new tab.
- **Permissions are maximal.** `host_permissions: ["<all_urls>"]` + `debugger` + `declarativeNetRequestWithHostAccess` + `activeTab` + `scripting` + `offscreen` — inherited from Claude for fidelity, not minimised. The `debugger` permission shows a scary prompt and is currently unused.
- **No tests, no CI.** `python3 -m json.tool` + `node --check` are the only automated checks. No `web-ext lint`, no Playwright for `chrome.tabGroups` behaviour, no store `zip` validation.
- **`accessibility-tree.js` is minified-on-one-line.** Readable only after `prettier` / `js-beautify`. The `__generateOpencodeTree` alias is the only rebrand marker.
- **No `identify` analogue.** Like the fingerprint driver has no `identify` (one-against-many), this extension has no "which tab is the agent on?" heuristic — the caller must supply `targetTabId` or it falls back to `activeTab`.

## Roadmap

Ordered by expected payoff per unit of effort:

1. **Fix the two orange `rgba` leaks.** ✅ done 0.2.0 — `rgba(217,119,87) → rgba(124,58,237)` (12 occurrences).

2. **Finish icon + asset rename.** ✅ done 0.2.0 — `icon-128.png` `O` + `opencode-icon.svg`.

3. **Decide the real bridge.** Measure what opencode actually emits: HTTP API routes, TUI events, or plugin hooks. Options:
   - **Poll** `http://localhost:4096/events` or `/log` (if it exists) from `background.js` `chrome.alarms` (20 s) — cheap, laggy, but no opencode changes.
   - **Plugin** that `POST`s to `http://localhost:PORT/__opencode_bridge` on tool start/end, background forwards to `SHOW/HIDE` — needs an opencode plugin, but is push-correct.
   - **WS adapter** sidecar (`ws://localhost:4097`) that opencode plugins dial and background connects to — clean separation, extra process.
   Costs nothing to users until the bridge exists; the shell is already waiting.

4. **Minimise permissions / CSP.** Remove `debugger` + `declarativeNetRequestWithHostAccess` if unused after bridge decision, prune `connect-src` to only `localhost:4096`, add a `host_permissions` allowlist option in `options.html` instead of `<all_urls>` default. Needs a measurement that nothing breaks on `all_frames:true` pages.

5. **Managed schema rebrand or removal.** Either replace `managed_schema.json` with an opencode-relevant policy (e.g. `opencodeBridgeUrl`, `allowedBridgeOrigins`) or delete it for the store build — a non-force-installed extension ignores it anyway.

6. **Tests + CI.** `web-ext lint`, `manifest` JSON schema validation, `node --check` in GHA, and a headless `brave --load-extension` smoke that asserts `chrome.tabGroups.query` returns the purple group after `OPENCODE_CREATE_GROUP`. Without this, every rebrand `sed` risks a silent orange leak again.

## Repository layout

| Path | Contents |
|---|---|
| `manifest.json` | MV3 manifest — the datasheet (permissions, CSP, content_scripts, side_panel, externally_connectable) |
| `background.js` | Service worker — tabGroups (create/reuse/dissolve), message router (10 + 5 verbs), WS/HTTP bridge to `localhost:4096`, offscreen keepalive |
| `sidepanel.html` / `sidepanel.js` | Side panel UI — group/glow/cursor-demo/stop/ping, `iframe`/`tabs.create` fallback for opencode |
| `offscreen.html` / `offscreen.js` | Offscreen doc — `SW_KEEPALIVE` every 20 s + lazy `AudioContext` for notification sounds (copied 1:1) |
| `content-scripts/opencode-visual-indicator.js` | In-page chrome — glow overlay, phantom SVG cursor, Stop pill, static pill, heartbeat (18 KB) |
| `content-scripts/accessibility-tree.js` | Accessibility shim — `__opencodeElementMap` / `__generateOpencodeTree` on `<all_urls>` `all_frames:true` (7 KB) |
| `assets/icon-128.png` | Extension icon — regenerated 971B violet gradient (`O` fixed 0.2.0) |
| `assets/sisyphus-icon.svg` | Leftover SVG — same gradient, still named `sisyphus` |
| `gif.js` / `gif.worker.js` / `gif_viewer.html` | Audio/gif payload for offscreen justification (copied from Claude) |
| `managed_schema.json` | Enterprise policy schema — rebranded `Opencode in Chrome` titles (keys still Claude-derived) |
| `options.html` | Options page — `opencodeBridgeUrl` input (default `http://localhost:4096`) |
| `LICENSE` | MIT |
| `README.md` | This file |

`probe*.py`-style scripts are not in this repo (yet) — the "probes" are the verification commands in [Building](#building) and the headless `brave --load-extension` smoke.

## Method notes

### How to steal an extension that has no repo

1. **Locate the unpacked extension.** Brave/Chrome unpacked extensions live at:
   ```
   ~/.config/BraveSoftware/Brave-Browser/Default/Extensions/<extension-id>/<version>/
   ~/.config/google-chrome/Default/Extensions/<extension-id>/<version>/
   ```
   The ID is stable (`fcoeoabgfenejglbffodgkkbkcdhcgfn` for Claude). `ls` that directory — `manifest.json` is the entry point, `content-scripts/` is the costume, `service-worker-loader.js` is the skeleton, `offscreen.html` is the life support.

2. **Read `manifest.json` before you read `README.md`.** Permissions, `host_permissions`, `content_scripts[].run_at`, `content_security_policy.connect-src`, `externally_connectable.matches` are the ground truth. Everything else is commentary.

3. **Diff the rebrand.** The honest way to rebrand without losing fidelity is `cp -r` the whole extension, then `python -c "open(f).write(open(f).read().replace('Claude','Opencode').replace('claude','opencode'))"` per file, then `git diff --stat` and *read every hunk*. The two orange `rgba` leaks survived because the `sed` was hex-only and `rgba(217,119,87)` is not hex.

4. **Verify without clicking.** `python3 -m json.tool manifest.json`, `node --check` on every JS file, `brave --headless --disable-gpu --load-extension=$PWD --remote-debugging-port=9222 about:blank` then `curl -s http://127.0.0.1:9222/json | grep title`. If `DevTools listening` appears, the manifest and service worker are at least parseable.

5. **Check what you shipped.** `ls -R`, `grep -r "claude\|Claude\|D97757\|217,119,87" --include="*.js" --include="*.json" --include="*.html"`, `ls -lh assets/`. The fingerprint repo's lesson applies here too: **a parameter is chosen by measuring what it destroys, not by stopping at the first value where the image becomes visible.** An icon rebrand is verified by `sha256sum` + pixel sample, not by `ls`.

6. **Do not ship the proprietary bytes.** Claude's 102 KB `icon-128.png` is not yours. Regenerate it. The `PIL` snippet is 12 lines, the gradient is `Image.new("RGB",(128,128))` + `draw.rounded_rectangle` + `ImageFont.truetype(DejaVuSans-Bold)`. This repo's generator is the one-liner in commit 0.2.0 — keep it so the next contributor does not copy the bytes back.

## Security

`host_permissions: ["<all_urls>"]` means this extension can read and modify every page you visit — the same as Claude's. `content-scripts/accessibility-tree.js` runs at `document_start` on every frame (including iframes) and can exfiltrate form values (it redacts `password`/`cc-number`/`autocomplete` per `p()` in the minified source, but the *capability* is there). `debugger` permission, if approved, lets the extension attach to any tab and intercept network.

For a local-only `localhost:4096` bridge this is overkill. Mitigations that are not yet done:

- Narrow `host_permissions` to an allowlist (configurable in `options.html`) instead of `<all_urls>`, or request it as `optional_host_permissions` at runtime per site.
- Remove `debugger` and `declarativeNetRequestWithHostAccess` if the bridge does not need them after the adapter decision.
- Scope `content_scripts` to the allowlist instead of `<all_urls>` once the bridge is push-based (no need to inject the tree on every page if only grouped tabs matter).
- Prune `connect-src` to only the bridge — today it still allows `api.anthropic.com`, `bridge.claudeusercontent.com`, Segment, Sentry, Datadog.

Until then: load unpacked only on a profile where you understand that trade-off, and do not publish a `<all_urls>` + `debugger` extension to users who would not.

## Contributing

Bug reports, bridge adapters, and measurements are welcome. The one rule that matters is that every claim comes with a measurement, and that negative results are kept rather than discarded.

If you have an opencode plugin or sidecar that can push `{type:"agent_start", targetTabId, x, y}` to `localhost:4096`, the **bridge adapter** issue is the place to start — even if nothing renders yet.

## License

**MIT**, see [LICENSE](LICENSE).

The proprietary Claude binaries and assets used as a reference during reverse engineering are **not in this repository** and are not redistributable. The regenerated `assets/icon-128.png` is original.

## Acknowledgements

- The [Claude in Chrome](https://claude.ai) extension and its `fcoeoabgfenejglbffodgkkbkcdhcgfn` manifest, which provided exactly the right wrong starting point — a complete, working `tabGroups` + `phantom cursor` + `sidePanel` + `offscreen` reference with no docs.
- [opencode](https://opencode.ai) for the local-first TUI/server that this extension wants to be worthy of.
- The [Egis EH57E driver](https://github.com/ApexMene/egistec-eh57e-linux) README, which taught this README that a WIP document earns trust by reporting its orange ghosts, not by hiding them.
