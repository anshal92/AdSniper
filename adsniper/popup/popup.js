/**
 * AdSniper v2 — Popup Script
 *
 * Calls chrome.* APIs directly (no service-worker message relay needed for UI operations).
 *
 * Ad Blocker tab:
 *   - Real-time request log (current tab) with URL filter and ad highlighting
 *   - Monitoring ON/OFF toggle
 *   - Inline editable block-pattern form
 *   - Active blocked-rules list with Remove option
 *
 * Cookie Editor tab:
 *   - Cookie list for the current tab's URL
 *   - Click value to edit → save/cancel
 *   - 🔒 Lock cookie (SW enforces via cookies.onChanged)
 *   - 🔓 Unlock cookie
 *   - 🗑 Delete cookie
 */

'use strict';

// ─────────────────────────────────────────────
// State
// ─────────────────────────────────────────────
let activeTabId   = null;
let activeTabUrl  = null;
let currentTab    = 'adblocker';
let refreshTimer  = null;
let editingActive = false;   // Pauses auto-refresh while inline form is open
let filterText    = '';
let allRequests   = [];
let adHosts       = [];
let adPatterns    = [];

const RESOURCE_TYPES = [
  'main_frame','sub_frame','script','image','xmlhttprequest',
  'media','font','stylesheet','ping','object','websocket','other',
];

// Rule IDs 50001+ are reserved for mass-block rules (user rules start at 1001)
const MASS_BLOCK_BASE_ID = 50001;

// Rule IDs 40001–49999 are reserved for new-tab-block rules (main_frame only)
const NEW_TAB_BLOCK_BASE_ID = 40001;

// ─────────────────────────────────────────────
// sendToTab — robust message delivery
// Injects content.js on-demand if the content script is not yet running
// (happens when a tab was already open before the extension was loaded/reloaded).
// ─────────────────────────────────────────────
async function sendToTab(message) {
  try {
    return await chrome.tabs.sendMessage(activeTabId, message);
  } catch {
    // Content script not present — try to inject it now
    let protocol;
    try { protocol = new URL(activeTabUrl).protocol; } catch { protocol = ''; }

    if (protocol !== 'http:' && protocol !== 'https:') {
      return { error: 'unsupported_protocol' };
    }

    // Inject content scripts into the already-open tab
    await chrome.scripting.executeScript({
      target: { tabId: activeTabId },
      files:  ['content/sniper-game.js', 'content/content.js'],
    });

    // Brief wait for listeners to register and storage init to complete
    await new Promise((r) => setTimeout(r, 120));

    // Retry — should succeed now
    return await chrome.tabs.sendMessage(activeTabId, message);
  }
}

// Global exports for MCP client
window.sendToTab = sendToTab;
window.toggleNewTabBlock = toggleNewTabBlock;
window.toggleMassBlock = toggleMassBlock;

// ─────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  // Identify active tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTabId  = tab.id;
  activeTabUrl = tab.url;

  // Load ad patterns from storage (fetched by SW on install)
  const stored = await chrome.storage.local.get(['adHosts', 'adPatterns']);
  adHosts    = stored.adHosts    || [];
  adPatterns = stored.adPatterns || [];

  // Wire tabs
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // Wire monitoring toggle
  await initMonitoringToggle();

  // Wire filter
  document.getElementById('filter-input').addEventListener('input', (e) => {
    filterText = e.target.value.toLowerCase().trim();
    renderRequests(allRequests);
  });

  // Wire clear button
  document.getElementById('clear-btn').addEventListener('click', async (e) => {
    e.stopPropagation();
    await chrome.storage.local.remove(`requests_${activeTabId}`);
    allRequests = [];
    renderRequests([]);
  });

  // Wire collapsible section headers for Requests and Blocked Rules
  const reqCollapseBtn = document.getElementById('requests-collapse-btn');
  if (reqCollapseBtn) {
    reqCollapseBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleSectionCollapse('requests');
    });
  }
  document.getElementById('requests-header').addEventListener('click', (e) => {
    if (e.target.id !== 'clear-btn') {
      toggleSectionCollapse('requests');
    }
  });

  const rulesCollapseBtn = document.getElementById('rules-collapse-btn');
  if (rulesCollapseBtn) {
    rulesCollapseBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleSectionCollapse('rules');
    });
  }
  document.getElementById('rules-header').addEventListener('click', () => {
    toggleSectionCollapse('rules');
  });

  // Wire mass-block button + restore its visual state
  await updateMassBlockButton();
  document.getElementById('mass-block-btn').addEventListener('click', toggleMassBlock);

  // Wire new-tab-block button + restore its visual state
  await updateNewTabBlockButton();
  document.getElementById('new-tab-block-btn').addEventListener('click', toggleNewTabBlock);

  // Wire AI assistant toggle + restore state
  await initAIAssistant();
  await initAISettings();
  document.getElementById('ai-toggle-btn').addEventListener('click', toggleAIAssistant);
  document.getElementById('ai-send-btn').addEventListener('click', () => handleAISend());
  document.getElementById('ai-prompt-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleAISend();
    }
  });
  document.querySelectorAll('.ai-chip').forEach((chip) => {
    chip.addEventListener('click', () => handleAISend(chip.dataset.prompt));
  });
  document.querySelectorAll('.ai-hint-tag').forEach((tag) => {
    tag.addEventListener('click', () => {
      const prompt = tag.dataset.prompt;
      const input = document.getElementById('ai-prompt-input');
      if (input) input.value = prompt;
      handleAISend(prompt);
    });
  });

  // Wire DOM cleanup toggle + Clean Page button
  await initDomCleanupToggle();
  document.getElementById('clean-page-btn').addEventListener('click', handleCleanPage);

  // Wire element picker button
  document.getElementById('element-picker-btn').addEventListener('click', handleElementPicker);

  // Wire iFrame blocker toggle
  await initIframeBlockerToggle();

  // Wire sniping game button
  document.getElementById('sniping-btn').addEventListener('click', handleSnipingGame);

  // Wire cookie refresh
  document.getElementById('refresh-cookies-btn').addEventListener('click', refreshCookies);

  // Initial data load
  await Promise.all([refreshAdBlocker(), refreshCookies()]);

  // Auto-refresh every 2 s (pauses during inline edits)
  refreshTimer = setInterval(async () => {
    if (editingActive) return;
    if (currentTab === 'adblocker') await refreshAdBlocker();
    else await refreshCookies();
  }, 2000);
  
  await initPersonalAssistant();
  await initListsPanel();
});

window.addEventListener('unload', () => {
  if (refreshTimer) clearInterval(refreshTimer);
  if (window.GeminiNanoClient) {
    window.GeminiNanoClient.getInstance().destroy();
  }
});

// ─────────────────────────────────────────────
// Tab switching
// ─────────────────────────────────────────────
function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab-btn').forEach((b) =>
    b.classList.toggle('active', b.dataset.tab === tab)
  );
  document.querySelectorAll('.panel').forEach((p) =>
    p.classList.toggle('active', p.id === `panel-${tab}`)
  );
}

// ─────────────────────────────────────────────
// Monitoring toggle
// ─────────────────────────────────────────────
async function initMonitoringToggle() {
  const { monitoringEnabled = true } = await chrome.storage.local.get('monitoringEnabled');
  const toggle = document.getElementById('monitoring-toggle');
  toggle.checked = monitoringEnabled;
  updateMonitoringUI(monitoringEnabled);

  toggle.addEventListener('change', async () => {
    const next = toggle.checked;
    await chrome.storage.local.set({ monitoringEnabled: next });
    updateMonitoringUI(next);
  });
}

function updateMonitoringUI(enabled) {
  const label = document.getElementById('monitoring-label');
  const toggle = document.getElementById('monitoring-toggle');
  toggle.checked = enabled;
  label.textContent = enabled ? 'Monitoring ON' : 'Monitoring OFF';
  label.className = `toggle-label ${enabled ? 'on' : 'off'}`;
}

// ─────────────────────────────────────────────
// AD BLOCKER — data refresh
// ─────────────────────────────────────────────
async function refreshAdBlocker() {
  const [storedReqs, rules] = await Promise.all([
    chrome.storage.local.get(`requests_${activeTabId}`),
    chrome.declarativeNetRequest.getDynamicRules(),
  ]);
  allRequests = storedReqs[`requests_${activeTabId}`] || [];

  // Fetch all block counts in one storage call
  const countKeys = rules.map((r) => `blockCount_${r.id}`);
  const blockCounts = countKeys.length > 0
    ? await chrome.storage.local.get(countKeys)
    : {};

  renderRequests(allRequests);
  renderRules(rules, blockCounts);
  updateFooter();
}

