# AdSniper — Change Log

All notable changes to the AdSniper extension are documented here. Newest entries first.

---

## [2026-09-04] — System Prompt Settings Configuration & Intent Triggering Refinement

### Added
- **LLM System Prompt Configuration UI (⚙️ Gear Icon)**:
  - Added a setting **⚙️ Gear button** directly in the AI Assistant header row (`#ai-settings-btn`).
  - Added an interactive collapsible configuration panel (`#ai-settings-panel`) displaying the active system instructions sent to Gemini Nano.
  - Added custom prompt persistence via `chrome.storage.local.set({ customSystemPrompt })`.
  - Added **💾 Save & Apply** and **🔄 Reset Default** buttons with visual status indicators.
  - Saving or resetting triggers `session.destroy()` so subsequent prompts hot-reload into fresh sessions with the new prompt.

### Fixed
- **Erroneous Audit Tool Execution on General Prompts**:
  - **Root Cause**: Two issues caused general queries (e.g. *"Get me all anchor link"*) to trigger tracker audit reports:
    1. `detectDirectIntent` audit regex had a loose fallback `lower.includes('tracker')`, which triggered whenever a query or explanation contained the word "tracker".
    2. In `processPrompt()`, line 748 evaluated `this.detectDirectIntent(fullResponse)`. When Gemini Nano generated a natural conversational response discussing trackers or requests, the model's own words triggered `tool_inspect_requests` and replaced the reply with an audit report.
  - **Resolved**:
    - Removed `detectDirectIntent(fullResponse)` on the model output so generated text never triggers internal tool actions.
    - Tightened `detectDirectIntent` audit regex to require explicit user action verbs (`audit trackers`, `inspect network`, `scan telemetry`), preventing false positives on general queries.
    - Updated `DEFAULT_SYSTEM_PROMPT` with explicit boundaries: if a prompt is outside available ad-blocking/DNR tools (e.g. anchor links, general questions), the model must not execute any tool and must answer directly in natural language.

---

## [2026-09-04] — Fix Gemini Nano Availability Detection for Modern Prompt API

### Fixed
- **Nano Ready Detection (`checkAvailability` in `adsniper/ai/nano-client.js`)**:
  - **Root Cause**: `checkAvailability()` only accepted the legacy preview status string `"readily"` (`if (avail === 'readily')`). In modern Chromium builds where Gemini Nano is installed and active (as reported by `chrome://on-device-internals`), `LanguageModel.availability()` returns `"available"`. This caused AdSniper to misclassify the active model as unsupported and drop into Heuristics Mode.
  - **Resolved**:
    - Expanded readiness checks in `checkAvailability()` to recognize `"available"`, `"readily"`, `"ready"`, and `true`.
    - Added recognition for `"downloadable"` and `"downloading"` alongside `"after-download"`.
    - Added direct session creation capability fallback (`lm.create()`) so that if the model is ready, it is immediately confirmed and activated.
    - Updated `getOrCreateSession()` with graceful fallback tiers (`createOptions` -> `systemPrompt` only -> bare `create()`), preventing initialization crashes if sampling options are restricted.
    - Updated `getLanguageModelAPI()` to search `globalThis.LanguageModel`, bare `LanguageModel`, and `window.LanguageModel` across all scopes.

---

## [2026-09-03] — Gemini Nano LLM Implementation & Chrome Flags Documentation

### Added
- **Comprehensive Built-in AI Documentation (`README.md` & `Architecture.md`)**:
  - Detailed the **Gemini Nano On-Device AI Assistant** powered by Chrome's native Built-in AI (Prompt API / `window.ai.languageModel`).
  - Added step-by-step Chrome flag setup instructions (`chrome://flags/#prompt-api-for-gemini-nano`, `chrome://flags/#optimization-guide-on-device-model` with `BypassPerfRequirement`), `chrome://components` model updater, and DevTools console verification scripts.
  - Documented the **Autonomous MCP Tool Suite** (`tool_inspect_requests`, `tool_remove_overlay`, `tool_add_block_rule`, `tool_hide_element_css`, `tool_extract_clean_content`, `tool_toggle_feature`).
  - Documented the **Intent-First Deterministic Dispatcher** (`detectDirectIntent`) providing 0ms execution for common commands, alongside the **Resilient Heuristics Fallback Engine** (`executeHeuristicFallback`).
  - Added the Gemini Nano lifecycle ASCII sequence and high-level component diagrams in `Architecture.md`.
  - Detailed the parameter exfiltration decoding dictionary for the forensic network audit engine.

