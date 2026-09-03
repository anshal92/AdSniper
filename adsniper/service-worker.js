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

const MAX_REQUESTS_PER_TAB = 200;
const INITIAL_RULE_ID = 1001;

// Source: Peter Lowe's ad-server list — plain text, one hostname per line, no headers
const AD_HOSTS_FETCH_URL =
  'https://pgl.yoyo.org/adservers/serverlist.php?hostformat=nohtml&showintro=0&mimetype=plaintext';

// ---------------------------------------------------------------------------
// 1. webRequest logger — observe all URLs, store per tab
// ---------------------------------------------------------------------------
chrome.webRequest.onBeforeRequest.addListener(
  async (details) => {
    if (details.tabId < 0) return; // Ignore background/browser requests

    const { monitoringEnabled = true } = await chrome.storage.local.get('monitoringEnabled');
    if (!monitoringEnabled) return;

    const key = `requests_${details.tabId}`;
    const stored = await chrome.storage.local.get(key);
    const requests = stored[key] || [];

    // Prepend newest first
    requests.unshift({
      url: details.url,
      type: details.type,
      timestamp: Date.now(),
    });

    if (requests.length > MAX_REQUESTS_PER_TAB) requests.length = MAX_REQUESTS_PER_TAB;
    await chrome.storage.local.set({ [key]: requests });
  },
  { urls: ['<all_urls>'] }
);

// ---------------------------------------------------------------------------
// 2. Cleanup — remove log when tab is closed
// ---------------------------------------------------------------------------
chrome.tabs.onRemoved.addListener(async (tabId) => {
  await chrome.storage.local.remove(`requests_${tabId}`);
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
  const { snipingActiveTabId } = await chrome.storage.local.get('snipingActiveTabId');
  if (snipingActiveTabId && newTab.openerTabId === snipingActiveTabId) {
    try {
      console.log('[AdSniper] Closed unwanted popup tab opened by game tab:', newTab.id);
      await chrome.tabs.remove(newTab.id);
    } catch { /* Tab may already be closed */ }
  }
});

// ---------------------------------------------------------------------------
// 3. Block-count tracker — increments a storage counter every time a DNR rule fires
//    Requires the declarativeNetRequestFeedback permission (already declared).
// ---------------------------------------------------------------------------
chrome.declarativeNetRequest.onRuleMatchedDebug.addListener(async (info) => {
  // ── Increment per-rule block count ──
  const key = `blockCount_${info.rule.ruleId}`;
  const stored = await chrome.storage.local.get(key);
  await chrome.storage.local.set({ [key]: (stored[key] || 0) + 1 });

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
        const { nextRuleId = 1001 } = await chrome.storage.local.get('nextRuleId');
        await chrome.declarativeNetRequest.updateDynamicRules({
          addRules: [{
            id: nextRuleId,
            priority: 1,
            action: { type: 'block' },
            condition: { urlFilter: message.pattern, resourceTypes: RESOURCE_TYPES_SW },
          }],
          removeRuleIds: [],
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

  // ── Restore blocking state after sniping game ends ──
  if (message.type === 'RESTORE_SNIPING_STATE') {
    (async () => {
      try {
        const { snipingPreGameState = null } =
          await chrome.storage.local.get('snipingPreGameState');

        if (!snipingPreGameState) {
          sendResponse({ ok: false, reason: 'no saved state' });
          return;
        }

        // Restore DOM cleanup and iframe blocker flags
        await chrome.storage.local.set({
          domCleanupEnabled: snipingPreGameState.domCleanupEnabled,
          iframeBlockerEnabled: snipingPreGameState.iframeBlockerEnabled,
        });

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

          if (rules.length > 0) {
            await chrome.declarativeNetRequest.updateDynamicRules({
              addRules: rules,
              removeRuleIds: [],
            });
            await chrome.storage.local.set({
              massBlockActive: true,
              massBlockRuleIds: rules.map((r) => r.id),
            });
          }
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

          if (rules.length > 0) {
            await chrome.declarativeNetRequest.updateDynamicRules({
              addRules: rules,
              removeRuleIds: [],
            });
            await chrome.storage.local.set({
              newTabBlockActive: true,
              newTabBlockRuleIds: rules.map((r) => r.id),
            });
          }
        }

        // If newTabBlock was not active before game, remove the rules we activated
        if (!snipingPreGameState.newTabBlockActive) {
          const { newTabBlockRuleIds = [] } = await chrome.storage.local.get('newTabBlockRuleIds');
          if (newTabBlockRuleIds.length > 0) {
            await chrome.declarativeNetRequest.updateDynamicRules({
              addRules: [],
              removeRuleIds: newTabBlockRuleIds,
            });
            await chrome.storage.local.set({
              newTabBlockActive: false,
              newTabBlockRuleIds: [],
            });
          }
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
      }
    })();
    return true;
  }
});

// ---------------------------------------------------------------------------
// 6. Install / update hook
// ---------------------------------------------------------------------------
chrome.runtime.onInstalled.addListener(async (details) => {
  // Set storage defaults on first install
  const { nextRuleId } = await chrome.storage.local.get('nextRuleId');
  if (!nextRuleId) {
    await chrome.storage.local.set({
      nextRuleId: INITIAL_RULE_ID,
      monitoringEnabled: true,
      lockedCookies: {},
    });
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