// ─────────────────────────────────────────────
// AD BLOCKER — request rendering
// ─────────────────────────────────────────────
function isAdRequest(url) {
  try {
    const { hostname } = new URL(url);
    if (adHosts.some((h) => hostname === h || hostname.endsWith(`.${h}`))) return true;
    const lower = url.toLowerCase();
    if (adPatterns.some((p) => lower.includes(p.toLowerCase()))) return true;
  } catch { /* ignore malformed URLs */ }
  return false;
}

function renderRequests(requests) {
  const container = document.getElementById('requests-list');
  const filtered  = filterText
    ? requests.filter((r) => r.url.toLowerCase().includes(filterText))
    : requests;

  document.getElementById('req-count').textContent = String(filtered.length);

  if (filtered.length === 0) {
    container.innerHTML = filterText
      ? '<div class="empty">No requests match the filter.</div>'
      : '<div class="empty">No requests captured yet — browse a page.</div>';
    return;
  }

  const prevScroll = container.scrollTop;
  container.innerHTML = '';
  filtered.forEach((req) => container.appendChild(buildRequestRow(req)));
  container.scrollTop = prevScroll;
}

function buildRequestRow(req) {
  const isAd = isAdRequest(req.url);
  const row   = document.createElement('div');
  row.className = `request-row${isAd ? ' is-ad' : ''}`;

  if (isAd) {
    const flag = document.createElement('span');
    flag.className = 'ad-flag';
    flag.title = 'Matches known ad/tracker pattern';
    flag.textContent = '🎯';
    row.appendChild(flag);
  }

  const badge = document.createElement('span');
  badge.className = `type-badge type-${req.type}`;
  badge.textContent = req.type === 'xmlhttprequest' ? 'XHR' : req.type;

  const urlEl = document.createElement('span');
  urlEl.className = 'req-url';
  urlEl.title = req.url;
  urlEl.textContent = req.url;

  const blockBtn = document.createElement('button');
  blockBtn.className = 'btn btn-block';
  blockBtn.textContent = 'Block';
  blockBtn.addEventListener('click', () => openBlockForm(row, req.url));

  row.appendChild(badge);
  row.appendChild(urlEl);
  row.appendChild(blockBtn);
  return row;
}

// ─────────────────────────────────────────────
// AD BLOCKER — inline block-pattern editor
// ─────────────────────────────────────────────
function openBlockForm(row, url) {
  editingActive = true;
  row.classList.add('editing');
  row.innerHTML = '';

  const label = document.createElement('span');
  label.className = 'edit-label';
  label.textContent = 'Pattern:';

  const input = document.createElement('input');
  input.type        = 'text';
  input.className   = 'pattern-input';
  input.value       = `||${extractHostname(url)}`;
  input.placeholder = '||ads.example.com';
  input.title       = '|| = domain anchor  · * = wildcard  · ^ = separator';

  const confirmBtn = document.createElement('button');
  confirmBtn.className = 'btn btn-confirm';
  confirmBtn.textContent = '✓ Block';
  confirmBtn.addEventListener('click', () => commitBlock(input.value.trim()));

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn btn-cancel';
  cancelBtn.textContent = '✕';
  cancelBtn.addEventListener('click', closeBlockEdit);

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter')  commitBlock(input.value.trim());
    if (e.key === 'Escape') closeBlockEdit();
  });

  row.appendChild(label);
  row.appendChild(input);
  row.appendChild(confirmBtn);
  row.appendChild(cancelBtn);
  input.focus();
  input.select();
}

async function commitBlock(pattern) {
  if (!pattern) return;
  const { nextRuleId = 1001 } = await chrome.storage.local.get('nextRuleId');

  await chrome.declarativeNetRequest.updateDynamicRules({
    addRules: [{
      id: nextRuleId,
      priority: 1,
      action: { type: 'block' },
      condition: { urlFilter: pattern, resourceTypes: RESOURCE_TYPES },
    }],
    removeRuleIds: [],
  });
  await chrome.storage.local.set({ nextRuleId: nextRuleId + 1 });
  await syncBadge();
  closeBlockEdit();
}

function closeBlockEdit() {
  editingActive = false;
  refreshAdBlocker();
}

// ─────────────────────────────────────────────
// AD BLOCKER — blocked rules list
// ─────────────────────────────────────────────
function renderRules(rules, blockCounts = {}) {
  const container   = document.getElementById('rules-list');
  const countEl     = document.getElementById('rules-count');
  const headerBadge = document.getElementById('header-badge');

  countEl.textContent = String(rules.length);

  if (rules.length > 0) {
    headerBadge.textContent = `${rules.length} blocked`;
    headerBadge.classList.add('visible');
  } else {
    headerBadge.classList.remove('visible');
  }

  if (rules.length === 0) {
    container.innerHTML = '<div class="empty">No rules active.</div>';
    return;
  }

  container.innerHTML = '';
  rules.forEach((rule) => {
    const row = document.createElement('div');
    row.className = 'rule-row';

    // Pattern label
    const patternEl = document.createElement('span');
    patternEl.className   = 'rule-pattern';
    patternEl.title       = `Rule ID: ${rule.id}`;
    patternEl.textContent = rule.condition.urlFilter;

    // Block count badge
    const hits = blockCounts[`blockCount_${rule.id}`] || 0;
    const countBadge = document.createElement('span');
    countBadge.className = `block-count${hits === 0 ? ' zero' : ''}`;
    countBadge.title     = hits === 0
      ? 'No requests blocked yet by this rule'
      : `${hits} request${hits === 1 ? '' : 's'} blocked by this rule`;
    countBadge.textContent = hits === 0 ? '0 blocked' : `🚫 ${hits.toLocaleString()}`;

    // Remove button
    const removeBtn = document.createElement('button');
    removeBtn.className   = 'btn btn-remove';
    removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', async () => {
      await chrome.declarativeNetRequest.updateDynamicRules({
        addRules: [],
        removeRuleIds: [rule.id],
      });
      // Clean up the stored block count for this rule
      await chrome.storage.local.remove(`blockCount_${rule.id}`);
      await syncBadge();
      await refreshAdBlocker();
    });

    row.appendChild(patternEl);
    row.appendChild(countBadge);
    row.appendChild(removeBtn);
    container.appendChild(row);
  });
}

async function syncBadge() {
  const rules = await chrome.declarativeNetRequest.getDynamicRules();
  await chrome.action.setBadgeText({ text: rules.length > 0 ? String(rules.length) : '' });
  await chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
}

// ─────────────────────────────────────────────
// AD BLOCKER — mass-block toggle
// ─────────────────────────────────────────────

/**
 * Reads adHosts + adPatterns from storage (loaded from data/ad-patterns.json on install),
 * builds a DNR dynamic rule for each entry, and stores the rule IDs for later removal.
 * A second click removes all those rules.
 */
