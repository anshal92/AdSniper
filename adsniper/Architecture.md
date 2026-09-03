# AdSniper — Architecture & Knowledge Base

> **Version**: 2.1 | **Platform**: Chrome Extension (Manifest V3) | **Location**: `TestProject/adsniper/`

---

## 1. Summary

AdSniper is a privacy-first Chrome extension built to give users surgical control over network requests, intrusive popups, and cookies, while introducing gamified ad sniping and an autonomous **on-device Gemini Nano AI Assistant**.

| Tab / Subsystem | Purpose |
|---|---|
| 🛡 **Ad Blocker** | Live network request monitor, pattern-based blocking, mass-block all known ads, new-tab ad blocking, DOM cleanup, element picker, iframe remover |
| 🍪 **Cookie Editor** | View, edit, lock (prevent page from changing), and delete cookies for the current tab |
| 🤖 **Gemini Nano AI** | On-device Built-in AI (Chrome Prompt API) running 100% locally; natural language ad control, forensic tracker audits, overlay & paywall removal, and autonomous MCP tools |
| 🔫 **Sniping Mode** | Interactive Canvas game that temporarily pauses blocking, scans page ads, and converts them into flying bird targets |

It uses **Manifest V3** exclusively. Network blocking is performed natively by Chrome's `declarativeNetRequest` (DNR) engine, not `webRequest` blocking. The DOM is manipulated via an isolated content script. The AI assistant runs directly in the browser's GPU/VRAM via Chrome's Built-in AI, executing lightweight Model Context Protocol (MCP) actions.

---

## 2. Architecture

### High-Level Component Map

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                                     CHROME BROWSER                                     │
│                                                                                        │
│  ┌──────────────────────┐    ┌───────────────────────────┐    ┌─────────────────────┐  │
│  │       POPUP UI       │    │      SERVICE WORKER       │    │    BUILT-IN AI      │  │
│  │      popup.html      │    │     service-worker.js     │    │    Gemini Nano      │  │
│  │      popup.js        │    │                           │    │ (window.ai / Prompt)│  │
│  │                      │    │ 1. webRequest logger      │    └──────────┬──────────┘  │
│  │  ┌────────────────┐  │    │ 2. Tab cleanup            │               │             │
│  │  │   AI CLIENT    │  │    │ 3. Block count & DOM msg  │               │ local IPC   │
│  │  │ nano-client.js │◄─┼────┼───────────────────────────┼───────────────┘             │
│  │  └───────┬────────┘  │    │ 4. Cookie lock enforcer   │                             │
│  │          │           │    │ 5. ADD_BLOCK_RULE handler │                             │
│  │          │ calls     │    │ 6. Sniping state restore  │                             │
│  │          │ chrome.*  │    │ 7. onInstalled pattern DL │                             │
│  └──────────┼───────────┘    └─────────────▲─────────────┘                             │
│             │ chrome.tabs.sendMessage     │ runtime.sendMessage                        │
│             ▼                             │                                            │
│  ┌────────────────────────────────────────┴─────────────────────────────────────────┐  │
│  │                             CONTENT SCRIPT (per-tab)                             │  │
│  │                                content/content.js                                │  │
│  │                                                                                  │  │
│  │  • Hides elements matching blocked URLs (display:none)                           │  │
│  │  • Element Picker: overlay + hover guide + click-to-block                        │  │
│  │  • iFrame Ad Blocker: fully removes() ad iframes                                 │  │
│  │  • Overlay Neutralizer: strips anti-adblock modals, video ads & unlocks scroll   │  │
│  │  • CSS Selector Hider: injects display:none on custom AI selectors               │  │
│  │  • Content Extractor: strips ads/sidebars for reader view                        │  │
│  │  • MutationObserver: catches dynamically injected ads                            │  │
│  └──────────────────────────────────────────────────────────────────────────────────┘  │
│                                                                                        │
│  ┌──────────────────────────────────────┐    ┌──────────────────────────────────────┐  │
│  │        declarativeNetRequest         │    │         chrome.storage.local         │  │
│  │              DNR Engine              │    │          (Persistent State)          │  │
│  │                                      │    │                                      │  │
│  │   Static: rules/rules.json           │    │   requests_{tabId} (last 200 reqs)   │  │
│  │   Dynamic user rules: 1001–39999     │    │   adHosts / adPatterns               │  │
│  │   Dynamic newtab-block: 40001–49999  │    │   massBlockActive / RuleIds          │  │
│  │   Dynamic mass-block: 50001+         │    │   newTabBlockActive / RuleIds        │  │
│  └──────────────────────────────────────┘    └──────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

