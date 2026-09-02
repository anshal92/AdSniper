# AdSniper — Architecture & Knowledge Base

> **Version**: 2.0 | **Platform**: Chrome Extension (Manifest V3) | **Location**: `TestProject/adsniper/`

---

## 1. Summary

AdSniper is a Chrome extension built to give users surgical control over network requests and cookies. It has two tabs in its popup:

| Tab | Purpose |
|---|---|
| 🛡 **Ad Blocker** | Live network request monitor, pattern-based blocking, mass-block all known ads, new-tab ad blocking, DOM cleanup, element picker, iframe remover |
| 🍪 **Cookie Editor** | View, edit, lock (prevent page from changing), and delete cookies for the current tab |

It uses **Manifest V3** exclusively. Blocking is done via `declarativeNetRequest` (DNR), not `webRequest` intercept. The DOM is manipulated via an injected content script. The service worker is deliberately slim — all UI logic lives in `popup.js`.

---

## 2. Architecture

### High-Level Component Map

```
┌─────────────────────────────────────────────────────────────────┐
│                        CHROME BROWSER                           │
│                                                                 │
│  ┌──────────────┐    ┌──────────────────────────────────────┐   │
│  │   POPUP UI   │    │           SERVICE WORKER             │   │
│  │  popup.html  │    │         service-worker.js            │   │
│  │  popup.js    │    │                                      │   │
│  │              │    │  1. webRequest logger (per-tab log)  │   │
│  │  calls       │    │  2. Tab cleanup (onRemoved)          │   │
│  │  chrome.* ───┼────┼→  3. Block-count + DOM cleanup msg  │   │
│  │  APIs        │    │  4. Cookie lock enforcer             │   │
│  │  directly    │    │  5. ADD_BLOCK_RULE msg handler       │   │
│  │              │    │  6. onInstalled → fetch ad patterns  │   │
│  └──────┬───────┘    └──────────────────────────────────────┘   │
│         │                                                        │
│         │ chrome.tabs.sendMessage                               │
│         ↓                                                        │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │              CONTENT SCRIPT (per-tab)                    │   │
│  │                  content/content.js                      │   │
│  │                                                          │   │
│  │  • Hides elements matching blocked URLs (display:none)   │   │
│  │  • Element Picker: overlay + hover + click-to-block      │   │
│  │  • iFrame Ad Blocker: fully removes() ad iframes         │   │
│  │  • MutationObserver: catches dynamically injected ads    │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
│  ┌──────────────────────────────┐  ┌────────────────────────┐  │
│  │   declarativeNetRequest      │  │   chrome.storage.local │  │
│  │   DNR Engine                 │  │   (all persistent state│  │
│  │                              │  │    lives here)         │  │
│  │   Static: rules/rules.json   │  │                        │  │
│  │   Dynamic user rules 1001+   │  │   See Storage Keys     │  │
│  │   Dynamic newtab-block 40001+│  │   section below        │  │
│  │   Dynamic mass-block 50001+  │  │                        │  │
│  └──────────────────────────────┘  └────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### Request Lifecycle

```
Network request →
  webRequest.onBeforeRequest (SW) → logs to requests_{tabId}
  DNR Engine checks rules →
    BLOCKED →
      onRuleMatchedDebug (SW) →
        Increments blockCount_{ruleId}
        Sends REMOVE_AD_ELEMENT to content script →
          Content script: findByUrl() → bestContainer() → applyHide() [display:none]
```

### Element Picker Flow

```
"🎯 Pick Element" clicked in popup →
  sendMessage(tabId, START_ELEMENT_PICKER) →
  window.close()  ← popup closes so user can interact
  content.js: startElementPicker() →
    overlay (z-index 2147483646) captures mouse events
    hover → red highlight box + tooltip
    click → findNearestAdUrl() walks ≤8 ancestors
           → bestContainer() finds ad-named ancestor
           → applyHide(container)
           → sendMessage(SW, ADD_BLOCK_RULE { pattern: "||hostname" })
    Escape → cancel
