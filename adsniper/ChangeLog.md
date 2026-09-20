# AdSniper — Change Log

All notable changes to the AdSniper extension are documented here. Newest entries first.

---

## [2026-09-18] — Fix DNR Duplicate Rule ID Crashes & LanguageModel Output Language Warning

### Fixed
- **"Rule with id 50001/40001 does not have a unique ID" crash (`popup.js`)**:
  - **Root Cause**: When toggling Mass-Block or New-Tab-Block ON, the code tried to remove stale rules using IDs stored in `chrome.storage.local`. If storage was out of sync with the actual DNR engine (e.g. after a game quit crash, extension reload, or partial failure), the stored IDs were stale/empty while the real DNR rules with those IDs still existed. Calling `updateDynamicRules({ addRules: [id:50001...], removeRuleIds: [] })` then threw "does not have a unique ID".
  - **Fix**: Both `toggleMassBlock` and `toggleNewTabBlock` now query the actual DNR engine via `chrome.declarativeNetRequest.getDynamicRules()`, collect all rule IDs in their respective ranges (50001+ for mass-block, 40001–49999 for new-tab-block), and pass them as `removeRuleIds` in the same `updateDynamicRules` call. This guarantees no duplicate ID collision regardless of storage state.
  - **Auto-Recovery**: If a "unique ID" error still occurs somehow, the catch block automatically wipes orphan rules from the DNR engine, resets storage flags, and prompts the user to retry — instead of showing a raw error dump.
- **"No output language was specified in a LanguageModel API request" warning (`nano-client.js`)**:
  - Chrome's LanguageModel API now requires `expectedOutputLanguage` in the `create()` options for optimal quality and safety attestation.
  - Added `expectedOutputLanguage: 'en'` to all `lm.create()` calls (primary, systemPrompt-only fallback, and bare fallback).
  - Also added `expectedOutputLanguage: 'en'` to `lm.availability()` check and the test session creation during `checkAvailability()` to fully suppress the warning on startup.
- **"Resource::kQuotaBytes quota exceeded" error (`popup.js`, `service-worker.js`)**:
  - **Root Cause**: `chrome.storage.local` has a strict size limit. AdSniper was storing hundreds of individual `blockCount_*` keys (one for every active DNR rule), along with up to 200 intercepted requests for every single tab opened by the user. If tabs were closed unexpectedly (e.g. Chrome crash), the request logs were never pruned, eventually filling up the local storage quota.
  - **Fix**:
    - **Manifest Permission**: Added `"unlimitedStorage"` to `manifest.json` to lift the hard quota limit.
    - **Batched Storage Writes**: Consolidated the hundreds of individual `blockCount_*` keys into a single `blockCounts` object. The `service-worker.js` now uses an in-memory batching system that only flushes the block counts to storage once every 5 seconds, rather than hammering the storage API on every blocked request.
    - **Storage Cleanup**: Added an automatic cleanup routine in `service-worker.js`'s `onInstalled`/startup hook that purges old legacy `blockCount_*` keys and cleans up `requests_*` arrays for tabs that no longer exist.
    - **Lowered Overhead**: Reduced `MAX_REQUESTS_PER_TAB` from 200 to 100.
    - **Error Handling**: Added a specific catch in `popup.js` for the `kQuotaBytes` error message that explicitly alerts the user to reload the extension (to apply the new `unlimitedStorage` permission and trigger the startup cleanup).

---

## [2026-09-04] — AI Prompt Persistence & JS Execution MCP Tool (Executor, Verifier, Fixer)

### Added
- **AI Prompt State Persistence Across Popup Sessions**:
  - Added real-time draft saving for `#ai-prompt-input` to `chrome.storage.local` under the `aiPromptDraft` key via `input` listener.
  - Automatically restores saved draft text whenever the extension popup or AI Assistant panel is opened.
  - Clears persisted draft upon user submission (`handleAISend()`), preventing accidental draft loss on popup closing.
- **JavaScript Execution MCP Tool (`tool_execute_js_script`)**:
  - Registered `tool_execute_js_script(code, description)` in `DEFAULT_SYSTEM_PROMPT` for Gemini Nano.
  - Built an end-to-end **Executor, Verifier, and Fixer** pipeline inside `adsniper/ai/nano-client.js`:
    - **Executor**: Executes JS in the active tab DOM context via `AI_EXECUTE_SCRIPT` messaging (with `chrome.scripting.executeScript` fallback).
    - **Verifier**: Inspects return structures, validates data integrity, and checks error states.
    - **Auto-Fixer Triad**: Automatically repairs missing return statements or function enclosures (Phase 1), executes resilient domain-specific heuristic extractors for anchor links, floating boxes/popups, images, and form inputs if script execution fails or returns empty (Phase 2), and prompts Gemini Nano for self-healing repair if unhandled exceptions occur (Phase 3).
    - **Report Formatter**: Formats tabular extraction results (links, coordinates, z-indices, tags, sources) into markdown tables for chat presentation.
  - Added `AI_EXECUTE_SCRIPT` message handler and safe DOM evaluation in `adsniper/content/content.js` with comprehensive `serializeItem` to eliminate `DataCloneError` across Chrome extension messaging boundaries.
  - Added quick prompt suggestion chips for `🔗 Anchor Links` and `🪟 Floating Boxes` in `adsniper/popup/popup.html`.

