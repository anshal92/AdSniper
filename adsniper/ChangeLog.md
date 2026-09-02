# AdSniper — Change Log

All notable changes to the AdSniper extension are documented here. Newest entries first.

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