---

## [2026-09-03] — Fix Chrome New Tab Breaking Post Game Completion & Quit

### Fixed
- **Chrome New Tab Auto-Closing Bug (`chrome.tabs.onCreated`)**:
  - **Root Cause**: During the sniping game, `service-worker.js` tracked `snipingActiveTabId` and closed any new tab created by the game tab to suppress ad popups. When the game completed and the user clicked "Quit Game", `snipingActiveTabId` remained stuck in `chrome.storage.local` because:
    1. `RESTORE_SNIPING_STATE` attempted to re-add DNR dynamic rules without removing existing rule IDs first, throwing `"Rule with id 40001 already exists"` and crashing before clearing storage.
    2. `endGame()` in `sniper-game.js` did not directly remove `snipingActiveTabId` from storage.
    3. `chrome.tabs.onCreated` had no check to ignore Chrome internal URLs (`chrome://newtab/`, `chrome://new-tab-page/`, `about:blank`), causing any new tab opened by the user to be immediately killed.
  - **Resolved**:
    - **Chrome System Page Protection**: Added strict URL guards in `chrome.tabs.onCreated` to never close `chrome://`, `chrome-extension://`, `about:blank`, or browser new-tab pages.
    - **Instant Direct Storage Cleanup**: `endGame()` in `sniper-game.js` now immediately calls `chrome.storage.local.remove(['snipingActiveTabId', 'snipingGamePending'])`.
    - **Safe Dynamic Rule Reconciliation**: `RESTORE_SNIPING_STATE` in `service-worker.js` now checks and removes existing dynamic rules in ranges 40001–49999 and 50001+ before adding restored rules, eliminating duplicate ID crashes.
    - **Guaranteed Cleanup in Finally Block**: Storage flags are always removed in a `finally` block in `service-worker.js`.
    - **New Message Handlers**: Added `SNIPING_GAME_ENDED` and `CLOSE_CURRENT_TAB` message handlers so tabs opened via the "Open in New Tab" game option cleanly terminate upon quitting.
    - **Unhooked Click & Window Listeners**: `onGlobalClickPreventNewTab` now checks `gameState === 'PLAYING'` and `restoreWindowOpenInPage()` properly restores `window.top.open` and `window.parent.open`.

---

## [2026-09-03] — Forensic Ad/Tracker Audit Report & Action JSON Leak Fix

### Added
- **🔍 Forensic Ad & Tracker Network Audit Report (`generateAuditReport`)**:
  - Clicking `🎯 Audit Trackers` or asking to audit network requests now produces a comprehensive forensic breakdown of:
    - **Exact ad calls**: Target endpoints, hostnames (`rqtrk.eu`, `amxrtb.com`, `purpleads.io`, etc.), and resource types (`script`, `xmlhttprequest`, `ping`, `beacon`).
    - **Data Sent / Exfiltrated Parameters**: Parses and decodes all URL search query parameters with plain-English annotations (e.g. `zpartnerid` → Publisher ID, `reqId` → Auction Request ID, `domain`/`ref` → Page Referrer, `tz` → User Timezone, `res` → Screen Resolution, `uid`/`visitor_id` → Unique Tracking ID, `consent` → GDPR/Privacy Consent).
    - **POST Payload Capture**: Updated `service-worker.js`'s `webRequest.onBeforeRequest` listener with `['requestBody']` to capture HTTP method (`POST`/`GET`) and request body payloads.
    - **Actionable Protection**: Provides one-click blocking guidance for detected domains.
  - Returns instantly with 0ms latency directly from Chrome's live network storage, eliminating LLM waiting time or risk of hallucination.