### Request Lifecycle

```
Network request →
  webRequest.onBeforeRequest (SW) → logs to requests_{tabId} (including POST body)
  DNR Engine checks rules →
    BLOCKED →
      onRuleMatchedDebug (SW) →
        Increments blockCount_{ruleId}
        Sends REMOVE_AD_ELEMENT to content script →
          Content script: findByUrl() → bestContainer() → applyHide() [display:none]
```

### Gemini Nano On-Device AI & MCP Execution Lifecycle

```
User Input in Popup ("Kill popups", "Audit trackers", "Block tracker.com")
        │
        ▼
GeminiNanoClient.getInstance()
        │
        ├──► 1. Intent Pre-Dispatch Engine (detectDirectIntent)
        │        │ Checks deterministic regex for instant commands
        │        ▼
        │    [Pre-Executes MCP Action: 0ms Latency]
        │        │ (e.g. tool_remove_overlay, tool_inspect_requests)
        │
        ├──► 2. Prompt API Session Manager (getOrCreateSession)
        │        │ Lazy window.ai.languageModel.create() with system directives
        │        ▼
        │    Streaming & Parsing (promptStreaming)
        │        │
        │        ├──► Token Sanitizer (cleanActionFromReply) ──► Real-Time Stream to UI
        │        │      (Strips native tool_name{...}, backtick blocks, raw JSON)
        │        │
        │        └──► Action Extractor (extractActionJSON)
        │               (Parses ```action, native calls, balanced JSON objects)
        │
        └──► 3. MCP Tool Dispatcher (executeMcpAction)
                 ├── tool_add_block_rule ────────► SW: ADD_BLOCK_RULE (DNR Dynamic)
                 ├── tool_remove_overlay ────────► Content: AI_REMOVE_OVERLAY
                 ├── tool_hide_element_css ──────► Content: AI_HIDE_SELECTOR
                 ├── tool_extract_clean_content ──► Content: AI_EXTRACT_CONTENT
                 ├── tool_inspect_requests ──────► Storage: requests_{tabId} (Forensic Report)
                 └── tool_toggle_feature ────────► Popup: toggleNewTabBlock / toggleMassBlock
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
├── service-worker.js          Background SW (webRequest logging, DNR rules, cookie lock, state cleanup)
├── ai/
│   └── nano-client.js         Gemini Nano on-device AI static singleton & MCP tool dispatcher (~950 lines)
├── content/
│   ├── content.js             Content script: DOM sanitization, overlays, picker bridge, AI message handlers
│   └── sniper-game.js         Sniping game engine (loaded on-demand via web_accessible_resources)
├── popup/
│   ├── popup.html             Two-tab dark-theme UI + Sniping button + Enable AI button & prompt section
│   ├── popup.css              Dark-theme styling, animations, blinking/pulsing status indicators
│   └── popup.js               All popup logic, AI session coordination, direct chrome.* API calls
├── data/
│   └── ad-patterns.json       Fallback: 64 ad hosts + 30 URL patterns
└── rules/
    └── rules.json             Empty static DNR ruleset (required by manifest)