async function toggleMassBlock() {
  const btn = document.getElementById('mass-block-btn');
  btn.disabled = true; // Prevent double-click while async work runs

  try {
    const { massBlockActive = false } = await chrome.storage.local.get('massBlockActive');

    if (massBlockActive) {
      // ── Deactivate ──────────────────────────────────
      const { massBlockRuleIds = [] } = await chrome.storage.local.get('massBlockRuleIds');
      if (massBlockRuleIds.length > 0) {
        await chrome.declarativeNetRequest.updateDynamicRules({
          addRules: [],
          removeRuleIds: massBlockRuleIds,
        });
        // Clean up stored block counts for all mass-block rules
        await chrome.storage.local.remove(massBlockRuleIds.map((id) => `blockCount_${id}`));
      }
      await chrome.storage.local.set({ massBlockActive: false, massBlockRuleIds: [] });

    } else {
      // ── Activate ────────────────────────────────────
      const { adHosts = [], adPatterns = [] } =
        await chrome.storage.local.get(['adHosts', 'adPatterns']);

      // Remove any stale mass-block rules first (safety)
      const { massBlockRuleIds: staleIds = [] } = await chrome.storage.local.get('massBlockRuleIds');
      if (staleIds.length > 0) {
        await chrome.declarativeNetRequest.updateDynamicRules({
          addRules: [],
          removeRuleIds: staleIds,
        });
      }

      // Build one DNR rule per host and one per URL-fragment pattern
      const rules = [];
      let id = MASS_BLOCK_BASE_ID;

      for (const host of adHosts) {
        if (!host) continue;
        rules.push({
          id: id++,
          priority: 2, // Higher than user rules (priority 1) so mass-block wins
          action: { type: 'block' },
          condition: { urlFilter: `||${host}`, resourceTypes: RESOURCE_TYPES },
        });
      }

      for (const pattern of adPatterns) {
        if (!pattern) continue;
        rules.push({
          id: id++,
          priority: 2,
          action: { type: 'block' },
          condition: { urlFilter: pattern, resourceTypes: RESOURCE_TYPES },
        });
      }

      if (rules.length === 0) {
        alert('No ad patterns loaded yet. Try reloading the extension.');
        return;
      }

      // DNR updateDynamicRules accepts all rules in one call (limit: 30,000 total)
      await chrome.declarativeNetRequest.updateDynamicRules({
        addRules: rules,
        removeRuleIds: [],
      });

      await chrome.storage.local.set({
        massBlockActive: true,
        massBlockRuleIds: rules.map((r) => r.id),
      });

      // Immediately scan the active tab's DOM with the new patterns
      try {
        const response = await sendToTab({
          type: 'APPLY_BLOCKED_PATTERNS',
          hosts:    adHosts,
          patterns: adPatterns,
        });
        if (response && response.total) updateHiddenStat(response.total);
      } catch { /* Tab may not support content scripts (chrome://, PDF, etc.) */ }
    }

    await syncBadge();
    await updateMassBlockButton();
    await refreshAdBlocker(); // Refresh rules list

  } catch (err) {
    console.error('[AdSniper] Mass-block toggle failed:', err);
    alert(`Error: ${err.message}`);
  } finally {
    btn.disabled = false;
  }
}

/** Reads massBlockActive from storage and updates button + status text accordingly. */
async function updateMassBlockButton() {
  const { massBlockActive = false, massBlockRuleIds = [] } =
    await chrome.storage.local.get(['massBlockActive', 'massBlockRuleIds']);

  const btn    = document.getElementById('mass-block-btn');
  const title  = document.getElementById('mass-block-title');
  const sub    = document.getElementById('mass-block-sub');

  if (massBlockActive) {
    btn.classList.add('active');
    title.textContent = 'Blocking all ad patterns';
    sub.textContent   = `${massBlockRuleIds.length} rules active — click to stop`;
    sub.className     = 'mass-block-sub active';
  } else {
    btn.classList.remove('active');
    title.textContent = 'Block all known ad patterns';
    sub.textContent   = 'Inactive — click to activate';
    sub.className     = 'mass-block-sub';
  }
}

// ─────────────────────────────────────────────
// NEW-TAB AD BLOCK — prevents ad domains from opening as new tabs
// ─────────────────────────────────────────────

/**
 * Creates DNR rules that block main_frame navigation to known ad domains.
 * This prevents ads that open new tabs/windows from loading.
 * Uses rule IDs 40001–49999 (separate from mass-block 50001+).
 */
async function toggleNewTabBlock() {
  const btn = document.getElementById('new-tab-block-btn');
  btn.disabled = true;

  try {
    const { newTabBlockActive = false } = await chrome.storage.local.get('newTabBlockActive');

    if (newTabBlockActive) {
      // ── Deactivate ──────────────────────────────────
      const { newTabBlockRuleIds = [] } = await chrome.storage.local.get('newTabBlockRuleIds');
      if (newTabBlockRuleIds.length > 0) {
        await chrome.declarativeNetRequest.updateDynamicRules({
          addRules: [],
          removeRuleIds: newTabBlockRuleIds,
        });
        await chrome.storage.local.remove(newTabBlockRuleIds.map((id) => `blockCount_${id}`));
      }
      await chrome.storage.local.set({ newTabBlockActive: false, newTabBlockRuleIds: [] });

    } else {
      // ── Activate ────────────────────────────────────
      const { adHosts = [] } = await chrome.storage.local.get('adHosts');

      // Clean up any stale rules
      const { newTabBlockRuleIds: staleIds = [] } = await chrome.storage.local.get('newTabBlockRuleIds');
      if (staleIds.length > 0) {
        await chrome.declarativeNetRequest.updateDynamicRules({
          addRules: [],
          removeRuleIds: staleIds,
        });
      }

      // Build one DNR rule per ad host — only block main_frame navigations
      const rules = [];
      let id = NEW_TAB_BLOCK_BASE_ID;
      for (const host of adHosts) {
        if (!host) continue;
        if (id >= 50000) break; // Stay within our ID range
        rules.push({
          id: id++,
          priority: 3, // Higher than mass-block (2) and user rules (1)
          action: { type: 'block' },
          condition: { urlFilter: `||${host}`, resourceTypes: ['main_frame'] },
        });
      }

      if (rules.length === 0) {
        alert('No ad patterns loaded yet. Try reloading the extension.');
        return;
      }

      await chrome.declarativeNetRequest.updateDynamicRules({
        addRules: rules,
        removeRuleIds: [],
      });

      await chrome.storage.local.set({
        newTabBlockActive: true,
        newTabBlockRuleIds: rules.map((r) => r.id),
      });
    }

    await syncBadge();
    await updateNewTabBlockButton();
    await refreshAdBlocker();

  } catch (err) {
    console.error('[AdSniper] New-tab-block toggle failed:', err);
    alert(`Error: ${err.message}`);
  } finally {
    btn.disabled = false;
  }
}

/** Reads newTabBlockActive from storage and updates the button visually. */
async function updateNewTabBlockButton() {
  const { newTabBlockActive = false, newTabBlockRuleIds = [] } =
    await chrome.storage.local.get(['newTabBlockActive', 'newTabBlockRuleIds']);

  const btn = document.getElementById('new-tab-block-btn');

  if (newTabBlockActive) {
    btn.classList.add('active');
    btn.title = `Blocking new-tab ads — ${newTabBlockRuleIds.length} rules active`;
  } else {
    btn.classList.remove('active');
    btn.title = 'Click to block ads from opening new tabs';
  }
}

// ─────────────────────────────────────────────
// GEMINI NANO AI ASSISTANT & MCP ACTIONS
// ─────────────────────────────────────────────

async function initAIAssistant() {
  const { aiEnabled = false } = await chrome.storage.local.get('aiEnabled');
  const btn = document.getElementById('ai-toggle-btn');
  const section = document.getElementById('ai-prompt-section');

  if (aiEnabled) {
    btn.classList.add('active');
    section.style.display = 'flex';
    checkAndDisplayAIStatus();
    // Collapse Requests and Blocked Rules when AI mode is active
    setSectionCollapsed('requests', true);
    setSectionCollapsed('rules', true);
  } else {
    btn.classList.remove('active');
    section.style.display = 'none';
    setSectionCollapsed('requests', false);
    setSectionCollapsed('rules', false);
  }
}

async function checkAndDisplayAIStatus() {
  const pill = document.getElementById('ai-status-pill');
  const statusText = document.getElementById('ai-status-text');
  if (!pill || !window.GeminiNanoClient) return;

  // Yellow pulsing light during startup
  pill.className = 'ai-status-pill startup';
  if (statusText) statusText.textContent = 'Starting up…';

  const client = window.GeminiNanoClient.getInstance();
  const info = await client.checkAvailability();

  pill.className = 'ai-status-pill';
  if (info.status === 'ready') {
    // Green blinking light when ready & running
    pill.classList.add('running');
    if (statusText) statusText.textContent = 'Nano Ready';
    pill.title = 'Gemini Nano is available and running 100% on-device.';
  } else if (info.status === 'downloading') {
    // Yellow pulsing light for downloading / startup
    pill.classList.add('startup');
    if (statusText) statusText.textContent = `Downloading ${info.progress ? info.progress + '%' : '…'}`;
    pill.title = info.message || 'Downloading model via Chrome components';
  } else if (info.status === 'down' || info.status === 'error') {
    // Red for down
    pill.classList.add('down');
    if (statusText) statusText.textContent = 'AI Down';
    pill.title = info.message || 'On-device AI engine is offline';
  } else {
    // Green blinking light for Heuristics Mode (available and running)
    pill.classList.add('running');
    if (statusText) statusText.textContent = 'Heuristics Mode';
    pill.title = 'Heuristics Mode is available and running on-device with MCP actions.';
  }
}

