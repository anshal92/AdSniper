# AdSniper — Change Log

All notable changes to the AdSniper extension are documented here. Newest entries first.

---

## [2026-10-25] — Element Picker Delete Fix, Popup Resize Controls, Lists Tab Reorder & Save Domain Blocklist

### Fixed
- **Target Container Bounding Box & Element Picker Deletion (`content/content.js`)**:
  - Replaced soft `applyHide` with `applyDelete` to physically remove targeted elements from the DOM instead of leaving them with `display: none`.
  - Overhauled target container detection (`findTargetContainer`) to accurately detect full ad containers, banner slots, modals, and wrapper blocks with upward DOM traversal.
  - Eliminated the fullscreen transparent overlay that caused dropped hit-tests, pointer-event capture bugs, and broken bounding boxes; replaced with zero-overhead capture listeners on `window` and global crosshair style injection.
  - Added real-time visual indicator card on targeted elements showing tag name, ID, class, rendered dimensions (`W × H px`), and extracted domain name (`🌐 domain.com`).
  - Added keyboard container stepping: press `↑` or `W` to expand bounding box to parent container, `↓` or `S` to narrow to leaf element, `Enter` to delete, and `Esc` to cancel.
  - Added top-center screen indicator banner ("Element Deletion Mode") and post-deletion floating toast notification confirming the removed element.
  - Added null guards and graceful fallback handling so clicking empty page regions exits cleanly without throwing errors.

### Added
- **Popup Window Resize System (`popup/popup.html`, `popup/popup.js`)**:
  - Added size preset buttons (`S: 480×450`, `M: 575×550`, `L: 780×600`) in the header for 1-click resizing.
  - Added interactive drag-resize corner handle in the bottom-right for freeform resizing between 420px–800px width and 400px–600px height.
  - Persisted user-selected dimensions in `chrome.storage.local` across popup sessions.
- **Save Domain Blocklist Button in Requests View (`popup/popup.html`, `popup/popup.js`, `service-worker.js`)**:
  - Added `💾 Save` button alongside `Block` on every captured network request row.
  - Automatically extracts and normalizes the target domain, appends to `savedBlockedDomains`, merges into `adHosts`, registers dynamic DNR block rules, and hides matching elements in real-time.
  - Added `export list` button to the Requests header to download the complete domain blocklist as a `.txt` file.
  - Ensured `savedBlockedDomains` are retained and merged on browser/extension startup and background fetches.

### Changed
- **Lists Tab Layout Hierarchy (`popup/popup.html`)**:
  - Moved the **Todo List** to the top half and the **Scratchpad** to the bottom half for improved daily task visibility.

---

## [2026-10-20] — Sniping Game Engine Visual Beautification & AAA Polish

### Added
- **Dynamic Gradient Sky & Twinkling Stars (`content/sniper-game.js`)**:
  - Replaced flat semi-transparent backdrop with animated gradient canvas sky shifting smoothly across deep navy, dusky purple, and atmospheric twilight tones.
  - Added starfield system (`initStars`, `renderSky`) with 60 twinkling stars featuring randomized twinkle phase and radius.
- **Volumetric Cloud System (`content/sniper-game.js`)**:
  - Upgraded flat ellipse clouds into soft, multi-layered radial gradient cloud puffs (`renderClouds`).
  - Added cloud drift simulation in both `PLAYING` and `GAME_OVER` states (`updateClouds`).
- **Tactical Multi-Layered Crosshair (`content/sniper-game.js`)**:
  - Implemented dynamic weapon-tinted outer rotating ring with 8 tick marks, inner reticle with center gap, pulsing center dot, weapon mode icon indicator (`◎SNP`, `◉SHG`, `⚡MAG`), and a real-time circular reload cooldown progress arc.
- **Glassmorphism HUD Bar (`content/sniper-game.js`)**:
  - Redesigned top HUD bar with frosted glass aesthetic (`rgba(20, 20, 35, 0.65)`), subtle gradient specular highlight, and glowing accent bottom border.
  - Added pill-shaped animated combo badge with flame styling (`×N 🔥`), animated gradient player health bar (10 HP with green/amber/red dynamic color transitions), weapon slot badges with active selection indicator, and real-time ammo pips for Shotgun/Magnum.