### Fixed
- **Gemini Nano Native Function-Call Leak (` ``tool_name{...}`` `)**:
  - Fixed issue where Gemini Nano emitted its native tool-calling syntax (e.g. ` ``tool_inspect_requests{"url": "...", "max_results": 10}`` `) directly into the UI.
  - **Native Tool Call Extractor**: Enhanced `extractActionJSON` to parse native format `tool_name{...}` with or without enclosing backticks, extracting the tool and JSON arguments.
  - **Live Streaming & Display Sanitization**: Integrated `cleanActionFromReply` into token streaming and final prompt reply resolution, ensuring native tool calls are completely hidden while actions execute in the background.
  - **Prompt Intent Matching**: Expanded `detectDirectIntent` to flexibly capture prompts like *"Audit and list suspicious tracking requests on this tab"* and updated the quick chip in `popup.html`.
- **Raw Action JSON Leak in UI**: Fixed bug where clicking `Audit Trackers` or running actions displayed raw technical JSON (`{"tool": "tool_inspect_requests", "args": {...}}`).
  - Implemented balanced-brace JSON parsing in `extractActionJSON` supporting nested objects like `"args": {}`.
  - Implemented `cleanActionFromReply` ensuring raw tool call JSON and markdown action blocks are cleanly stripped from the user-facing response box.

---

## [2026-09-03] — Status Light States & Guaranteed Direct MCP Action Execution

### Added
- **🚦 Tri-State Blinking Status Light**:
  - **Green Blinking Light (`@keyframes blink-green`)**: Active when `Heuristics Mode` or `Nano Ready` is available and running.
  - **Yellow Pulsing Light (`@keyframes pulse-yellow`)**: Active during initialization, startup, and model downloading.
  - **Red Static Light**: Active when the AI engine is down, offline, or unavailable.
- **⚡ Intent-First Action Execution (`detectDirectIntent`)**:
  - Added deterministic pre-dispatch intent matcher in `adsniper/ai/nano-client.js` recognizing direct commands:
    - `"kill popups"` / `"remove popup"` / `"kill overlays"` / `"clear overlays"` -> triggers `tool_remove_overlay`
    - `"remove on click new tab"` / `"block new tab"` / `"stop opening new tab"` -> triggers `tool_toggle_feature` (`new_tab_block`)
    - `"block all ads"` / `"mass block"` -> triggers `tool_toggle_feature` (`mass_block`)
    - `"reader view"` / `"extract content"` -> triggers `tool_extract_clean_content`
    - `"audit trackers"` / `"inspect requests"` -> triggers `tool_inspect_requests`
    - `"block <domain>"` -> triggers `tool_add_block_rule`
  - Pre-executes MCP actions immediately on user send, guaranteeing instant browser effect without waiting for model text generation or risking model omission.
- **🛡️ Full `new_tab_block` & `mass_block` Programmatic Execution**:
  - Implemented live feature toggling in `executeMcpAction` for `tool_toggle_feature`, creating DNR rules for ad hosts, persisting `newTabBlockActive`, updating popup buttons, and syncing badges.
- **🎬 Enhanced Floating Video & Overlay Cleanup in Content Script**:
  - Upgraded `removeIntrusiveOverlays()` in `adsniper/content/content.js` to target floating video ad boxes, high-z modals (z >= 200), sticky banners, and restores body overflow scrolling.

### Fixed
- **Generic Non-Action Model Response Bug**: Fixed issue where Gemini Nano responded with conversational advice essays suggesting users install uBlock Origin instead of calling AdSniper MCP actions. Added strong in-prompt system directives, few-shot tool instructions, clean hostname summaries, external adblocker suggestion stripping, and fallback intent execution.

---

## [2026-09-03] — Gemini Nano On-Device AI Assistant & MCP Actions

