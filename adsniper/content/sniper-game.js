/**
 * AdSniper — Sniping Game Engine
 *
 * Full-screen HTML5 Canvas shooting game that turns ad elements into
 * flying "birds" the user can shoot with a crosshair.
 *
 * Lifecycle:
 *   1. launchGame(adElements) called by content.js after ad scan
 *   2. Loading screen while birds are built from ad data
 *   3. Game loop: birds fly in zigzag, user clicks to shoot
 *   4. Game over when all birds destroyed or user presses Escape
 *   5. Sends RESTORE_SNIPING_STATE to SW, cleans up
 *
 * This file is loaded via web_accessible_resources and executed in the
 * content script's isolated world.
 */

'use strict';

// Namespace — avoids global pollution in the content script world
window.AdSniperGame = (() => {

  // ═══════════════════════════════════════════════
  //  CONSTANTS
  // ═══════════════════════════════════════════════
  const MIN_BIRD_SIZE_PCT = 0.05;   // 5% of min(vw, vh)
  const MAX_BIRD_SIZE_PCT = 0.20;   // 20% of min(vw, vh)
  const BIRD_SPEED        = 3;      // px/frame (constant)
  const ZIGZAG_A1         = 40;     // Primary amplitude (px)
  const ZIGZAG_F1         = 0.02;   // Primary frequency
  const ZIGZAG_A2         = 15;     // Secondary amplitude (flutter)
  const ZIGZAG_F2         = 0.07;   // Secondary frequency
  const PARTICLE_COUNT    = 12;     // Particles per explosion
  const PARTICLE_LIFETIME = 30;     // Frames
  const COMBO_DECAY_MS    = 2000;   // Combo resets after this idle time
  const LOADING_DELAY_MS  = 3000;   // Wait for ads to render before scanning
  const CROSSHAIR_SIZE    = 20;     // Crosshair radius in px

  // Colors
  const COLOR_BG        = 'rgba(15, 15, 23, 0.75)';
  const COLOR_HUD_BG    = 'rgba(28, 28, 40, 0.9)';
  const COLOR_TEXT       = '#e8e8f0';
  const COLOR_ACCENT    = '#7c6aff';
  const COLOR_GREEN      = '#22c55e';
  const COLOR_RED        = '#ef4444';
  const COLOR_AMBER      = '#f59e0b';
  const COLOR_MUTED      = '#6b6b88';

  const BIRD_COLORS = [
    '#ef4444', '#f97316', '#f59e0b', '#22c55e',
    '#3b82f6', '#8b5cf6', '#ec4899', '#06b6d4',
  ];

  // ═══════════════════════════════════════════════
  //  GAME STATE
  // ═══════════════════════════════════════════════
  let canvas, ctx;
  let gameState = 'LOADING'; // LOADING | PLAYING | GAME_OVER
  let birds = [];
  let particles = [];
  let score = 0;
  let combo = 0;
  let bestCombo = 0;
  let lastHitTime = 0;
  let totalBirds = 0;
  let birdsHit = 0;
  let shotsFired = 0;
  let shotsMissed = 0;
  let multikillCount = 0;
  let doubleKills = 0;
  let tripleKills = 0;
  let multiKills = 0; // 4+ kills
  let fireworks = []; // Fireworks for accuracy > 80%
  let fireworkSpawnTimer = 0;
  let quitButtonBounds = { x: 0, y: 0, w: 0, h: 0 };
  let mouseX = 0, mouseY = 0;
  let animFrameId = null;
  let frameCount = 0;
  let loadingProgress = 0;
  let loadingMessage = 'Scanning for ads...';
  let gameOverAlpha = 0; // Fade-in for game over screen
  let loadingPurgedAds = []; // Overlays caught and purged during the loading screen

  // ═══════════════════════════════════════════════
  //  COVERING OVERLAY & POPUP PURGER
  // ═══════════════════════════════════════════════
  let popupObserver = null;
  let overlayCheckInterval = null;
  let antiOverlayStyleEl = null;

  /**
   * Injects CSS rules to immediately hide and deactivate ad overlays, modals,
   * and anti-adblock banners before and during game loading.
   */
  function injectAntiOverlayStyles() {
    if (antiOverlayStyleEl && antiOverlayStyleEl.isConnected) return;
    try {
      antiOverlayStyleEl = document.createElement('style');
      antiOverlayStyleEl.id = 'adsniper-anti-overlay-css';
      antiOverlayStyleEl.textContent = `
        [data-shb],
        [data-area],
        [data-onopen],
        [data-onclose],
        .D1BnW,
        ._0Or05,
        .Kv1JU,
        #a1rmqtdyf,
        #custom-ad-slot,
        [id^="bg-ssp-"],
        div[style*="2147483647"]:not(#adsniper-game-canvas),
        div[style*="2147483646"]:not(#adsniper-game-canvas),
        div[style*="z-index: 2147483647"]:not(#adsniper-game-canvas),
        div[style*="z-index: 2147483646"]:not(#adsniper-game-canvas),
        iframe[src*="nauticaldiscipline"],
        iframe[src*="composed-stop"],
        iframe[src*="hoopoohonesty"],
        iframe[src*="shikosharply"],
        iframe[src*="mynahsterfez"],
        iframe[src*="pubadx"] {
          display: none !important;
          visibility: hidden !important;
          opacity: 0 !important;
          pointer-events: none !important;
          z-index: -999999 !important;
        }
      `;
      (document.head || document.documentElement).appendChild(antiOverlayStyleEl);
    } catch (e) {
      console.warn('[AdSniper] Failed to inject anti-overlay styles:', e);
    }
  }

  function removeAntiOverlayStyles() {
    if (antiOverlayStyleEl) {
      try { antiOverlayStyleEl.remove(); } catch (e) {}
      antiOverlayStyleEl = null;
    }
    const existing = document.getElementById('adsniper-anti-overlay-css');
    if (existing) {
      try { existing.remove(); } catch (e) {}
    }
  }

  /**
   * Intercepts and drops ad-network window message events that trigger new tab popups.
   */
  function onInterceptAdMessage(e) {
    if (e.data && (e.data.$G$ || (typeof e.data === 'object' && (e.data.event === 'open' || e.data.event === 'close')))) {
      if (typeof e.stopImmediatePropagation === 'function') {
        e.stopImmediatePropagation();
      }
      console.warn('[AdSniper] Intercepted ad postMessage:', e.data);
    }
  }

  /**
   * Walks up the DOM tree from an element to find its topmost overlay container.
   */
  function getOverlayRoot(el) {
    let target = el;
    while (target && target.parentElement && target.parentElement !== document.body && target.parentElement !== document.documentElement) {
      const p = target.parentElement;
      if (p.id === 'adsniper-game-canvas' || (p.id && p.id.startsWith('adsniper'))) return el;
      if (p.hasAttribute('data-shb') ||
          p.id === 'a1rmqtdyf' ||
          p.id === 'custom-ad-slot' ||
          p.id.startsWith('bg-ssp-') ||
          (p.style && (p.style.position === 'fixed' || (p.style.zIndex && parseInt(p.style.zIndex, 10) >= 1000)))) {
        target = p;
      } else {
        break;
      }
    }
    return target;
  }

  function isCoveringOverlay(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;

    // Never touch AdSniper elements
    if (el.id === 'adsniper-game-canvas' || (el.id && el.id.startsWith('adsniper'))) return false;
    if (el.closest && el.closest('#adsniper-game-canvas, [id^="adsniper"]')) return false;

    // Never delete fundamental root containers
    const tag = el.tagName;
    if (tag === 'HTML' || tag === 'BODY' || tag === 'HEAD' || tag === 'SCRIPT' || tag === 'STYLE' || tag === 'LINK') {
      return false;
    }

    // 1. Explicit ad popup / anti-adblock tags and attributes
    if (el.hasAttribute('data-shb') || el.getAttribute('data-shb') === '1' ||
        el.hasAttribute('data-area') || el.hasAttribute('data-onopen') || el.hasAttribute('data-onclose')) {
      return true;
    }
    if (el.id && (el.id === 'a1rmqtdyf' || el.id === 'custom-ad-slot' || el.id.startsWith('bg-ssp-') || /^(bg-ssp|custom-ad|a1rm|fqkfun)/i.test(el.id))) {
      return true;
    }
    if (el.classList && (el.classList.contains('D1BnW') || el.classList.contains('_0Or05') || el.classList.contains('Kv1JU') || el.classList.contains('blox'))) {
      return true;
    }

    // 2. Elements containing ad iframes or srcdoc redirects
    if (el.querySelector && el.querySelector('iframe[srcdoc], iframe[sandbox*="allow-popups"], iframe[src*="nauticaldiscipline"], iframe[src*="composed-stop"], iframe[src*="hoopoohonesty"], iframe[src*="shikosharply"], iframe[src*="mynahsterfez"], iframe[src*="pubadx"]')) {
      return true;
    }

    let style;
    try { style = window.getComputedStyle(el); } catch (e) { return false; }
    if (!style || style.display === 'none') return false;

    const pos = style.position;
    const inlineStyle = (el.getAttribute('style') || '').toLowerCase();
    const zIndex = parseInt(style.zIndex, 10);

    // 3. Any element with maximum/high z-index other than game canvas
    if (!isNaN(zIndex) && zIndex >= 1000 && (pos === 'fixed' || pos === 'absolute')) {
      return true;
    }
    if (inlineStyle.includes('2147483647') || inlineStyle.includes('2147483646')) {
      return true;
    }

    // 4. Inset: 0 full-screen overlays
    if ((pos === 'fixed' || pos === 'absolute') &&
        (inlineStyle.includes('inset: 0') || inlineStyle.includes('inset:0') || style.inset === '0px' ||
         (style.top === '0px' && style.left === '0px' && style.bottom === '0px' && style.right === '0px'))) {
      return true;
    }

    // 5. Fixed container with 100vw / 100vh / 100dvh child
    if ((pos === 'fixed' || pos === 'absolute') && el.querySelector && el.querySelector('[style*="100vw"], [style*="100vh"], [style*="100dvh"]')) {
      return true;
    }

    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // 6. Viewport coverage
    const coversLargeArea = (rect.width >= vw * 0.35 && rect.height >= vh * 0.25) ||
                           (rect.width * rect.height >= vw * vh * 0.15);

    if ((pos === 'fixed' || pos === 'absolute') && coversLargeArea) {
      return true;
    }

    // 7. Sticky bottom or top ad bars (like #a1rmqtdyf)
    if (pos === 'fixed' && rect.width >= vw * 0.5 && (rect.top <= 15 || rect.bottom >= vh - 15)) {
      return true;
    }

    // 8. Elements matching popup/modal keywords with elevated z-index
    const classAndId = `${el.className || ''} ${el.id || ''}`;
    if ((pos === 'fixed' || pos === 'absolute') && (!isNaN(zIndex) && zIndex >= 20)) {
      if (/modal|overlay|backdrop|popup|interstitial|takeover|consent|cookie|dialog|notice|promo|wrapper|blox|kln/i.test(classAndId) ||
          el.getAttribute('role') === 'dialog' ||
          el.getAttribute('role') === 'alertdialog' ||
          tag === 'DIALOG') {
        return true;
      }
    }

    // 9. Standard ad container naming
    if ((pos === 'fixed' || pos === 'absolute') && AD_CONTAINER_RE.test(classAndId)) {
      return true;
    }

    return false;
  }

  function purgeCoveringOverlays() {
    const extractedAds = [];
    const handled = new Set();

    const candidates = document.querySelectorAll(
      '[data-shb], [data-area], [data-onopen], [data-onclose], [id^="bg-ssp-"], #custom-ad-slot, #a1rmqtdyf, .D1BnW, ._0Or05, .Kv1JU, .blox, dialog, [role="dialog"], [role="alertdialog"], [class*="overlay"], [class*="modal"], [class*="popup"], [class*="backdrop"], [class*="consent"], [class*="interstitial"], [class*="takeover"], [style*="position: fixed"], [style*="position:fixed"], [style*="position: absolute"], [style*="position:absolute"], [style*="2147483647"], [style*="2147483646"], [style*="inset: 0"], [style*="inset:0"], iframe[srcdoc], iframe[src*="nauticaldiscipline"], iframe[src*="composed-stop"]'
    );

    candidates.forEach((el) => {
      const root = getOverlayRoot(el);
      if (handled.has(root)) return;
      handled.add(root);

      if (isCoveringOverlay(root)) {
        const rect = root.getBoundingClientRect();
        const label = root.id || extractFirstClass(root) || 'overlay-ad';
        extractedAds.push({
          label,
          width: Math.max(rect.width, 80),
          height: Math.max(rect.height, 80),
          area: Math.max(rect.width * rect.height, 6400),
          tagName: root.tagName,
        });
        try { root.remove(); } catch (e) {}
      }
    });

    // Also check direct children of body and documentElement
    const directChildren = [...(document.body ? document.body.children : []), ...document.documentElement.children];
    directChildren.forEach((child) => {
      if (handled.has(child)) return;
      handled.add(child);

      if (isCoveringOverlay(child)) {
        const rect = child.getBoundingClientRect();
        const label = child.id || extractFirstClass(child) || 'overlay-ad';
        extractedAds.push({
          label,
          width: Math.max(rect.width, 80),
          height: Math.max(rect.height, 80),
          area: Math.max(rect.width * rect.height, 6400),
          tagName: child.tagName,
        });
        try { child.remove(); } catch (e) {}
      }
    });

    // Reset potential body/html scroll locks from modals
    document.documentElement.style.overflow = '';
    document.body.style.overflow = '';

    return extractedAds;
  }

  function startOverlayWatcher() {
    if (popupObserver) return;

    popupObserver = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            checkAndPurgeSingleOverlay(node);
            if (node.querySelectorAll) {
              node.querySelectorAll(
                '[data-shb], [data-area], [data-onopen], [id^="bg-ssp-"], #custom-ad-slot, #a1rmqtdyf, .D1BnW, ._0Or05, .Kv1JU, .blox, dialog, [role="dialog"], [role="alertdialog"], [class*="overlay"], [class*="modal"], [class*="popup"], [style*="fixed"], [style*="2147483647"], iframe[srcdoc]'
              ).forEach(checkAndPurgeSingleOverlay);
            }
          }
        }
      }
    });

    popupObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });

    // Periodic check every 250ms to catch elements styled or unhidden via JS
    if (!overlayCheckInterval) {
      overlayCheckInterval = setInterval(() => {
        const purged = purgeCoveringOverlays();
        for (const ad of purged) {
          if (gameState === 'PLAYING') {
            spawnBirdFromAd(ad);
          } else {
            loadingPurgedAds.push(ad);
          }
        }
      }, 250);
    }
  }

  function checkAndPurgeSingleOverlay(el) {
    const root = getOverlayRoot(el);
    if (isCoveringOverlay(root)) {
      const rect = root.getBoundingClientRect();
      const label = root.id || extractFirstClass(root) || 'popup-ad';
      const ad = {
        label,
        width: Math.max(rect.width, 80),
        height: Math.max(rect.height, 80),
        area: Math.max(rect.width * rect.height, 6400),
        tagName: root.tagName,
      };

      try { root.remove(); } catch (e) {}
      document.documentElement.style.overflow = '';
      document.body.style.overflow = '';

      if (gameState === 'PLAYING') {
        spawnBirdFromAd(ad);
      } else {
        loadingPurgedAds.push(ad);
      }
    }
  }

  function spawnBirdFromAd(ad) {
    const vw = canvas ? canvas.width : window.innerWidth;
    const vh = canvas ? canvas.height : window.innerHeight;
    const minDim = Math.min(vw, vh);
    const minSize = minDim * MIN_BIRD_SIZE_PCT;
    const maxSize = minDim * MAX_BIRD_SIZE_PCT;

    // Size based on area (popups are large -> smaller agile bird)
    const size = Math.max(minSize, Math.min(maxSize, minDim * 0.08));
    const points = Math.round(50 + Math.random() * 50);

    const texture = createBirdTexture(ad, size);
    const directionAngle = Math.floor(Math.random() * 360) + 1;

    // Spawn from edge
    const fromLeft = Math.random() > 0.5;
    const x = fromLeft ? -size : vw + size;
    const y = Math.random() * (vh - size * 2 - 60) + 60;

    const newBird = {
      id: birds.length,
      x, y,
      size,
      speed: BIRD_SPEED * (0.8 + Math.random() * 0.4),
      directionAngle,
      lastDirChange: Date.now(),
      a1: ZIGZAG_A1 * (0.7 + Math.random() * 0.6),
      f1: ZIGZAG_F1 * (0.8 + Math.random() * 0.4),
      a2: ZIGZAG_A2 * (0.6 + Math.random() * 0.8),
      f2: ZIGZAG_F2 * (0.7 + Math.random() * 0.6),
      phase: Math.random() * Math.PI * 2,
      points,
      alive: true,
      texture,
      label: ad.label,
      tagName: ad.tagName,
      color: BIRD_COLORS[birds.length % BIRD_COLORS.length],
      rotation: (directionAngle * Math.PI) / 180,
      wingPhase: Math.random() * Math.PI * 2,
      wingSpeed: 0.15 + Math.random() * 0.1,
    };

    birds.push(newBird);
    totalBirds++;

    // Notification popup particle
    particles.push({
      x: vw / 2,
      y: 70,
      vx: 0,
      vy: -0.6,
      life: 60,
      maxLife: 60,
      isText: true,
      text: `🚨 Intercepted Popup Ad! (+1 Target)`,
      color: COLOR_AMBER,
      size: 0,
    });
  }

  // ═══════════════════════════════════════════════
  //  ANTI-NEW-TAB AD BLOCKER IN GAME TAB
  // ═══════════════════════════════════════════════
  function preventWindowOpenInPage() {
    try {
      const script = document.createElement('script');
      script.textContent = `
        (() => {
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
        })();
      `;
      (document.head || document.documentElement).appendChild(script);
      script.remove();
    } catch (e) {
      console.warn('[AdSniper] Could not override window.open:', e);
    }
  }

  function restoreWindowOpenInPage() {
    try {
      const script = document.createElement('script');
      script.textContent = `
        (() => {
          try {
            if (window.__adsniper_orig_open) {
              window.open = window.__adsniper_orig_open;
              try { if (window.top) window.top.open = window.__adsniper_orig_open; } catch (e) {}
              try { if (window.parent) window.parent.open = window.__adsniper_orig_open; } catch (e) {}
              delete window.__adsniper_orig_open;
            }
          } catch (e) {}
        })();
      `;
      (document.head || document.documentElement).appendChild(script);
      script.remove();
    } catch (e) { /* ignore */ }
  }

  function onGlobalClickPreventNewTab(e) {
    if (gameState !== 'PLAYING' && gameState !== 'LOADING') return;
    const link = e.target && e.target.closest && e.target.closest('a[target="_blank"], a[target="_new"], a[href^="http"]');
    if (link) {
      if (link.target === '_blank' || link.target === '_new' || link.closest('[data-shb], [data-area], .D1BnW, #a1rmqtdyf')) {
        e.preventDefault();
        e.stopPropagation();
        console.warn('[AdSniper] Blocked link from opening new tab:', link.href);
      }
    }
  }

  // ═══════════════════════════════════════════════
  //  AD SCANNER
  // ═══════════════════════════════════════════════

  // Same regex as content.js — identifies ad container class/id names
  const AD_CONTAINER_RE =
    /\b(ad|ads|advert|advertisement|banner|sponsor(?:ed)?|promo|dfp|gpt|adsbox|ad[-_]slot|ad[-_]unit|ad[-_]container|ad[-_]wrap(?:per)?|ad[-_]box|adframe|adsbygoogle)\b/i;

  const AD_IFRAME_PATS = [
    'safeframe', 'tpc.googlesyndication', 'ad_iframe', 'ad-iframe',
    'googleads', 'amazon-adsystem', 'facebook.com/tr', 'doubleclick',
    'googlesyndication', 'adservice', 'pagead', 'adsystem',
  ];

  /**
   * Scans the DOM for ad-like elements. Returns an array of
   * { label, width, height, area, color } objects.
   */
  async function scanForAds() {
    // Collect all ads detected during the loading screen + fresh scan
    const results = [...loadingPurgedAds];
    loadingPurgedAds = [];
    const seen = new WeakSet();

    // 1. Purge existing covering overlays & popups and treat them as ads
    const overlayAds = purgeCoveringOverlays();
    for (const oAd of overlayAds) {
      results.push(oAd);
    }

    let adHosts = [];
    let adPatterns = [];
    try {
      const stored = await chrome.storage.local.get(['adHosts', 'adPatterns']);
      adHosts = stored.adHosts || [];
      adPatterns = stored.adPatterns || [];
    } catch (e) { /* storage fallback */ }

    function isBlockedUrl(url) {
      if (!url) return false;
      let hostname = '';
      try { hostname = new URL(url).hostname; } catch (e) { return false; }
      if (adHosts.some((h) => hostname === h || hostname.endsWith(`.${h}`))) return true;
      const lower = url.toLowerCase();
      return adPatterns.some((p) => lower.includes(p.toLowerCase()));
    }

    // Scan iframes
    document.querySelectorAll('iframe').forEach((iframe) => {
      if (seen.has(iframe)) return;
      const src = (iframe.src || (iframe.dataset && iframe.dataset.src) || '').toLowerCase();
      const label = `${iframe.className || ''} ${iframe.id || ''} ${iframe.name || ''}`;

      const isAd = AD_CONTAINER_RE.test(label) ||
                   AD_IFRAME_PATS.some((p) => src.includes(p)) ||
                   isBlockedUrl(iframe.src);

      if (isAd) {
        seen.add(iframe);
        const rect = iframe.getBoundingClientRect();
        if (rect.width > 1 && rect.height > 1) {
          results.push({
            label: extractDomain(iframe.src) || 'ad-iframe',
            width: rect.width,
            height: rect.height,
            area: rect.width * rect.height,
            tagName: 'IFRAME',
          });
        }
      }
    });

    // Scan common ad elements
    document.querySelectorAll(
      'img, div, section, aside, ins, [class*="ad"], [id*="ad"], [class*="banner"], [class*="sponsor"]'
    ).forEach((el) => {
      if (seen.has(el)) return;
      const label = `${el.className || ''} ${el.id || ''}`;

      if (AD_CONTAINER_RE.test(label)) {
        seen.add(el);
        const rect = el.getBoundingClientRect();
        if (rect.width > 10 && rect.height > 10) {
          results.push({
            label: el.id || extractFirstClass(el) || el.tagName.toLowerCase(),
            width: rect.width,
            height: rect.height,
            area: rect.width * rect.height,
            tagName: el.tagName,
          });
        }
      }
    });

    // Scan elements with ad-related src URLs
    document.querySelectorAll('img[src], script[src], embed[src], object[data]').forEach((el) => {
      if (seen.has(el)) return;
      const src = (el.src || el.getAttribute('data') || '').toLowerCase();

      if (AD_IFRAME_PATS.some((p) => src.includes(p)) || isBlockedUrl(src)) {
        seen.add(el);
        const rect = el.getBoundingClientRect();
        if (rect.width > 5 && rect.height > 5) {
          results.push({
            label: extractDomain(el.src || el.getAttribute('data')) || 'ad-resource',
            width: rect.width,
            height: rect.height,
            area: rect.width * rect.height,
            tagName: el.tagName,
          });
        }
      }
    });

    return results;
  }

  function extractDomain(url) {
    if (!url) return null;
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return null; }
  }

  function extractFirstClass(el) {
    const cls = String(el.className || '').trim().split(/\s+/)[0];
    return cls || null;
  }

  // ═══════════════════════════════════════════════
  //  BIRD FACTORY
  // ═══════════════════════════════════════════════

  /**
   * Creates bird objects from scanned ad data.
   * Bird size is inversely proportional to the ad component's area.
   */
  function createBirds(adData) {
    if (adData.length === 0) return [];

    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const minDim = Math.min(vw, vh);
    const minSize = minDim * MIN_BIRD_SIZE_PCT;
    const maxSize = minDim * MAX_BIRD_SIZE_PCT;

    // Find area range for normalization
    const areas = adData.map((a) => a.area);
    const minArea = Math.min(...areas);
    const maxArea = Math.max(...areas);
    const areaRange = maxArea - minArea || 1; // Avoid division by zero

    return adData.map((ad, i) => {
      // Inverse proportional: large ad area → small bird
      const normalized = (ad.area - minArea) / areaRange; // 0 = smallest ad, 1 = largest ad
      const size = maxSize - normalized * (maxSize - minSize); // Inverse: small area → big bird

      // Points scale inversely with size (smaller = harder = more points)
      const sizeRatio = (size - minSize) / (maxSize - minSize); // 0 = min size, 1 = max size
      const points = Math.round(10 + (1 - sizeRatio) * 90); // 10–100 points

      // Create texture for this bird
      const texture = createBirdTexture(ad, size);

      // Random starting direction angle: between 1 and 360 degrees
      const directionAngle = Math.floor(Math.random() * 360) + 1;
      const lastDirChange = Date.now() - Math.floor(Math.random() * 2500); // Stagger initial 3s timers

      // Spawn position: random edge
      const fromLeft = Math.random() > 0.5;
      const x = fromLeft ? -size : vw + size;
      const y = Math.random() * (vh - size * 2 - 60) + 60;

      // Zigzag parameters — slight randomization for variety
      const a1 = ZIGZAG_A1 * (0.7 + Math.random() * 0.6);
      const f1 = ZIGZAG_F1 * (0.8 + Math.random() * 0.4);
      const a2 = ZIGZAG_A2 * (0.6 + Math.random() * 0.8);
      const f2 = ZIGZAG_F2 * (0.7 + Math.random() * 0.6);

      return {
        id: i,
        x, y,
        size,
        directionAngle,
        lastDirChange,
        speed: BIRD_SPEED * (0.8 + Math.random() * 0.4),
        a1, f1, a2, f2,
        phase: Math.random() * Math.PI * 2,
        points,
        alive: true,
        texture,
        label: ad.label,
        tagName: ad.tagName,
        color: BIRD_COLORS[i % BIRD_COLORS.length],
        rotation: (directionAngle * Math.PI) / 180,
        // Wing flap animation
        wingPhase: Math.random() * Math.PI * 2,
        wingSpeed: 0.15 + Math.random() * 0.1,
      };
    });
  }

  /**
   * Creates an offscreen canvas texture for a bird.
   * Draws a stylized "ad card" with the element's info.
   */
  function createBirdTexture(ad, size) {
    const tCanvas = document.createElement('canvas');
    const s = Math.round(size);
    tCanvas.width = s;
    tCanvas.height = s;
    const tCtx = tCanvas.getContext('2d');

    const color = BIRD_COLORS[Math.floor(Math.random() * BIRD_COLORS.length)];

    // Body — rounded rectangle
    tCtx.fillStyle = color;
    tCtx.globalAlpha = 0.9;
    roundRect(tCtx, 2, 2, s - 4, s - 4, s * 0.15);
    tCtx.fill();

    // Inner glow
    tCtx.globalAlpha = 0.3;
    tCtx.fillStyle = '#fff';
    roundRect(tCtx, s * 0.1, s * 0.1, s * 0.8, s * 0.4, s * 0.1);
    tCtx.fill();
    tCtx.globalAlpha = 1;

    // "AD" watermark
    tCtx.fillStyle = 'rgba(0,0,0,0.25)';
    tCtx.font = `bold ${Math.max(10, s * 0.35)}px 'Segoe UI', system-ui, sans-serif`;
    tCtx.textAlign = 'center';
    tCtx.textBaseline = 'middle';
    tCtx.fillText('AD', s / 2, s * 0.4);

    // Label text
    tCtx.fillStyle = '#fff';
    tCtx.font = `bold ${Math.max(8, s * 0.12)}px 'Segoe UI', system-ui, sans-serif`;
    const labelText = ad.label.length > 14 ? ad.label.slice(0, 12) + '…' : ad.label;
    tCtx.fillText(labelText, s / 2, s * 0.72);

    // Tag name
    tCtx.fillStyle = 'rgba(255,255,255,0.6)';
    tCtx.font = `${Math.max(7, s * 0.09)}px 'Segoe UI', system-ui, sans-serif`;
    tCtx.fillText(ad.tagName, s / 2, s * 0.87);

    // Border
    tCtx.globalAlpha = 0.6;
    tCtx.strokeStyle = '#fff';
    tCtx.lineWidth = 2;
    roundRect(tCtx, 2, 2, s - 4, s - 4, s * 0.15);
    tCtx.stroke();
    tCtx.globalAlpha = 1;

    return tCanvas;
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.arcTo(x + w, y, x + w, y + r, r);
    ctx.lineTo(x + w, y + h - r);
    ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
    ctx.lineTo(x + r, y + h);
    ctx.arcTo(x, y + h, x, y + h - r, r);
    ctx.lineTo(x, y + r);
    ctx.arcTo(x, y, x + r, y, r);
    ctx.closePath();
  }

  // ═══════════════════════════════════════════════
  //  PHYSICS ENGINE
  // ═══════════════════════════════════════════════

  function updateBirds() {
    const vw = canvas.width;
    const vh = canvas.height;
    const now = Date.now();

    for (const bird of birds) {
      if (!bird.alive) continue;

      // Requirement: Change movement of the bird every 3 sec by using the logic:
      // random number between 1-360 where number represents the direction of bird.
      if (now - bird.lastDirChange >= 3000) {
        bird.directionAngle = Math.floor(Math.random() * 360) + 1;
        bird.lastDirChange = now;
      }

      // Convert direction angle to radians
      let rad = (bird.directionAngle * Math.PI) / 180;

      // Directional velocity with constant speed
      const vx = Math.cos(rad) * bird.speed;
      const vy = Math.sin(rad) * bird.speed;

      // Normal (perpendicular) vector for zigzag flutter
      const nx = -Math.sin(rad);
      const ny = Math.cos(rad);

      // Dual-component zigzag flutter velocity
      const t = frameCount + bird.phase;
      const zigzagVel = (bird.a1 * bird.f1 * Math.cos(bird.f1 * t) +
                         bird.a2 * bird.f2 * Math.cos(bird.f2 * t)) * 0.5;

      bird.x += vx + nx * zigzagVel;
      bird.y += vy + ny * zigzagVel;

      // Screen boundary handling (bounce back so birds stay on screen)
      const half = bird.size / 2;
      let bounced = false;

      if (bird.x < half) {
        bird.x = half;
        bird.directionAngle = Math.round((180 - bird.directionAngle + 360) % 360) || 360;
        bounced = true;
      } else if (bird.x > vw - half) {
        bird.x = vw - half;
        bird.directionAngle = Math.round((180 - bird.directionAngle + 360) % 360) || 360;
        bounced = true;
      }

      if (bird.y < half + 42) { // Stay below top HUD
        bird.y = half + 42;
        bird.directionAngle = Math.round((360 - bird.directionAngle + 360) % 360) || 360;
        bounced = true;
      } else if (bird.y > vh - half) {
        bird.y = vh - half;
        bird.directionAngle = Math.round((360 - bird.directionAngle + 360) % 360) || 360;
        bounced = true;
      }

      if (bounced) {
        rad = (bird.directionAngle * Math.PI) / 180;
      }

      // Bird faces direction of flight
      bird.rotation = rad;

      // Wing flap animation
      bird.wingPhase += bird.wingSpeed;
    }
  }

  // ═══════════════════════════════════════════════
  //  PARTICLE SYSTEM
  // ═══════════════════════════════════════════════

  function spawnParticles(x, y, color) {
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const angle = (Math.PI * 2 * i) / PARTICLE_COUNT + (Math.random() - 0.5) * 0.5;
      const speed = 3 + Math.random() * 5;
      particles.push({
        x, y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: PARTICLE_LIFETIME,
        maxLife: PARTICLE_LIFETIME,
        color,
        size: 3 + Math.random() * 4,
      });
    }
    // Score popup particle
    particles.push({
      x, y: y - 20,
      vx: 0,
      vy: -1.5,
      life: 45,
      maxLife: 45,
      isText: true,
      text: `+${getLastScore()}`,
      color: COLOR_GREEN,
      size: 0,
    });
  }

  function updateParticles() {
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.x += p.vx;
      p.y += p.vy;
      if (!p.isText) {
        p.vy += 0.15; // Gravity
        p.size *= 0.96;
      }
      p.life--;
      if (p.life <= 0) particles.splice(i, 1);
    }
  }

  function renderParticles() {
    for (const p of particles) {
      const alpha = p.life / p.maxLife;
      if (p.isText) {
        ctx.globalAlpha = alpha;
        ctx.fillStyle = p.color;
        ctx.font = `bold 18px 'Segoe UI', system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillText(p.text, p.x, p.y);
        ctx.globalAlpha = 1;
      } else {
        ctx.globalAlpha = alpha;
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    }
  }

  // ═══════════════════════════════════════════════
  //  FIREWORKS ENGINE (ACCURACY > 80%)
  // ═══════════════════════════════════════════════
  const FIREWORK_COLORS = [
    '#f59e0b', '#fbbf24', '#38bdf8', '#4ade80',
    '#f472b6', '#a855f7', '#ec4899', '#ef4444',
    '#10b981', '#06b6d4', '#eab308', '#ffffff'
  ];

  function spawnFireworkBurst(x, y) {
    const color = FIREWORK_COLORS[Math.floor(Math.random() * FIREWORK_COLORS.length)];
    const sparkCount = 28 + Math.floor(Math.random() * 16);

    for (let i = 0; i < sparkCount; i++) {
      const angle = (Math.PI * 2 * i) / sparkCount + (Math.random() - 0.5) * 0.35;
      const speed = 2.5 + Math.random() * 6;
      fireworks.push({
        x, y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 45 + Math.floor(Math.random() * 25),
        maxLife: 70,
        color,
        size: 2.5 + Math.random() * 2.5,
      });
    }

    // Flash light particle at burst center
    fireworks.push({
      x, y,
      vx: 0, vy: 0,
      life: 8, maxLife: 8,
      color: '#ffffff',
      size: 16,
    });
  }

  function updateFireworks(vw, vh, cx, cy) {
    fireworkSpawnTimer++;

    // Launch a firework burst every 24 frames
    if (fireworkSpawnTimer % 24 === 0) {
      const zone = Math.random();
      let fx, fy;
      if (zone < 0.35 && cx > 300) {
        // Left flank
        fx = Math.random() * (cx - 280) + 40;
        fy = Math.random() * (vh * 0.7) + 50;
      } else if (zone < 0.7 && vw - cx > 300) {
        // Right flank
        fx = cx + 280 + Math.random() * (vw - cx - 320);
        fy = Math.random() * (vh * 0.7) + 50;
      } else {
        // Top area above card
        fx = Math.random() * (vw - 120) + 60;
        fy = Math.random() * Math.max(80, cy - 230) + 30;
      }
      spawnFireworkBurst(fx, fy);
    }

    for (let i = fireworks.length - 1; i >= 0; i--) {
      const f = fireworks[i];
      f.x += f.vx;
      f.y += f.vy;
      f.vy += 0.08; // Gravity
      f.vx *= 0.98; // Air drag
      f.vy *= 0.98;
      f.life--;
      if (f.life <= 0) fireworks.splice(i, 1);
    }
  }

  function renderFireworks() {
    for (const f of fireworks) {
      const alpha = f.life / f.maxLife;
      ctx.globalAlpha = Math.max(0, Math.min(1, alpha * (0.85 + Math.random() * 0.15)));
      ctx.fillStyle = f.color;
      ctx.beginPath();
      ctx.arc(f.x, f.y, f.size * (0.5 + alpha * 0.5), 0, Math.PI * 2);
      ctx.fill();

      // Sparkle glow
      if (f.size > 3) {
        ctx.globalAlpha = alpha * 0.3;
        ctx.beginPath();
        ctx.arc(f.x, f.y, f.size * 2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }

  let _lastScore = 0;
  function getLastScore() { return _lastScore; }

  // ═══════════════════════════════════════════════
  //  SCORING
  // ═══════════════════════════════════════════════

  function getComboMultiplier() {
    if (combo <= 1) return 1;
    return Math.min(combo, 5); // Max ×5
  }

  function handleHit(bird) {
    bird.alive = false;
    birdsHit++;

    // Combo logic
    const now = Date.now();
    if (now - lastHitTime < COMBO_DECAY_MS) {
      combo++;
    } else {
      combo = 1;
    }
    bestCombo = Math.max(bestCombo, combo);
    lastHitTime = now;

    const multiplier = getComboMultiplier();
    const points = bird.points * multiplier;
    _lastScore = points;
    score += points;

    // Spawn explosion
    spawnParticles(bird.x, bird.y, bird.color);

    // Check game over
    if (birdsHit >= totalBirds) {
      gameState = 'GAME_OVER';
      gameOverAlpha = 0;
    }
  }

  function handleMiss() {
    combo = 0;
  }

  // ═══════════════════════════════════════════════
  //  RENDERER
  // ═══════════════════════════════════════════════

  function render() {
    const vw = canvas.width;
    const vh = canvas.height;

    // Clear
    ctx.clearRect(0, 0, vw, vh);

    if (gameState === 'LOADING') {
      renderLoadingScreen(vw, vh);
      return;
    }

    // Semi-transparent background
    ctx.fillStyle = COLOR_BG;
    ctx.fillRect(0, 0, vw, vh);

    if (gameState === 'PLAYING' || gameState === 'GAME_OVER') {
      // Draw birds
      for (const bird of birds) {
        if (!bird.alive) continue;
        renderBird(bird);
      }

      // Draw particles
      renderParticles();

      // Draw HUD
      renderHUD(vw, vh);

      // Draw crosshair
      if (gameState === 'PLAYING') {
        renderCrosshair();
      }

      // Game over overlay
      if (gameState === 'GAME_OVER') {
        renderGameOver(vw, vh);
      }
    }
  }

  function renderBird(bird) {
    ctx.save();
    ctx.translate(bird.x, bird.y);
    ctx.rotate(bird.rotation);

    // Draw wings (flapping triangles)
    const wingFlap = Math.sin(bird.wingPhase) * 0.4;
    const wingSize = bird.size * 0.35;

    ctx.fillStyle = bird.color;
    ctx.globalAlpha = 0.6;

    // Left wing
    ctx.save();
    ctx.rotate(-0.8 + wingFlap);
    ctx.beginPath();
    ctx.moveTo(-bird.size * 0.3, 0);
    ctx.lineTo(-bird.size * 0.3 - wingSize, -wingSize * 0.6);
    ctx.lineTo(-bird.size * 0.3 - wingSize * 0.3, wingSize * 0.3);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // Right wing
    ctx.save();
    ctx.rotate(0.8 - wingFlap);
    ctx.beginPath();
    ctx.moveTo(bird.size * 0.3, 0);
    ctx.lineTo(bird.size * 0.3 + wingSize, -wingSize * 0.6);
    ctx.lineTo(bird.size * 0.3 + wingSize * 0.3, wingSize * 0.3);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    ctx.globalAlpha = 1;

    // Draw body (texture)
    ctx.drawImage(
      bird.texture,
      -bird.size / 2, -bird.size / 2,
      bird.size, bird.size
    );

    ctx.restore();
  }

  function renderCrosshair() {
    const r = CROSSHAIR_SIZE;
    ctx.strokeStyle = COLOR_GREEN;
    ctx.lineWidth = 2;
    ctx.globalAlpha = 0.9;

    // Outer circle
    ctx.beginPath();
    ctx.arc(mouseX, mouseY, r, 0, Math.PI * 2);
    ctx.stroke();

    // Inner dot
    ctx.fillStyle = COLOR_GREEN;
    ctx.beginPath();
    ctx.arc(mouseX, mouseY, 3, 0, Math.PI * 2);
    ctx.fill();

    // Crosshair lines
    ctx.beginPath();
    ctx.moveTo(mouseX - r - 6, mouseY);
    ctx.lineTo(mouseX - r / 2, mouseY);
    ctx.moveTo(mouseX + r / 2, mouseY);
    ctx.lineTo(mouseX + r + 6, mouseY);
    ctx.moveTo(mouseX, mouseY - r - 6);
    ctx.lineTo(mouseX, mouseY - r / 2);
    ctx.moveTo(mouseX, mouseY + r / 2);
    ctx.lineTo(mouseX, mouseY + r + 6);
    ctx.stroke();

    ctx.globalAlpha = 1;
  }

  function renderHUD(vw, vh) {
    const padding = 14;
    const barH = 40;

    // Top bar background
    ctx.fillStyle = COLOR_HUD_BG;
    ctx.fillRect(0, 0, vw, barH);

    // Bottom border line
    ctx.fillStyle = COLOR_ACCENT;
    ctx.fillRect(0, barH - 2, vw, 2);

    ctx.textBaseline = 'middle';
    const cy = barH / 2;

    // Score
    ctx.fillStyle = COLOR_GREEN;
    ctx.font = `bold 16px 'Segoe UI', system-ui, sans-serif`;
    ctx.textAlign = 'left';
    ctx.fillText(`🎯 SCORE: ${score.toLocaleString()}`, padding, cy);

    // Combo
    const multiplier = getComboMultiplier();
    if (multiplier > 1) {
      ctx.fillStyle = COLOR_AMBER;
      ctx.font = `bold 14px 'Segoe UI', system-ui, sans-serif`;
      ctx.fillText(`×${multiplier} COMBO`, 200, cy);
    }

    // Birds remaining, Misses & Multikills
    ctx.fillStyle = COLOR_TEXT;
    ctx.font = `13px 'Segoe UI', system-ui, sans-serif`;
    ctx.textAlign = 'center';
    let centerText = `🐦 ${birdsHit}/${totalBirds} Birds`;
    if (shotsMissed > 0) {
      centerText += `  |  ❌ ${shotsMissed} Missed`;
    }
    if (multikillCount > 0) {
      centerText += `  |  ⚡ ${multikillCount} Multikill${multikillCount > 1 ? 's' : ''}`;
    }
    ctx.fillText(centerText, vw / 2, cy);

    // Exit hint
    ctx.fillStyle = COLOR_MUTED;
    ctx.font = `11px 'Segoe UI', system-ui, sans-serif`;
    ctx.textAlign = 'right';
    ctx.fillText('[ESC] Exit Game', vw - padding, cy);
  }

  function renderLoadingScreen(vw, vh) {
    // Full dark background
    ctx.fillStyle = 'rgba(15, 15, 23, 0.92)';
    ctx.fillRect(0, 0, vw, vh);

    const cx = vw / 2;
    const cy = vh / 2;

    // Spinning crosshair animation
    const angle = frameCount * 0.05;
    ctx.save();
    ctx.translate(cx, cy - 60);
    ctx.rotate(angle);
    ctx.strokeStyle = COLOR_GREEN;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(0, 0, 30, 0, Math.PI * 1.5);
    ctx.stroke();
    ctx.restore();

    // Title
    ctx.fillStyle = COLOR_GREEN;
    ctx.font = `bold 24px 'Segoe UI', system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('🔫 SNIPING MODE', cx, cy + 10);

    // Subtitle
    ctx.fillStyle = COLOR_TEXT;
    ctx.font = `14px 'Segoe UI', system-ui, sans-serif`;
    ctx.fillText(loadingMessage, cx, cy + 45);

    // Progress bar
    const barW = 300;
    const barH = 6;
    const barX = cx - barW / 2;
    const barY = cy + 70;

    ctx.fillStyle = 'rgba(255,255,255,0.1)';
    roundRect(ctx, barX, barY, barW, barH, 3);
    ctx.fill();

    ctx.fillStyle = COLOR_GREEN;
    roundRect(ctx, barX, barY, barW * loadingProgress, barH, 3);
    ctx.fill();
  }

  function renderGameOver(vw, vh) {
    gameOverAlpha = Math.min(1, gameOverAlpha + 0.02);

    const cx = vw / 2;
    const cy = vh / 2;

    const totalShots = birdsHit + shotsMissed;
    const accuracy = totalShots > 0 ? Math.round((birdsHit / totalShots) * 100) : (totalBirds > 0 ? 0 : 100);
    const isHighAccuracy = accuracy > 80;

    // Dark backdrop overlay
    ctx.globalAlpha = gameOverAlpha * 0.88;
    ctx.fillStyle = 'rgba(15, 15, 23, 0.92)';
    ctx.fillRect(0, 0, vw, vh);

    // Render celebratory fireworks around results if accuracy > 80%
    if (isHighAccuracy) {
      renderFireworks();
    }

    ctx.globalAlpha = gameOverAlpha;

    const cardW = 500;
    const cardH = 430;

    // Card background
    ctx.fillStyle = COLOR_HUD_BG;
    roundRect(ctx, cx - cardW / 2, cy - cardH / 2, cardW, cardH, 16);
    ctx.fill();

    // Card border (golden glow if accuracy > 80%)
    ctx.strokeStyle = isHighAccuracy ? '#fbbf24' : COLOR_ACCENT;
    ctx.lineWidth = isHighAccuracy ? 3 : 2;
    roundRect(ctx, cx - cardW / 2, cy - cardH / 2, cardW, cardH, 16);
    ctx.stroke();

    // High accuracy celebration banner
    if (isHighAccuracy) {
      ctx.fillStyle = '#fbbf24';
      ctx.font = `bold 13px 'Segoe UI', system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('✨ 🏆 SHARPSHOOTER BONUS! (+80% ACCURACY) 🏆 ✨', cx, cy - 180);
    }

    // Title
    ctx.fillStyle = isHighAccuracy ? '#fbbf24' : COLOR_GREEN;
    ctx.font = `bold 28px 'Segoe UI', system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('🎯 GAME OVER', cx, isHighAccuracy ? cy - 150 : cy - 160);

    // Score
    ctx.fillStyle = COLOR_TEXT;
    ctx.font = `bold 22px 'Segoe UI', system-ui, sans-serif`;
    ctx.fillText(`Score: ${score.toLocaleString()}`, cx, isHighAccuracy ? cy - 114 : cy - 122);

    // Stats Grid
    ctx.font = `14px 'Segoe UI', system-ui, sans-serif`;

    // Row 1: Birds Hit & Shots Missed
    ctx.fillStyle = COLOR_MUTED;
    ctx.textAlign = 'left';
    ctx.fillText(`🐦 Birds Hit:`, cx - 185, cy - 70);
    ctx.fillStyle = COLOR_TEXT;
    ctx.fillText(`${birdsHit} / ${totalBirds}`, cx - 70, cy - 70);

    ctx.fillStyle = COLOR_MUTED;
    ctx.fillText(`❌ Shots Missed:`, cx + 30, cy - 70);
    ctx.fillStyle = shotsMissed === 0 ? COLOR_GREEN : COLOR_RED;
    ctx.fillText(`${shotsMissed}`, cx + 165, cy - 70);

    // Row 2: Accuracy & Best Combo
    ctx.fillStyle = COLOR_MUTED;
    ctx.fillText(`🎯 Accuracy:`, cx - 185, cy - 40);
    ctx.fillStyle = accuracy >= 80 ? COLOR_GREEN : accuracy >= 50 ? COLOR_AMBER : COLOR_RED;
    ctx.fillText(`${accuracy}%`, cx - 70, cy - 40);

    ctx.fillStyle = COLOR_MUTED;
    ctx.fillText(`🔥 Best Combo:`, cx + 30, cy - 40);
    ctx.fillStyle = COLOR_AMBER;
    ctx.fillText(`×${Math.max(1, bestCombo)}`, cx + 165, cy - 40);

    // Row 3: Double Kills & Triple Kills
    ctx.fillStyle = COLOR_MUTED;
    ctx.fillText(`⚡ Double Kills:`, cx - 185, cy - 10);
    ctx.fillStyle = doubleKills > 0 ? COLOR_AMBER : COLOR_MUTED;
    ctx.fillText(`${doubleKills}`, cx - 70, cy - 10);

    ctx.fillStyle = COLOR_MUTED;
    ctx.fillText(`🔥 Triple Kills:`, cx + 30, cy - 10);
    ctx.fillStyle = tripleKills > 0 ? COLOR_AMBER : COLOR_MUTED;
    ctx.fillText(`${tripleKills}`, cx + 165, cy - 10);

    // Row 4: Multi Kills (4+) & Total Shots
    ctx.fillStyle = COLOR_MUTED;
    ctx.fillText(`💥 Multi Kills (4+):`, cx - 185, cy + 20);
    ctx.fillStyle = multiKills > 0 ? COLOR_AMBER : COLOR_MUTED;
    ctx.fillText(`${multiKills}`, cx - 70, cy + 20);

    ctx.fillStyle = COLOR_MUTED;
    ctx.fillText(`🔫 Total Shots:`, cx + 30, cy + 20);
    ctx.fillStyle = COLOR_TEXT;
    ctx.fillText(`${shotsFired}`, cx + 165, cy + 20);

    // Row 5: Total Multikills Summary
    ctx.fillStyle = COLOR_MUTED;
    ctx.textAlign = 'center';
    ctx.font = `12px 'Segoe UI', system-ui, sans-serif`;
    ctx.fillText(`⚡ Total Multikills: ${multikillCount}  (Double: ${doubleKills} | Triple: ${tripleKills} | 4+: ${multiKills})`, cx, cy + 54);

    // Quit Game Button
    const btnW = 180;
    const btnH = 40;
    const btnX = cx - btnW / 2;
    const btnY = cy + 86;
    quitButtonBounds = { x: btnX, y: btnY, w: btnW, h: btnH };

    const isHover = mouseX >= btnX && mouseX <= btnX + btnW &&
                    mouseY >= btnY && mouseY <= btnY + btnH;

    if (canvas) {
      canvas.style.cursor = isHover ? 'pointer' : 'default';
    }

    // Button Background
    ctx.fillStyle = isHover ? '#dc2626' : 'rgba(239, 68, 68, 0.25)';
    roundRect(ctx, btnX, btnY, btnW, btnH, 8);
    ctx.fill();

    // Button Border
    ctx.strokeStyle = isHover ? '#f87171' : '#ef4444';
    ctx.lineWidth = 2;
    roundRect(ctx, btnX, btnY, btnW, btnH, 8);
    ctx.stroke();

    // Button Text
    ctx.fillStyle = '#ffffff';
    ctx.font = `bold 15px 'Segoe UI', system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('🚪 Quit Game', cx, btnY + btnH / 2);

    // Key hint below button
    ctx.fillStyle = COLOR_MUTED;
    ctx.font = `11px 'Segoe UI', system-ui, sans-serif`;
    ctx.fillText('or press [ESC]', cx, btnY + btnH + 16);

    ctx.globalAlpha = 1;
  }

  // ═══════════════════════════════════════════════
  //  GAME LOOP
  // ═══════════════════════════════════════════════

  function gameLoop() {
    frameCount++;

    // Ensure canvas stays full screen even if innerHeight was small during initial render
    if (canvas && (canvas.width !== window.innerWidth || canvas.height !== window.innerHeight)) {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    }

    if (gameState === 'PLAYING') {
      updateBirds();
      updateParticles();

      // Auto-decay combo
      if (combo > 0 && Date.now() - lastHitTime > COMBO_DECAY_MS) {
        combo = 0;
      }
    } else if (gameState === 'GAME_OVER') {
      updateParticles();
      const totalShots = birdsHit + shotsMissed;
      const accuracy = totalShots > 0 ? Math.round((birdsHit / totalShots) * 100) : (totalBirds > 0 ? 0 : 100);
      if (accuracy > 80) {
        const vw = canvas ? canvas.width : window.innerWidth;
        const vh = canvas ? canvas.height : window.innerHeight;
        updateFireworks(vw, vh, vw / 2, vh / 2);
      }
    }

    render();
    animFrameId = requestAnimationFrame(gameLoop);
  }

  // ═══════════════════════════════════════════════
  //  INPUT HANDLING
  // ═══════════════════════════════════════════════

  function onMouseMove(e) {
    mouseX = e.clientX;
    mouseY = e.clientY;
  }

  function onClick(e) {
    if (gameState === 'GAME_OVER') {
      // ONLY clicking the Quit Game button or pressing ESC should close the gaming screen
      const clickX = e.clientX;
      const clickY = e.clientY;
      const b = quitButtonBounds;
      if (clickX >= b.x && clickX <= b.x + b.w &&
          clickY >= b.y && clickY <= b.y + b.h) {
        endGame();
      }
      return;
    }

    if (gameState !== 'PLAYING') return;

    e.preventDefault();
    e.stopPropagation();

    const clickX = e.clientX;
    const clickY = e.clientY;

    shotsFired++;

    // Check hit on all alive birds under crosshair (piercing / multikill)
    const hitBirds = [];
    for (let i = birds.length - 1; i >= 0; i--) {
      const bird = birds[i];
      if (!bird.alive) continue;

      const halfSize = bird.size / 2;
      if (clickX >= bird.x - halfSize && clickX <= bird.x + halfSize &&
          clickY >= bird.y - halfSize && clickY <= bird.y + halfSize) {
        hitBirds.push(bird);
      }
    }

    if (hitBirds.length > 0) {
      // Eliminate all aligned birds
      for (const bird of hitBirds) {
        handleHit(bird);
      }

      // Multikill bonus and announcement if multiple birds were aligned
      if (hitBirds.length > 1) {
        multikillCount++;
        let killText = '⚡ DOUBLE KILL!';
        if (hitBirds.length === 2) {
          doubleKills++;
          killText = '⚡ DOUBLE KILL!';
        } else if (hitBirds.length === 3) {
          tripleKills++;
          killText = '🔥 TRIPLE KILL!';
        } else {
          multiKills++;
          killText = `💥 MULTIKILL ×${hitBirds.length}!`;
        }

        const bonusPoints = hitBirds.length * 100;
        score += bonusPoints;

        // Floating multikill announcement
        particles.push({
          x: clickX,
          y: clickY - 40,
          vx: 0,
          vy: -1.2,
          life: 60,
          maxLife: 60,
          isText: true,
          text: `${killText} (+${bonusPoints})`,
          color: COLOR_AMBER,
          size: 0,
        });
      }
    } else {
      shotsMissed++;
      handleMiss();
      // Miss particle (small red puff)
      for (let i = 0; i < 4; i++) {
        const angle = Math.random() * Math.PI * 2;
        particles.push({
          x: clickX, y: clickY,
          vx: Math.cos(angle) * 2,
          vy: Math.sin(angle) * 2,
          life: 15, maxLife: 15,
          color: 'rgba(239,68,68,0.6)',
          size: 2,
        });
      }
    }
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      endGame();
    }
  }

  function onResize() {
    if (canvas) {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    }
  }

  // ═══════════════════════════════════════════════
  //  GAME LIFECYCLE
  // ═══════════════════════════════════════════════

  /**
   * Main entry point — called by content.js after page reload.
   * Orchestrates: loading screen → ad scan → bird creation → game start.
   */
  async function launchGame() {
    // Reset state
    score = 0;
    combo = 0;
    bestCombo = 0;
    lastHitTime = 0;
    birdsHit = 0;
    shotsFired = 0;
    shotsMissed = 0;
    multikillCount = 0;
    doubleKills = 0;
    tripleKills = 0;
    multiKills = 0;
    fireworks = [];
    fireworkSpawnTimer = 0;
    quitButtonBounds = { x: 0, y: 0, w: 0, h: 0 };
    frameCount = 0;
    particles = [];
    gameOverAlpha = 0;
    loadingProgress = 0;
    loadingMessage = 'Scanning for ads...';
    loadingPurgedAds = [];

    // 1. Inject anti-overlay CSS immediately
    injectAntiOverlayStyles();

    // 2. Prevent window.open and ad postMessage immediately
    preventWindowOpenInPage();
    document.addEventListener('click', onGlobalClickPreventNewTab, true);
    window.addEventListener('message', onInterceptAdMessage, true);

    // 3. Start overlay watcher immediately
    startOverlayWatcher();

    // 4. Purge existing overlays right now
    const initialOverlays = purgeCoveringOverlays();
    for (const ad of initialOverlays) {
      loadingPurgedAds.push(ad);
    }

    // 5. Create full-screen canvas with MAXIMUM Z-INDEX
    canvas = document.createElement('canvas');
    canvas.id = 'adsniper-game-canvas';
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    Object.assign(canvas.style, {
      position: 'fixed',
      top: '0',
      left: '0',
      width: '100vw',
      height: '100vh',
      zIndex: '2147483647',
      cursor: 'none',
      pointerEvents: 'auto',
    });
    document.documentElement.appendChild(canvas);
    ctx = canvas.getContext('2d');

    // Center mouse crosshair initially
    mouseX = window.innerWidth / 2;
    mouseY = window.innerHeight / 2;

    // Start game loop (shows loading screen)
    gameState = 'LOADING';
    animFrameId = requestAnimationFrame(gameLoop);

    // Wire input
    document.addEventListener('mousemove', onMouseMove, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('resize', onResize);

    // Notify service worker of active game tab to suppress new tabs
    try {
      chrome.runtime.sendMessage({ type: 'SNIPING_GAME_STARTED' });
    } catch (e) { /* ignore */ }

    // Animate loading progress & purge overlays continuously throughout loading
    const loadStart = Date.now();
    const loadInterval = setInterval(() => {
      // Continuously purge overlays during the entire loading screen
      const purged = purgeCoveringOverlays();
      for (const ad of purged) {
        loadingPurgedAds.push(ad);
      }

      // Ensure canvas is always topmost child of document.documentElement
      if (canvas && canvas.parentElement && canvas.parentElement.lastElementChild !== canvas) {
        canvas.parentElement.appendChild(canvas);
      }

      const elapsed = Date.now() - loadStart;
      loadingProgress = Math.min(0.9, elapsed / LOADING_DELAY_MS);

      if (elapsed < LOADING_DELAY_MS * 0.3) {
        loadingMessage = 'Waiting for ads to load...';
      } else if (elapsed < LOADING_DELAY_MS * 0.7) {
        loadingMessage = 'Scanning DOM for ad components...';
      } else {
        loadingMessage = 'Building targets...';
      }
    }, 50);

    // Wait for ads to render
    await new Promise((r) => setTimeout(r, LOADING_DELAY_MS));

    // Scan for ads
    let adData = await scanForAds();
    clearInterval(loadInterval);

    if (adData.length === 0) {
      // Fallback: spawn mock ad targets so game is always playable
      loadingProgress = 0.9;
      loadingMessage = 'No live ads detected — spawning 5 training targets!';
      await new Promise((r) => setTimeout(r, 1200));
      adData = [
        { label: 'tracker.doubleclick.net', width: 300, height: 250, area: 75000, tagName: 'IFRAME' },
        { label: 'banner.adservice.google.com', width: 728, height: 90, area: 65520, tagName: 'DIV' },
        { label: 'sponsor.outbrain.com', width: 160, height: 600, area: 96000, tagName: 'IFRAME' },
        { label: 'pixel.criteo.com', width: 50, height: 50, area: 2500, tagName: 'IMG' },
        { label: 'ad-slot.taboola.com', width: 468, height: 60, area: 28080, tagName: 'DIV' },
      ];
    }

    // Create birds
    loadingProgress = 0.95;
    loadingMessage = `Found ${adData.length} target${adData.length > 1 ? 's' : ''} — preparing...`;
    await new Promise((r) => setTimeout(r, 500));

    birds = createBirds(adData);
    totalBirds = birds.length;
    loadingProgress = 1;
    loadingMessage = 'GO!';
    await new Promise((r) => setTimeout(r, 300));

    // Start playing
    gameState = 'PLAYING';
  }

  /**
   * Ends the game — cleans up canvas, restores blocking state.
   */
  async function endGame() {
    gameState = 'ENDED';

    // 1. Immediately clear game tab ID directly so new tabs in Chrome are never killed
    try {
      await chrome.storage.local.remove(['snipingActiveTabId', 'snipingGamePending']);
    } catch (e) {
      console.warn('[AdSniper Game] Direct storage cleanup error:', e);
    }

    // Remove anti-overlay styles
    removeAntiOverlayStyles();

    // Stop overlay watcher
    if (popupObserver) {
      popupObserver.disconnect();
      popupObserver = null;
    }
    if (overlayCheckInterval) {
      clearInterval(overlayCheckInterval);
      overlayCheckInterval = null;
    }

    // Restore new tab behaviors & ad message listener
    document.removeEventListener('click', onGlobalClickPreventNewTab, true);
    window.removeEventListener('message', onInterceptAdMessage, true);
    restoreWindowOpenInPage();

    // Stop game loop
    if (animFrameId) {
      cancelAnimationFrame(animFrameId);
      animFrameId = null;
    }

    // Remove canvas
    if (canvas) {
      canvas.remove();
      canvas = null;
      ctx = null;
    }

    // Remove event listeners
    document.removeEventListener('mousemove', onMouseMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('resize', onResize);

    // Reset cursor
    document.body.style.cursor = '';

    // Tell SW to unhook gaming tab and restore pre-game blocking state
    try {
      chrome.runtime.sendMessage({ type: 'SNIPING_GAME_ENDED' });
      chrome.runtime.sendMessage({ type: 'RESTORE_SNIPING_STATE' });
    } catch (err) {
      console.warn('[AdSniper Game] Failed to restore state:', err.message);
    }

    // Clear references
    birds = [];
    particles = [];
    fireworks = [];
    loadingPurgedAds = [];
    quitButtonBounds = { x: 0, y: 0, w: 0, h: 0 };

    // If this game was launched in a dedicated new tab, close this tab on quit
    try {
      const { snipingOpenNewTab = false } = await chrome.storage.local.get('snipingOpenNewTab');
      if (snipingOpenNewTab) {
        await chrome.storage.local.remove('snipingOpenNewTab');
        chrome.runtime.sendMessage({ type: 'CLOSE_CURRENT_TAB' });
        try { window.close(); } catch (e) {}
      }
    } catch (e) { /* ignore */ }
  }

  // Public API
  return { launchGame, endGame, injectAntiOverlayStyles };

})();