- **Cinematic Radar Scope Loading Screen (`content/sniper-game.js`)**:
  - Upgraded loading phase with radial vignette background, dual rotating radar scope rings with 12 tick marks, pulsing center scope dot, glowing neon typography, and a gradient progress bar with glowing leading edge and live percentage indicator.
- **Glassmorphism Game Over Results Card (`content/sniper-game.js`)**:
  - Enhanced victory/defeat card with 30px drop shadow, top specular glass highlight stripe, and individual pill container backgrounds for each statistic row.
  - Added modern gradient quit button with specular highlight, hover glow border, and smooth pointer tracking.
- **Combat Feedback & Visual FX Polish (`content/sniper-game.js`)**:
  - Integrated red radial vignette damage pulse on taking damage from aggressive red flasher birds.
  - Added multi-layered weapon muzzle flash burst at crosshair coordinates.
  - Enhanced particle explosion engine with 3-segment motion trails, outer glow halos, and shadow-blurred floating score/event text popups.
  - Enhanced bird visuals with feather pattern curves, depth gradients, drop shadows, and pulsing radial glow rings for special targets (Golden Shiny & Red Flasher).
  - Modernized dark-mode color palette constants with softer, high-contrast tones.

---

## [2026-10-18] — Fix Block New Tab Ads Definition, Overblocking & Rule ID Collisions

### Fixed
- **Block New Tab Ads Overblocking Legitimate Websites (`popup.js`)**:
  - **Root Cause**: `toggleNewTabBlock()` previously iterated through generic substring patterns from `adPatterns` (e.g. `"tracker"`, `"tracking"`, `"analytics"`, `"sponsored"`, `"/banner"`) alongside `adHosts` with `resourceTypes: ['main_frame']`. This inadvertently caused Chrome to block normal browsing to sites like `analytics.google.com`, FedEx/UPS tracking pages, or search queries containing tracker keywords.
  - **Fix**: Aligned with the defined specification in `Architecture.md` and `ChangeLog.md` by restricting `main_frame` blocking strictly to known ad hosts (`adHosts`), omitting generic URL path patterns.
- **"Rule with id 40001 does not have a unique ID" Crash on Toggle & Sniping Game (`popup.js`)**:
  - **Root Cause**: When activating `Block New Tab Ads` or launching the Sniping Game, existing dynamic rules were removed only based on rule IDs found in `chrome.storage.local`. If storage was desynchronized from the browser DNR engine (e.g. after a crash or restart), calling `updateDynamicRules` with `addRules` starting at 40001 threw a duplicate rule ID error and failed.
  - **Fix**: Both `toggleNewTabBlock()` and `handleSnipingGame()` now query the actual DNR engine directly via `chrome.declarativeNetRequest.getDynamicRules()`, filter all existing IDs in the `40001–49999` range, and atomically pass them into `removeRuleIds` alongside `addRules` in a single update call. Added auto-recovery in the catch block to wipe orphan rules if an error ever occurs.
- **Dead & Misrouted Window Open Override Messaging (`popup.js`)**:
  - Removed defunct `sendToTab({ type: 'INJECT_WINDOW_OPEN_OVERRIDE' })` and `RESTORE_WINDOW_OPEN_OVERRIDE` calls from `toggleNewTabBlock()`. These messages were sent to the tab's content script (which has no listener) rather than background, and the service worker's `noopOpen` override would break legitimate user navigation.
- **AI Intent & Feature Toggle Synchronization (`nano-client.js`)**:
  - Upgraded `detectDirectIntent` to distinguish disable/turn-off commands from enable commands, passing `state: false` when the user asks to turn off new tab blocking.
  - Added support for explicit boolean state in `toggleNewTabBlock(explicitState)`.
  - Updated `tool_toggle_feature` in `nano-client.js` to respect `args.state`, reliably setting target state and reporting accurate activation/deactivation messages.