### Added
- **✨ Enable AI button** in popup action bar beside "Block New Tab Ads" with gradient purple/cyan styling and pulsing active indicator (disabled by default).
- **Collapsible AI Prompt Section** with space-saving floating send arrow inside an enlarged multi-line textarea input, live status pill, and quick suggestion chips (`🎯 Audit Trackers`, `🧹 Kill Overlays`, `📝 Reader View`).
- **Prompt Hints Panel** (`.ai-hints-panel`) displaying clickable example prompts showing users what is possible with Gemini Nano.
- **Fixed & Formatted Output Box** (185px fixed height) with safe markdown formatting (`formatAIOutput` for bold, code, headings, lists, paragraphs) and auto-scroll.
- **Auto-collapsing of Requests & Blocked Rules**: When AI mode is enabled, Requests and Blocked Rules lists automatically collapse with `[▾ Collapse]` / `[▸ Expand]` toggles, preserving popup height under 600px. Both lists auto-expand when AI is toggled off.
- **`adsniper/ai/nano-client.js`** — Static singleton client (`GeminiNanoClient`) interfacing with Chrome's native Built-in AI (`window.ai.languageModel` / `ai.languageModel` / `LanguageModel` Prompt API):
  - **100% on-device & privacy-first**: zero cloud round-trips, no user data or URLs leave the device.
  - **Lightweight MCP tool suite**:
    - `tool_add_block_rule`: natural language to DNR dynamic rule synthesis.
    - `tool_remove_overlay`: removes anti-adblock modals/paywalls and unlocks body scroll.
    - `tool_hide_element_css`: applies `display: none !important` to custom AI-identified CSS selectors.
    - `tool_extract_clean_content`: extracts clean reader text from cluttered articles.
    - `tool_inspect_requests`: audits intercepted tab requests for telemetry & tracking endpoints.
    - `tool_toggle_feature`: programmatically toggles shields (`mass_block`, `new_tab_block`, etc.).
  - **Intelligent heuristic fallback**: executes common natural language commands even while the model is downloading or when flags are disabled.
  - **Memory-safe lifecycle**: lazy session instantiation on first toggle; calls `session.destroy()` on unload or toggle off.
- **Content script enhancements**: added message handlers for `AI_REMOVE_OVERLAY`, `AI_HIDE_SELECTOR`, and `AI_EXTRACT_CONTENT` with dedicated DOM helpers.

### Fixed
- **Streaming token accumulation bug**: Fixed an issue where delta token chunks were overwriting the output text word-by-word on a single line. The stream loop now auto-detects cumulative vs delta tokens, accumulates the full multi-line response, and filters raw action blocks during streaming.

### Changed
- **popup.html** — Added `#ai-toggle-btn`, enlarged textarea `#ai-prompt-input`, floating send button, `.ai-hints-panel`, fixed `#ai-response-box`, collapsible `#requests-header` and `#rules-header`, and `<script src="../ai/nano-client.js"></script>`.
- **popup.js** — Added `initAIAssistant()`, `checkAndDisplayAIStatus()`, `toggleAIAssistant()`, `handleAISend()`, `setSectionCollapsed()`, `toggleSectionCollapse()`, `formatAIOutput()`, Enter/Shift+Enter support, session cleanup on `unload`.
- **service-worker.js** — Ensured `aiEnabled: false` default initialization on install.
- **Architecture.md** — Documented `ai/nano-client.js`, new functions, `aiEnabled` storage key, and AI message types.

---

## [2026-09-03] — Sniping Game (Gamification)

### Added
- **🔫 Sniping ON** button in popup header — launches the ad sniping game. Temporarily disables all blocking, reloads the page (or opens a new tab via "New Tab" checkbox), scans for ad components, and turns them into flying "birds" on a full-screen Canvas overlay.
- **New Tab option** — Checkbox beside the Sniping button lets users open the same URL in a new tab instead of reloading, preserving form data and user state.
- **`content/sniper-game.js`** — Self-contained HTML5 Canvas game engine (~550 lines) with:
  - **Ad Scanner** — Walks DOM for ad iframes, divs, images using existing ad-detection heuristics
  - **Inverse-proportional bird sizing** — Large ad components become small (hard-to-hit) birds; small ads become large (easy) birds. Range: 5%–20% of viewport
  - **Dual-component zigzag flight** — `y = A₁·sin(ω₁·t) + A₂·sin(ω₂·t)` with randomized amplitudes/frequencies for natural "flutter"
  - **Scoring** — 10–100 points per bird (inversely proportional to bird size), ×1–×5 combo multiplier on consecutive hits
  - **Particle effects** — Explosion shards + floating score text on bird hit; red puff on miss
  - **Wing flap animation** — Animated triangular wings on each bird
  - **Loading screen** — Animated spinner with progress bar during ad scan phase
  - **Game Over screen** — Score, birds hit, accuracy %, combo stats