```

### service-worker.js

| Responsibility | API Used |
|---|---|
| 1. webRequest logger | `webRequest.onBeforeRequest` (with `requestBody`) → `storage.local` |
| 2. Tab cleanup | `tabs.onRemoved` → `storage.local.remove` |
| 3. Block-count + DOM msg | `declarativeNetRequest.onRuleMatchedDebug` → `tabs.sendMessage` |
| 4. Cookie lock enforce | `cookies.onChanged` → `cookies.set` |
| 5. ADD_BLOCK_RULE handler | `runtime.onMessage` → `declarativeNetRequest.updateDynamicRules` |
| 6. Sniping state restore | `runtime.onMessage` (`RESTORE_SNIPING_STATE`, `SNIPING_GAME_ENDED`) → DNR re-enable |
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
| `initAIAssistant()` | Reads/writes `aiEnabled` (default false); manages UI state & auto-collapse |
| `checkAndDisplayAIStatus()` | Checks Gemini Nano availability, drives tri-state status light (green/yellow/red) |
| `toggleAIAssistant()` | Toggles prompt section, auto-collapses/expands sections, frees memory when off |
| `initAISettings()` | Configures System Prompt settings panel, wires gear icon, save/reset actions |
| `handleAISend()` | Dispatches prompt to GeminiNanoClient with streaming output, auto-executes MCP actions, updates UI |
| `setSectionCollapsed(section, isCollapsed)` | Programmatically collapses or expands Requests / Rules sections |
| `toggleSectionCollapse(section)` | User toggle handler for collapsible section headers |
| `formatAIOutput(text)` | Formats raw AI response into safe, styled HTML (markdown, bold, code, lists) |
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
| `startElementPicker()` | Full overlay picker with mouse tracking and click-to-block |
| `findNearestAdUrl(el)` | Walks ≤8 ancestors, prefers known-ad URLs |
| `isAdIframe(iframe)` | 5-check heuristic for ad iframes |
| `scanAndRemoveAdIframes()` | Snapshots + `iframe.remove()` on matches |
| `processNewNode(node)` | MutationObserver callback for new DOM nodes |
| `launchSnipingGame()` | Dynamically loads sniper-game.js, calls `AdSniperGame.launchGame()` |
| `removeIntrusiveOverlays()` | Detects & removes anti-adblock modals, floating video ads, paywalls, restores scrolling |
| `hideBySelector(selector)` | Applies `display:none !important` to AI-generated CSS selector |
| `extractCleanArticleText()` | Extracts readable article text without ads/sidebars |

### nano-client.js — Key Systems (Gemini Nano Static Singleton)

| System | What it does |
|---|---|
| `GeminiNanoClient.getInstance()` | Static singleton managing active on-device Prompt API session |
| `checkAvailability()` | Detects Prompt API, tests availability (`available`/`readily`/`downloadable`/`unsupported`) |
| `getSystemPrompt()` | Retrieves active system prompt (honoring `customSystemPrompt` from storage or `DEFAULT_SYSTEM_PROMPT`) |
| `getOrCreateSession()` | Lazy session initialization with AdSniper MCP tool system prompt |
| `detectDirectIntent()` | Pre-dispatch regex intent classifier for instant 0ms command execution |
| `extractActionJSON()` | Robust balanced-brace JSON extractor capable of parsing nested action arguments and native function syntax |
| `cleanActionFromReply()` | Strips action blocks, raw tool JSON, and third-party recommendations from display text |
| `generateAuditReport()` | Generates forensic audit report detailing intercepted ad calls and exfiltrated parameters |
| `processPrompt()` | Executes prompt with intent pre-dispatch, streaming token support, few-shot prompt constraints, and action parsing |
| `executeMcpAction()` | Dispatches actions: `tool_add_block_rule`, `tool_remove_overlay`, `tool_hide_element_css`, `tool_extract_clean_content`, `tool_inspect_requests`, `tool_toggle_feature` |
| `executeHeuristicFallback()` | Instant on-device heuristic execution when model is downloading or flags inactive |
| `destroy()` | Explicitly calls `session.destroy()` to immediately reclaim RAM/VRAM |

---

## 4. Points to Remember

### DNR Rule ID Ranges
```
1     –  1000   Chrome internal (never use)
1001  – 39999   User-added rules (inline Block form, element picker, AI tool_add_block_rule)
40001 – 49999   New-tab-block rules (main_frame only, ad host navigations)
50001+           Mass-block rules (ad hosts + URL patterns)
```

### Storage Keys
```
requests_{tabId}       Array<{url, type, timestamp, method, postData}>, max 200, newest-first
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
aiEnabled              Boolean, default false (controls Gemini Nano AI assistant UI)
customSystemPrompt     String, user-customized system prompt for Gemini Nano LLM
snipingGamePending     Boolean, true while waiting for page reload + game launch
snipingPreGameState    Object: snapshot of all toggle states before game started
snipingOpenNewTab      Boolean, whether to open new tab vs reload for game
```

### Critical Constraints

1. **webRequest in MV3 is observe-only** — cannot block via webRequest. All blocking via `declarativeNetRequest.updateDynamicRules()`.
2. **Content scripts cannot call `chrome.declarativeNetRequest`** — route through SW via `runtime.sendMessage({ type: 'ADD_BLOCK_RULE' })`.
3. **`chrome.cookies` is undefined (not just restricted) on `chrome://`, `about:`, `data:`, `chrome-extension://` pages** — always call `isCookieAccessibleUrl(url)` before any cookies API call.
4. **Service worker has no persistent memory** — it can be killed between events. All state must live in `chrome.storage.local`.
5. **`onRuleMatchedDebug` is dev-mode only** — only fires for unpacked extensions with `declarativeNetRequestFeedback` permission.
6. **Cookie lock loop prevention** — `cookies.onChanged` checks `cookie.value === locked.value` before restoring.
7. **DOM hide vs delete** — DOM Cleanup and element picker use `display:none` (reversible on reload). iFrame Blocker uses `iframe.remove()` (permanent for that page session).
8. **On-device AI VRAM reclamation** — Chrome sessions allocate GPU memory. Always call `destroy()` when popup closes or AI is disabled.

