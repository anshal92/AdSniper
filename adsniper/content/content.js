/**
 * AdSniper v2 — Content Script
 *
 * Injected into every http/https page at document_idle.
 * Hides DOM elements whose src/href/style matches a blocked URL or pattern.
 *
 * All removal is via `display: none !important` — reversible on page reload.
 * Elements are tracked in a WeakSet so they're never processed twice.
 *
 * Message API (from SW or popup):
 *   REMOVE_AD_ELEMENT   { url }                → hide element(s) matching that exact URL
 *   APPLY_BLOCKED_PATTERNS { hosts, patterns } → full DOM scan + update MutationObserver state
 *   CLEAN_PAGE          {}                     → immediate full DOM scan with current patterns
 *   SET_DOM_CLEANUP     { enabled }            → toggle feature on/off
 *   GET_HIDDEN_COUNT    {}                     → returns { hiddenCount }
 */

'use strict';

// ── Double-injection guard ────────────────────────────────────────────────────
// content_scripts in manifest.json auto-inject into new navigations.
// popup.js may also inject on-demand (via chrome.scripting.executeScript) for
// tabs that were already open before the extension loaded/reloaded.
// This guard aborts the second run so we never have duplicate listeners.
if (window.__adSniperInjected) {
  throw new Error('[AdSniper] Content script already injected — skipping re-init');
}
window.__adSniperInjected = true;

// ─────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────
let domCleanupEnabled = true;
let blockedHosts      = [];   // e.g. ["doubleclick.net", "googlesyndication.com"]
let blockedPatterns   = [];   // e.g. ["adserv", "pagead", "/ads/"]
let hiddenCount       = 0;    // Running total for this page session

// Element picker state
let pickerActive = false;

// iFrame ad blocker state
let iframeBlockerEnabled = false;
let iframesRemovedCount  = 0;

// WeakSet prevents double-processing and avoids memory leaks
const hiddenElements = new WeakSet();

// Regex for recognising ad container class/id names
const AD_CONTAINER_RE =
  /\b(ad|ads|advert|advertisement|banner|sponsor(?:ed)?|promo|dfp|gpt|adsbox|ad[-_]slot|ad[-_]unit|ad[-_]container|ad[-_]wrap(?:per)?|ad[-_]box|adframe|adsbygoogle)\b/i;

// ─────────────────────────────────────────────────────────
// Message listener — SW and popup both talk to us here
// ─────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message.type) {

    case 'REMOVE_AD_ELEMENT': {
      if (!domCleanupEnabled) { sendResponse({ hidden: 0 }); break; }
      const hidden = hideByUrl(message.url);
      hiddenCount += hidden;
      sendResponse({ hidden, total: hiddenCount });
      break;
    }

    case 'APPLY_BLOCKED_PATTERNS': {
      // Update state — MutationObserver will now use these going forward
      blockedHosts    = message.hosts    || [];
      blockedPatterns = message.patterns || [];
      const hidden = domCleanupEnabled ? scanAndHide() : 0;
      hiddenCount += hidden;
      sendResponse({ hidden, total: hiddenCount });
      break;
    }

    case 'CLEAN_PAGE': {
      const hidden = scanAndHide();
      hiddenCount += hidden;
      sendResponse({ hidden, total: hiddenCount });
      break;
    }

    case 'SET_DOM_CLEANUP': {
      domCleanupEnabled = message.enabled;
      sendResponse({ ok: true, total: hiddenCount });
      break;
    }

    case 'GET_HIDDEN_COUNT': {
      sendResponse({ total: hiddenCount });
      break;
    }

    case 'START_ELEMENT_PICKER': {
      startElementPicker();
      sendResponse({ ok: true });
      break;
    }

    case 'TOGGLE_IFRAME_BLOCKER': {
      iframeBlockerEnabled = message.enabled;
      if (iframeBlockerEnabled) {
        const removed = scanAndRemoveAdIframes();
        sendResponse({ removed, total: iframesRemovedCount });
      } else {
        sendResponse({ removed: 0, total: iframesRemovedCount });
      }
      break;
    }

    case 'GET_IFRAME_STATS': {
      sendResponse({ total: iframesRemovedCount, enabled: iframeBlockerEnabled });
      break;
    }

    case 'START_SNIPING_GAME': {
      launchSnipingGame();
      sendResponse({ ok: true });
      break;
    }
  }

  return true; // Keep async message channel open
});

