/**
 * AdSniper v2 — Service Worker
 *
 * Slim background script. All UI logic lives in popup.js using direct chrome.* API calls.
 * The SW is responsible for:
 *   1. Observing network requests → rolling per-tab log in chrome.storage.local
 *   2. Enforcing cookie locks via chrome.cookies.onChanged
 *   3. Fetching ad-host data on first install (internet → fallback JSON)
 */

'use strict';

const MAX_REQUESTS_PER_TAB = 100;
const INITIAL_RULE_ID = 1001;

// Source: Peter Lowe's ad-server list — plain text, one hostname per line, no headers
const AD_HOSTS_FETCH_URL =
  'https://pgl.yoyo.org/adservers/serverlist.php?hostformat=nohtml&showintro=0&mimetype=plaintext';

// ---------------------------------------------------------------------------
// 1. webRequest logger — observe all URLs, store per tab (Batched)
// ---------------------------------------------------------------------------
const pendingRequests = new Map();
let requestFlushTimer = null;

async function flushRequests() {
  requestFlushTimer = null;
  if (pendingRequests.size === 0) return;

  const pending = new Map(pendingRequests);
  pendingRequests.clear();

  try {
    const keys = Array.from(pending.keys());
    const stored = await chrome.storage.local.get(keys);
    
    for (const [key, newReqs] of pending.entries()) {
      let existing = stored[key] || [];
      // Prepend newest first
      existing.unshift(...newReqs);
      if (existing.length > MAX_REQUESTS_PER_TAB) existing.length = MAX_REQUESTS_PER_TAB;
      stored[key] = existing;
    }
    
    await chrome.storage.local.set(stored);
  } catch (err) {
    console.warn('[AdSniper] Failed to flush requests:', err.message);
  }
}

function handleBeforeRequest(details) {
  if (details.tabId < 0) return; // Ignore background/browser requests

  (async () => {
    const { monitoringEnabled = true } = await chrome.storage.local.get('monitoringEnabled');
    if (!monitoringEnabled) return;

    let postData = null;
    if (details.requestBody) {
      if (details.requestBody.formData) {
        postData = details.requestBody.formData;
      } else if (details.requestBody.raw && details.requestBody.raw.length > 0) {
        try {
          const dec = new TextDecoder('utf-8');
          postData = dec.decode(details.requestBody.raw[0].bytes);
          if (postData && postData.length > 300) postData = postData.slice(0, 300) + '…';
        } catch (e) {}
      }
    }

    const key = `requests_${details.tabId}`;
    if (!pendingRequests.has(key)) {
      pendingRequests.set(key, []);
    }
    
    pendingRequests.get(key).unshift({
      url: details.url,
      method: details.method || 'GET',
      type: details.type,
      postData,
      timestamp: Date.now(),
    });

    if (!requestFlushTimer) {
      requestFlushTimer = setTimeout(flushRequests, 2000);
    }
  })().catch(() => {});
}

try {
  chrome.webRequest.onBeforeRequest.addListener(
    handleBeforeRequest,
    { urls: ['<all_urls>'] },
    ['requestBody']
  );
} catch (e) {
  chrome.webRequest.onBeforeRequest.addListener(
    handleBeforeRequest,
    { urls: ['<all_urls>'] }
  );
}

// ---------------------------------------------------------------------------
// 2. Cleanup — remove log when tab is closed
// ---------------------------------------------------------------------------
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const key = `requests_${tabId}`;
  pendingRequests.delete(key);
  await chrome.storage.local.remove(key);
  const { snipingActiveTabId } = await chrome.storage.local.get('snipingActiveTabId');
  if (snipingActiveTabId === tabId) {
    await chrome.storage.local.remove('snipingActiveTabId');
  }
});