---

## 5. Gemini Nano Built-in AI & MCP Tool Architecture

AdSniper integrates Chrome's native Built-in AI (the **Prompt API** / **LanguageModel** interface) to provide conversational, local-first browser control without cloud latency or external API dependencies.

### 5.1 Architecture Overview & Core Design Tenets

```
┌────────────────────────────────────────────────────────────────────────┐
│                        GeminiNanoClient (Singleton)                    │
│                                                                        │
│  1. Check Availability (window.ai.languageModel / window.ai.assistant) │
│  2. Intent Pre-Dispatch (0ms Deterministic Regex Matcher)              │
│  3. Lazy Session Creation (Temperature: 0.2, TopK: 3, System Prompt)   │
│  4. Prompt Streaming with Token-Level Sanitization                     │
│  5. Multi-Syntax Action Parser (Native, Markdown & Balanced JSON)      │
│  6. Autonomous MCP Tool Execution                                      │
│  7. Resilient Heuristic Fallback Engine                                │
│  8. Memory-Safe Session Teardown (VRAM Reclamation)                   │
└────────────────────────────────────────────────────────────────────────┘
```

1. **Zero External Surface**: No user prompt, visited URL, cookie, or network payload is ever transmitted over the network.
2. **Deterministic Pre-Dispatch**: User commands that map directly to browser actions (e.g. *"kill popups"*, *"audit trackers"*) execute **before or in parallel with** the model output. This guarantees instantaneous browser responsiveness.
3. **Dual-Engine Resilience**: If Gemini Nano flags are disabled, hardware requirements are not met, or the model is downloading, AdSniper transitions to **Heuristics Mode** with zero feature loss for core commands.
4. **Memory Conservation**: Models running on device occupy 1.5 GB–2.5 GB of system/GPU memory. The session is lazily initialized upon opening AI mode and explicitly freed via `session.destroy()` upon popup closing or toggling AI off.

---

### 5.2 API Detection Matrix & Interface Resolution

Chrome has evolved its built-in AI namespace across releases (M127 to M131+). `nano-client.js` detects the active interface through a tiered resolver:

```javascript
getLanguageModelAPI() {
  if (typeof window !== 'undefined') {
    if (window.ai && window.ai.languageModel) return window.ai.languageModel; // Standard Prompt API (Chrome 128+)
    if (window.ai && window.ai.assistant)     return window.ai.assistant;     // Early Canary/Dev experimental
    if (window.LanguageModel)                return window.LanguageModel;     // Global proposal spec
  }
  if (typeof self !== 'undefined') {
    if (self.ai && self.ai.languageModel)    return self.ai.languageModel;
    if (self.ai && self.ai.assistant)        return self.ai.assistant;
    if (self.LanguageModel)                  return self.LanguageModel;
  }
  return null;
}
```