async function toggleAIAssistant() {
  const { aiEnabled = false } = await chrome.storage.local.get('aiEnabled');
  const next = !aiEnabled;
  await chrome.storage.local.set({ aiEnabled: next });

  const btn = document.getElementById('ai-toggle-btn');
  const section = document.getElementById('ai-prompt-section');
  const input = document.getElementById('ai-prompt-input');

  if (next) {
    btn.classList.add('active');
    section.style.display = 'flex';
    if (input) input.focus();
    await checkAndDisplayAIStatus();
    // Auto-collapse Requests and Blocked Rules with option to expand
    setSectionCollapsed('requests', true);
    setSectionCollapsed('rules', true);
  } else {
    btn.classList.remove('active');
    section.style.display = 'none';
    const panel = document.getElementById('ai-settings-panel');
    const settingsBtn = document.getElementById('ai-settings-btn');
    if (panel) panel.style.display = 'none';
    if (settingsBtn) settingsBtn.classList.remove('active');
    // Auto-expand Requests and Blocked Rules back to default view
    setSectionCollapsed('requests', false);
    setSectionCollapsed('rules', false);
    if (window.GeminiNanoClient) {
      window.GeminiNanoClient.getInstance().destroy();
    }
  }
}

/**
 * Initializes the AI System Prompt settings panel and controls.
 */
async function initAISettings() {
  const settingsBtn = document.getElementById('ai-settings-btn');
  const panel = document.getElementById('ai-settings-panel');
  const closeBtn = document.getElementById('ai-settings-close');
  const saveBtn = document.getElementById('ai-settings-save');
  const resetBtn = document.getElementById('ai-settings-reset');
  const textarea = document.getElementById('ai-system-prompt-input');
  const statusSpan = document.getElementById('ai-settings-status');

  if (!settingsBtn || !panel || !textarea) return;

  async function loadPromptIntoTextarea() {
    if (window.GeminiNanoClient) {
      const client = window.GeminiNanoClient.getInstance();
      textarea.value = await client.getSystemPrompt();
    }
  }

  // Toggle settings panel
  settingsBtn.addEventListener('click', async () => {
    const isVisible = panel.style.display !== 'none';
    if (isVisible) {
      panel.style.display = 'none';
      settingsBtn.classList.remove('active');
    } else {
      await loadPromptIntoTextarea();
      panel.style.display = 'flex';
      settingsBtn.classList.add('active');
      textarea.focus();
    }
  });

  // Close button
  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      panel.style.display = 'none';
      settingsBtn.classList.remove('active');
    });
  }

  // Save button
  if (saveBtn) {
    saveBtn.addEventListener('click', async () => {
      const newPrompt = textarea.value.trim();
      await chrome.storage.local.set({ customSystemPrompt: newPrompt });
      if (window.GeminiNanoClient) {
        window.GeminiNanoClient.getInstance().destroy();
      }
      if (statusSpan) {
        statusSpan.textContent = '✓ Saved & Applied';
        statusSpan.style.color = '#22c55e';
        setTimeout(() => { statusSpan.textContent = ''; }, 2500);
      }
    });
  }

  // Reset to default button
  if (resetBtn) {
    resetBtn.addEventListener('click', async () => {
      await chrome.storage.local.remove('customSystemPrompt');
      if (window.GeminiNanoClient) {
        textarea.value = window.GeminiNanoClient.DEFAULT_SYSTEM_PROMPT;
        window.GeminiNanoClient.getInstance().destroy();
      }
      if (statusSpan) {
        statusSpan.textContent = '✓ Reset to Default';
        statusSpan.style.color = '#38bdf8';
        setTimeout(() => { statusSpan.textContent = ''; }, 2500);
      }
    });
  }
}

/**
 * Collapses or expands a section ('requests' or 'rules')
 */
function setSectionCollapsed(section, isCollapsed) {
  const list = document.getElementById(`${section}-list`);
  const btn = document.getElementById(`${section}-collapse-btn`);
  if (!list) return;

  if (isCollapsed) {
    list.classList.add('collapsed');
    if (btn) btn.textContent = '▸ Expand';
  } else {
    list.classList.remove('collapsed');
    if (btn) btn.textContent = '▾ Collapse';
  }
}

function toggleSectionCollapse(section) {
  const list = document.getElementById(`${section}-list`);
  if (!list) return;
  const isCurrentlyCollapsed = list.classList.contains('collapsed');
  setSectionCollapsed(section, !isCurrentlyCollapsed);
}

/**
 * Formats AI text response into safe, styled HTML with bold, code, bullets, paragraphs.
 */