### Fixed
- **Raw JSON Action Leak & Script Execution on Anchor Link Queries**:
  - **Root Cause**: When users ran queries like *"get all anchor link in page"*, Gemini Nano generated a script ending in `console.log(JSON.stringify(links, null, 2))` rather than an explicit `return`. Blindly wrapping statement blocks with `return (${code})` produced a `SyntaxError: Unexpected token 'const'`. When the fallback reply was processed, stripping the action JSON left an empty string, causing `cleanedReply || fullResponse` to leak the raw model tool call JSON directly into the chat response.
  - **Resolved**:
    - Enhanced `executeCustomDOMScript` in `adsniper/content/content.js` to intercept and capture `console.log` / `console.table` / `console.dir` calls, support multi-statement blocks without syntax errors, and auto-return declared variables.
    - Updated `adsniper/ai/nano-client.js` `DEFAULT_SYSTEM_PROMPT` to instruct Gemini Nano that `tool_execute_js_script` must explicitly return data and not use `console.log`.
    - Expanded `detectDirectIntent` to match singular and plural variations (`get all anchor link in page`, `anchor link`, `links in page`).
    - Added safety guards in `nano-client.js` `processPrompt` so that raw JSON action blocks are never returned as chat text, falling back to the verified action report.
- **Content Security Policy (CSP) 'unsafe-eval' Violation on Protected Pages**:
  - **Root Cause**: On web pages enforcing strict Content Security Policies (disallowing `'unsafe-eval'`), executing dynamic JavaScript strings via `new Function(...)` is blocked by the browser engine with `Evaluating a string as JavaScript violates the following Content Security Policy directive because 'unsafe-eval' is not an allowed source of script`.
  - **Resolved**:
    - Implemented a **Zero-Eval CSP-Safe DOM Query Engine** (`safeExecuteWithoutEval`) in `adsniper/content/content.js`.
    - Parses and executes DOM query patterns (anchor links, floating elements, images, form inputs, and CSS selectors) natively using direct compiled browser APIs (`document.querySelectorAll`, `getAttribute`, `getComputedStyle`).
    - Added automatic CSP violation detection and fallback in `executeCustomDOMScript` and `chrome.scripting.executeScript` fallback, enabling seamless DOM extraction on any webpage regardless of its Content Security Policy.

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
## 2026-09-18
- Fixed 'Rule does not have a unique ID' crash in ADD_BLOCK_RULE by syncing nextRuleId with existing DNR rule max.
- Strengthened Gemini Nano Prompt API JSON action extraction regex to correctly parse LLM formatting hallucinations.
- Restructured SYSTEM_PROMPT to severely restrict conversational outputs and force JSON blocks for actions.


### Added
- **Personal Assistant Tab**: A new tab beside 'Ad Blocker' powered by the local Gemini Nano LLM. It features conversational chat history, context size management, and real-time LLM telemetry (generation speed in tokens/sec, and token capacity utilization).
- **Assistant Features Bar**: Added quick-access action chips for 'Summarise Page' (uses tool_extract_clean_content to fetch and display clean HTML in a new browser tab), 'Intent Finder', 'Calculator', 'Grammar Fixer', and 'Smart Reply'.
- **processAssistantPrompt()**: Added dedicated streaming and execution pipeline in nano-client.js with \session.countPromptTokens()\ support.

### Added
- **Lists Tab**: A new tab for managing Notes (Scratchpad) and a Todo list.
- **AI Integration**: The Personal Assistant can now read instructions and write directly to the user's Scratchpad or Todo list using the new \	ool_add_scratchpad\ and \	ool_add_todo\ MCP actions.
- **Feature Chips**: Added 'Save Note' and 'Add Todo' quick-action chips in the Assistant UI.

### Fixed
- Fixed a ReferenceError crashing the extension popup on initialization caused by the Assistant/Lists scripts not being fully bundled.

### Fixed
- Fixed a syntax error in popup.js triggered by template literals breaking during the build process, preventing the popup from opening.

### Fixed
- Fixed an issue where the Personal Assistant only outputted 'Action completed.' for normal chat messages. The assistant now uses a dedicated conversation prompt instead of the strict adblocker prompt, allowing it to chat naturally.

### Fixed
- Fixed a CSP `unsafe-eval` error preventing the Personal Assistant from extracting page text. The assistant now falls back to a custom Zero-Eval Engine in the content script when chrome.scripting.executeScript is blocked by strict Content Security Policies.
- Added a second pass LLM synthesis loop for the Personal Assistant to natively summarize text extracted via 	ool_extract_clean_content.
- Fixed an issue in the Ad Blocker tab where 	ool_execute_js_script output (like anchor link tables) was silently dropped, rendering as 'Action completed'. The .report payload is now correctly displayed in the UI.