### Added
- **Cross-Domain New Tab Ad Interceptor (`service-worker.js`)**:
  - Implemented base domain extraction (`getBaseDomain`) and comparison (`isSameDomain`, `extractDomain`) supporting standard TLDs and multi-part ccTLDs (`.co.uk`, `.com.au`, `.co.in`, etc.).
  - Added new-tab cross-domain interception via `chrome.tabs.onCreated` and `chrome.tabs.onUpdated`: when `newTabBlockActive` is enabled (or during gaming mode), any new tab opened by an opener page whose destination domain does not match the opener tab's base domain is automatically closed/blocked.
  - Asynchronous navigation tracking: handles tabs created with `about:blank` or pending URLs via in-memory `pendingOpenerTabs` map with self-pruning TTL (30s) and cleanup on `chrome.tabs.onRemoved`.
  - System page protection: exempts browser internal schemes (`chrome://`, `chrome-extension://`, `edge://`, `brave://`, `about:blank`, new tab pages) from accidental closure.

---

## [2026-10-17] — Gemini 3.8 Release: Personal Assistant & Lists Architecture Overhaul

### Fixed
- **Inline Page Summarisation (`popup.js`, `nano-client.js`)**:
  - Eliminated unwanted external browser tab creation (`chrome.tabs.create({ url: blobUrl })`) when summarising a page.
  - Page summaries now render and stream directly inline within the Personal Assistant chat interface (`#ast-chat-history`).
- **Todo List & Scratchpad Functionality (`nano-client.js`, `popup.js`)**:
  - Implemented `detectAssistantDirectIntent` in `nano-client.js` for deterministic pre-dispatch of assistant commands (`add_todo`, `add_scratchpad`, `get_todos`, `summarize_page`), eliminating reliance on on-device 3B model JSON generation.
  - Upgraded `executeMcpAction` to persist directly and authoritatively to `chrome.storage.local` for `tool_add_todo` and `tool_add_scratchpad` instead of relying exclusively on in-memory DOM CustomEvents.
  - Removed flawed 300ms debounce on Scratchpad; notes now persist immediately on each `input` event, eliminating note loss caused by instant popup process termination on blur.
  - Fixed Todo item accordion event bubbling: stopped `click` propagation on checkboxes and throughout `.todo-details`, attached expand/collapse strictly to `contentRow`, and made description edits persist immediately on `input`.
  - Added `chrome.storage.onChanged` listener and tab-switch synchronization (`refreshListsPanel()`) so the Lists tab stays in sync with AI actions in real time.
- **Chat History Restoration & Premature Erasure (`popup.js`)**:
  - Removed broken duplicate history restoration in `DOMContentLoaded` that targeted non-existent element `#ast-chat` with mismatched CSS classes.
  - Fixed timestamp staleness in `handleAstSend()` by persisting `astLastUpdate: Date.now()` and `astLastUrl` alongside `astHistory`, preventing chats from prematurely expiring across popup sessions.
  - Added copy button rendering for restored assistant messages (`role === 'assistant'`).
- **MCP Action Contract Desynchronization & Task Loss (`nano-client.js`)**:
  - Fixed issue in `processAssistantPrompt()` where `tool_get_todos` output was dropped if the model returned an introductory greeting or preamble. Now concatenates preamble text with the structured todo report.
  - Cleaned dead `tool_get_todos` branch inside the second-pass synthesis pipeline.

### Added
- **Interactive Context Depth Telemetry (`popup.html`, `popup.js`)**:
  - Replaced static turn text with real-time `Math.floor(astHistory.length / 2)` turn telemetry.
  - Added an interactive context slider (`#ast-context-slider`, 2–20 turns) to configure dialogue memory depth on the fly.