The availability check queries `lm.availability()` or legacy `lm.capabilities()`:
- `'readily'`: Model downloaded and resident in memory.
- `'after-download'`: Model component is pending download.
- `'unsupported'` / `'no'`: System hardware incompatible or flags not enabled.

---

### 5.3 System Prompt Engineering & Anti-Hallucination Directives

Gemini Nano runs with a concise system prompt injecting the AdSniper tool schema, strict governance constraints, and tool execution boundaries:

```text
You are AdSniper AI, an on-device Chrome extension assistant.
You help users inspect network traffic, eliminate annoying ads/trackers, remove paywalls and popups, and control the page.

You have access to the following MCP Actions:
- tool_add_block_rule(pattern, reason): Adds a DeclarativeNetRequest block rule (e.g. pattern="||tracker.example.com").
- tool_remove_overlay(): Removes anti-adblock modals, blur filters, and restores page scrolling.
- tool_hide_element_css(selector, reason): Hides elements matching a CSS selector (display: none !important).
- tool_extract_clean_content(): Extracts clean readable text of the page without ads/sidebars.
- tool_inspect_requests(category): Audits recent network requests captured on the tab.
- tool_toggle_feature(feature, state): Toggles 'mass_block', 'new_tab_block', 'dom_cleanup', or 'iframe_blocker'.

Rules for executing tools:
1. ONLY execute an action tool if the user's request explicitly matches one of the available tools above.
2. If the user asks for general information, page questions, anchor links, text summaries, or anything outside of these specific tools, DO NOT call any tool. Answer the user directly and concisely in natural language.
3. When an action IS appropriate, provide a concise explanation (1-2 sentences), followed immediately by an action block formatted exactly as:
```action
{"tool": "tool_name", "args": {"arg1": "value"}}
```
4. NEVER recommend installing other extensions (e.g. uBlock Origin, AdBlock).
```

#### System Prompt Configuration & Customization (⚙️ Settings Gear)
AdSniper provides a settings drawer via the **⚙️ Gear Icon** in the AI assistant header:
- **Direct Transparency**: Users can view the exact system prompt instruction currently provided to Gemini Nano.
- **Customization & Persistence**: Users can tweak directives, modify rules, or adjust personas. Custom prompts are saved to `chrome.storage.local.set({ customSystemPrompt })`.
- **Instant Hot-Reload**: Saving calls `session.destroy()` so the very next prompt creates a new session reflecting the updated prompt immediately.
- **One-Click Reset**: The **🔄 Reset Default** button clears `customSystemPrompt` and re-applies `GeminiNanoClient.DEFAULT_SYSTEM_PROMPT`.

#### Anti-Recommendation & In-Prompt Directives
Small parameter models (like 3B Nano) frequently hallucinate or default to generic web advice (e.g. *"You should install uBlock Origin or AdBlock Plus"*). AdSniper prevents this with:
1. **System Directives**: `[YOU ARE ADSNIPER, AN ACTIVE IN-BROWSER EXTENSION RUNNING ON THIS TAB] NEVER tell the user to install other extensions.`
2. **Reply Stripping**: `cleanActionFromReply()` strips third-party extension recommendations and links matching `/(install|use)\s*(ublock|adblock|privacy badger)/gi`.
3. **Context Injection**: Active tab URL and up to 8 detected network hostnames are fed into the prompt context to keep answers grounded in current tab telemetry.

---

### 5.4 Intent-First Deterministic Dispatcher (`detectDirectIntent`)

To eliminate latency and prevent model non-compliance, natural language inputs are evaluated against deterministic intent regexes:

| User Input Pattern | Triggered Tool | Action Executed |
|---|---|---|
| `kill/remove/clear popups/overlays/modals/paywalls` | `tool_remove_overlay` | Injects overlay cleanup, strips high-z modals, unlocks scroll |
| `block/stop/remove on click new tab / popup tabs` | `tool_toggle_feature` | Activates `new_tab_block` DNR rules (IDs 40001–49999) |
| `block all ads / mass block` | `tool_toggle_feature` | Activates `mass_block` DNR rules (IDs 50001+) |
| `reader view / clean article / extract content` | `tool_extract_clean_content` | Extracts readability text without ads/sidebars |
| `audit/inspect trackers / telemetry / network` | `tool_inspect_requests` | Compiles forensic network audit report |
| `block <domain.com>` | `tool_add_block_rule` | Generates DNR rule `\|\|<domain.com>` |