### Fixed
- Fixed 'Extract anchor links' chip in the Ad Blocker tab. Previously, the LLM incorrectly called `tool_extract_clean_content` instead of extracting links. Added `tool_extract_anchor_links` and `tool_extract_floating_boxes` as direct-intent tools that bypass the LLM entirely, executing DOM queries via the content script and returning rich Markdown table reports.
- Anchor link extraction now shows at most 100 links in the table. When >100 are found, a 'Download All' button appears in the action card to save the full list as a .txt file.

### Added
- **Thinking Animation**: Replaced the static 'Thinking...' text in the Personal Assistant with an animated word-cycling indicator. 69 synonyms of 'thinking' (Pondering, Contemplating, Musing, etc.) cycle every 600ms with a buzzing brain emoji animation. Starting word is randomized for variety.

### Fixed
- Fixed an issue in the Personal Assistant where DOM queries (via \	ool_execute_js_script\) dumped raw JSON blocks instead of human-readable text. Enabled the second-pass synthesis engine to process \	ool_execute_js_script\ outputs so the AI can read the JSON and answer naturally.

### Fixed
- Tuned the Personal Assistant prompt to correctly prioritize \	ool_execute_js_script\ for counting specific words or extracting specific elements, rather than defaulting to full-page summarization.
- Added explicit instructions to the second-pass synthesizer to extract exact URLs and values from JSON output to prevent the AI from hallucinating missing data.

### Added
- Enhanced Todo List with Expandable UI showing Creation Date, ETA, and Descriptions.
- Added dynamic progress bar backgrounds for tasks based on ETA (Green -> Yellow -> Red).
- Added CSS animations for Overdue tasks: scales up 5% per day overdue (max 20%), and ignites with animated fire at 5+ days overdue.
- Gave Personal Assistant awareness of the current date and time so it can accurately calculate ETAs like 'next Friday'.

- Added inline editing capabilities for Tasks: The manual Add bar now has ETA and Description fields, and expanding an existing task reveals editable fields that auto-save.

- Fixed ETA Date Pickers to cap maximum selection at +5 years, defaulting to +2 days for out-of-bounds dates.
- Fixed CSS z-indexing bug that hid the green/yellow/red progress bars behind the task background.
- Refined overdue task scaling animation to scale vertically only (scaleY), avoiding text overlap issues.

- Adjusted ETA bounds to allow selecting dates up to 1 month in the past.
- Standardized CSS styling for the manual Optional Description input so it matches the main task input exactly.
- Provided the Personal Assistant tool_get_todos() access to the Todo List and instructed it to provide structured Day Summaries when requested.

- Hardened tool_get_todos instruction formatting in Personal Assistant's prompt to avoid tool_code hallucinations.
- Fixed Personal Assistant quick action chips overflow by using flex-wrap.
- Tweaked task overdue vertical scaling to 7% per day (max 35%).
- Moved 'Summarize my day' button from Ad Blocker tab to Personal Assistant tab.
- Fixed 'Summarize my day' outputting raw JSON by enabling the LLM synthesis pass for tool_get_todos.
- Stripped 'Action Executed: Fetched Tasks' prefix from Day Summary output.
- Injected date-math categorization ('suggestedCategory') directly into the tool_get_todos payload to prevent Gemini Nano from miscategorizing task ETAs.
- Increased entire popup width by 10% (520px -> 575px) and base font to 13px.
- Added CSS list margins/padding for Assistant AI messages to fix indentation.
- Updated tool_get_todos to filter out completed tasks and label them 'Complete'.
- Updated AI system prompt to include '✅ Complete' section in Day Summary.
- Pre-grouped tasks into categories directly inside tool_get_todos payload. The AI now only has to print the pre-grouped JSON as markdown without doing any grouping logic, preventing it from incorrectly classifying completed tasks as active priorities.
- Reordered features in README.md to prioritize AI, Ad Blocker, Element Picker, and Sniping Mode.
- Added a quick navigation Index to README.md.
- Greatly simplified the 'How to Enable Chrome Built-in AI' section in README.md to make it highly user-friendly.
- Reordered features in README.md to bump Scratchpad & Todo Lists to the 5th spot.

- Fixed an issue where the AI content extraction returned '0 words' on sites like India Today due to aggressive 'aria-hidden' attribute stripping.
- Improved readability of extracted text by adding spacing between block elements and increased character limit to handle larger articles.

- Improved 'Summarize my Day' output in Personal Assistant by explicitly formatting as Markdown, bypassing AI summarization which was degrading the formatting.
- Added a 'Copy' button on AI messages in Personal Assistant for easy text copying.
- Added a 'Download Chat' button to export the assistant chat history as a text file.

- Fixed 'Summarize my Day' output leaking raw HTML by replacing it with standard markdown and added strikethrough parsing support to the AI message renderer.

- Fixed an issue where the AI would hallucinate the Day Summary repeatedly when trying to extract page content, caused by context contamination in Gemini Nano's prompt.
- Rebranded 'Paywall' to 'Distraction free Reading' across UI elements.
- Offloaded AI processing to service-worker.js to allow Assistant queries to complete in the background even if the popup is closed.