```

### iFrame Blocker Flow

```
"Block iFrame Ads" toggled ON →
  storage: iframeBlockerEnabled = true
  sendMessage(tabId, TOGGLE_IFRAME_BLOCKER) →
  scanAndRemoveAdIframes():
    For each <iframe>: isAdIframe() checks:
      1. src vs ad hosts/patterns
      2. id/class vs AD_CONTAINER_RE
      3. 0×0 or 1×1 pixel tracker
      4. BoundingRect ≤ 1px
      5. Hardcoded patterns (safeframe, googlesyndication, etc.)
    → iframe.remove()  [fully deleted from DOM]
  MutationObserver watches for dynamically injected iframes going forward
```

---

## 3. Code Locations

### File Tree

```
adsniper/
├── manifest.json              Extension config, permissions, DNR ruleset, web_accessible_resources
├── service-worker.js          Background SW (7 responsibilities)
├── content/
│   ├── content.js             Injected into every http/https page
│   └── sniper-game.js         Sniping game engine (loaded on-demand via web_accessible_resources)
├── popup/
│   ├── popup.html             Two-tab dark-theme UI + Sniping ON button
│   └── popup.js               All popup logic, direct chrome.* API calls
├── data/
│   └── ad-patterns.json       Fallback: 64 ad hosts + 30 URL patterns
└── rules/
    └── rules.json             Empty static DNR ruleset (required by manifest)