// ─────────────────────────────────────────────────────────
// Hide elements matching one specific blocked URL
// Called reactively by the SW for every onRuleMatchedDebug hit.
// ─────────────────────────────────────────────────────────
function hideByUrl(url) {
  let count = 0;
  for (const el of findByUrl(url)) {
    const container = bestContainer(el);
    if (applyHide(container)) count++;
  }
  return count;
}

/** Returns all DOM elements that reference the given URL. */
function findByUrl(url) {
  const results = [];
  const base = stripQuery(url); // Match without query string too

  document.querySelectorAll(
    'img, script, iframe, video, audio, source, embed, object, link'
  ).forEach((el) => {
    for (const attr of urlAttrs(el)) {
      if (attr === url || attr === base || attr.startsWith(base)) {
        results.push(el);
        break;
      }
    }
  });

  // Inline background-image style
  document.querySelectorAll('[style]').forEach((el) => {
    const bg = extractBgUrl(el.style.backgroundImage);
    if (bg && (bg === url || bg.startsWith(base))) results.push(el);
  });

  return results;
}

// ─────────────────────────────────────────────────────────
// Full DOM scan — used by CLEAN_PAGE and APPLY_BLOCKED_PATTERNS
// ─────────────────────────────────────────────────────────
function scanAndHide() {
  if (blockedHosts.length === 0 && blockedPatterns.length === 0) return 0;

  let count = 0;
  document.querySelectorAll(
    'img, script, iframe, video, audio, source, embed, object, link, [style]'
  ).forEach((el) => {
    if (anyUrlMatches(el)) {
      const container = bestContainer(el);
      if (applyHide(container)) count++;
    }
  });
  return count;
}

// ─────────────────────────────────────────────────────────
// URL helpers
// ─────────────────────────────────────────────────────────
function urlAttrs(el) {
  return [
    el.src,
    el.href,
    el.currentSrc,
    el.dataset?.src,
    el.dataset?.lazySrc,
    el.dataset?.originalSrc,
  ].filter(Boolean);
}

function stripQuery(url) {
  try { return url.split('?')[0]; } catch { return url; }
}

function extractBgUrl(bgImage) {
  if (!bgImage) return null;
  const m = bgImage.match(/url\(["']?([^"')]+)["']?\)/);
  return m ? m[1] : null;
}

function anyUrlMatches(el) {
  const urls = urlAttrs(el);
  const bg   = extractBgUrl(el.style?.backgroundImage);
  if (bg) urls.push(bg);
  return urls.some((u) => isBlocked(u));
}

function isBlocked(url) {
  if (!url) return false;
  let hostname = '';
  try { hostname = new URL(url).hostname; } catch { return false; }

  // Exact hostname match or subdomain match
  if (blockedHosts.some((h) => hostname === h || hostname.endsWith(`.${h}`))) return true;

  // URL substring pattern match
  const lower = url.toLowerCase();
  return blockedPatterns.some((p) => lower.includes(p.toLowerCase()));
}

// ─────────────────────────────────────────────────────────
// Smart container detection — walk up the DOM to find
// the best-named ad wrapper to remove instead of just
// the raw leaf element.
// ─────────────────────────────────────────────────────────
function bestContainer(element) {
  let best = element;
  let node = element;

  for (let depth = 0; depth < 6; depth++) {
    const parent = node.parentElement;
    if (!parent || parent === document.body || parent === document.documentElement) break;

    const label = `${parent.className || ''} ${parent.id || ''}`;
    if (AD_CONTAINER_RE.test(label)) {
      best = parent; // Climb as high as the ad wrapper goes
    }
    node = parent;
  }

  return best;
}

// ─────────────────────────────────────────────────────────
// Apply hide — display:none !important (reversible on reload)
// ─────────────────────────────────────────────────────────
function applyHide(el) {
  if (hiddenElements.has(el)) return false; // Already handled
  hiddenElements.add(el);
  el.style.setProperty('display', 'none', 'important');
  el.setAttribute('data-adsniper-hidden', 'true');
  return true;
}