function formatAIOutput(text) {
  if (!text) return '';

  // Escape HTML entities to prevent XSS
  const escapeHtml = (str) =>
    str.replace(/&/g, '&amp;')
       .replace(/</g, '&lt;')
       .replace(/>/g, '&gt;')
       .replace(/"/g, '&quot;')
       .replace(/'/g, '&#039;');

  let safe = escapeHtml(text);

  // Pre-code blocks
  safe = safe.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, (_m, _lang, code) => {
    return `<pre style="background:var(--bg);border:1px solid var(--border);border-radius:4px;padding:6px;font-size:10px;overflow-x:auto;"><code>${code.trim()}</code></pre>`;
  });

  // Inline code `code`
  safe = safe.replace(/`([^`\n]+)`/g, '<code class="ai-inline-code">$1</code>');

  // Bold **bold**
  safe = safe.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

  // Italics *italic*
  safe = safe.replace(/(^|[^\*])\*([^\*\n]+)\*([^\*]|$)/g, '$1<em>$2</em>$3');

  // Headings
  safe = safe.replace(/^###?\s+(.+)$/gm, '<div class="ai-heading">$1</div>');

  // Bullet items
  safe = safe.replace(/^[•\-\*]\s+(.+)$/gm, '<li class="ai-bullet-item">$1</li>');
  safe = safe.replace(/(<li class="ai-bullet-item">[\s\S]*?<\/li>)/g, '<ul class="ai-list">$1</ul>');
  safe = safe.replace(/<\/ul>\s*<ul class="ai-list">/g, '');

  // Paragraphs
  const parts = safe.split(/\n\n+/);
  safe = parts.map((p) => {
    const trimmed = p.trim();
    if (!trimmed) return '';
    if (trimmed.startsWith('<div') || trimmed.startsWith('<ul') || trimmed.startsWith('<pre')) {
      return trimmed;
    }
    return `<p>${trimmed.replace(/\n/g, '<br>')}</p>`;
  }).join('');

  return safe;
}

async function handleAISend(overridePrompt) {
  const input = document.getElementById('ai-prompt-input');
  const sendBtn = document.getElementById('ai-send-btn');
  const responseBox = document.getElementById('ai-response-box');
  const responseText = document.getElementById('ai-response-text');
  const actionCard = document.getElementById('ai-action-card');

  const prompt = (overridePrompt || (input ? input.value : '') || '').trim();
  if (!prompt) return;

  if (input) input.value = '';
  sendBtn.disabled = true;
  actionCard.style.display = 'none';
  startThinkingAnimation(responseText);

  try {
    const client = window.GeminiNanoClient.getInstance();
    const context = {
      activeTabId,
      activeTabUrl,
      recentRequests: allRequests,
    };

    const result = await client.processPrompt(prompt, context, (tokenChunk) => {
      // Live streaming update with formatting
      stopThinkingAnimation();
      responseText.innerHTML = formatAIOutput(tokenChunk);
      responseBox.scrollTop = responseBox.scrollHeight;
    });

    stopThinkingAnimation();
    responseText.innerHTML = formatAIOutput(result.reply || 'Action executed.');
    responseBox.scrollTop = responseBox.scrollHeight;

    if (result.actionExecuted && result.actionExecuted.success) {
      actionCard.style.display = 'flex';
      const action = result.actionExecuted;
      const cardText = `⚡ ${action.message || 'Action executed'}`;

      actionCard.innerHTML = `<span>${cardText}</span>`;

      // Add download button for anchor links when there are more than 100
      if (action.tool === 'tool_extract_anchor_links' && action.allLinks && action.totalCount > 100) {
        const dlBtn = document.createElement('button');
        dlBtn.textContent = '📥 Download All (' + action.totalCount + ' links)';
        dlBtn.style.cssText = 'margin-left:auto;background:var(--accent);color:#fff;border:none;border-radius:4px;padding:4px 10px;cursor:pointer;font-size:11px;white-space:nowrap;';
        dlBtn.addEventListener('click', function() {
          var lines = action.allLinks.map(function(link, i) {
            return (i + 1) + '. ' + (link.text || '(no text)') + ' | ' + (link.href || '') + ' | target=' + (link.target || '_self');
          });
          var content = 'Anchor Links Extracted (' + action.totalCount + ' total)\n' + '='.repeat(50) + '\n\n' + lines.join('\n');
          var blob = new Blob([content], { type: 'text/plain' });
          var url = URL.createObjectURL(blob);
          var a = document.createElement('a');
          a.href = url;
          a.download = 'anchor-links-' + Date.now() + '.txt';
          a.click();
          URL.revokeObjectURL(url);
        });
        actionCard.appendChild(dlBtn);
      }

      // If a rule was added or feature toggled, sync UI and refresh
      if (action.tool === 'tool_add_block_rule') {
        await syncBadge();
        await refreshAdBlocker();
      } else if (action.tool === 'tool_toggle_feature') {
        if (action.feature === 'new_tab_block') {
          await updateNewTabBlockButton();
          await syncBadge();
          await refreshAdBlocker();
        } else if (action.feature === 'mass_block') {
          await updateMassBlockButton();
          await syncBadge();
          await refreshAdBlocker();
        }
      }
    }
  } catch (err) {
    console.error('[AdSniper AI] Error processing request:', err);
    responseText.innerHTML = `<p style="color:var(--red);">Error: ${err.message}</p>`;
  } finally {
    stopThinkingAnimation();
    sendBtn.disabled = false;
  }
}

// ─────────────────────────────────────────────
// DOM CLEANUP — toggle + clean-page button
// ─────────────────────────────────────────────

async function initDomCleanupToggle() {
  const { domCleanupEnabled = true } = await chrome.storage.local.get('domCleanupEnabled');
  const toggle = document.getElementById('dom-cleanup-toggle');
  toggle.checked = domCleanupEnabled;
  updateDomCleanupUI(domCleanupEnabled);

  toggle.addEventListener('change', async () => {
    const next = toggle.checked;
    await chrome.storage.local.set({ domCleanupEnabled: next });
    updateDomCleanupUI(next);
    // Notify content script in active tab
    try {
      await sendToTab({ type: 'SET_DOM_CLEANUP', enabled: next });
    } catch { /* No content script on this tab */ }
  });
}

function updateDomCleanupUI(enabled) {
  const toggle = document.getElementById('dom-cleanup-toggle');
  const label  = document.getElementById('dom-cleanup-label');
  toggle.checked  = enabled;
  label.textContent = enabled ? 'DOM Cleanup ON' : 'DOM Cleanup OFF';
  label.className   = `toggle-label ${enabled ? 'on' : 'off'}`;
}

async function handleCleanPage() {
  const btn = document.getElementById('clean-page-btn');
  btn.disabled  = true;
  btn.textContent = '⏳ Cleaning…';
  try {
    const response = await sendToTab({ type: 'CLEAN_PAGE' });
    if (response && response.total !== undefined) {
      updateHiddenStat(response.total);
    }
  } catch (err) {
    console.warn('[AdSniper] Clean Page failed (no content script on this tab):', err.message);
  } finally {
    btn.disabled  = false;
    btn.textContent = '🧹 Clean Page';
  }
}

/** Updates the "N hidden" stat badge in the DOM cleanup bar. */
function updateHiddenStat(total) {
  const el = document.getElementById('hidden-stat');
  if (!el) return;
  if (total > 0) {
    el.textContent = `🙈 ${total.toLocaleString()} hidden`;
    el.className   = 'hidden-stat active';
  } else {
    el.textContent = '0 hidden';
    el.className   = 'hidden-stat';
  }
}

// ─────────────────────────────────────────────
// ELEMENT PICKER — send message then close popup
// ─────────────────────────────────────────────

async function handleElementPicker() {
  try {
    const resp = await sendToTab({ type: 'START_ELEMENT_PICKER' });
    if (resp && resp.error === 'unsupported_protocol') return;
  } catch (err) {
    console.warn('[AdSniper] Could not start element picker:', err.message);
    return;
  }
  // Close the popup so the user can interact with the page
  window.close();
}

// ─────────────────────────────────────────────
// IFRAME AD BLOCKER — toggle + stats
// ─────────────────────────────────────────────

async function initIframeBlockerToggle() {
  const { iframeBlockerEnabled = false } = await chrome.storage.local.get('iframeBlockerEnabled');
  const toggle = document.getElementById('iframe-blocker-toggle');
  toggle.checked = iframeBlockerEnabled;
  updateIframeBlockerUI(iframeBlockerEnabled);

  // Fetch initial removed count from content script
  try {
    const resp = await sendToTab({ type: 'GET_IFRAME_STATS' });
    if (resp && resp.total !== undefined) updateIframeStat(resp.total);
  } catch { /* No content script on this tab */ }

  toggle.addEventListener('change', async () => {
    const next = toggle.checked;
    await chrome.storage.local.set({ iframeBlockerEnabled: next });
    updateIframeBlockerUI(next);
    try {
      const resp = await sendToTab({
        type: 'TOGGLE_IFRAME_BLOCKER',
        enabled: next,
      });
      if (resp && resp.total !== undefined) updateIframeStat(resp.total);
    } catch (err) {
      console.warn('[AdSniper] iFrame blocker toggle failed:', err.message);
    }
  });
}

function updateIframeBlockerUI(enabled) {
  const label = document.getElementById('iframe-blocker-label');
  label.textContent = enabled ? 'Block iFrame Ads ON' : 'Block iFrame Ads';
  label.className   = `toggle-label ${enabled ? 'on' : 'off'}`;
}

function updateIframeStat(total) {
  const el = document.getElementById('iframe-stat');
  if (!el) return;
  if (total > 0) {
    el.textContent = `🗑️ ${total.toLocaleString()} removed`;
    el.className   = 'iframe-stat active';
  } else {
    el.textContent = '0 removed';
    el.className   = 'iframe-stat';
  }
}

// ─────────────────────────────────────────────
// COOKIE EDITOR — data refresh
// ─────────────────────────────────────────────

/**
 * Returns true if the URL is one where chrome.cookies API is accessible.
 * chrome://, about:, chrome-extension://, and data: URLs are restricted —
 * calling chrome.cookies on them throws "chrome.cookies is undefined" or
 * a permissions error.
 */
function isCookieAccessibleUrl(url) {
  if (!url) return false;
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

async function refreshCookies() {
  if (!activeTabUrl) return;

  // Guard: chrome.cookies only works on http/https pages
  if (!isCookieAccessibleUrl(activeTabUrl)) {
    document.getElementById('cookie-count').textContent = '0';
    document.getElementById('cookie-domain').textContent = '';
    document.getElementById('cookies-list').innerHTML =
      '<div class="empty">Cookies are only accessible on http:// and https:// pages.</div>';
    return;
  }

  try {
    const { hostname } = new URL(activeTabUrl);
    document.getElementById('cookie-domain').textContent = hostname;
  } catch { /* shouldn't happen after the guard, but be safe */ }

  const [cookies, { lockedCookies = {} }] = await Promise.all([
    chrome.cookies.getAll({ url: activeTabUrl }),
    chrome.storage.local.get('lockedCookies'),
  ]);

  const enriched = cookies.map((c) => ({
    ...c,
    isLocked: !!lockedCookies[cookieLockKey(c.domain, c.name)],
  }));

  document.getElementById('cookie-count').textContent = String(enriched.length);
  renderCookies(enriched);
}

// ─────────────────────────────────────────────
// COOKIE EDITOR — rendering
// ─────────────────────────────────────────────
function renderCookies(cookies) {
  const container = document.getElementById('cookies-list');

  if (cookies.length === 0) {
    container.innerHTML = '<div class="empty">No cookies found for this page.</div>';
    return;
  }

  container.innerHTML = '';
  cookies.forEach((cookie) => container.appendChild(buildCookieRow(cookie)));
}

function buildCookieRow(cookie) {
  const row = document.createElement('div');
  row.className = `cookie-row${cookie.isLocked ? ' locked' : ''}`;

  // Name
  const nameEl = document.createElement('span');
  nameEl.className = 'cookie-name';
  nameEl.title     = cookie.name;
  nameEl.textContent = cookie.name;

  // Value (click to edit, unless locked)
  const valueEl = document.createElement('span');
  const displayVal = cookie.value || '(empty)';
  valueEl.className = `cookie-value${cookie.isLocked ? ' locked-value' : ''}`;
  valueEl.title     = cookie.isLocked
    ? `🔒 Locked — unlock to edit. Value: ${cookie.value}`
    : `Click to edit. Value: ${cookie.value}`;
  valueEl.textContent = displayVal;
  if (!cookie.isLocked) {
    valueEl.addEventListener('click', () => openCookieEditForm(row, cookie));
  }

  // Attribute flags
  const flagsEl = document.createElement('span');
  flagsEl.className = 'cookie-flags';
  if (cookie.httpOnly) flagsEl.appendChild(makeFlag('H', 'HttpOnly'));
  if (cookie.secure)   flagsEl.appendChild(makeFlag('S', 'Secure'));
  if (cookie.sameSite && cookie.sameSite !== 'no_restriction') {
    flagsEl.appendChild(makeFlag(cookie.sameSite[0].toUpperCase(), `SameSite: ${cookie.sameSite}`));
  }

  // Lock / unlock button
  const lockBtn = document.createElement('button');
  lockBtn.className = `btn btn-lock${cookie.isLocked ? ' is-locked' : ''}`;
  lockBtn.title     = cookie.isLocked ? 'Unlock — allow site to change this cookie' : 'Lock — prevent site from changing this cookie';
  lockBtn.textContent = cookie.isLocked ? '🔒' : '🔓';
  lockBtn.addEventListener('click', () => toggleCookieLock(cookie));

  // Delete button
  const delBtn = document.createElement('button');
  delBtn.className  = 'btn btn-delete';
  delBtn.title      = 'Delete cookie';
  delBtn.textContent = '🗑';
  delBtn.addEventListener('click', () => deleteCookie(cookie, row));

  row.appendChild(nameEl);
  row.appendChild(valueEl);
  row.appendChild(flagsEl);
  row.appendChild(lockBtn);
  row.appendChild(delBtn);
  return row;
}

function makeFlag(text, title) {
  const el = document.createElement('span');
  el.className   = 'cookie-flag';
  el.title       = title;
  el.textContent = text;
  return el;
}

// ─────────────────────────────────────────────
// COOKIE EDITOR — inline value editor
// ─────────────────────────────────────────────
function openCookieEditForm(row, cookie) {
  editingActive = true;
  row.classList.add('editing');
  row.innerHTML = '';

  const nameEl = document.createElement('span');
  nameEl.className   = 'cookie-name';
  nameEl.textContent = cookie.name;

  const input = document.createElement('input');
  input.type        = 'text';
  input.className   = 'pattern-input';
  input.value       = cookie.value;
  input.placeholder = 'Cookie value…';

  const saveBtn = document.createElement('button');
  saveBtn.className   = 'btn btn-confirm';
  saveBtn.textContent = '✓ Save';
  saveBtn.addEventListener('click', () => saveCookieValue(cookie, input.value));

  const cancelBtn = document.createElement('button');
  cancelBtn.className   = 'btn btn-cancel';
  cancelBtn.textContent = '✕';
  cancelBtn.addEventListener('click', closeCookieEdit);

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter')  saveCookieValue(cookie, input.value);
    if (e.key === 'Escape') closeCookieEdit();
  });

  row.appendChild(nameEl);
  row.appendChild(input);
  row.appendChild(saveBtn);
  row.appendChild(cancelBtn);
  input.focus();
  input.select();
}

async function saveCookieValue(cookie, newValue) {
  try {
    await chrome.cookies.set({
      url:            activeTabUrl,
      name:           cookie.name,
      value:          newValue,
      domain:         cookie.domain,
      path:           cookie.path || '/',
      secure:         cookie.secure,
      httpOnly:       cookie.httpOnly,
      sameSite:       cookie.sameSite,
      ...(cookie.expirationDate ? { expirationDate: cookie.expirationDate } : {}),
    });
  } catch (err) {
    console.warn('[AdSniper] Failed to set cookie:', err.message);
  }
  closeCookieEdit();
}

function closeCookieEdit() {
  editingActive = false;
  refreshCookies();
}

// ─────────────────────────────────────────────
// COOKIE EDITOR — lock / unlock
// ─────────────────────────────────────────────
async function toggleCookieLock(cookie) {
  const { lockedCookies = {} } = await chrome.storage.local.get('lockedCookies');
  const key = cookieLockKey(cookie.domain, cookie.name);

  if (cookie.isLocked) {
    delete lockedCookies[key];
  } else {
    lockedCookies[key] = { ...cookie }; // Snapshot current value as the locked value
  }

  await chrome.storage.local.set({ lockedCookies });
  await refreshCookies();
}

// ─────────────────────────────────────────────
// COOKIE EDITOR — delete
// ─────────────────────────────────────────────
async function deleteCookie(cookie, row) {
  row.style.opacity = '0.3';
  try {
    await chrome.cookies.remove({ url: activeTabUrl, name: cookie.name });

    // Remove lock entry if it exists
    const { lockedCookies = {} } = await chrome.storage.local.get('lockedCookies');
    delete lockedCookies[cookieLockKey(cookie.domain, cookie.name)];
    await chrome.storage.local.set({ lockedCookies });
  } catch (err) {
    console.warn('[AdSniper] Failed to delete cookie:', err.message);
  }
  await refreshCookies();
}

// ─────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────
function extractHostname(url) {
  try { return new URL(url).hostname; } catch { return url; }
}

function cookieLockKey(domain, name) {
  return `${domain}::${name}`;
}

function updateFooter() {
  const footer = document.getElementById('footer');
  if (!footer) return;
  const time = new Date().toLocaleTimeString([], {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  footer.textContent = `Last updated: ${time} · auto-refresh every 2s`;
}

// ─────────────────────────────────────────────
// SNIPING GAME — disable blocking, reload/new-tab, launch game
// ─────────────────────────────────────────────

/**
 * Handles the "Sniping ON" button click.
 * 1. Saves current blocking state (mass-block, newtab-block, DOM cleanup, iframe blocker)
 * 2. Disables all blocking features so ads can load
 * 3. Reloads the current tab OR opens a new tab (based on checkbox)
 * 4. Sets snipingGamePending flag so content script launches the game after load
 */
async function handleSnipingGame() {
  const btn = document.getElementById('sniping-btn');
  btn.disabled = true;

  try {
    // ── 1. Save current state ──────────────────────────────
    const state = await chrome.storage.local.get([
      'massBlockActive', 'massBlockRuleIds',
      'newTabBlockActive', 'newTabBlockRuleIds',
      'domCleanupEnabled', 'iframeBlockerEnabled',
    ]);

    const preGameState = {
      massBlockActive:     state.massBlockActive     || false,
      massBlockRuleIds:    state.massBlockRuleIds     || [],
      newTabBlockActive:   state.newTabBlockActive   || false,
      newTabBlockRuleIds:  state.newTabBlockRuleIds  || [],
      domCleanupEnabled:   state.domCleanupEnabled   !== false, // Default true
      iframeBlockerEnabled: state.iframeBlockerEnabled || false,
    };

    await chrome.storage.local.set({ snipingPreGameState: preGameState });

    // ── 2. Disable in-page blocking so ad components load in DOM ──
    // Remove mass-block DNR rules so ad elements load inside the page
    if (preGameState.massBlockActive && preGameState.massBlockRuleIds.length > 0) {
      await chrome.declarativeNetRequest.updateDynamicRules({
        addRules: [],
        removeRuleIds: preGameState.massBlockRuleIds,
      });
    }

    // Keep or activate new-tab-block DNR rules so ads cannot open new tabs
    let activeNewTabRuleIds = preGameState.newTabBlockRuleIds;
    if (!preGameState.newTabBlockActive || activeNewTabRuleIds.length === 0) {
      const { adHosts = [] } = await chrome.storage.local.get('adHosts');
      const rules = [];
      let id = NEW_TAB_BLOCK_BASE_ID;
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
        await chrome.declarativeNetRequest.updateDynamicRules({ addRules: rules, removeRuleIds: [] });
        activeNewTabRuleIds = rules.map((r) => r.id);
      }
    }

    // Disable in-page DOM cleanup and mass-block (so ads are visible for scanning)
    // while keeping new-tab ad blocking active
    await chrome.storage.local.set({
      massBlockActive: false,
      massBlockRuleIds: [],
      newTabBlockActive: true,
      newTabBlockRuleIds: activeNewTabRuleIds,
      domCleanupEnabled: false,
      iframeBlockerEnabled: false,
    });

    await syncBadge();

    // ── 3. Set game pending flag ───────────────────────────
    const openInNewTab = document.getElementById('sniping-newtab-toggle').checked;
    await chrome.storage.local.set({
      snipingGamePending: true,
      snipingOpenNewTab: openInNewTab,
    });

    // ── 4. Reload or open new tab ─────────────────────────
    if (openInNewTab) {
      await chrome.tabs.create({ url: activeTabUrl, active: true });
    } else {
      await chrome.tabs.reload(activeTabId);
    }

    // Popup will close naturally when tab reloads/navigates
  } catch (err) {
    console.error('[AdSniper] Sniping game launch failed:', err);
    btn.disabled = false;
  }
}
// ==========================================
// PERSONAL ASSISTANT
// ==========================================
let astHistory = [];
let astContextSize = 10;
let astIsGenerating = false;
let astThinkingTimer = null;

const AST_THINKING_WORDS = [
  'Thinking', 'Pondering', 'Contemplating', 'Musing', 'Reasoning',
  'Deliberating', 'Reflecting', 'Analyzing', 'Processing', 'Cogitating',
  'Ruminating', 'Brainstorming', 'Mulling', 'Evaluating', 'Computing',
  'Deducing', 'Inferring', 'Synthesizing', 'Deciphering', 'Interpreting',
  'Formulating', 'Weighing', 'Considering', 'Examining', 'Probing',
  'Scrutinizing', 'Investigating', 'Exploring', 'Unraveling', 'Decoding',
  'Calibrating', 'Crunching', 'Distilling', 'Parsing', 'Mapping',
  'Connecting', 'Correlating', 'Hypothesizing', 'Theorizing', 'Conjuring',
  'Brewing', 'Churning', 'Sparking', 'Ideating', 'Envisioning',
  'Imagining', 'Devising', 'Scheming', 'Plotting', 'Architecting',
  'Assembling', 'Composing', 'Crafting', 'Weaving', 'Channeling',
  'Meditating', 'Concentrating', 'Focusing', 'Absorbing', 'Digesting',
  'Simmering', 'Percolating', 'Gestating', 'Incubating', 'Marinating',
  'Crystallizing', 'Resolving', 'Untangling', 'Harmonizing'
];

function startThinkingAnimation(targetDiv) {
  let idx = Math.floor(Math.random() * AST_THINKING_WORDS.length);
  if (astThinkingTimer) clearInterval(astThinkingTimer);
  function render() {
    var word = AST_THINKING_WORDS[idx % AST_THINKING_WORDS.length];
    targetDiv.innerHTML = '<div class="ast-thinking-anim"><span class="brain-buzz">🧠</span> <em>' + word + '...</em></div>';
    idx++;
  }
  render();
  astThinkingTimer = setInterval(render, 1200);
}

function stopThinkingAnimation() {
  if (astThinkingTimer) {
    clearInterval(astThinkingTimer);
    astThinkingTimer = null;
  }
}

async function initPersonalAssistant() {
  const sendBtn = document.getElementById('ast-send-btn');
  const input = document.getElementById('ast-input');
  const historyInput = document.getElementById('ast-context-size');
  
  historyInput.addEventListener('change', (e) => {
    let val = parseInt(e.target.value, 10);
    if (isNaN(val) || val < 1) val = 1;
    if (val > 50) val = 50;
    astContextSize = val;
    e.target.value = val;
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleAstSend();
    }
  });
  
  sendBtn.addEventListener('click', handleAstSend);

  // Feature Buttons
  document.getElementById('ast-btn-summarize-day').addEventListener('click', () => {
    input.value = 'Summarize my day';
    handleAstSend();
  });
  document.getElementById('ast-btn-summarize').addEventListener('click', () => {
    input.value = 'Please extract the clean readable content from this page and summarise it for me.';
    handleAstSend();
  });
  document.getElementById('ast-btn-calc').addEventListener('click', () => {
    input.value = 'Calculate: ';
    input.focus();
  });
  document.getElementById('ast-btn-grammar').addEventListener('click', () => {
    input.value = 'Fix the grammar in the following text: ';
    input.focus();
  });
  document.getElementById('ast-btn-note').addEventListener('click', () => {
    input.value = 'Save the following to my scratchpad: ';
    input.focus();
  });
  document.getElementById('ast-btn-todo').addEventListener('click', () => {
    input.value = 'Add the following to my todo list: ';
    input.focus();
  });
}

function appendAstMessage(role, text) {
  const container = document.getElementById('ast-chat-history');
  const div = document.createElement('div');
  div.className = `ast-message ${role === 'user' ? 'user-msg' : 'bot-msg'}`;
  div.innerHTML = formatAIOutput(text);
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
  return div;
}

async function handleAstSend() {
  if (astIsGenerating) return;
  const input = document.getElementById('ast-input');
  const text = input.value.trim();
  if (!text) return;
  
  input.value = '';
  appendAstMessage('user', text);
  
  astIsGenerating = true;
  document.getElementById('ast-send-btn').disabled = true;
  
  const botDiv = appendAstMessage('bot', '');
  startThinkingAnimation(botDiv);
  
  if (!window.GeminiNanoClient) {
    stopThinkingAnimation();
    botDiv.innerHTML = '<p style="color:var(--red);">AI Client not found.</p>';
    astIsGenerating = false;
    document.getElementById('ast-send-btn').disabled = false;
    return;
  }
  
  const client = window.GeminiNanoClient.getInstance();
  const context = {
    activeTabId,
    activeTabUrl,
    recentRequests: allRequests,
  };
  
  // Truncate history
  if (astHistory.length > astContextSize * 2) {
    astHistory = astHistory.slice(-(astContextSize * 2));
  }
  
  try {
    const result = await client.processAssistantPrompt(text, astHistory, context, 
      (tokenChunk) => {
        stopThinkingAnimation();
        botDiv.innerHTML = formatAIOutput(tokenChunk);
        const container = document.getElementById('ast-chat-history');
        container.scrollTop = container.scrollHeight;
      },
      (stats) => {
        document.getElementById('ast-token-count').textContent = `${stats.tokensIn + stats.tokensOut} / ${stats.maxTokens}`;
        document.getElementById('ast-speed').textContent = `${stats.speed} t/s`;
      }
    );
    
    stopThinkingAnimation();
    botDiv.innerHTML = formatAIOutput(result.reply || 'Action completed.');
    
    astHistory.push({ role: 'user', content: text });
    astHistory.push({ role: 'assistant', content: result.reply });
    
    // Check if this was a summarise request that extracted content
    if (result.actionExecuted && result.actionExecuted.tool === 'tool_extract_clean_content' && result.actionExecuted.success) {
      const content = (result.actionExecuted.result && result.actionExecuted.result.content) ? result.actionExecuted.result.content : result.actionExecuted.report;
      if (content) {
         const html = `<!DOCTYPE html><html><head><title>Cleaned Page</title><style>body{font-family:sans-serif;max-width:800px;margin:2rem auto;padding:1rem;line-height:1.6;font-size:18px;color:#333;background:#f9f9f9;}</style></head><body><h1>Extracted Content</h1>${content.replace(/\n/g, '<br>')}</body></html>`;
         const blob = new Blob([html], { type: 'text/html' });
         const url = URL.createObjectURL(blob);
         chrome.tabs.create({ url });
      }
    }
  } catch (err) {
    stopThinkingAnimation();
    botDiv.innerHTML = `<p style="color:var(--red);">Error: ${err.message}</p>`;
  }
  
  astIsGenerating = false;
  document.getElementById('ast-send-btn').disabled = false;
  const container = document.getElementById('ast-chat-history');
  container.scrollTop = container.scrollHeight;
}