// ---------------------------------------------------------------------------
// 2b. Block ads from opening new tabs while gaming
// ---------------------------------------------------------------------------
chrome.tabs.onCreated.addListener(async (newTab) => {
  if (!newTab.openerTabId) return;

  const targetUrl = (newTab.url || newTab.pendingUrl || '').toLowerCase();

  // NEVER close Chrome system pages, new-tab pages, empty tabs, or extension pages
  if (
    !targetUrl ||
    targetUrl === 'about:blank' ||
    targetUrl.startsWith('chrome://') ||
    targetUrl.startsWith('chrome-extension://') ||
    targetUrl.startsWith('edge://') ||
    targetUrl.startsWith('brave://') ||
    targetUrl.includes('newtab')
  ) {
    return;
  }

  const { snipingActiveTabId } = await chrome.storage.local.get('snipingActiveTabId');
  if (snipingActiveTabId && newTab.openerTabId === snipingActiveTabId) {
    try {
      console.log('[AdSniper] Closed unwanted popup tab opened by game tab:', newTab.id, targetUrl);
      await chrome.tabs.remove(newTab.id);
    } catch { /* Tab may already be closed */ }
  }
});

// ---------------------------------------------------------------------------
// 3. Block-count tracker — increments a storage counter every time a DNR rule fires
//    Requires the declarativeNetRequestFeedback permission (already declared).
//    Uses in-memory batch to avoid hammering storage on every single match.
// ---------------------------------------------------------------------------
const pendingBlockCounts = {};
let blockCountFlushTimer = null;

async function flushBlockCounts() {
  blockCountFlushTimer = null;
  const pending = Object.assign({}, pendingBlockCounts);
  // Clear pending immediately so new events start a fresh batch
  for (const k of Object.keys(pendingBlockCounts)) delete pendingBlockCounts[k];

  if (Object.keys(pending).length === 0) return;

  try {
    const { blockCounts = {} } = await chrome.storage.local.get('blockCounts');
    for (const ruleId of Object.keys(pending)) {
      blockCounts[ruleId] = (blockCounts[ruleId] || 0) + pending[ruleId];
    }
    await chrome.storage.local.set({ blockCounts });
  } catch (err) {
    console.warn('[AdSniper] Failed to flush block counts:', err.message);
  }
}

chrome.declarativeNetRequest.onRuleMatchedDebug.addListener(async (info) => {
  // ── Batch-increment per-rule block count ──
  const ruleId = String(info.rule.ruleId);
  pendingBlockCounts[ruleId] = (pendingBlockCounts[ruleId] || 0) + 1;

  // Flush to storage at most once every 5 seconds
  if (!blockCountFlushTimer) {
    blockCountFlushTimer = setTimeout(flushBlockCounts, 5000);
  }

  // ── Notify content script to hide the matching DOM element ──
  const { domCleanupEnabled = true } = await chrome.storage.local.get('domCleanupEnabled');
  if (domCleanupEnabled && info.request.tabId > 0) {
    try {
      await chrome.tabs.sendMessage(info.request.tabId, {
        type: 'REMOVE_AD_ELEMENT',
        url: info.request.url,
      });
    } catch { /* Tab has no content script (e.g. chrome://, PDF) — safe to ignore */ }
  }
});

// ---------------------------------------------------------------------------
// 4. Cookie lock enforcement
//    When a locked cookie is modified by the page, immediately restore its locked value.
//    The `cookie.value === locked.value` guard prevents an infinite restore loop.
// ---------------------------------------------------------------------------
chrome.cookies.onChanged.addListener(async (changeInfo) => {
  if (changeInfo.removed) return; // Only care about sets/updates

  const cookie = changeInfo.cookie;
  const { lockedCookies = {} } = await chrome.storage.local.get('lockedCookies');
  const lockKey = `${cookie.domain}::${cookie.name}`;

  const locked = lockedCookies[lockKey];
  if (!locked) return;
  if (cookie.value === locked.value) return; // Already correct — prevents restore loop

  try {
    const scheme = cookie.secure ? 'https' : 'http';
    const rawDomain = cookie.domain.startsWith('.') ? cookie.domain.slice(1) : cookie.domain;
    await chrome.cookies.set({
      url: `${scheme}://${rawDomain}${cookie.path || '/'}`,
      name: locked.name,
      value: locked.value,
      domain: cookie.domain,
      path: cookie.path || '/',
      secure: cookie.secure,
      httpOnly: cookie.httpOnly,
      sameSite: cookie.sameSite,
      ...(locked.expirationDate ? { expirationDate: locked.expirationDate } : {}),
    });
  } catch (err) {
    console.warn('[AdSniper] Failed to restore locked cookie:', lockKey, err.message);
  }
});

