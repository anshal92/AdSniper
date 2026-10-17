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
  pendingOpenerTabs.delete(tabId);
  const key = `requests_${tabId}`;
  pendingRequests.delete(key);
  await chrome.storage.local.remove(key);
  const { snipingActiveTabId } = await chrome.storage.local.get('snipingActiveTabId');
  if (snipingActiveTabId === tabId) {
    await chrome.storage.local.remove('snipingActiveTabId');
  }
});

// ---------------------------------------------------------------------------
// 2b. Block new tab ads (cross-domain new tabs & gaming popup protection)
// ---------------------------------------------------------------------------
// Map of newly created tab IDs awaiting their initial committed navigation:
// tabId -> { openerTabId, openerDomain, openerUrl, isGameTab, createdAt }
const pendingOpenerTabs = new Map();

/**
 * Extracts base registrable domain from hostname (e.g. 'sub.example.com' -> 'example.com',
 * 'sport.bbc.co.uk' -> 'bbc.co.uk').
 */
function getBaseDomain(hostname) {
  if (!hostname) return '';
  hostname = hostname.toLowerCase().trim();
  if (hostname.startsWith('[') && hostname.endsWith(']')) return hostname;
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(hostname)) return hostname;

  const parts = hostname.split('.');
  if (parts.length <= 2) return hostname;

  // Multi-part second-level ccTLDs (e.g. .co.uk, .com.au, .co.in, .org.uk, .com.br, etc.)
  if (/\.(co|com|net|org|edu|gov|ac|mil|gen|ne|nom)\.[a-z]{2}$/i.test(hostname)) {
    return parts.slice(-3).join('.');
  }
  return parts.slice(-2).join('.');
}

/**
 * Parses and returns base domain for valid http/https URLs. Returns null for non-http
 * protocols, system URLs (about:blank, chrome://, chrome-extension://), or empty URLs.
 */
function extractDomain(urlStr) {
  if (!urlStr || typeof urlStr !== 'string') return null;
  const trimmed = urlStr.trim();
  if (
    !trimmed ||
    trimmed === 'about:blank' ||
    trimmed.startsWith('chrome://') ||
    trimmed.startsWith('chrome-extension://') ||
    trimmed.startsWith('edge://') ||
    trimmed.startsWith('brave://') ||
    trimmed.startsWith('devtools://') ||
    trimmed.startsWith('view-source:') ||
    trimmed.startsWith('javascript:') ||
    trimmed.startsWith('data:') ||
    trimmed.includes('newtab')
  ) {
    return null;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    return getBaseDomain(parsed.hostname);
  } catch {
    return null;
  }
}

/**
 * Returns true if both URLs share the same base domain.
 */
function isSameDomain(url1, url2) {
  const d1 = extractDomain(url1);
  const d2 = extractDomain(url2);
  if (!d1 || !d2) return false;
  return d1 === d2;
}

/** Evicts pending opener tracking entries older than 30 seconds to prevent leaks */
function prunePendingOpenerTabs() {
  const now = Date.now();
  for (const [tabId, item] of pendingOpenerTabs.entries()) {
    if (now - item.createdAt > 30000) {
      pendingOpenerTabs.delete(tabId);
    }
  }
}