If an intent matches, `executeMcpAction()` fires **immediately**. The UI displays an execution confirmation banner alongside the streaming response.

---

### 5.5 Action Extraction & Stream Sanitization

Gemini Nano can output tool calls in multiple formats. `extractActionJSON()` handles all of them:
1. **Triple-Backtick Blocks**: ```` ```action {"tool": ...} ``` ````
2. **Native Prompt API Tool Calls**: ````tool_inspect_requests{"category": "all"}```` (with or without backticks)
3. **Balanced JSON Extraction**: State machine that counts braces `{}` while respecting string boundaries and escape characters `\"`.

#### Real-Time Stream Cleaning (`cleanActionFromReply`)
During streaming (`session.promptStreaming`), chunks containing raw action JSON or native function signatures are dynamically stripped before rendering to the user-facing output box:
- Eliminates visual flicker of technical code blocks.
- Prevents raw JSON from leaking into the conversation interface.

---

### 5.6 Autonomous MCP Tool Handlers

| Tool Name | Arguments | Implementation & Mechanism |
|---|---|---|
| `tool_add_block_rule` | `pattern`, `reason` | Calls `chrome.runtime.sendMessage({ type: 'ADD_BLOCK_RULE', pattern })`. Service worker creates dynamic DNR rule (priority 1). |
| `tool_remove_overlay` | *none* | Dispatches `AI_REMOVE_OVERLAY` to content script. Targets fixed/absolute elements with z-index ≥ 200, cleans backdrop blurs, removes overflow locks from `<html>` and `<body>`. |
| `tool_hide_element_css` | `selector`, `reason` | Dispatches `AI_HIDE_SELECTOR` to content script. Injects inline `display: none !important` style onto matching nodes. |
| `tool_extract_clean_content` | *none* | Dispatches `AI_EXTRACT_CONTENT` to content script. Traverses main article/content nodes, strips scripts/styles/ads, returns clean text and word count. |
| `tool_inspect_requests` | `category` | Queries `chrome.storage.local.get('requests_{tabId}')` and `adHosts`. Compiles the forensic audit report with decoded query parameters. |
| `tool_toggle_feature` | `feature`, `state` | Programmatically triggers `toggleNewTabBlock()`, `toggleMassBlock()`, or updates storage flags. |

---

### 5.7 Forensic Network Audit Engine (`generateAuditReport`)

When `tool_inspect_requests` is called, AdSniper inspects all network requests captured by `service-worker.js` for the active tab and correlates them against Peter Lowe's ad hosts and known telemetry keywords.

#### Decoded Exfiltration Parameters
Ad networks exfiltrate sensitive device and auction data via URL query parameters. AdSniper automatically annotates these parameters for the user:

| Parameter Key | Forensic Classification | Plain-English Meaning |
|---|---|---|
| `zpartnerid`, `partnerid`, `pub_id` | Account Tracking | Publisher Account / Partner ID |
| `reqid`, `req_id`, `auction_id` | Ad Auction | Real-Time Bidding Auction Identifier |
| `ref`, `referrer`, `url`, `page` | Origin Leakage | Page Referrer / Current Browsing URL |
| `tz`, `res`, `screen`, `vw`, `vh` | Device Fingerprinting | Timezone, Screen Resolution & Viewport Dimensions |
| `uid`, `uuid`, `visitor_id`, `cid` | User Tracking | Persistent Cross-Site Visitor Identifier |
| `fledge`, `topics` | Privacy Sandbox | Protected Audience / Topics API Profile |
| `consent`, `gdpr_consent`, `ccpa` | Consent Framework | TCF / CCPA Consent String |

Requests are grouped into categories:
- **Real-Time Ad Auction / Bidding**: OpenX, Prebid, Criteo, Rubicon, AMXRTB.
- **User Tracking & Telemetry**: Clarity, Hotjar, Google Analytics, Telemetry endpoints.
- **Tracking Pixels & Beacons**: 1×1 GIF trackers, beacon pings.
- **Popup / Popunder Networks**: PopCash, Adsterra, ExoClick.