// ---------------------------------------------------------------------------
// 5. Message handler — content script requests (element picker → block rule)
// ---------------------------------------------------------------------------
const RESOURCE_TYPES_SW = [
  'main_frame','sub_frame','script','image','xmlhttprequest',
  'media','font','stylesheet','ping','object','websocket','other',
];

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'ADD_BLOCK_RULE') {
    (async () => {
      try {
        let { nextRuleId = 1001 } = await chrome.storage.local.get('nextRuleId');
        
        // Auto-recover if storage got out of sync with DNR
        const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
        const maxId = existingRules.reduce((max, r) => (r.id < 40000 && r.id > max ? r.id : max), 1000);
        if (nextRuleId <= maxId) {
          nextRuleId = maxId + 1;
        }

        await chrome.declarativeNetRequest.updateDynamicRules({
          addRules: [{
            id: nextRuleId,
            priority: 1,
            action: { type: 'block' },
            condition: { urlFilter: message.pattern, resourceTypes: RESOURCE_TYPES_SW },
          }],
          removeRuleIds: [nextRuleId], // Safely remove just in case
        });
        await chrome.storage.local.set({ nextRuleId: nextRuleId + 1 });

        // Update badge
        const rules = await chrome.declarativeNetRequest.getDynamicRules();
        await chrome.action.setBadgeText({ text: rules.length > 0 ? String(rules.length) : '' });
        await chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });

        sendResponse({ ok: true, ruleId: nextRuleId });
      } catch (err) {
        console.error('[AdSniper] ADD_BLOCK_RULE failed:', err);
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true; // Keep channel open for async response
  }

  // ── Track gaming tab to block ad popups from opening new tabs ──
  if (message.type === 'SNIPING_GAME_STARTED') {
    if (sender.tab && sender.tab.id) {
      chrome.storage.local.set({ snipingActiveTabId: sender.tab.id });
    }
    sendResponse({ ok: true });
    return;
  }

  // ── Immediately unhook active sniping tab tracking ──
  if (message.type === 'SNIPING_GAME_ENDED') {
    (async () => {
      try {
        await chrome.storage.local.remove(['snipingActiveTabId', 'snipingGamePending']);
        console.log('[AdSniper] Cleared active sniping tab state');
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }


  // ── Execute AI Scripts in MAIN world safely via chrome.scripting (C3 Fix) ──
  if (message.type === 'AI_EXECUTE_SCRIPT_MAIN_WORLD') {
    if (sender.tab && sender.tab.id) {
      (async () => {
        try {
          const results = await chrome.scripting.executeScript({
            target: { tabId: sender.tab.id },
            world: 'MAIN',
            func: (codeToRun) => {
              try {
                // Return eval inside MAIN world sandbox
                return { result: eval(codeToRun) };
              } catch (err) {
                return { error: err.message };
              }
            },
            args: [message.code]
          });
          sendResponse({ ok: true, result: results[0]?.result?.result, error: results[0]?.result?.error });
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
      })();
      return true;
    }
  }

  // ── Inject Window Open Override in MAIN world (I2 Fix) ──
  if (message.type === 'INJECT_WINDOW_OPEN_OVERRIDE') {
    if (sender.tab && sender.tab.id) {
      (async () => {
        try {
          await chrome.scripting.executeScript({
            target: { tabId: sender.tab.id },
            world: 'MAIN',
            func: () => {
              try {
                if (!window.__adsniper_orig_open) {
                  window.__adsniper_orig_open = window.open;
                }
                const noopOpen = function(url, target, features) {
                  console.warn('[AdSniper] Blocked ad script from opening new tab:', url);
                  return null;
                };
                window.open = noopOpen;
                try { if (window.top) window.top.open = noopOpen; } catch (e) {}
                try { if (window.parent) window.parent.open = noopOpen; } catch (e) {}

                window.addEventListener('message', function(e) {
                  if (e.data && (e.data.$G$ || (typeof e.data === 'object' && e.data.event === 'open'))) {
                    e.stopImmediatePropagation();
                    console.warn('[AdSniper] Blocked ad postMessage in page context:', e.data);
                  }
                }, true);
              } catch (err) {}
            }
          });
          sendResponse({ ok: true });
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
      })();
      return true;
    }
  }
  
  // ── Restore Window Open Override in MAIN world (I2 Fix) ──
  if (message.type === 'RESTORE_WINDOW_OPEN_OVERRIDE') {
    if (sender.tab && sender.tab.id) {
      (async () => {
        try {
          await chrome.scripting.executeScript({
            target: { tabId: sender.tab.id },
            world: 'MAIN',
            func: () => {
              try {
                if (window.__adsniper_orig_open) {
                  window.open = window.__adsniper_orig_open;
                  try { if (window.top) window.top.open = window.__adsniper_orig_open; } catch (e) {}
                  try { if (window.parent) window.parent.open = window.__adsniper_orig_open; } catch (e) {}
                  delete window.__adsniper_orig_open;
                }
              } catch (err) {}
            }
          });
          sendResponse({ ok: true });
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
      })();
      return true;
    }
  }

  // ── Close dedicated game tab when user clicks Quit Game ──
  if (message.type === 'CLOSE_CURRENT_TAB') {
    if (sender.tab && sender.tab.id) {
      try {
        chrome.tabs.remove(sender.tab.id);
      } catch (e) { /* ignore */ }
    }
    sendResponse({ ok: true });
    return;
  }

  // ── Restore blocking state after sniping game ends ──
  if (message.type === 'RESTORE_SNIPING_STATE') {
    (async () => {
      try {
        // Guarantee game tab active ID is cleared immediately
        await chrome.storage.local.remove(['snipingActiveTabId', 'snipingGamePending']);

        const { snipingPreGameState = null } =
          await chrome.storage.local.get('snipingPreGameState');

        if (!snipingPreGameState) {
          sendResponse({ ok: true, note: 'no pre-game state' });
          return;
        }

        // Restore DOM cleanup and iframe blocker flags
        await chrome.storage.local.set({
          domCleanupEnabled: snipingPreGameState.domCleanupEnabled !== false,
          iframeBlockerEnabled: snipingPreGameState.iframeBlockerEnabled === true,
        });

        // Query all existing dynamic rules to safely avoid duplicate ID collisions
        const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
        const existingMassBlockIds = existingRules
          .filter((r) => r.id >= 50001)
          .map((r) => r.id);
        const existingNewTabIds = existingRules
          .filter((r) => r.id >= 40001 && r.id < 50000)
          .map((r) => r.id);

        // Re-enable mass-block DNR rules if they were active
        if (snipingPreGameState.massBlockActive) {
          const { adHosts = [], adPatterns = [] } =
            await chrome.storage.local.get(['adHosts', 'adPatterns']);

          const rules = [];
          let id = 50001; // MASS_BLOCK_BASE_ID

          for (const host of adHosts) {
            if (!host) continue;
            rules.push({
              id: id++,
              priority: 2,
              action: { type: 'block' },
              condition: { urlFilter: `||${host}`, resourceTypes: RESOURCE_TYPES_SW },
            });
          }
          for (const pattern of adPatterns) {
            if (!pattern) continue;
            rules.push({
              id: id++,
              priority: 2,
              action: { type: 'block' },
              condition: { urlFilter: pattern, resourceTypes: RESOURCE_TYPES_SW },
            });
          }

          await chrome.declarativeNetRequest.updateDynamicRules({
            addRules: rules,
            removeRuleIds: existingMassBlockIds, // Remove any existing rules first to prevent duplicate ID crashes
          });
          await chrome.storage.local.set({
            massBlockActive: true,
            massBlockRuleIds: rules.map((r) => r.id),
          });
        } else {
          if (existingMassBlockIds.length > 0) {
            await chrome.declarativeNetRequest.updateDynamicRules({
              addRules: [],
              removeRuleIds: existingMassBlockIds,
            });
          }
          await chrome.storage.local.set({
            massBlockActive: false,
            massBlockRuleIds: [],
          });
        }

        // Re-enable new-tab-block DNR rules if they were active
        if (snipingPreGameState.newTabBlockActive) {
          const { adHosts = [] } = await chrome.storage.local.get('adHosts');

          const rules = [];
          let id = 40001; // NEW_TAB_BLOCK_BASE_ID

          for (const host of adHosts) {
            if (!host) continue;
            if (id >= 50000) break;
            rules.push({
              id: id++,
              priority: 3,
              action: { type: 'block' },
              condition: { urlFilter: `||${host}`, resourceTypes: ['main_frame'] },
            });
          }

          await chrome.declarativeNetRequest.updateDynamicRules({
            addRules: rules,
            removeRuleIds: existingNewTabIds, // Remove any existing rules first to prevent duplicate ID crashes
          });
          await chrome.storage.local.set({
            newTabBlockActive: true,
            newTabBlockRuleIds: rules.map((r) => r.id),
          });
        } else {
          if (existingNewTabIds.length > 0) {
            await chrome.declarativeNetRequest.updateDynamicRules({
              addRules: [],
              removeRuleIds: existingNewTabIds,
            });
          }
          await chrome.storage.local.set({
            newTabBlockActive: false,
            newTabBlockRuleIds: [],
          });
        }

        // Update badge
        const allRules = await chrome.declarativeNetRequest.getDynamicRules();
        await chrome.action.setBadgeText({ text: allRules.length > 0 ? String(allRules.length) : '' });
        await chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });

        // Clean up saved state
        await chrome.storage.local.remove(['snipingPreGameState', 'snipingActiveTabId']);
        console.log('[AdSniper] Sniping game state restored successfully');

        sendResponse({ ok: true });
      } catch (err) {
        console.error('[AdSniper] RESTORE_SNIPING_STATE failed:', err);
        sendResponse({ ok: false, error: err.message });
      } finally {
        await chrome.storage.local.remove(['snipingActiveTabId', 'snipingGamePending']);
      }
    })();
    return true;
  }
});

// ---------------------------------------------------------------------------
// 6. Install / update hook
// ---------------------------------------------------------------------------
async function cleanupOrphanedData() {
  try {
    const allStorage = await chrome.storage.local.get(null);
    const keysToRemove = [];
    const openTabs = await chrome.tabs.query({});
    const openTabIds = new Set(openTabs.map(t => t.id));

    for (const key of Object.keys(allStorage)) {
      if (key.startsWith('blockCount_')) {
        keysToRemove.push(key);
      } else if (key.startsWith('requests_')) {
        const tabIdStr = key.replace('requests_', '');
        if (tabIdStr !== 'global' && !openTabIds.has(Number(tabIdStr))) {
          keysToRemove.push(key);
        }
      }
    }

    if (keysToRemove.length > 0) {
      await chrome.storage.local.remove(keysToRemove);
      console.log(`[AdSniper] Storage cleanup: removed ${keysToRemove.length} stale/legacy keys.`);
    }
  } catch (err) {
    console.warn('[AdSniper] Storage cleanup failed:', err);
  }
}

chrome.runtime.onStartup.addListener(() => cleanupOrphanedData());

chrome.runtime.onSuspend.addListener(() => {
  // Ensure we don't lose batched in-memory data when the ephemeral MV3 worker goes to sleep
  flushRequests();
  if (typeof flushBlockCounts === 'function') flushBlockCounts();
});

async function cleanupOrphanedData() {
  try {
    const allStorage = await chrome.storage.local.get(null);
    const keysToRemove = [];
    const openTabs = await chrome.tabs.query({});
    const openTabIds = new Set(openTabs.map(t => t.id));

    for (const key of Object.keys(allStorage)) {
      if (key.startsWith('blockCount_')) {
        keysToRemove.push(key);
      } else if (key.startsWith('requests_')) {
        const tabIdStr = key.replace('requests_', '');
        if (tabIdStr !== 'global' && !openTabIds.has(Number(tabIdStr))) {
          keysToRemove.push(key);
        }
      }
    }

    if (keysToRemove.length > 0) {
      await chrome.storage.local.remove(keysToRemove);
      console.log(`[AdSniper] Storage cleanup: removed ${keysToRemove.length} stale/legacy keys.`);
    }
  } catch (err) {
    console.warn('[AdSniper] Storage cleanup failed:', err);
  }
}

chrome.runtime.onStartup.addListener(() => cleanupOrphanedData());

chrome.runtime.onSuspend.addListener(() => {
  // Ensure we don't lose batched in-memory data when the ephemeral MV3 worker goes to sleep
  flushRequests();
  if (typeof flushBlockCounts === 'function') flushBlockCounts();
});

chrome.runtime.onInstalled.addListener(async (details) => {
  // Set storage defaults on first install
  const { nextRuleId, aiEnabled } = await chrome.storage.local.get(['nextRuleId', 'aiEnabled']);
  if (!nextRuleId) {
    await chrome.storage.local.set({
      nextRuleId: INITIAL_RULE_ID,
      monitoringEnabled: true,
      lockedCookies: {},
      aiEnabled: false,
    });
  } else if (aiEnabled === undefined) {
    await chrome.storage.local.set({ aiEnabled: false });
  }

  // Fetch ad patterns on first install only
  if (details.reason === 'install') {
    await fetchAndStoreAdPatterns();
  }

  // Restore badge if rules already exist (e.g. after extension reload)
  const rules = await chrome.declarativeNetRequest.getDynamicRules();
  if (rules.length > 0) {
    await chrome.action.setBadgeText({ text: String(rules.length) });
    await chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
  }

  // ── Run storage cleanup for legacy keys and orphaned tabs ──
  await cleanupOrphanedData();
});

// ---------------------------------------------------------------------------
// 5. Ad-pattern fetch — online first, bundled JSON fallback
// ---------------------------------------------------------------------------
async function fetchAndStoreAdPatterns() {
  // --- Try fetching from the internet ---
  try {
    const res = await fetch(AD_HOSTS_FETCH_URL, { cache: 'no-store' });
    if (res.ok) {
      const text = await res.text();
      const hosts = text
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'))
        .slice(0, 500); // cap at 500 hosts

      if (hosts.length > 0) {
        await chrome.storage.local.set({ adHosts: hosts, adPatternsUpdated: Date.now() });
        console.log(`[AdSniper] Loaded ${hosts.length} ad hosts from internet`);
        return;
      }
    }
  } catch (err) {
    console.warn('[AdSniper] Online fetch failed, using bundled fallback:', err.message);
  }

  // --- Fallback: bundled data/ad-patterns.json ---
  try {
    const fallbackRes = await fetch(chrome.runtime.getURL('data/ad-patterns.json'));
    const data = await fallbackRes.json();
    await chrome.storage.local.set({
      adHosts: data.hosts || [],
      adPatterns: data.patterns || [],
      adPatternsUpdated: Date.now(),
    });
    console.log('[AdSniper] Loaded bundled fallback ad patterns');
  } catch (err) {
    console.warn('[AdSniper] Failed to load bundled fallback:', err.message);
  }
}