- **Smart Lists & Assistant Bi-Directional Bridge (`popup.html`, `popup.js`)**:
  - Added `🪄 Convert to Tasks` button in Scratchpad header to automatically parse notes into Todo items.
  - Added `📥 Send to Chat` button to forward Scratchpad notes directly into the Personal Assistant input prompt.
  - Added Todo filter pills (`All`, `Pending`, `🔥 Urgent`, `Done`) in the Todo List header.
  - Replaced blurry `scaleY` CSS distortion on overdue tasks with modern pulsating urgency badges and color-coded accent borders.
  - Added timezone-safe local date parsing and card expansion state preservation during edits.
- **Enhanced Todo List UI with ETA & Dynamic Urgency (`popup.html`, `popup.js`)**:
  - Expandable task cards with creation dates, ETAs, descriptions, and dynamic progress bar color indicators.
  - Day summary synthesis with pre-grouped task categories in `tool_get_todos`.
- **Thinking Animation & Dynamic Feedback (`popup.js`, `popup.html`)**:
  - Replaced static text with an animated word-cycling indicator featuring 69 thinking synonyms cycling every 600ms with a buzzing brain emoji.
  - Added one-click **Copy** button on AI message bubbles and **Download Chat** button to export conversations.
- **UI Distraction-Free Rebranding**:
  - Rebranded "Paywall" terminology to "Distraction free Reading" across all UI elements and AI directives.

### Optimized
- **Gemini Nano Session Turn Tracking & Error Recovery (`nano-client.js`)**:
  - Eliminated quadratic $O(N^2)$ prompt token bloat on stateful session turns by only seeding conversation history on fresh session starts (`_assistantSessionPromptCount === 0`).
  - Added `expectedOutputLanguage: 'en'` across all assistant session creation tiers to suppress Chrome engine warnings and optimize tokenization.
  - Implemented automated session self-healing via `destroyAssistantSession()` on prompt errors to prevent permanent zombie session locks.

---

## [2026-10-03] — Personal Assistant Deep Audit & Bug Fixes

### Fixed
- **Summarization Context Overflow**: Fixed an issue where asking the Personal Assistant to "summarize this page" would silently fail and output only the raw extraction status. The synthesis pass was blowing Gemini Nano's context window by re-feeding the full system prompt and up to 16,000 characters of extracted text on the same session. Fixed by creating a fresh synthesis session and aggressively truncating input to ~8000 characters.
- **Context Poisoning & Exponential Token Growth**: Fixed a critical bug in `nano-client.js` where the entire conversation history was manually appended to the prompt on every turn, exponentially duplicating history since `session.prompt()` already maintains its own internal context.
- **Race Condition in Session Initialization**: Replaced dangerous polling loops in `getOrCreateSession` and `getAssistantSession` with strict Promise-based locks, preventing duplicate concurrent `lm.create()` calls from leaking memory and creating orphaned sessions.
- **Leaking Chrome Message Ports**: Removed a blanket `return true;` in `content.js`'s message listener that was leaking ports on every synchronous AI action (like DOM cleanup or overlay removal), causing Chrome extension errors.
- **Session Crash Recovery**: Added robust catch blocks to `processAssistantPrompt` that detect fatal Gemini Nano errors (like token exhaustion) and actively `destroy()` the corrupted session, allowing automatic recovery on the user's next prompt.

### Optimized
- **O(N²) Streaming Processing Lag**: Heavily optimized the token streaming loops in `nano-client.js`. `cleanActionFromReply` now fires only every 10 chunks or when an action block is detected, eliminating severe UI thread stalling caused by parsing the entire accumulated string on every single token.
- **MutationObserver Batching**: Refactored the `content.js` DOM observer to use `requestAnimationFrame` batching instead of running `querySelectorAll` synchronously for every individual node added to the DOM, fixing main-thread freezes on modern single-page apps.
- **Redundant Token Counting**: Replaced the expensive async `session.countPromptTokens()` call on the output response with a fast character-based heuristic.

### Added
- **Chat History Persistence**: The Personal Assistant now automatically saves conversations to `chrome.storage.local` and restores them when the popup opens.
- **Robust Content Script Injection**: Replaced a flaky 120ms hardcoded delay in `popup.js` with an exponential backoff `PING`-polling mechanism, ensuring AI commands don't randomly fail on heavy tabs.

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
