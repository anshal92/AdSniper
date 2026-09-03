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
    // Auto-expand Requests and Blocked Rules back to default view
    setSectionCollapsed('requests', false);
    setSectionCollapsed('rules', false);
    if (window.GeminiNanoClient) {
      window.GeminiNanoClient.getInstance().destroy();
    }
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
  responseText.innerHTML = '<p style="color:var(--accent);"><em>Thinking with on-device AI…</em></p>';

  try {
    const client = window.GeminiNanoClient.getInstance();
    const context = {
      activeTabId,
      activeTabUrl,
      recentRequests: allRequests,
    };

    const result = await client.processPrompt(prompt, context, (tokenChunk) => {
      // Live streaming update with formatting
      responseText.innerHTML = formatAIOutput(tokenChunk);
      responseBox.scrollTop = responseBox.scrollHeight;
    });

    responseText.innerHTML = formatAIOutput(result.reply || 'Action executed.');
    responseBox.scrollTop = responseBox.scrollHeight;

    if (result.actionExecuted && result.actionExecuted.success) {
      actionCard.style.display = 'flex';
      const action = result.actionExecuted;
      const cardText = `⚡ ${action.message || 'Action executed'}`;

      actionCard.innerHTML = `<span>${cardText}</span>`;

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