---

### 5.8 Resilient Heuristics Fallback Engine

When Gemini Nano is not available (`status === 'unsupported'` or `'downloading'`), `executeHeuristicFallback()` ensures the extension remains fully operational:
- Direct commands are processed instantly via `detectDirectIntent`.
- Keyword queries (audit, reader, block) map directly to their corresponding MCP tool actions.
- Output includes helpful guidance on how to enable Chrome flags for full generative capabilities.

---

### 5.9 Tri-State Status Indicator State Machine

The status pill in the AI prompt header provides continuous visual feedback on the engine state:

```
                  ┌───────────────────────┐
                  │ AI Toggle Clicked (ON)│
                  └───────────┬───────────┘
                              │
                              ▼
                  ┌───────────────────────┐
                  │ .ai-status-pill.startup│
                  │ Yellow Pulsing Light  │
                  │    "Starting up…"     │
                  └───────────┬───────────┘
                              │
            ┌─────────────────┴─────────────────┐
            │ checkAvailability()               │
            ▼                                   ▼
┌───────────────────────┐           ┌───────────────────────┐
│ status === 'ready'    │           │ status !== 'ready'    │
├───────────────────────┤           ├───────────────────────┤
│ .ai-status-pill.running│          │ .ai-status-pill.running│
│ Green Blinking Light  │           │ Green Blinking Light  │
│     "Nano Ready"      │           │   "Heuristics Mode"   │
└───────────────────────┘           └───────────────────────┘
            │                                   │
            ▼                                   ▼
┌───────────────────────────────────────────────────────────┐
│ status === 'downloading' → Yellow Pulsing ("Downloading %")│
│ status === 'down'/'error' → Red Static Light ("AI Down")   │
└───────────────────────────────────────────────────────────┘
```

---

### 5.10 Chrome Flags & Environment Configuration Guide

To enable full on-device Gemini Nano generative capabilities in Chromium, follow these exact settings:

#### 1. Chromium Build Requirements
- Chrome version **128+** (Dev, Canary, Beta, or Stable 131+).
- 64-bit OS with at least **22 GB free disk space** on the system drive.
- GPU with at least **4 GB VRAM** (DirectML / WebGPU compatible).

#### 2. Flag Settings (`chrome://flags`)

| Flag | Recommended Value | Purpose |
|---|---|---|
| `chrome://flags/#prompt-api` *(or `#prompt-api-for-gemini-nano`)* | **Enabled** | Exposes the `window.ai.languageModel` API to web pages and extensions. In modern Chromium builds, this flag is titled **Prompt API** (`#prompt-api`). |
| `chrome://flags/#optimization-guide-on-device-model` | **Enabled BypassPerfRequirement** *(if present)* | Bypasses Google's hardware qualification check, ensuring model download on all compatible GPUs. |

> **Note**: If Chrome indicates *"Nearly up to date! Relaunch Chrome to finish updating"*, you must relaunch Chrome for the browser binaries and flags to activate. Until restarted, `window.ai` remains `undefined`.

#### 3. Component & Model Diagnostics (`chrome://on-device-internals` & `chrome://components`)
- **Primary Dashboard**: Navigate to `chrome://on-device-internals` to inspect real-time model status, installation path, device hardware qualification, and active model execution.
- **Component Updater**: Navigate to `chrome://components/`, locate **Optimization Guide On Device Model**, and click **Check for update**.

#### 4. DevTools Diagnostic Console Commands
> **Important**: Test within an **Extension Context** (e.g. Right-click AdSniper popup → **Inspect**), as Chrome isolates on-device AI from regular web tabs by default.

In modern Chrome, use the W3C standard **`LanguageModel`** interface:

```javascript
// 1. Check model availability
const availability = await (window.LanguageModel || window.ai?.languageModel).availability();
console.log("Nano Availability:", availability); // "readily" | "after-download" | "downloadable" | "unavailable"

// 2. Test session creation and prompt execution
const session = await (window.LanguageModel || window.ai?.languageModel).create();
const response = await session.prompt("Summarize ad blocking in 5 words.");
console.log("Model Response:", response);
session.destroy(); // Always free memory
```