// ─────────────────────────────────────────────────────────
// MutationObserver — catches dynamically injected ad elements
// (SPA navigations, lazy-loaded ad slots, etc.)
// ─────────────────────────────────────────────────────────
function processNewNode(node) {
  if (node.nodeType !== Node.ELEMENT_NODE) return;
  if (hiddenElements.has(node)) return;

  // Check the node itself
  if (anyUrlMatches(node)) {
    const container = bestContainer(node);
    if (applyHide(container)) hiddenCount++;
    return;
  }

  // Check all ad-likely descendants
  node.querySelectorAll?.('img, script, iframe, video, audio, source, embed, object').forEach((child) => {
    if (anyUrlMatches(child)) {
      const container = bestContainer(child);
      if (applyHide(container)) hiddenCount++;
    }
  });
}

const mutationObserver = new MutationObserver((mutations) => {
  if (!domCleanupEnabled) return;
  if (blockedHosts.length === 0 && blockedPatterns.length === 0) return;

  for (const mutation of mutations) {
    for (const node of mutation.addedNodes) {
      processNewNode(node);

      // Also check for dynamically injected ad iframes
      if (iframeBlockerEnabled && node.nodeType === Node.ELEMENT_NODE) {
        if (node.tagName === 'IFRAME' && isAdIframe(node)) {
          node.remove();
          iframesRemovedCount++;
        }
        node.querySelectorAll?.('iframe').forEach((iframe) => {
          if (isAdIframe(iframe)) {
            iframe.remove();
            iframesRemovedCount++;
          }
        });
      }
    }
  }
});

mutationObserver.observe(document.documentElement, {
  childList: true,
  subtree: true,
});

// ─────────────────────────────────────────────────────────
// Init — load persisted state and run initial scan if needed
// ─────────────────────────────────────────────────────────
chrome.storage.local.get(
  ['domCleanupEnabled', 'adHosts', 'adPatterns', 'massBlockActive', 'iframeBlockerEnabled', 'snipingGamePending'],
  (result) => {
    domCleanupEnabled    = result.domCleanupEnabled !== false; // Default true
    iframeBlockerEnabled = result.iframeBlockerEnabled === true; // Default false
    blockedHosts         = result.adHosts    || [];
    blockedPatterns      = result.adPatterns || [];

    // If the "AD Blocker" mass-block was already ON when this page loaded, scan immediately
    if (domCleanupEnabled && result.massBlockActive) {
      const count = scanAndHide();
      hiddenCount += count;
      if (count > 0) {
        console.debug(`[AdSniper] Hidden ${count} ad element(s) on page load`);
      }
    }

    // If iframe blocker was ON, scan immediately
    if (iframeBlockerEnabled) {
      const removed = scanAndRemoveAdIframes();
      if (removed > 0) {
        console.debug(`[AdSniper] Removed ${removed} ad iframe(s) on page load`);
      }
    }

    // If sniping game was pending (page reloaded/new tab for game), launch it
    if (result.snipingGamePending) {
      chrome.storage.local.set({ snipingGamePending: false });
      // Wait for ads to fully render before launching game
      setTimeout(() => launchSnipingGame(), 1500);
    }
  }
);

// ─────────────────────────────────────────────────────────
// ELEMENT PICKER — visual point-and-click ad blocker
//
// Flow:
//   1. Popup sends START_ELEMENT_PICKER → this function activates
//   2. An overlay captures all mouse events
//   3. Hover: highlights the element under cursor
//   4. Click: extracts the nearest ad URL, sends ADD_BLOCK_RULE
//      to the SW, hides the element, exits picker mode
//   5. Escape: cancels picker
// ─────────────────────────────────────────────────────────