```

### service-worker.js

| Responsibility | API Used |
|---|---|
| 1. webRequest logger | `webRequest.onBeforeRequest` → `storage.local` |
| 2. Tab cleanup | `tabs.onRemoved` → `storage.local.remove` |
| 3. Block-count + DOM msg | `declarativeNetRequest.onRuleMatchedDebug` → `tabs.sendMessage` |
| 4. Cookie lock enforce | `cookies.onChanged` → `cookies.set` |
| 5. ADD_BLOCK_RULE handler | `runtime.onMessage` → `declarativeNetRequest.updateDynamicRules` |
| 6. RESTORE_SNIPING_STATE handler | `runtime.onMessage` → re-enables DNR rules + storage flags from saved state |
| 7. Install hook | `runtime.onInstalled` → fetch pgl.yoyo.org → fallback JSON |

### popup.js — Key Functions

| Function | What it does |
|---|---|
| `initMonitoringToggle()` | Reads/writes `monitoringEnabled` |
| `refreshAdBlocker()` | Loads requests + rules + blockCounts in one pass |
| `isAdRequest(url)` | Client-side ad detection for 🎯 flag highlighting |
| `buildRequestRow(req)` | Creates one request row with type badge + Block button |
| `openBlockForm(row, url)` | Inline editable pattern form, pre-fills `\|\|hostname` |
| `commitBlock(pattern)` | Adds DNR dynamic rule, increments `nextRuleId` |
| `renderRules(rules, blockCounts)` | Blocked rules list with hit counter + Remove |
| `syncBadge()` | Updates toolbar badge (red, shows rule count) |
| `toggleMassBlock()` | On: creates DNR rules for all ad hosts+patterns; Off: removes them all |
| `updateMassBlockButton()` | Syncs button style from storage |
| `toggleNewTabBlock()` | On: creates DNR rules (main_frame only) for ad hosts; Off: removes them. IDs 40001–49999 |
| `updateNewTabBlockButton()` | Syncs new-tab-block button style from storage |
| `initDomCleanupToggle()` | Reads/writes `domCleanupEnabled`, messages content script |
| `handleCleanPage()` | Sends CLEAN_PAGE to content script |
| `handleElementPicker()` | Sends START_ELEMENT_PICKER, closes popup |
| `initIframeBlockerToggle()` | Reads/writes `iframeBlockerEnabled`, messages content script |
| `handleSnipingGame()` | Saves state, disables blocking, reloads tab or opens new tab, sets `snipingGamePending` |
| `refreshCookies()` | Calls `chrome.cookies.getAll`, renders with lock/delete |
| `isCookieAccessibleUrl(url)` | Guards against chrome:// / PDF pages |
| `toggleCookieLock(cookie)` | Writes/removes from `lockedCookies` in storage |

### content.js — Key Functions

| Function | What it does |
|---|---|
| `hideByUrl(url)` | Reactive hide triggered per blocked URL |
| `scanAndHide()` | Full DOM scan against blockedHosts + blockedPatterns |
| `bestContainer(el)` | Walks ≤6 DOM levels for ad-named ancestor to hide |
| `applyHide(el)` | `display:none !important` + `data-adsniper-hidden` attr |
| `startElementPicker()` | Full overlay picker (see flow above) |
| `findNearestAdUrl(el)` | Walks ≤8 ancestors, prefers known-ad URLs |
| `isAdIframe(iframe)` | 5-check heuristic for ad iframes |
| `scanAndRemoveAdIframes()` | Snapshots + `iframe.remove()` on matches |
| `processNewNode(node)` | MutationObserver callback for new DOM nodes |
| `launchSnipingGame()` | Dynamically loads sniper-game.js, calls `AdSniperGame.launchGame()` |

### sniper-game.js — Key Systems

| System | What it does |
|---|---|
| `AdScanner.scanForAds()` | Walks DOM for ad elements (iframes, divs, imgs with ad class/id/src) |
| `BirdFactory.createBirds()` | Converts ad data to bird sprites with inverse-proportional sizing |
| `PhysicsEngine.updateBirds()` | Dual-component zigzag flight: `y = A₁·sin(ω₁·t) + A₂·sin(ω₂·t)` |
| `GameRenderer` | Canvas rendering: birds (with wing flap), crosshair, HUD, particles |
| `ScoreManager` | Points (10–100 based on size), combo multiplier (×1–×5) |
| `ParticleSystem` | Explosion particles + floating score text on bird hit |
| `GameLoop` | `requestAnimationFrame` loop with LOADING → PLAYING → GAME_OVER states |

---

## 4. Points to Remember

### DNR Rule ID Ranges
```
1     –  1000   Chrome internal (never use)
1001  – 39999   User-added rules (inline Block form, element picker)
40001 – 49999   New-tab-block rules (main_frame only, ad host navigations)
50001+           Mass-block rules (ad hosts + URL patterns)
```

### Storage Keys
```
requests_{tabId}       Array<{url, type, timestamp}>, max 200, newest-first
nextRuleId             Integer, starts at 1001, increments per user rule added
monitoringEnabled      Boolean, default true
adHosts                String[] hostnames (fetched from internet or fallback JSON)
adPatterns             String[] URL substring patterns
adPatternsUpdated      Timestamp of last fetch
massBlockActive        Boolean
massBlockRuleIds       Integer[] of DNR IDs (50001+)
newTabBlockActive      Boolean
newTabBlockRuleIds     Integer[] of DNR IDs (40001–49999)
blockCount_{ruleId}    Integer hit count, cleaned up on rule removal
lockedCookies          Object: "domain::name" → full cookie object snapshot
domCleanupEnabled      Boolean, default true
iframeBlockerEnabled   Boolean, default false
snipingGamePending     Boolean, true while waiting for page reload + game launch
snipingPreGameState    Object: snapshot of all toggle states before game started
snipingOpenNewTab      Boolean, whether to open new tab vs reload for game
```

### Critical Constraints

1. **webRequest in MV3 is observe-only** — cannot block via webRequest. All blocking via `declarativeNetRequest.updateDynamicRules()`.

2. **Content scripts cannot call `chrome.declarativeNetRequest`** — route through SW via `runtime.sendMessage({ type: 'ADD_BLOCK_RULE' })`.

3. **`chrome.cookies` is undefined (not just restricted) on `chrome://`, `about:`, `data:`, `chrome-extension://` pages** — always call `isCookieAccessibleUrl(url)` before any cookies API call.

4. **Service worker has no persistent memory** — it can be killed between events. All state must live in `chrome.storage.local`.