chrome.tabs.onCreated.addListener(async (newTab) => {
  if (!newTab || !newTab.id || !newTab.openerTabId) return;

  prunePendingOpenerTabs();

  const { newTabBlockActive = false, snipingActiveTabId } =
    await chrome.storage.local.get(['newTabBlockActive', 'snipingActiveTabId']);

  const isGameTab = Boolean(snipingActiveTabId && newTab.openerTabId === snipingActiveTabId);
  const isBlockNewTabActive = Boolean(newTabBlockActive);

  if (!isGameTab && !isBlockNewTabActive) {
    return;
  }

  // Retrieve opener tab information to evaluate origin domain
  let openerTab = null;
  try {
    openerTab = await chrome.tabs.get(newTab.openerTabId);
  } catch {
    // Opener tab may already be closed
  }

  // During gaming mode, close any popup tab spawned by the game tab (except system pages)
  if (isGameTab) {
    const rawTarget = (newTab.url || newTab.pendingUrl || '').toLowerCase();
    const isSystemPage =
      rawTarget.startsWith('chrome://') ||
      rawTarget.startsWith('chrome-extension://') ||
      rawTarget.startsWith('edge://') ||
      rawTarget.startsWith('brave://') ||
      rawTarget.includes('newtab');

    if (!isSystemPage) {
      if (rawTarget && rawTarget !== 'about:blank') {
        try {
          console.log('[AdSniper] Closed unwanted popup tab opened by game tab:', newTab.id, rawTarget);
          await chrome.tabs.remove(newTab.id);
        } catch { /* Tab may already be closed */ }
        return;
      } else {
        // Destination URL not yet known; track for onUpdated
        pendingOpenerTabs.set(newTab.id, {
          openerTabId: newTab.openerTabId,
          openerDomain: null,
          openerUrl: null,
          isGameTab: true,
          createdAt: Date.now(),
        });
        return;
      }
    }
  }

  // For Block New Tab Ads: compare opener domain vs target domain
  if (!openerTab) return;
  const openerUrl = openerTab.url || openerTab.pendingUrl || '';
  const openerDomain = extractDomain(openerUrl);

  // If opener is not an http/https page (e.g. extension page, chrome://), never block
  if (!openerDomain) return;

  const targetUrl = newTab.url || newTab.pendingUrl || '';
  const targetDomain = extractDomain(targetUrl);

  if (targetDomain) {
    // Target URL is already resolved
    if (targetDomain !== openerDomain) {
      try {
        console.log(`[AdSniper] Blocked cross-domain new tab (${targetDomain} !== ${openerDomain}):`, newTab.id, targetUrl);
        await chrome.tabs.remove(newTab.id);
      } catch { /* Tab may already be closed */ }
    }
  } else {
    // Target URL is pending or about:blank — track for onUpdated check
    const rawTarget = targetUrl.toLowerCase();
    const isSystemPage =
      rawTarget.startsWith('chrome://') ||
      rawTarget.startsWith('chrome-extension://') ||
      rawTarget.startsWith('edge://') ||
      rawTarget.startsWith('brave://') ||
      rawTarget.includes('newtab');

    if (!isSystemPage) {
      pendingOpenerTabs.set(newTab.id, {
        openerTabId: newTab.openerTabId,
        openerDomain,
        openerUrl,
        isGameTab: false,
        createdAt: Date.now(),
      });
    }
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!changeInfo.url) return;
  if (!pendingOpenerTabs.has(tabId)) return;

  const pending = pendingOpenerTabs.get(tabId);
  const targetUrl = changeInfo.url;
  const rawTarget = targetUrl.toLowerCase();

  // If still on about:blank, wait for destination
  if (rawTarget === 'about:blank') return;
  if (
    rawTarget.startsWith('chrome://') ||
    rawTarget.startsWith('chrome-extension://') ||
    rawTarget.startsWith('edge://') ||
    rawTarget.startsWith('brave://') ||
    rawTarget.includes('newtab')
  ) {
    pendingOpenerTabs.delete(tabId);
    return;
  }

  // If it was opened during gaming mode, close it once a real URL is loaded
  if (pending.isGameTab) {
    pendingOpenerTabs.delete(tabId);
    try {
      console.log('[AdSniper] Closed unwanted popup tab opened by game tab on navigation:', tabId, targetUrl);
      await chrome.tabs.remove(tabId);
    } catch { /* Tab may already be closed */ }
    return;
  }

  const targetDomain = extractDomain(targetUrl);
  if (!targetDomain) return; // Non-http/https URL or still parsing

  // Initial navigation resolved
  pendingOpenerTabs.delete(tabId);

  if (pending.openerDomain && targetDomain !== pending.openerDomain) {
    try {
      console.log(`[AdSniper] Blocked cross-domain new tab navigation (${targetDomain} !== ${pending.openerDomain}):`, tabId, targetUrl);
      await chrome.tabs.remove(tabId);
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
  if (message.type === 'UPDATE_ICON') {
    updateExtensionIcon();
    return;
  }
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

// ---------------------------------------------------------------------------
// Icon animation — blinks the extension icon when any blocker is active.
// Uses chrome.alarms (not setInterval) so it survives MV3 SW termination.
// ---------------------------------------------------------------------------

const ICON_ALARM_NAME = 'adsniper-icon-blink';

/** Called after any blocking state change — starts or stops the blink alarm. */
async function updateExtensionIcon() {
  const { massBlockActive = false, newTabBlockActive = false } =
    await chrome.storage.local.get(['massBlockActive', 'newTabBlockActive']);
  const rules = await chrome.declarativeNetRequest.getDynamicRules();
  const isActive = massBlockActive || newTabBlockActive || rules.length > 0;

  if (isActive) {
    // Ensure the alarm is running (idempotent — Chrome ignores duplicate creates)
    chrome.alarms.create(ICON_ALARM_NAME, { periodInMinutes: 1 / 60 }); // ~1 s
    // Draw immediately so there's no visible lag
    await _drawAnimFrame();
  } else {
    // Stop blinking and revert to gray idle icon
    await chrome.alarms.clear(ICON_ALARM_NAME);
    await chrome.storage.local.set({ _iconFrame: 0 });
    await _drawIdleIcon();
  }
}

/** Fired by the alarm every ~1 second — advances animation frame. */
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ICON_ALARM_NAME) return;
  // Re-check state each tick so we stop automatically if blockers were disabled
  const { massBlockActive = false, newTabBlockActive = false } =
    await chrome.storage.local.get(['massBlockActive', 'newTabBlockActive']);
  const rules = await chrome.declarativeNetRequest.getDynamicRules();
  const isActive = massBlockActive || newTabBlockActive || rules.length > 0;

  if (!isActive) {
    await chrome.alarms.clear(ICON_ALARM_NAME);
    await _drawIdleIcon();
    return;
  }
  await _drawAnimFrame();
});

/** Draws one blink frame — alternates between bright-red and dim-red. */
async function _drawAnimFrame() {
  const { _iconFrame = 0 } = await chrome.storage.local.get('_iconFrame');
  const nextFrame = _iconFrame + 1;
  await chrome.storage.local.set({ _iconFrame: nextFrame });

  // Two-phase blink: even frames = bright red, odd frames = dim red
  const bright = nextFrame % 2 === 0;
  try {
    await chrome.action.setIcon({
      imageData: {
        16:  _drawCrosshair(16,  bright),
        32:  _drawCrosshair(32,  bright),
        48:  _drawCrosshair(48,  bright),
        128: _drawCrosshair(128, bright),
      },
    });
  } catch (e) {
    console.warn('[AdSniper] setIcon failed:', e.message);
  }
}

/** Draws the gray idle icon (no blockers active). */
async function _drawIdleIcon() {
  try {
    await chrome.action.setIcon({
      imageData: {
        16:  _drawCrosshair(16,  false, true),
        32:  _drawCrosshair(32,  false, true),
        48:  _drawCrosshair(48,  false, true),
        128: _drawCrosshair(128, false, true),
      },
    });
  } catch (e) {
    console.warn('[AdSniper] setIcon (idle) failed:', e.message);
  }
}

/**
 * Draws a crosshair icon onto an OffscreenCanvas and returns ImageData.
 * @param {number}  size   - Canvas size (16, 32, 48, or 128)
 * @param {boolean} bright - true = full-opacity red (blink-on), false = dim red (blink-off)
 * @param {boolean} idle   - true = gray outline (no blockers active)
 */
function _drawCrosshair(size, bright, idle = false) {
  const canvas = new OffscreenCanvas(size, size);
  const ctx    = canvas.getContext('2d');
  const cx     = size / 2;
  const r      = size * 0.38;

  if (idle) {
    // --- Gray outline circle ---
    ctx.beginPath();
    ctx.arc(cx, cx, r, 0, Math.PI * 2);
    ctx.strokeStyle = '#6b6b88';
    ctx.lineWidth   = Math.max(1, size * 0.07);
    ctx.stroke();

    // Crosshair
    ctx.strokeStyle = '#6b6b88';
    ctx.lineWidth   = Math.max(1, size * 0.05);
    ctx.beginPath();
    ctx.moveTo(cx, cx - r * 0.65); ctx.lineTo(cx, cx + r * 0.65);
    ctx.moveTo(cx - r * 0.65, cx); ctx.lineTo(cx + r * 0.65, cx);
    ctx.stroke();
  } else {
    // --- Red filled circle (bright or dim) ---
    const alpha = bright ? 1.0 : 0.35;
    ctx.beginPath();
    ctx.arc(cx, cx, r, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(220, 38, 38, ${alpha})`;
    ctx.fill();

    // Outer glow ring (only on bright frame)
    if (bright) {
      ctx.beginPath();
      ctx.arc(cx, cx, r + size * 0.07, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(239, 68, 68, 0.45)';
      ctx.lineWidth   = Math.max(1, size * 0.05);
      ctx.stroke();
    }

    // White crosshair lines
    ctx.strokeStyle = bright ? '#ffffff' : 'rgba(255,255,255,0.5)';
    ctx.lineWidth   = Math.max(1, size * 0.06);
    ctx.beginPath();
    ctx.moveTo(cx, cx - r * 0.65); ctx.lineTo(cx, cx + r * 0.65);
    ctx.moveTo(cx - r * 0.65, cx); ctx.lineTo(cx + r * 0.65, cx);
    ctx.stroke();

    // Center dot
    ctx.beginPath();
    ctx.arc(cx, cx, Math.max(1, size * 0.06), 0, Math.PI * 2);
    ctx.fillStyle = bright ? '#ffffff' : 'rgba(255,255,255,0.5)';
    ctx.fill();
  }

  return ctx.getImageData(0, 0, size, size);
}