function startElementPicker() {
  if (pickerActive) return;
  pickerActive = true;

  // ── Create overlay ──
  const overlay = document.createElement('div');
  overlay.id = 'adsniper-picker-overlay';
  Object.assign(overlay.style, {
    position: 'fixed',
    top: '0', left: '0', width: '100vw', height: '100vh',
    zIndex: '2147483646',
    cursor: 'crosshair',
    background: 'transparent',
  });

  // ── Highlight box ──
  const highlight = document.createElement('div');
  highlight.id = 'adsniper-picker-highlight';
  Object.assign(highlight.style, {
    position: 'fixed',
    border: '2px solid #ef4444',
    background: 'rgba(239,68,68,0.12)',
    borderRadius: '3px',
    pointerEvents: 'none',
    zIndex: '2147483647',
    transition: 'top .05s, left .05s, width .05s, height .05s',
    display: 'none',
  });

  // ── Tooltip label ──
  const tooltip = document.createElement('div');
  tooltip.id = 'adsniper-picker-tooltip';
  Object.assign(tooltip.style, {
    position: 'fixed',
    zIndex: '2147483647',
    background: '#1c1c28',
    color: '#e8e8f0',
    fontFamily: 'Segoe UI, system-ui, sans-serif',
    fontSize: '11px',
    padding: '4px 10px',
    borderRadius: '4px',
    border: '1px solid #ef4444',
    pointerEvents: 'none',
    whiteSpace: 'nowrap',
    display: 'none',
    maxWidth: '400px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  });

  document.documentElement.appendChild(overlay);
  document.documentElement.appendChild(highlight);
  document.documentElement.appendChild(tooltip);

  let currentTarget = null;

  function onMouseMove(e) {
    // Hide overlay temporarily to get the real element beneath
    overlay.style.pointerEvents = 'none';
    const el = document.elementFromPoint(e.clientX, e.clientY);
    overlay.style.pointerEvents = 'auto';

    if (!el || el === document.body || el === document.documentElement) {
      highlight.style.display = 'none';
      tooltip.style.display   = 'none';
      currentTarget = null;
      return;
    }

    currentTarget = el;
    const rect = el.getBoundingClientRect();
    Object.assign(highlight.style, {
      display: 'block',
      top:    `${rect.top}px`,
      left:   `${rect.left}px`,
      width:  `${rect.width}px`,
      height: `${rect.height}px`,
    });

    // Show tooltip with tag name and extracted URL preview
    const url = extractBestUrl(el);
    const tag = el.tagName.toLowerCase();
    const cls = el.className ? `.${String(el.className).split(/\s+/).slice(0, 2).join('.')}` : '';
    tooltip.textContent = url
      ? `🎯 ${tag}${cls} → ${truncateUrl(url, 60)}`
      : `🎯 ${tag}${cls} (no URL found — will search ancestors)`;
    Object.assign(tooltip.style, {
      display: 'block',
      top:  `${Math.max(0, rect.top - 28)}px`,
      left: `${Math.max(0, rect.left)}px`,
    });
  }

  function onClick(e) {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    if (!currentTarget) { cleanupPicker(); return; }

    // Search the element and its ancestors for the best URL to block
    const url = findNearestAdUrl(currentTarget);
    const container = bestContainer(currentTarget);

    if (url) {
      let hostname;
      try { hostname = new URL(url).hostname; } catch { hostname = null; }
      const pattern = hostname ? `||${hostname}` : url;

      // Hide the element
      applyHide(container);
      hiddenCount++;

      // Ask SW to add the block rule (content scripts can't call declarativeNetRequest)
      chrome.runtime.sendMessage({
        type: 'ADD_BLOCK_RULE',
        pattern,
        url,
      });

      console.log(`[AdSniper Picker] Blocked: ${pattern} | Hidden: <${container.tagName.toLowerCase()}>`);
    } else {
      // No URL found — just hide the element the user clicked
      applyHide(container);
      hiddenCount++;
      console.log(`[AdSniper Picker] Hidden (no URL): <${container.tagName.toLowerCase()}>`);
    }

    cleanupPicker();
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      cleanupPicker();
    }
  }

  function cleanupPicker() {
    pickerActive = false;
    overlay.remove();
    highlight.remove();
    tooltip.remove();
    document.removeEventListener('mousemove', onMouseMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKeyDown, true);
  }

  document.addEventListener('mousemove', onMouseMove, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKeyDown, true);
}

/**
 * Searches the element and up to 6 ancestors for a src/href URL.
 * Prefers URLs that match known ad patterns, but will take any external URL.
 */
function findNearestAdUrl(startEl) {
  let node = startEl;
  let fallbackUrl = null;

  for (let depth = 0; depth < 8; depth++) {
    if (!node || node === document.documentElement) break;

    const urls = urlAttrs(node);
    const bg = extractBgUrl(node.style?.backgroundImage);
    if (bg) urls.push(bg);

    // Prefer URLs that match known ad patterns
    for (const u of urls) {
      if (isBlocked(u)) return u;
    }

    // Keep the first external URL found as fallback
    if (!fallbackUrl && urls.length > 0) {
      const external = urls.find((u) => {
        try { return new URL(u).hostname !== location.hostname; } catch { return false; }
      });
      if (external) fallbackUrl = external;
    }

    node = node.parentElement;
  }

  return fallbackUrl;
}

function extractBestUrl(el) {
  const urls = urlAttrs(el);
  const bg = extractBgUrl(el.style?.backgroundImage);
  if (bg) urls.push(bg);
  return urls[0] || null;
}

function truncateUrl(url, max) {
  return url.length > max ? url.slice(0, max) + '…' : url;
}

// ─────────────────────────────────────────────────────────
// IFRAME AD BLOCKER — find and completely remove ad iframes
//
// Unlike regular DOM cleanup (display:none), this feature
// fully removes matching iframes from the DOM as requested.
// ─────────────────────────────────────────────────────────

/** Checks if an iframe looks like an ad based on its src, id, class, or size. */
function isAdIframe(iframe) {
  const src = iframe.src || iframe.dataset?.src || '';

  // 1. Check src against ad hosts/patterns
  if (src && isBlocked(src)) return true;

  // 2. Check id/class for ad-related names
  const label = `${iframe.className || ''} ${iframe.id || ''} ${iframe.name || ''}`;
  if (AD_CONTAINER_RE.test(label)) return true;

  // 3. Tiny pixel iframes (1×1, 0×0) are almost always trackers
  const w = iframe.width  || iframe.getAttribute('width')  || '';
  const h = iframe.height || iframe.getAttribute('height') || '';
  if ((w === '0' || w === '1') && (h === '0' || h === '1')) return true;

  // 4. Hidden iframes are suspicious
  const rect = iframe.getBoundingClientRect();
  if (rect.width <= 1 && rect.height <= 1) return true;

  // 5. Common ad iframe src patterns not caught by isBlocked
  const srcLower = src.toLowerCase();
  const adIframePats = [
    'safeframe', 'tpc.googlesyndication', 'ad_iframe', 'ad-iframe',
    'googleads', 'amazon-adsystem', 'facebook.com/tr', 'doubleclick',
  ];
  if (adIframePats.some((p) => srcLower.includes(p))) return true;

  return false;
}

/** Scans all iframes on the page and removes ones that look like ads. */
function scanAndRemoveAdIframes() {
  let count = 0;
  // Use spread to snapshot the list since we're removing during iteration
  [...document.querySelectorAll('iframe')].forEach((iframe) => {
    if (isAdIframe(iframe)) {
      iframe.remove();
      count++;
      iframesRemovedCount++;
    }
  });
  return count;
}

// ─────────────────────────────────────────────────────────
// SNIPING GAME — dynamically loads the game engine and launches it
//
// The game engine lives in content/sniper-game.js and is loaded
// on-demand via web_accessible_resources to avoid bloating every
// page load with ~15KB of game code.
// ─────────────────────────────────────────────────────────

let snipingGameLoaded = false;

function launchSnipingGame() {
  if (snipingGameLoaded && window.AdSniperGame) {
    window.AdSniperGame.launchGame();
    return;
  }

  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('content/sniper-game.js');
  script.onload = () => {
    snipingGameLoaded = true;
    if (window.AdSniperGame) {
      window.AdSniperGame.launchGame();
    } else {
      console.error('[AdSniper] Game engine failed to initialize');
    }
  };
  script.onerror = (err) => {
    console.error('[AdSniper] Failed to load game engine:', err);
    // Clean up the pending flag
    chrome.storage.local.set({ snipingGamePending: false });
  };
  document.head.appendChild(script);
}

// Listen for game-end events from the game engine (runs in page main world)
// The game can't call chrome.* APIs directly, so it posts a message here.
window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  if (event.data?.type !== 'ADSNIPER_GAME_ENDED') return;

  console.log(`[AdSniper] Game ended — Score: ${event.data.score}, Birds: ${event.data.birdsHit}/${event.data.totalBirds}`);

  // Tell SW to restore pre-game blocking state
  chrome.runtime.sendMessage({ type: 'RESTORE_SNIPING_STATE' }, (response) => {
    if (response?.ok) {
      console.log('[AdSniper] Blocking state restored');
    } else {
      console.warn('[AdSniper] Failed to restore state:', response);
    }
  });

  // Clear the game pending flag
  chrome.storage.local.set({ snipingGamePending: false });
});