- **RESTORE_SNIPING_STATE** message handler in `service-worker.js` — Re-enables mass-block and newtab-block DNR rules after game ends
- **postMessage bridge** — Game engine (page main world) → content script (isolated world) → service worker for Chrome API access

### Changed
- **popup.html** — Added `#sniping-btn` button + `#sniping-newtab-toggle` checkbox in header with green glow CSS
- **popup.js** — Added `handleSnipingGame()` function, wired in `DOMContentLoaded`
- **content.js** — Added `START_SNIPING_GAME` message handler, `snipingGamePending` auto-launch check, `launchSnipingGame()` dynamic loader, `ADSNIPER_GAME_ENDED` postMessage listener
- **manifest.json** — Added `web_accessible_resources` for `content/sniper-game.js`
- **Architecture.md** — Updated file tree, storage keys, message types, function maps

---

## [2026-08-30] — Block New Tab Ads + ChangeLog

### Added
- **ChangeLog.md** — This file. Linked to `.gemini/GEMINI.md` for AI auto-update on every code change.
- **Block New Tab Ads** button — Red button placed beside the "AD Blocker" button in the mass-block bar. When activated, creates DNR rules with `resourceTypes: ['main_frame']` for all known ad hosts, preventing ad domains from opening as new tabs or pop-ups. Uses rule IDs `40001–49999` (new reserved range). State stored as `newTabBlockActive` + `newTabBlockRuleIds` in `chrome.storage.local`.

### Changed
- **popup.html** — Added `#new-tab-block-btn` button + CSS in mass-block bar, placed beside existing AD Blocker button.
- **popup.js** — Added `toggleNewTabBlock()`, `updateNewTabBlockButton()`, wired in `DOMContentLoaded`.
- **Architecture.md** — Updated DNR rule ID ranges, storage keys, and function maps.
- **.gemini/GEMINI.md** — Added ChangeLog.md update requirement.

---

## [2026-08-29] — sendToTab + Protocol Guard Fix

### Fixed
- **sendToTab()** helper in `popup.js` — Injects `content/content.js` on-demand when the content script is not running on a tab (tabs opened before extension install/reload). Returns `{ error: 'unsupported_protocol' }` silently for `chrome://`, `about:`, etc. instead of throwing an error.
- **content.js** — Added double-injection guard (`window.__adSniperInjected`) to prevent duplicate listeners.
- All 6 `chrome.tabs.sendMessage(activeTabId, ...)` calls in `popup.js` replaced with `sendToTab(...)`.

---

## [2026-08-23] — Element Picker + iFrame Blocker

### Added
- **Element Picker** (`🎯 Pick Element` button) — Sends `START_ELEMENT_PICKER` to content script, closes popup, user clicks an element on the page → `findNearestAdUrl()` walks ≤8 ancestors → extracts hostname → sends `ADD_BLOCK_RULE` to SW → element hidden.
- **iFrame Ad Blocker** (`Block iFrame Ads` toggle) — `scanAndRemoveAdIframes()` fully removes (`el.remove()`) ad iframes via 5-check heuristic. MutationObserver watches for new iframes.
- **DOM Ad Element Removal** — Content script hides blocked-URL elements (`display: none !important`), MutationObserver for dynamic elements.
- **Block count per rule** — `onRuleMatchedDebug` increments `blockCount_{ruleId}`; red badge in rules list.
- **Mass-block "AD Blocker"** button — Red pulsing button; activates DNR rules for all ad patterns from `data/ad-patterns.json`.

### Fixed
- **Cookie API crash** — Added `isCookieAccessibleUrl()` guard for `chrome://`, `about:` pages where `chrome.cookies` is `undefined`.

---

## [2026-08-19] — Initial Release (v2.0)

### Added
- **Two-tab popup** — Ad Blocker + Cookie Editor, dark theme.
- **Request monitor** — Logs all network requests per tab (max 200), newest-first.
- **Pattern-based blocking** — Inline block form, editable `||hostname` pattern, DNR dynamic rules.
- **Cookie Editor** — View, edit, lock (prevent page modification), delete cookies.
- **Ad pattern fetch** — Peter Lowe's list on install; fallback: bundled `data/ad-patterns.json`.
- **Manifest V3** scaffold — `declarativeNetRequest`, `webRequest` (observe-only), `cookies`, `storage`, `tabs`, `scripting`.
