# AdSniper Project — AI Knowledge Base

This workspace contains the **AdSniper** Chrome extension located at `adsniper/`.

## MANDATORY: Read before every task

Before making any code changes or answering questions about this project, you MUST read the architecture file:

**File:** `adsniper/Architecture.md`

This file contains:
- Full app summary
- Component architecture diagram and data flow
- Complete file tree and function map for every file
- Storage key table (critical — do not create duplicate keys)
- DNR rule ID ranges (critical — do not conflict)
- Hard constraints and anti-patterns
- Standard patterns for adding new features
- Complete message type table (all SW ↔ Popup ↔ Content Script messages)

## MANDATORY: Update after architectural changes

If you make any changes to the architecture, storage keys, DNR rules, message types, or add new files/functions, you MUST update `adsniper/Architecture.md` to reflect these changes.

## MANDATORY: Update ChangeLog on every code change

After making any code changes to the AdSniper extension, you MUST prepend a dated summary entry to `adsniper/ChangeLog.md`. Include what was added/changed/fixed, which files were modified, and any new storage keys or rule ID ranges.


## Quick facts (for trivial questions that do not require a full read)

- **Extension**: Manifest V3, `adsniper/manifest.json`
- **Blocking engine**: `declarativeNetRequest` only (not webRequest)
- **Popup**: `popup/popup.html` + `popup/popup.js` — calls chrome.* APIs directly, no SW relay for UI
- **Content script**: `content/content.js` — injected at `document_idle` into all http/https pages
- **Service worker**: `service-worker.js` — logs requests, cookie locks, block counts, ADD_BLOCK_RULE handler
- **Ad patterns**: fetched from pgl.yoyo.org on install; fallback: `data/ad-patterns.json`
- **State**: all persistent state lives in `chrome.storage.local` (SW has no persistent memory)
- **DNR rule IDs**: user rules 1001–39999, new-tab-block 40001–49999, mass-block 50001+