5. **`onRuleMatchedDebug` is dev-mode only** — only fires for unpacked extensions with `declarativeNetRequestFeedback` permission. Block counts and reactive DOM cleanup do not work in signed/production CRX.

6. **Cookie lock loop prevention** — `cookies.onChanged` checks `cookie.value === locked.value` before restoring. Our own `chrome.cookies.set` fires `onChanged` but the value already matches, so it returns immediately.

7. **DOM hide vs delete** — DOM Cleanup and element picker use `display:none` (reversible on reload). iFrame Blocker uses `iframe.remove()` (permanent for that page session).

8. **Auto-refresh pauses during editing** — `editingActive = true` while the inline block-form is open. Prevents the form from being replaced by a refresh.

9. **Ad pattern fetch on install only** — `fetchAndStoreAdPatterns()` is called once. Primary source: Peter Lowe's list from `pgl.yoyo.org` (up to 500 hosts). Fallback: bundled `data/ad-patterns.json`.

---

## 5. AI Section — Agent Notes

### Before editing anything
1. Read the Storage Keys table — use established keys, don't duplicate.
2. Check the DNR rule ID range before creating new rule categories.
3. Understand which layer owns what: UI logic → popup.js, DOM manipulation → content.js, network/storage events → service-worker.js.

### Adding a toggle feature (standard pattern)
```
popup.html → <input type="checkbox" id="foo-toggle"> in appropriate bar
popup.js   → initFooToggle() reads storage, wires 'change' event
popup.js   → call await initFooToggle() in DOMContentLoaded
content.js → add case 'SET_FOO' in onMessage switch if content script needs it
```

### Adding a content script → SW message (e.g. for DNR access)
```
content.js        → chrome.runtime.sendMessage({ type: 'MY_TYPE', ...data })
service-worker.js → add:  if (message.type === 'MY_TYPE') { (async()=>{...})(); return true; }
                    return true is required for async sendResponse
```

### Adding a popup → content script message
```
popup.js   → chrome.tabs.sendMessage(activeTabId, { type: 'MY_TYPE', ...data })
content.js → add case 'MY_TYPE': in the onMessage switch
             always return true at end of listener for async support
```

### Adding a new DNR rule category
```
1. Pick an ID range, document it in Architecture.md and popup.js constants
2. popup.js: create rules[], call updateDynamicRules({ addRules, removeRuleIds })
3. Store IDs in a new storage key (e.g., fooBlockRuleIds)
4. On deactivate: remove from DNR + clear storage key + clean up blockCount_{id} keys
```

### What NOT to do
- Do NOT block via webRequest in MV3 — it does not work
- Do NOT call declarativeNetRequest from content.js — route via SW
- Do NOT call chrome.cookies.* without isCookieAccessibleUrl() guard
- Do NOT use global variables for persistent state in service-worker.js
- Do NOT use innerHTML with user-provided data — use textContent + createElement
- Do NOT add inline event handlers in HTML — MV3 CSP blocks them

### Complete Message Type Table

| Message Type | Direction | File handling it |
|---|---|---|
| `REMOVE_AD_ELEMENT { url }` | SW → Content | content.js |
| `APPLY_BLOCKED_PATTERNS { hosts, patterns }` | Popup → Content | content.js |
| `CLEAN_PAGE` | Popup → Content | content.js |
| `SET_DOM_CLEANUP { enabled }` | Popup → Content | content.js |
| `GET_HIDDEN_COUNT` | Popup → Content | content.js |
| `START_ELEMENT_PICKER` | Popup → Content | content.js |
| `TOGGLE_IFRAME_BLOCKER { enabled }` | Popup → Content | content.js |
| `GET_IFRAME_STATS` | Popup → Content | content.js |
| `ADD_BLOCK_RULE { pattern, url }` | Content → SW | service-worker.js |
| `RESTORE_SNIPING_STATE` | Content → SW | service-worker.js |
| `ADSNIPER_GAME_ENDED { score, birdsHit, totalBirds }` | Page Main World → Content (postMessage) | content.js |
| `START_SNIPING_GAME` | Popup → Content | content.js |