// ==========================================
// LISTS PANEL (SCRATCHPAD & TODOS)
// ==========================================
let todos = [];

async function initListsPanel() {
  const scratchpad = document.getElementById('scratchpad-input');
  const scratchClear = document.getElementById('scratchpad-clear');
  const todoList = document.getElementById('todo-list');
  const todoInput = document.getElementById('todo-input');
  const todoAddBtn = document.getElementById('todo-add-btn');
  const todoClear = document.getElementById('todo-clear');

  // Load from storage
  const stored = await chrome.storage.local.get(['astScratchpad', 'astTodos']);
  if (stored.astScratchpad) {
    scratchpad.value = stored.astScratchpad;
  }
  if (stored.astTodos && Array.isArray(stored.astTodos)) {
    todos = stored.astTodos;
  }
  renderTodos();

  // Scratchpad events
  scratchpad.addEventListener('input', () => {
    chrome.storage.local.set({ astScratchpad: scratchpad.value });
  });
  scratchClear.addEventListener('click', () => {
    scratchpad.value = '';
    chrome.storage.local.set({ astScratchpad: '' });
  });

  // Initialize ETA to today with limits
  const etaInputElem = document.getElementById('todo-eta-input');
  if (etaInputElem) {
    const today = new Date();
    etaInputElem.value = today.toISOString().split('T')[0];
    
    // min is -1 month, max is +5 years
    const minDate = new Date(today);
    minDate.setMonth(minDate.getMonth() - 1);
    etaInputElem.min = minDate.toISOString().split('T')[0];
    const maxDate = new Date(today);
    maxDate.setFullYear(today.getFullYear() + 5);
    etaInputElem.max = maxDate.toISOString().split('T')[0];

    etaInputElem.addEventListener('change', () => {
      const selected = new Date(etaInputElem.value);
      if (isNaN(selected.getTime()) || selected > maxDate) {
        const fallback = new Date(today);
        fallback.setDate(today.getDate() + 2);
        etaInputElem.value = fallback.toISOString().split('T')[0];
      }
    });
  }

  // Todo events
  todoAddBtn.addEventListener('click', () => {
    const text = todoInput.value.trim();
    const etaVal = document.getElementById('todo-eta-input').value;
    const descVal = document.getElementById('todo-desc-input').value.trim();
    if (text) {
      todos.push({ 
        id: Date.now(), 
        text, 
        done: false,
        createdAt: new Date().toISOString(),
        description: descVal,
        eta: etaVal ? new Date(etaVal).toISOString() : null
      });
      chrome.storage.local.set({ astTodos: todos });
      todoInput.value = '';
      document.getElementById('todo-eta-input').value = new Date().toISOString().split('T')[0];
      document.getElementById('todo-desc-input').value = '';
      renderTodos();
    }
  });
  todoInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') todoAddBtn.click();
  });
  todoClear.addEventListener('click', () => {
    todos = todos.filter(t => !t.done);
    chrome.storage.local.set({ astTodos: todos });
    renderTodos();
  });

  // MCP Event Listeners
  window.addEventListener('AST_SCRATCHPAD_UPDATE', (e) => {
    const { content, append } = e.detail;
    if (append && scratchpad.value) {
      scratchpad.value += '\n\n' + content;
    } else {
      scratchpad.value = content;
    }
    chrome.storage.local.set({ astScratchpad: scratchpad.value });
  });

  window.addEventListener('AST_TODO_ADD', (e) => {
    const { task, description, eta } = e.detail;
    if (task) {
      todos.push({ 
        id: Date.now(), 
        text: task, 
        done: false, 
        createdAt: new Date().toISOString(), 
        description: description || '', 
        eta: eta || null 
      });
      chrome.storage.local.set({ astTodos: todos });
      renderTodos();
    }
  });

  function renderTodos() {
    todoList.innerHTML = '';
    todos.forEach((todo, index) => {
      const div = document.createElement('div');
      div.className = 'todo-item ' + (todo.done ? 'done' : '');
      
      let bg = '';
      let daysLeftText = '';
      let scale = 1;

      if (todo.eta && !todo.done) {
        const now = new Date();
        const etaDate = new Date(todo.eta);
        now.setHours(0,0,0,0);
        etaDate.setHours(0,0,0,0);
        const diffDays = Math.round((etaDate - now) / (1000 * 60 * 60 * 24));
        
        if (!isNaN(diffDays)) {
          if (diffDays >= 10) {
            bg = 'linear-gradient(to right, #22c55e 100%, transparent 0%)';
            daysLeftText = `${diffDays} days left`;
          } else if (diffDays > 0) {
            const pct = (diffDays / 10) * 100;
            bg = `linear-gradient(to right, #eab308 ${pct}%, #22c55e ${pct}%)`;
            daysLeftText = `${diffDays} days left`;
          } else if (diffDays === 0) {
            bg = 'linear-gradient(to right, #ef4444 100%, transparent 0%)';
            daysLeftText = 'Due today!';
          } else {
            const overdue = Math.abs(diffDays);
            daysLeftText = `${overdue} days overdue!`;
            bg = 'linear-gradient(to right, #ef4444 100%, transparent 0%)';
            if (overdue >= 5) {
              scale = 1;
              div.classList.add('todo-on-fire');
            } else {
              scale = 1 + (overdue * 0.07);
              if (scale > 1.35) scale = 1.35;
            }
          }
        }
      }

      if (scale !== 1) {
        div.style.transform = `scaleY(${scale})`;
        div.style.margin = `${(scale - 1) * 20}px 0`;
        div.style.zIndex = '10';
      }

      const progress = document.createElement('div');
      progress.className = 'todo-progress';
      if (bg) progress.style.background = bg;
      
      const contentRow = document.createElement('div');
      contentRow.className = 'todo-item-content';
      
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = todo.done;
      cb.addEventListener('change', (e) => {
        e.stopPropagation();
        todo.done = cb.checked;
        chrome.storage.local.set({ astTodos: todos });
        renderTodos();
      });

      const span = document.createElement('span');
      span.textContent = todo.text;

      const del = document.createElement('button');
      del.className = 'todo-item-del';
      del.textContent = 'x';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        todos.splice(index, 1);
        chrome.storage.local.set({ astTodos: todos });
        renderTodos();
      });

      contentRow.appendChild(cb);
      contentRow.appendChild(span);
      contentRow.appendChild(del);

      const details = document.createElement('div');
      details.className = 'todo-details';
      
      const createdDate = todo.createdAt ? new Date(todo.createdAt).toLocaleDateString() : 'Unknown';
      let detailsHTML = `<div style="display: flex; gap: 8px; margin-bottom: 4px;">
        <p style="margin: 0; flex: 1;"><strong>Created:</strong> ${createdDate}</p>
        ${todo.eta ? `<p style="margin: 0;">(${daysLeftText})</p>` : ''}
      </div>
      <div style="display: flex; flex-direction: column; gap: 4px;" class="todo-edit-area">
        <label style="font-size: 10px; margin-bottom: -2px;">ETA:</label>
        <input type="date" class="edit-eta" min="${new Date(new Date().setMonth(new Date().getMonth() - 1)).toISOString().split('T')[0]}" max="${new Date(new Date().setFullYear(new Date().getFullYear() + 5)).toISOString().split('T')[0]}" value="${todo.eta ? todo.eta.split('T')[0] : ''}" style="padding: 4px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text);">
        <label style="font-size: 10px; margin-bottom: -2px;">Description:</label>
        <textarea class="edit-desc" style="padding: 4px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); resize: vertical; min-height: 40px;">${todo.description || ''}</textarea>
      </div>`;
      details.innerHTML = detailsHTML;

      const editArea = details.querySelector('.todo-edit-area');
      editArea.addEventListener('click', (e) => e.stopPropagation());

      const etaInput = details.querySelector('.edit-eta');
      const descInput = details.querySelector('.edit-desc');

      etaInput.addEventListener('change', () => {
        const val = etaInput.value;
        if (val) {
           const selected = new Date(val);
           const maxDate = new Date();
           maxDate.setFullYear(maxDate.getFullYear() + 5);
           if (isNaN(selected.getTime()) || selected > maxDate) {
             const fallback = new Date();
             fallback.setDate(fallback.getDate() + 2);
             etaInput.value = fallback.toISOString().split('T')[0];
             todo.eta = fallback.toISOString();
           } else {
             todo.eta = selected.toISOString();
           }
        } else {
           todo.eta = null;
        }
        chrome.storage.local.set({ astTodos: todos });
        renderTodos();
      });

      descInput.addEventListener('change', () => {
        todo.description = descInput.value;
        chrome.storage.local.set({ astTodos: todos });
      });

      div.addEventListener('click', () => {
        details.classList.toggle('expanded');
      });

      div.appendChild(progress);
      div.appendChild(contentRow);
      div.appendChild(details);
      todoList.appendChild(div);
    });
  }
}