---

## 6. Developer Guidelines & Agent Notes

### Before Editing Anything
1. Read the **Storage Keys** table — use established keys, don't duplicate.
2. Check the **DNR rule ID range** before creating new rule categories.
3. Understand layer ownership:
   - UI logic & AI coordination → `popup/popup.js`
   - AI singleton & MCP dispatcher → `ai/nano-client.js`
   - DOM manipulation & sanitization → `content/content.js`
   - Network logging & DNR rule operations → `service-worker.js`

### Adding a Toggle Feature (Standard Pattern)
```text
popup.html → <input type="checkbox" id="foo-toggle"> in appropriate bar
popup.js   → initFooToggle() reads storage, wires 'change' event
popup.js   → call await initFooToggle() in DOMContentLoaded
content.js → add case 'SET_FOO' in onMessage switch if content script needs it
```

### Adding a Content Script → SW Message (e.g. for DNR Access)
```javascript
// content.js
chrome.runtime.sendMessage({ type: 'MY_TYPE', ...data });

// service-worker.js
if (message.type === 'MY_TYPE') {
  (async () => { /* logic */ })();
  return true; // Required for async sendResponse
}
```

### Adding a Popup → Content Script Message
```javascript
// popup.js
chrome.tabs.sendMessage(activeTabId, { type: 'MY_TYPE', ...data });

// content.js
case 'MY_TYPE':
  // handle message
  sendResponse({ ok: true });
  return true;
```

### Adding a New DNR Rule Category
1. Pick a distinct ID range (document in `Architecture.md` and `popup.js` constants).
2. `popup.js`: create `rules[]`, call `updateDynamicRules({ addRules, removeRuleIds })`.
3. Store IDs in a new storage key (e.g., `fooBlockRuleIds`).
4. On deactivate: remove from DNR + clear storage key + clean up `blockCount_{id}` keys.

### What NOT to Do
- **Do NOT block via `webRequest` in MV3** — it is observe-only. All blocking must use `declarativeNetRequest`.
- **Do NOT call `declarativeNetRequest` from `content.js`** — route via the service worker.
- **Do NOT call `chrome.cookies.*` without `isCookieAccessibleUrl()` guard** — `chrome.cookies` is undefined on system URLs.
- **Do NOT use global variables for persistent state in `service-worker.js`** — the worker can be suspended at any time. Use `chrome.storage.local`.
- **Do NOT use `innerHTML` with user-provided data** — use `textContent` or `createElement` to prevent XSS.
- **Do NOT leak session memory** — always invoke `session.destroy()` when AI sessions end or popup unloads.

### Complete Message Type Table

| Message Type | Direction | File Handling It |
|---|---|---|
| `REMOVE_AD_ELEMENT { url }` | SW → Content | content.js |
| `APPLY_BLOCKED_PATTERNS { hosts, patterns }` | Popup → Content | content.js |
| `CLEAN_PAGE` | Popup → Content | content.js |
| `SET_DOM_CLEANUP { enabled }` | Popup → Content | content.js |
| `GET_HIDDEN_COUNT` | Popup → Content | content.js |
| `START_ELEMENT_PICKER` | Popup → Content | content.js |
| `TOGGLE_IFRAME_BLOCKER { enabled }` | Popup → Content | content.js |
| `GET_IFRAME_STATS` | Popup → Content | content.js |
| `ADD_BLOCK_RULE { pattern, url }` | Content/AI → SW | service-worker.js |
| `SNIPING_GAME_ENDED` | Content → SW | service-worker.js |
| `CLOSE_CURRENT_TAB` | Content → SW | service-worker.js |
| `RESTORE_SNIPING_STATE` | Content → SW | service-worker.js |
| `ADSNIPER_GAME_ENDED { score, birdsHit, totalBirds }` | Page Main World → Content (postMessage) | content.js |
| `START_SNIPING_GAME` | Popup → Content | content.js |
| `AI_REMOVE_OVERLAY` | Popup/AI → Content | content.js |
| `AI_HIDE_SELECTOR { selector }` | Popup/AI → Content | content.js |
| `AI_EXTRACT_CONTENT` | Popup/AI → Content | content.js |
