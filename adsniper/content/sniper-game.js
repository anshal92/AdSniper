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

  // Colors — refined modern dark palette
  const COLOR_BG        = 'rgba(10, 10, 20, 0.80)';
  const COLOR_HUD_BG    = 'rgba(18, 18, 32, 0.75)';
  const COLOR_TEXT       = '#eaeaf4';
  const COLOR_ACCENT    = '#8b7aff';
  const COLOR_GREEN      = '#34d399';
  const COLOR_RED        = '#f87171';
  const COLOR_AMBER      = '#fbbf24';
  const COLOR_MUTED      = '#7878a0';

  const BIRD_COLORS = [
    '#f87171', '#fb923c', '#fbbf24', '#34d399',
    '#60a5fa', '#a78bfa', '#f472b6', '#22d3ee',
  ];

  // Weapon system
  const WEAPONS = {
    sniper:  { maxAmmo: Infinity, cooldown: 0,  reloadTime: 0,   scoreMult: 1.0, hitRadiusMult: 1.0 },
    shotgun: { maxAmmo: 8,        cooldown: 20, reloadTime: 120,  scoreMult: 0.5, hitRadiusMult: 1.0, pellets: 8, spreadAngle: Math.PI / 6 },
    magnum:  { maxAmmo: 6,        cooldown: 10, reloadTime: 90,   scoreMult: 2.0, hitRadiusMult: 2.0, piercing: true },
  };
  const WEAPON_ORDER = ['sniper', 'shotgun', 'magnum'];

  // Health system
  const MAX_HEALTH           = 10;
  const INVINCIBILITY_MS     = 1000;
  const DAMAGE_FLASH_FRAMES  = 8;

  // Enemy type chances
  const ENEMY_SHINY_CHANCE   = 0.15;
  const ENEMY_RED_CHANCE     = 0.10;
  const RED_BIRD_SPEED_MULT  = 2.0;
  const RED_BIRD_ATTACK_RANGE = 60;
  const RED_BIRD_ATTACK_FRAMES = 30;
  const RED_BIRD_DAMAGE      = 2;
  const SHINY_SPEED_MULT     = 1.5;
  const SHINY_DIR_CHANGE_MS  = 1500;

  // Clouds
  const CLOUD_COUNT     = 8;
  const CLOUD_MIN_SPEED = 0.3;
  const CLOUD_MAX_SPEED = 0.8;

  // Screen shake
  const SCREEN_SHAKE_DECAY = 0.85;

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
  let lastFrameTime = 0;
  let loadingAngle = 0;
  let loadingProgress = 0;
  let loadingMessage = 'Scanning for ads...';
  let gameOverAlpha = 0; // Fade-in for game over screen
  let loadingPurgedAds = []; // Overlays caught and purged during the loading screen

  // Weapon state
  let currentWeapon = 'sniper';
  let ammo = { sniper: Infinity, shotgun: 8, magnum: 6 };
  let reloadTimer = 0;
  let weaponCooldown = 0;
  let muzzleFlashTimer = 0;

  // Health state
  let playerHealth = 10;
  let damageFlashTimer = 0;
  let lastDamageTime = 0;

  // Screen shake
  let screenShakeX = 0;
  let screenShakeY = 0;

  // Cloud system
  let clouds = [];

  // Smoothed delta time
  let smoothDt = 1.0;

  // Sky & stars
  let stars = [];
  let skyHue = 0;

  // Red bird proximity tracking (birdId -> frames in range)
  let redBirdProximity = new Map();

  // ═══════════════════════════════════════════════
  //  STAGE 2: BOSS FIGHT & GUN SELECTION STATE
  // ═══════════════════════════════════════════════
  const STAGE2_GUNS = [
    {
      id: 'pistol',
      name: '🔫 Tactical Pistol',
      shortName: 'PISTOL',
      damage: 1,
      fireRateMs: 300,
      requiredScore: 0,
      color: '#00e5ff',
      desc: 'Rapid single-shot precision. Fast & agile.',
    },
    {
      id: 'shotgun',
      name: '🔥 Flame Shotgun',
      shortName: 'SHOTGUN',
      damage: 3,
      fireRateMs: 900,
      requiredScore: 150,
      color: '#ff6d00',
      desc: '3-pellet incendiary spread cone. Heavy impact.',
    },
    {
      id: 'railgun',
      name: '⚡ Hyper Railgun',
      shortName: 'RAILGUN',
      damage: 5,
      fireRateMs: 1500,
      requiredScore: 300,
      color: '#e040fb',
      desc: 'Piercing high-energy beam. Maximum penetration.',
    },
    {
      id: 'sniper',
      name: '🎯 Heavy Sniper',
      shortName: 'SNIPER',
      damage: 10,
      headshotDamage: 20,
      fireRateMs: 1800,
      requiredScore: 450,
      color: '#34d399',
      desc: '10 DMG base. CRITICAL HEADSHOT deals DOUBLE (20 DMG)!',
    },
  ];
  let currentStage = 1;
  let stage1Score = 0;
  let stage1BirdsHit = 0;
  let stage1TotalBirds = 0;
  let stageClearTimer = 0;
  let selectedGun = STAGE2_GUNS[0];
  let gunCardsBounds = [];
  let gunCooldownTimer = 0;

  // Boss state
  let totalAdsFound = 5;
  let bossMaxHP = 50;
  let bossHP = 50;
  let bossSmoothHP = 50;
  let bossX = 0;
  let bossY = 0;
  let bossVx = 4.8; // Base horizontal flight speed (+50% boosted from 3.2)
  let bossSize = 220;
  let bossState = 'PATROL'; // PATROL | BITING | STUNNED | ENRAGED | DYING
  const BOSS_PARRY_WINDOW_MS = 1000; // 1.0 second parry window
  let biteTimer = 0; // ms remaining in parry window
  let biteCooldown = 0; // frames until next bite attempt
  let stunTimer = 0; // frames remaining stunned
  let bossWingPhase = 0;
  let bossIntroProgress = 0;
  let bossDefeated = false;
  let bossDeathTimer = 0;
  let parriesLanded = 0;
  let bossDamageTaken = 0;
  let bossBiteDamage = 1; // Doubles (+100%) on every user hit
  let bossLungeStartX = 0;
  let bossLungeStartY = 0;
  let bossLungeTargetX = 0;
  let bossLungeTargetY = 0;
  let railgunBeam = null;
  let sniperTracer = null;

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
    // Both subtree observer and 1-second polling were massive performance killers
    // that caused layout thrashing and event floods on SPAs.
    // They have been removed to prioritize game performance.
    const purged = purgeCoveringOverlays();
    for (const ad of purged) {
      if (gameState === 'PLAYING') {
        spawnBirdFromAd(ad);
      } else {
        loadingPurgedAds.push(ad);
      }
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

    // Assign enemy type
    let type = 'normal';
    const typeRoll = Math.random();
    if (typeRoll < ENEMY_RED_CHANCE) type = 'red_flasher';
    else if (typeRoll < ENEMY_RED_CHANCE + ENEMY_SHINY_CHANCE) type = 'shiny';

    const speedMult = type === 'shiny' ? SHINY_SPEED_MULT : type === 'red_flasher' ? RED_BIRD_SPEED_MULT : 1;
    const texture = type === 'shiny' ? createShinyBirdTexture(ad, size)
                  : type === 'red_flasher' ? createRedFlasherTexture(ad, size)
                  : createBirdTexture(ad, size);
    const directionAngle = Math.floor(Math.random() * 360) + 1;

    // Spawn from edge
    const fromLeft = Math.random() > 0.5;
    const x = fromLeft ? -size : vw + size;
    const y = Math.random() * (vh - size * 2 - 60) + 60;

    const newBird = {
      id: birds.length,
      x, y,
      size,
      type,
      speed: BIRD_SPEED * (0.8 + Math.random() * 0.4) * speedMult,
      directionAngle,
      lastDirChange: Date.now(),
      a1: ZIGZAG_A1 * (0.7 + Math.random() * 0.6),
      f1: ZIGZAG_F1 * (0.8 + Math.random() * 0.4),
      a2: ZIGZAG_A2 * (0.6 + Math.random() * 0.8),
      f2: ZIGZAG_F2 * (0.7 + Math.random() * 0.6),
      phase: Math.random() * Math.PI * 2,
      time: 0,
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
      chrome.runtime.sendMessage({ type: 'INJECT_WINDOW_OPEN_OVERRIDE' });
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

      // Assign enemy type
      let type = 'normal';
      const typeRoll = Math.random();
      if (typeRoll < ENEMY_RED_CHANCE) type = 'red_flasher';
      else if (typeRoll < ENEMY_RED_CHANCE + ENEMY_SHINY_CHANCE) type = 'shiny';

      const speedMult = type === 'shiny' ? SHINY_SPEED_MULT : type === 'red_flasher' ? RED_BIRD_SPEED_MULT : 1;

      // Create type-specific texture
      const texture = type === 'shiny' ? createShinyBirdTexture(ad, size)
                    : type === 'red_flasher' ? createRedFlasherTexture(ad, size)
                    : createBirdTexture(ad, size);

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
        type,
        directionAngle,
        lastDirChange,
        speed: BIRD_SPEED * (0.8 + Math.random() * 0.4) * speedMult,
        a1, f1, a2, f2,
        phase: Math.random() * Math.PI * 2,
        time: 0,
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

    // Feather pattern overlay
    tCtx.globalAlpha = 0.15;
    tCtx.strokeStyle = '#000';
    tCtx.lineWidth = 1;
    for (let fi = 0; fi < 5; fi++) {
      const fy = s * 0.25 + fi * s * 0.1;
      tCtx.beginPath();
      tCtx.moveTo(s * 0.15, fy);
      tCtx.quadraticCurveTo(s * 0.5, fy - s * 0.03, s * 0.85, fy);
      tCtx.stroke();
    }
    tCtx.globalAlpha = 1;

    // Gradient overlay for depth
    const bodyGrad = tCtx.createLinearGradient(0, 0, 0, s);
    bodyGrad.addColorStop(0, 'rgba(255,255,255,0.15)');
    bodyGrad.addColorStop(0.5, 'rgba(0,0,0,0)');
    bodyGrad.addColorStop(1, 'rgba(0,0,0,0.2)');
    tCtx.fillStyle = bodyGrad;
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

    // Eye
    tCtx.fillStyle = '#fff';
    tCtx.beginPath();
    tCtx.arc(s * 0.7, s * 0.25, s * 0.06, 0, Math.PI * 2);
    tCtx.fill();
    tCtx.fillStyle = '#000';
    tCtx.beginPath();
    tCtx.arc(s * 0.72, s * 0.25, s * 0.03, 0, Math.PI * 2);
    tCtx.fill();
    // Specular highlight
    tCtx.fillStyle = '#fff';
    tCtx.beginPath();
    tCtx.arc(s * 0.73, s * 0.23, s * 0.012, 0, Math.PI * 2);
    tCtx.fill();

    // Beak
    tCtx.fillStyle = '#f59e0b';
    tCtx.beginPath();
    tCtx.moveTo(s * 0.88, s * 0.3);
    tCtx.lineTo(s * 1.02, s * 0.35);
    tCtx.lineTo(s * 0.88, s * 0.4);
    tCtx.closePath();
    tCtx.fill();

    // Tail feathers
    tCtx.globalAlpha = 0.5;
    tCtx.fillStyle = color;
    for (let tf = 0; tf < 3; tf++) {
      tCtx.beginPath();
      tCtx.moveTo(s * 0.05, s * 0.35 + tf * s * 0.06);
      tCtx.lineTo(-s * 0.12, s * 0.25 + tf * s * 0.1);
      tCtx.lineTo(s * 0.05, s * 0.42 + tf * s * 0.06);
      tCtx.closePath();
      tCtx.fill();
    }
    tCtx.globalAlpha = 1;

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

  function createShinyBirdTexture(ad, size) {
    const tCanvas = document.createElement('canvas');
    const s = Math.round(size);
    tCanvas.width = s;
    tCanvas.height = s;
    const tCtx = tCanvas.getContext('2d');

    // Golden gradient body
    const grad = tCtx.createLinearGradient(0, 0, s, s);
    grad.addColorStop(0, '#fde68a');
    grad.addColorStop(0.5, '#f59e0b');
    grad.addColorStop(1, '#fbbf24');

    tCtx.fillStyle = grad;
    tCtx.globalAlpha = 0.95;
    roundRect(tCtx, 2, 2, s - 4, s - 4, s * 0.15);
    tCtx.fill();

    // Shimmer highlight
    tCtx.globalAlpha = 0.45;
    tCtx.fillStyle = '#fff';
    roundRect(tCtx, s * 0.1, s * 0.08, s * 0.8, s * 0.32, s * 0.1);
    tCtx.fill();
    tCtx.globalAlpha = 1;

    // Star symbol
    tCtx.fillStyle = 'rgba(255,255,255,0.7)';
    tCtx.font = `bold ${Math.max(12, s * 0.32)}px 'Segoe UI', system-ui, sans-serif`;
    tCtx.textAlign = 'center';
    tCtx.textBaseline = 'middle';
    tCtx.fillText('★', s / 2, s * 0.36);

    // Eye
    tCtx.fillStyle = '#fff';
    tCtx.beginPath();
    tCtx.arc(s * 0.68, s * 0.24, s * 0.055, 0, Math.PI * 2);
    tCtx.fill();
    tCtx.fillStyle = '#000';
    tCtx.beginPath();
    tCtx.arc(s * 0.7, s * 0.24, s * 0.028, 0, Math.PI * 2);
    tCtx.fill();

    // Beak
    tCtx.fillStyle = '#ea580c';
    tCtx.beginPath();
    tCtx.moveTo(s * 0.88, s * 0.3);
    tCtx.lineTo(s * 1.02, s * 0.35);
    tCtx.lineTo(s * 0.88, s * 0.4);
    tCtx.closePath();
    tCtx.fill();

    // Label
    tCtx.fillStyle = '#fff';
    tCtx.font = `bold ${Math.max(7, s * 0.1)}px 'Segoe UI', system-ui, sans-serif`;
    const labelText = ad.label.length > 12 ? ad.label.slice(0, 10) + '…' : ad.label;
    tCtx.fillText(labelText, s / 2, s * 0.72);

    tCtx.fillStyle = 'rgba(255,255,255,0.6)';
    tCtx.font = `${Math.max(6, s * 0.08)}px 'Segoe UI', system-ui, sans-serif`;
    tCtx.fillText(ad.tagName, s / 2, s * 0.85);

    // Golden border
    tCtx.strokeStyle = '#fbbf24';
    tCtx.lineWidth = 3;
    tCtx.globalAlpha = 0.85;
    roundRect(tCtx, 2, 2, s - 4, s - 4, s * 0.15);
    tCtx.stroke();
    tCtx.globalAlpha = 1;

    return tCanvas;
  }

  function createRedFlasherTexture(ad, size) {
    const tCanvas = document.createElement('canvas');
    const s = Math.round(size);
    tCanvas.width = s;
    tCanvas.height = s;
    const tCtx = tCanvas.getContext('2d');

    // Dark red radial gradient body
    const grad = tCtx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s * 0.6);
    grad.addColorStop(0, '#ef4444');
    grad.addColorStop(1, '#991b1b');

    tCtx.fillStyle = grad;
    tCtx.globalAlpha = 0.95;
    roundRect(tCtx, 2, 2, s - 4, s - 4, s * 0.15);
    tCtx.fill();
    tCtx.globalAlpha = 1;

    // Warning symbol
    tCtx.fillStyle = 'rgba(255,255,255,0.8)';
    tCtx.font = `bold ${Math.max(12, s * 0.32)}px 'Segoe UI', system-ui, sans-serif`;
    tCtx.textAlign = 'center';
    tCtx.textBaseline = 'middle';
    tCtx.fillText('⚠', s / 2, s * 0.36);

    // Angry eyes
    tCtx.fillStyle = '#fff';
    tCtx.beginPath();
    tCtx.arc(s * 0.38, s * 0.26, s * 0.055, 0, Math.PI * 2);
    tCtx.fill();
    tCtx.beginPath();
    tCtx.arc(s * 0.62, s * 0.26, s * 0.055, 0, Math.PI * 2);
    tCtx.fill();
    // Red pupils
    tCtx.fillStyle = '#dc2626';
    tCtx.beginPath();
    tCtx.arc(s * 0.4, s * 0.26, s * 0.028, 0, Math.PI * 2);
    tCtx.fill();
    tCtx.beginPath();
    tCtx.arc(s * 0.64, s * 0.26, s * 0.028, 0, Math.PI * 2);
    tCtx.fill();
    // Angry eyebrows
    tCtx.strokeStyle = '#fff';
    tCtx.lineWidth = Math.max(1.5, s * 0.025);
    tCtx.beginPath();
    tCtx.moveTo(s * 0.28, s * 0.2);
    tCtx.lineTo(s * 0.46, s * 0.16);
    tCtx.stroke();
    tCtx.beginPath();
    tCtx.moveTo(s * 0.72, s * 0.2);
    tCtx.lineTo(s * 0.54, s * 0.16);
    tCtx.stroke();

    // Label
    tCtx.fillStyle = '#fecaca';
    tCtx.font = `bold ${Math.max(7, s * 0.1)}px 'Segoe UI', system-ui, sans-serif`;
    tCtx.textAlign = 'center';
    const labelText = ad.label.length > 12 ? ad.label.slice(0, 10) + '…' : ad.label;
    tCtx.fillText(labelText, s / 2, s * 0.72);

    tCtx.fillStyle = 'rgba(254,202,202,0.6)';
    tCtx.font = `${Math.max(6, s * 0.08)}px 'Segoe UI', system-ui, sans-serif`;
    tCtx.fillText(ad.tagName, s / 2, s * 0.85);

    // Red border
    tCtx.strokeStyle = '#ef4444';
    tCtx.lineWidth = 3;
    tCtx.globalAlpha = 0.9;
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

  function updateBirds(dt = 1) {
    const vw = canvas.width;
    const vh = canvas.height;
    const now = Date.now();

    for (const bird of birds) {
      if (!bird.alive) continue;

      // Type-specific movement logic
      if (bird.type === 'red_flasher') {
        // Red flasher tracks toward player crosshair
        const dx = mouseX - bird.x;
        const dy = mouseY - bird.y;
        bird.directionAngle = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360 || 1;
        bird.lastDirChange = now;
        // Speed ramp when close
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 300) {
          bird.speed = Math.min(bird.speed * 1.003, BIRD_SPEED * RED_BIRD_SPEED_MULT * 2.5);
        }
      } else if (bird.type === 'shiny') {
        // Shiny birds change direction faster (every 1.5s)
        if (now - bird.lastDirChange >= SHINY_DIR_CHANGE_MS) {
          bird.directionAngle = Math.floor(Math.random() * 360) + 1;
          bird.lastDirChange = now;
        }
      } else {
        // Normal: change direction every 3 sec
        if (now - bird.lastDirChange >= 3000) {
          bird.directionAngle = Math.floor(Math.random() * 360) + 1;
          bird.lastDirChange = now;
        }
      }

      // Convert direction angle to radians
      let rad = (bird.directionAngle * Math.PI) / 180;

      // Directional velocity with constant speed (scaled by dt)
      const vx = Math.cos(rad) * bird.speed * dt;
      const vy = Math.sin(rad) * bird.speed * dt;

      // Normal (perpendicular) vector for zigzag flutter
      const nx = -Math.sin(rad);
      const ny = Math.cos(rad);

      // Dual-component zigzag flutter velocity (scaled by dt)
      bird.time = (bird.time || 0) + dt;
      const t = bird.time + bird.phase;
      const zigzagVel = (bird.a1 * bird.f1 * Math.cos(bird.f1 * t) +
                         bird.a2 * bird.f2 * Math.cos(bird.f2 * t)) * 0.5 * dt;

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

      if (bird.y < half + 50) { // Stay below top HUD
        bird.y = half + 50;
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

      // Wing flap animation (scaled by dt)
      bird.wingPhase += bird.wingSpeed * dt;
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

  function updateParticles(dt = 1) {
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (!p.isText) {
        p.vy += 0.15 * dt; // Gravity
        p.size *= Math.pow(0.96, dt);
      }
      p.life -= dt;
      if (p.life <= 0) particles.splice(i, 1);
    }
  }

  function renderParticles() {
    for (const p of particles) {
      const alpha = p.life / p.maxLife;
      if (p.isText) {
        // Text popups with glow
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.shadowColor = p.color;
        ctx.shadowBlur = 8;
        ctx.fillStyle = p.color;
        ctx.font = `bold 18px 'Segoe UI', system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillText(p.text, p.x, p.y);
        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;
        ctx.restore();
      } else {
        // Motion trail (3 trail segments)
        for (let t = 0; t < 3; t++) {
          const trailAlpha = alpha * (1 - t * 0.3) * 0.4;
          ctx.globalAlpha = trailAlpha;
          ctx.fillStyle = p.color;
          ctx.beginPath();
          ctx.arc(p.x - p.vx * t * 0.6, p.y - p.vy * t * 0.6, p.size * (1 - t * 0.2), 0, Math.PI * 2);
          ctx.fill();
        }

        // Main particle with glow
        ctx.globalAlpha = alpha;
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();

        // Outer glow
        ctx.globalAlpha = alpha * 0.3;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * 2, 0, Math.PI * 2);
        ctx.fill();

        ctx.globalAlpha = 1;
      }
    }
    ctx.globalAlpha = 1;
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

  function updateFireworks(vw, vh, cx, cy, dt = 1) {
    fireworkSpawnTimer += dt;

    // Launch a firework burst every ~24 frames (normalized)
    if (fireworkSpawnTimer >= 24) {
      fireworkSpawnTimer = 0;
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
      f.x += f.vx * dt;
      f.y += f.vy * dt;
      f.vy += 0.08 * dt; // Gravity
      f.vx *= Math.pow(0.98, dt); // Air drag
      f.vy *= Math.pow(0.98, dt);
      f.life -= dt;
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

  // ═══════════════════════════════════════════════
  //  CLOUD SYSTEM
  // ═══════════════════════════════════════════════

  function initClouds(vw, vh) {
    clouds = [];
    for (let i = 0; i < CLOUD_COUNT; i++) {
      clouds.push({
        x: Math.random() * (vw + 400) - 200,
        y: Math.random() * vh * 0.6 + 20,
        w: 120 + Math.random() * 200,
        h: 30 + Math.random() * 40,
        speed: CLOUD_MIN_SPEED + Math.random() * (CLOUD_MAX_SPEED - CLOUD_MIN_SPEED),
        alpha: 0.03 + Math.random() * 0.06,
      });
    }
  }

  function updateClouds(vw, dt) {
    for (const c of clouds) {
      c.x += c.speed * dt;
      if (c.x > vw + c.w) {
        c.x = -c.w - Math.random() * 200;
        c.y = Math.random() * (canvas ? canvas.height * 0.6 : 500) + 20;
      }
    }
  }

  function renderClouds() {
    for (const c of clouds) {
      ctx.globalAlpha = c.alpha;

      // Main puff with radial gradient
      const grad = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, c.w / 2);
      grad.addColorStop(0, 'rgba(255, 255, 255, 0.5)');
      grad.addColorStop(0.6, 'rgba(255, 255, 255, 0.2)');
      grad.addColorStop(1, 'rgba(255, 255, 255, 0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.ellipse(c.x, c.y, c.w / 2, c.h / 2, 0, 0, Math.PI * 2);
      ctx.fill();

      // Secondary puff
      const grad2 = ctx.createRadialGradient(c.x - c.w * 0.25, c.y + c.h * 0.15, 0,
                                             c.x - c.w * 0.25, c.y + c.h * 0.15, c.w * 0.35);
      grad2.addColorStop(0, 'rgba(255, 255, 255, 0.4)');
      grad2.addColorStop(1, 'rgba(255, 255, 255, 0)');
      ctx.fillStyle = grad2;
      ctx.beginPath();
      ctx.ellipse(c.x - c.w * 0.25, c.y + c.h * 0.15, c.w * 0.35, c.h * 0.4, 0, 0, Math.PI * 2);
      ctx.fill();

      // Tertiary puff
      const grad3 = ctx.createRadialGradient(c.x + c.w * 0.2, c.y + c.h * 0.1, 0,
                                             c.x + c.w * 0.2, c.y + c.h * 0.1, c.w * 0.3);
      grad3.addColorStop(0, 'rgba(255, 255, 255, 0.35)');
      grad3.addColorStop(1, 'rgba(255, 255, 255, 0)');
      ctx.fillStyle = grad3;
      ctx.beginPath();
      ctx.ellipse(c.x + c.w * 0.2, c.y + c.h * 0.1, c.w * 0.3, c.h * 0.35, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  // ═══════════════════════════════════════════════
  //  STARS & SKY SYSTEM
  // ═══════════════════════════════════════════════

  function initStars(vw, vh) {
    stars = [];
    for (let i = 0; i < 60; i++) {
      stars.push({
        x: Math.random() * vw,
        y: Math.random() * vh * 0.7,
        radius: 0.5 + Math.random() * 1.5,
        twinkleSpeed: 0.02 + Math.random() * 0.04,
        twinklePhase: Math.random() * Math.PI * 2,
      });
    }
  }

  function renderSky(vw, vh) {
    // Animated gradient sky
    skyHue = (skyHue + 0.05) % 360;
    const grad = ctx.createLinearGradient(0, 0, 0, vh);
    grad.addColorStop(0, 'hsla(230, 40%, 8%, 0.85)');
    grad.addColorStop(0.5, 'hsla(260, 35%, 12%, 0.80)');
    grad.addColorStop(1, 'hsla(280, 25%, 15%, 0.75)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, vw, vh);

    // Twinkling stars
    for (const s of stars) {
      s.twinklePhase += s.twinkleSpeed;
      const alpha = 0.3 + Math.sin(s.twinklePhase) * 0.3;
      ctx.globalAlpha = alpha;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.radius, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  // ═══════════════════════════════════════════════
  //  WEAPON SYSTEM
  // ═══════════════════════════════════════════════

  function switchWeapon(weaponName) {
    if (weaponName === currentWeapon) return;
    if (!WEAPONS[weaponName]) return;
    currentWeapon = weaponName;
    reloadTimer = 0;
    weaponCooldown = 0;
    // Notification
    particles.push({
      x: canvas ? canvas.width / 2 : 400,
      y: canvas ? canvas.height - 60 : 500,
      vx: 0, vy: -1,
      life: 50, maxLife: 50,
      isText: true,
      text: `🔫 ${weaponName.toUpperCase()} equipped!`,
      color: currentWeapon === 'magnum' ? '#ef4444' : currentWeapon === 'shotgun' ? '#f97316' : COLOR_GREEN,
      size: 0,
    });
  }

  function cycleWeapon() {
    const idx = WEAPON_ORDER.indexOf(currentWeapon);
    const next = WEAPON_ORDER[(idx + 1) % WEAPON_ORDER.length];
    switchWeapon(next);
  }

  function tryReload() {
    const w = WEAPONS[currentWeapon];
    if (w.reloadTime <= 0) return;
    if (ammo[currentWeapon] >= w.maxAmmo) return;
    if (reloadTimer > 0) return;
    reloadTimer = w.reloadTime;
  }

  function finishReload() {
    const w = WEAPONS[currentWeapon];
    ammo[currentWeapon] = w.maxAmmo;
    reloadTimer = 0;
  }

  // ═══════════════════════════════════════════════
  //  HEALTH SYSTEM
  // ═══════════════════════════════════════════════

  function takeDamage(amount) {
    const now = Date.now();
    if (now - lastDamageTime < INVINCIBILITY_MS) return;
    playerHealth = Math.max(0, playerHealth - amount);
    damageFlashTimer = DAMAGE_FLASH_FRAMES;
    lastDamageTime = now;
    screenShakeX = (Math.random() - 0.5) * 12;
    screenShakeY = (Math.random() - 0.5) * 12;
    // Damage text
    particles.push({
      x: canvas ? canvas.width / 2 : 400,
      y: canvas ? canvas.height / 2 : 300,
      vx: 0, vy: -1.5,
      life: 55, maxLife: 55,
      isText: true,
      text: `💥 -${amount} HP!`,
      color: COLOR_RED,
      size: 0,
    });
    if (playerHealth <= 0) {
      gameState = 'GAME_OVER';
      gameOverAlpha = 0;
    }
  }

  function checkRedBirdAttacks() {
    for (const bird of birds) {
      if (!bird.alive || bird.type !== 'red_flasher') continue;
      const dx = mouseX - bird.x;
      const dy = mouseY - bird.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist <= RED_BIRD_ATTACK_RANGE) {
        const frames = (redBirdProximity.get(bird.id) || 0) + 1;
        redBirdProximity.set(bird.id, frames);
        if (frames >= RED_BIRD_ATTACK_FRAMES) {
          // Attack!
          takeDamage(RED_BIRD_DAMAGE);
          bird.alive = false;
          birdsHit++;
          spawnParticles(bird.x, bird.y, '#ef4444');
          redBirdProximity.delete(bird.id);
          particles.push({
            x: bird.x, y: bird.y - 30,
            vx: 0, vy: -1.2,
            life: 55, maxLife: 55,
            isText: true,
            text: '💥 RED BIRD ATTACK!',
            color: COLOR_RED,
            size: 0,
          });
          // Check if all birds done
          if (birds.every(b => !b.alive)) {
            if (currentStage === 1) {
              onStage1Complete();
            } else {
              gameState = 'GAME_OVER';
              gameOverAlpha = 0;
            }
          }
        }
      } else {
        redBirdProximity.delete(bird.id);
      }
    }
  }

  // ═══════════════════════════════════════════════
  //  STAGE 2: BOSS FIGHT ENGINE
  // ═══════════════════════════════════════════════

  function initBossFight() {
    currentStage = 2;
    bossMaxHP = 50 + (totalAdsFound * 2);
    bossHP = bossMaxHP;
    bossSmoothHP = bossMaxHP;
    bossBiteDamage = 1;
    const vw = canvas ? canvas.width : window.innerWidth;
    const vh = canvas ? canvas.height : window.innerHeight;
    bossX = vw / 2;
    bossY = -150;
    bossVx = 4.8; // +50% speed increase (boosted from 3.2)
    bossSize = Math.max(180, Math.min(vw, vh) * 0.28);
    bossState = 'PATROL';
    biteTimer = 0;
    biteCooldown = 220; // ~3.6s initial grace
    stunTimer = 0;
    bossWingPhase = 0;
    bossIntroProgress = 0;
    bossDefeated = false;
    bossDeathTimer = 0;
    parriesLanded = 0;
    bossDamageTaken = 0;
    gunCooldownTimer = 0;
    sniperTracer = null;
  }

  function updateBossIntro(dt = 1) {
    bossIntroProgress = Math.min(1, bossIntroProgress + 0.012 * dt);
    const vh = canvas ? canvas.height : window.innerHeight;
    const vw = canvas ? canvas.width : window.innerWidth;
    const targetY = vh * 0.32;
    bossY = -150 + (targetY + 150) * Math.sin((bossIntroProgress * Math.PI) / 2);
    bossX = vw / 2 + Math.sin(bossIntroProgress * Math.PI * 2) * 50;
    bossWingPhase += 0.16 * dt;

    if (bossIntroProgress >= 1) {
      gameState = 'BOSS_FIGHT';
      bossState = 'PATROL';
      biteCooldown = 180;
    }
  }

  function updateBoss(dt = 1) {
    const vw = canvas ? canvas.width : window.innerWidth;
    const vh = canvas ? canvas.height : window.innerHeight;

    // Smooth health bar interpolation
    bossSmoothHP += (bossHP - bossSmoothHP) * 0.1 * dt;

    // Wing flap animation (tuned for +50% flight speed)
    const wingSpeed = bossState === 'BITING' ? 0.45 : bossState === 'ENRAGED' ? 0.32 : 0.20;
    bossWingPhase += wingSpeed * dt;

    // Update railgun beam visual if active
    if (railgunBeam) {
      railgunBeam.timer -= dt;
      if (railgunBeam.timer <= 0) railgunBeam = null;
    }

    // Update sniper supersonic tracer visual if active
    if (sniperTracer) {
      sniperTracer.timer -= dt;
      if (sniperTracer.timer <= 0) sniperTracer = null;
    }

    if (bossState === 'DYING') {
      bossDeathTimer -= dt;
      triggerScreenShake(7);
      if (Math.random() < 0.35) {
        spawnBossHitParticles(
          bossX + (Math.random() - 0.5) * bossSize,
          bossY + (Math.random() - 0.5) * bossSize,
          FIREWORK_COLORS[Math.floor(Math.random() * FIREWORK_COLORS.length)]
        );
      }
      if (bossDeathTimer <= 0) {
        bossDefeated = true;
        score += 1500;
        gameState = 'GAME_OVER';
        gameOverAlpha = 0;
      }
      return;
    }

    if (bossState === 'PATROL') {
      bossX += bossVx * dt;
      bossY = vh * 0.32 + Math.sin(frameCount * 0.05) * 45;

      const halfW = bossSize * 0.6;
      if (bossX > vw - halfW) {
        bossVx = -Math.abs(bossVx);
      } else if (bossX < halfW) {
        bossVx = Math.abs(bossVx);
      }

      // Check enrage threshold (HP <= 25%)
      if (bossHP <= bossMaxHP * 0.25) {
        bossState = 'ENRAGED';
      }

      // Decrement bite cooldown
      biteCooldown -= dt;
      if (biteCooldown <= 0) {
        startBossBite(vw, vh);
      }
    } else if (bossState === 'ENRAGED') {
      // Faster, more aggressive erratic motion
      bossX += (bossVx * 1.5 + Math.sin(frameCount * 0.12) * 4.5) * dt;
      bossY = vh * 0.34 + Math.sin(frameCount * 0.1) * 70;

      const halfW = bossSize * 0.6;
      if (bossX > vw - halfW) {
        bossVx = -Math.abs(bossVx) * (1.1 + Math.random() * 0.2);
      } else if (bossX < halfW) {
        bossVx = Math.abs(bossVx) * (1.1 + Math.random() * 0.2);
      }

      biteCooldown -= dt;
      if (biteCooldown <= 0) {
        startBossBite(vw, vh);
      }
    } else if (bossState === 'BITING') {
      // 1000ms bite window (1.0s parry window)
      biteTimer -= dt * (1000 / 60);

      // Lunge motion toward center of screen
      const lungeProgress = 1 - Math.max(0, biteTimer / BOSS_PARRY_WINDOW_MS);
      const lungeArc = Math.sin(lungeProgress * Math.PI);
      bossX = bossLungeStartX + (bossLungeTargetX - bossLungeStartX) * lungeArc;
      bossY = bossLungeStartY + (bossLungeTargetY - bossLungeStartY) * lungeArc;

      if (biteTimer <= 0) {
        // Bite connects: player failed to parry in time
        const dmgDealt = bossBiteDamage;
        takeDamage(dmgDealt);
        bossDamageTaken += dmgDealt;
        bossX = bossLungeStartX;
        bossY = bossLungeStartY;
        bossState = bossHP <= bossMaxHP * 0.25 ? 'ENRAGED' : 'PATROL';
        biteCooldown = bossHP <= bossMaxHP * 0.25 ? 130 : 220;
        triggerScreenShake(14);

        // Increase the damage of the Boss on every user hit by 100%
        const prevDmg = bossBiteDamage;
        bossBiteDamage = bossBiteDamage * 2;

        particles.push({
          x: vw / 2,
          y: vh / 2,
          vx: 0,
          vy: -1.5,
          life: 75,
          maxLife: 75,
          isText: true,
          text: `💥 BOSS BITE! (-${dmgDealt} HP) [Next: ${bossBiteDamage} DMG! (+100%)]`,
          color: COLOR_RED,
          size: 0,
        });
      }
    } else if (bossState === 'STUNNED') {
      stunTimer -= dt;
      // Dizzy shake
      bossX += (Math.random() - 0.5) * 2;
      bossY += (Math.random() - 0.5) * 1.5;

      if (stunTimer <= 0) {
        bossState = bossHP <= bossMaxHP * 0.25 ? 'ENRAGED' : 'PATROL';
        biteCooldown = 180 + Math.random() * 60;
      }
    }
  }

  function startBossBite(vw, vh) {
    bossState = 'BITING';
    biteTimer = BOSS_PARRY_WINDOW_MS; // Exactly 1 second parry window
    bossLungeStartX = bossX;
    bossLungeStartY = bossY;
    bossLungeTargetX = vw / 2;
    bossLungeTargetY = vh * 0.55;
    triggerScreenShake(4);

    particles.push({
      x: vw / 2,
      y: 90,
      vx: 0,
      vy: -1.0,
      life: 55,
      maxLife: 55,
      isText: true,
      text: '⚠️ BITE INCOMING — SHOOT TO PARRY! (1.0s)',
      color: '#ef4444',
      size: 0,
    });
  }

  function spawnBossHitParticles(x, y, color) {
    for (let i = 0; i < 14; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 2 + Math.random() * 5;
      particles.push({
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 30 + Math.random() * 20,
        maxLife: 50,
        color,
        size: 3 + Math.random() * 4,
        isText: false,
      });
    }
  }

  function spawnParrySparks(x, y) {
    for (let i = 0; i < 22; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 4 + Math.random() * 7;
      particles.push({
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 40 + Math.random() * 20,
        maxLife: 60,
        color: i % 2 === 0 ? '#fbbf24' : '#ffffff',
        size: 4 + Math.random() * 3,
        isText: false,
      });
    }
  }

  // ═══════════════════════════════════════════════
  //  SCREEN SHAKE
  // ═══════════════════════════════════════════════

  function updateScreenShake() {
    screenShakeX *= SCREEN_SHAKE_DECAY;
    screenShakeY *= SCREEN_SHAKE_DECAY;
    if (Math.abs(screenShakeX) < 0.3) screenShakeX = 0;
    if (Math.abs(screenShakeY) < 0.3) screenShakeY = 0;
  }

  function triggerScreenShake(intensity) {
    screenShakeX = (Math.random() - 0.5) * intensity;
    screenShakeY = (Math.random() - 0.5) * intensity;
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

    const comboMult = getComboMultiplier();
    const weaponMult = WEAPONS[currentWeapon].scoreMult;
    let typeMult = 1;

    // Shiny bird: double points + weapon switch
    if (bird.type === 'shiny') {
      typeMult = 2;
      cycleWeapon();
      particles.push({
        x: bird.x, y: bird.y - 40,
        vx: 0, vy: -1.2,
        life: 65, maxLife: 65,
        isText: true,
        text: '✨ SHINY! ×2 + Weapon Switch!',
        color: '#fbbf24',
        size: 0,
      });
    }

    // Red flasher: danger bonus
    if (bird.type === 'red_flasher') {
      typeMult = 1.5;
      redBirdProximity.delete(bird.id);
      particles.push({
        x: bird.x, y: bird.y - 40,
        vx: 0, vy: -1.2,
        life: 55, maxLife: 55,
        isText: true,
        text: '🔴 THREAT NEUTRALIZED!',
        color: '#ef4444',
        size: 0,
      });
    }

    const points = Math.round(bird.points * comboMult * weaponMult * typeMult);
    _lastScore = points;
    score += points;

    // Spawn explosion
    spawnParticles(bird.x, bird.y, bird.type === 'shiny' ? '#fbbf24' : bird.type === 'red_flasher' ? '#ef4444' : bird.color);

    // Screen shake on hit
    triggerScreenShake(currentWeapon === 'magnum' ? 8 : currentWeapon === 'shotgun' ? 6 : 3);
    muzzleFlashTimer = 4;

    // Check victory
    if (birds.every(b => !b.alive)) {
      if (currentStage === 1) {
        onStage1Complete();
      } else {
        gameState = 'GAME_OVER';
        gameOverAlpha = 0;
      }
    }
  }

  function handleMiss() {
    combo = 0;
  }

  function onStage1Complete() {
    currentStage = 1;
    stage1Score = score;
    stage1BirdsHit = birdsHit;
    stage1TotalBirds = totalBirds;
    gameState = 'STAGE_CLEAR';
    stageClearTimer = 180;
    particles.push({
      x: canvas ? canvas.width / 2 : 400,
      y: (canvas ? canvas.height / 2 : 300) - 80,
      vx: 0,
      vy: -1.0,
      life: 90,
      maxLife: 90,
      isText: true,
      text: '🏆 STAGE 1 CLEARED!',
      color: '#fbbf24',
      size: 0,
    });
  }

  // ═══════════════════════════════════════════════
  //  RENDERER
  // ═══════════════════════════════════════════════

  function render(dt = 1) {
    const vw = canvas.width;
    const vh = canvas.height;

    // Clear
    ctx.clearRect(0, 0, vw, vh);

    if (gameState === 'LOADING') {
      renderLoadingScreen(vw, vh, dt);
      return;
    }

    // Animated gradient sky background + stars
    renderSky(vw, vh);

    // Render clouds behind birds/boss
    renderClouds();

    if (gameState === 'PLAYING') {
      // Draw birds
      for (const bird of birds) {
        if (!bird.alive) continue;
        renderBird(bird);
      }
      renderDamageFlash(vw, vh);
      renderParticles();
      renderMuzzleFlashCone();
      renderHUD(vw, vh);
      renderCrosshair();
    } else if (gameState === 'STAGE_CLEAR') {
      renderDamageFlash(vw, vh);
      renderParticles();
      renderStageClear(vw, vh, dt);
    } else if (gameState === 'GUN_SELECT') {
      renderParticles();
      renderGunSelect(vw, vh);
    } else if (gameState === 'BOSS_INTRO') {
      renderBoss(dt);
      renderParticles();
      renderBossIntro(vw, vh, dt);
    } else if (gameState === 'BOSS_FIGHT') {
      renderBoss(dt);
      renderDamageFlash(vw, vh);
      renderParticles();
      renderRailgunBeam();
      renderSniperTracer();
      renderMuzzleFlashCone();
      renderBossHUD(vw, vh);
      renderBossCrosshair();
    } else if (gameState === 'GAME_OVER') {
      if (currentStage === 1) {
        for (const bird of birds) {
          if (!bird.alive) continue;
          renderBird(bird);
        }
      } else {
        renderBoss(dt);
      }
      renderParticles();
      renderGameOver(vw, vh, dt);
    }
  }

  function renderDamageFlash(vw, vh) {
    if (damageFlashTimer > 0) {
      const flashAlpha = (damageFlashTimer / DAMAGE_FLASH_FRAMES) * 0.45;
      const vigGrad = ctx.createRadialGradient(vw / 2, vh / 2, vh * 0.25, vw / 2, vh / 2, vh * 0.85);
      vigGrad.addColorStop(0, 'rgba(248, 113, 113, 0)');
      vigGrad.addColorStop(1, `rgba(248, 113, 113, ${flashAlpha})`);
      ctx.fillStyle = vigGrad;
      ctx.fillRect(0, 0, vw, vh);
      damageFlashTimer--;
    }
  }

  function renderMuzzleFlashCone() {
    if (muzzleFlashTimer > 0) {
      const mfAlpha = (muzzleFlashTimer / 4) * 0.55;
      ctx.globalAlpha = mfAlpha;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(mouseX, mouseY, 18 * (muzzleFlashTimer / 4), 0, Math.PI * 2);
      ctx.fill();
      const flashColor = currentStage === 2 && selectedGun
        ? selectedGun.color
        : currentWeapon === 'magnum' ? '#f87171' : currentWeapon === 'shotgun' ? '#fb923c' : COLOR_GREEN;
      ctx.fillStyle = flashColor;
      ctx.beginPath();
      ctx.arc(mouseX, mouseY, 10 * (muzzleFlashTimer / 4), 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      muzzleFlashTimer--;
    }
  }

  function renderRailgunBeam() {
    if (!railgunBeam) return;
    ctx.save();
    const alpha = Math.max(0, railgunBeam.timer / 12);
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = '#e040fb';
    ctx.lineWidth = 14;
    ctx.shadowColor = '#e040fb';
    ctx.shadowBlur = 24;
    ctx.beginPath();
    ctx.moveTo(railgunBeam.startX, railgunBeam.startY);
    ctx.lineTo(railgunBeam.endX, railgunBeam.endY);
    ctx.stroke();

    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 4;
    ctx.shadowBlur = 0;
    ctx.beginPath();
    ctx.moveTo(railgunBeam.startX, railgunBeam.startY);
    ctx.lineTo(railgunBeam.endX, railgunBeam.endY);
    ctx.stroke();
    ctx.restore();
  }

  function renderSniperTracer() {
    if (!sniperTracer) return;
    ctx.save();
    const alpha = Math.max(0, sniperTracer.timer / 10);
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = '#34d399';
    ctx.lineWidth = 4;
    ctx.shadowColor = '#34d399';
    ctx.shadowBlur = 16;
    ctx.beginPath();
    ctx.moveTo(sniperTracer.startX, sniperTracer.startY);
    ctx.lineTo(sniperTracer.endX, sniperTracer.endY);
    ctx.stroke();

    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(sniperTracer.startX, sniperTracer.startY);
    ctx.lineTo(sniperTracer.endX, sniperTracer.endY);
    ctx.stroke();
    ctx.restore();
  }

  function renderStageClear(vw, vh, dt = 1) {
    const cx = vw / 2;
    const cy = vh / 2;

    ctx.fillStyle = 'rgba(12, 12, 22, 0.75)';
    ctx.fillRect(0, 0, vw, vh);

    const cardW = 540;
    const cardH = 340;

    ctx.shadowColor = 'rgba(0, 0, 0, 0.6)';
    ctx.shadowBlur = 32;
    ctx.shadowOffsetY = 8;

    ctx.fillStyle = COLOR_HUD_BG;
    roundRect(ctx, cx - cardW / 2, cy - cardH / 2, cardW, cardH, 18);
    ctx.fill();

    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;

    ctx.strokeStyle = '#fbbf24';
    ctx.lineWidth = 2.5;
    roundRect(ctx, cx - cardW / 2, cy - cardH / 2, cardW, cardH, 18);
    ctx.stroke();

    const topGrad = ctx.createLinearGradient(cx - cardW / 2, 0, cx + cardW / 2, 0);
    topGrad.addColorStop(0, 'rgba(251, 191, 36, 0)');
    topGrad.addColorStop(0.5, 'rgba(251, 191, 36, 0.15)');
    topGrad.addColorStop(1, 'rgba(251, 191, 36, 0)');
    ctx.fillStyle = topGrad;
    roundRect(ctx, cx - cardW / 2, cy - cardH / 2, cardW, 55, 18);
    ctx.fill();

    ctx.fillStyle = '#fbbf24';
    ctx.font = `bold 26px 'Segoe UI', system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('🏆 STAGE 1 CLEARED!', cx, cy - 110);

    ctx.fillStyle = COLOR_TEXT;
    ctx.font = `14px 'Segoe UI', system-ui, sans-serif`;
    ctx.fillText(`All ${stage1BirdsHit} Ad Targets Vaporized!`, cx, cy - 70);

    ctx.fillStyle = 'rgba(255, 255, 255, 0.04)';
    roundRect(ctx, cx - 210, cy - 45, 420, 60, 10);
    ctx.fill();

    ctx.font = `bold 18px 'Segoe UI', system-ui, sans-serif`;
    ctx.fillStyle = COLOR_GREEN;
    ctx.fillText(`Accumulated Points: ${score.toLocaleString()} PTS`, cx, cy - 15);

    ctx.fillStyle = '#f87171';
    ctx.font = `bold 14px 'Segoe UI', system-ui, sans-serif`;
    ctx.fillText('⚠️ BOSS ENCOUNTER AHEAD: GOOGLE ANALYTICS', cx, cy + 45);

    ctx.fillStyle = COLOR_MUTED;
    ctx.font = `12px 'Segoe UI', system-ui, sans-serif`;
    ctx.fillText('Unlocking weapon selection for boss battle...', cx, cy + 70);

    const pulse = 0.6 + Math.sin(frameCount * 0.1) * 0.4;
    ctx.globalAlpha = pulse;
    ctx.fillStyle = '#fbbf24';
    ctx.font = `bold 13px 'Segoe UI', system-ui, sans-serif`;
    ctx.fillText('[ Click anywhere to proceed to Armory ]', cx, cy + 115);
    ctx.globalAlpha = 1;
  }

  function renderGunSelect(vw, vh) {
    const cx = vw / 2;
    const cy = vh / 2;

    ctx.fillStyle = 'rgba(10, 10, 20, 0.85)';
    ctx.fillRect(0, 0, vw, vh);

    ctx.shadowColor = '#fbbf24';
    ctx.shadowBlur = 18;
    ctx.fillStyle = '#fbbf24';
    ctx.font = `bold 28px 'Segoe UI', system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('⚔️ CHOOSE YOUR WEAPON FOR STAGE 2 ⚔️', cx, cy - 220);
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;

    ctx.fillStyle = COLOR_TEXT;
    ctx.font = `14px 'Segoe UI', system-ui, sans-serif`;
    ctx.fillText('Equip a weapon to battle Google Analytics based on your Stage 1 points:', cx, cy - 182);

    const scorePillW = 260;
    const scorePillH = 28;
    ctx.fillStyle = 'rgba(52, 211, 153, 0.12)';
    roundRect(ctx, cx - scorePillW / 2, cy - 162, scorePillW, scorePillH, 14);
    ctx.fill();
    ctx.strokeStyle = COLOR_GREEN;
    ctx.lineWidth = 1;
    roundRect(ctx, cx - scorePillW / 2, cy - 162, scorePillW, scorePillH, 14);
    ctx.stroke();

    ctx.fillStyle = COLOR_GREEN;
    ctx.font = `bold 13px 'Segoe UI', system-ui, sans-serif`;
    ctx.fillText(`Accumulated Score: ${score.toLocaleString()} PTS`, cx, cy - 148);

    const numGuns = STAGE2_GUNS.length;
    const cardW = Math.min(210, Math.max(175, Math.floor((vw - 80) / numGuns)));
    const cardH = 340;
    const gap = 16;
    const totalW = numGuns * cardW + (numGuns - 1) * gap;
    const startX = cx - totalW / 2;
    const cardY = cy - 110;

    gunCardsBounds = [];
    let hoveredUnlocked = false;

    for (let i = 0; i < STAGE2_GUNS.length; i++) {
      const gun = STAGE2_GUNS[i];
      const cardX = startX + i * (cardW + gap);
      const isUnlocked = score >= gun.requiredScore;

      gunCardsBounds.push({
        x: cardX,
        y: cardY,
        w: cardW,
        h: cardH,
        gun,
        unlocked: isUnlocked,
      });

      const isHover = mouseX >= cardX && mouseX <= cardX + cardW &&
                      mouseY >= cardY && mouseY <= cardY + cardH;

      if (isHover && isUnlocked) {
        hoveredUnlocked = true;
      }

      ctx.shadowColor = isHover && isUnlocked ? gun.color : 'rgba(0, 0, 0, 0.5)';
      ctx.shadowBlur = isHover && isUnlocked ? 22 : 14;
      ctx.shadowOffsetY = 6;

      ctx.fillStyle = isUnlocked
        ? (isHover ? 'rgba(28, 28, 48, 0.95)' : 'rgba(20, 20, 36, 0.88)')
        : 'rgba(16, 16, 24, 0.7)';
      roundRect(ctx, cardX, cardY, cardW, cardH, 14);
      ctx.fill();

      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;

      ctx.strokeStyle = isUnlocked
        ? (isHover ? gun.color : 'rgba(255, 255, 255, 0.18)')
        : 'rgba(239, 68, 68, 0.3)';
      ctx.lineWidth = isHover && isUnlocked ? 2.5 : 1.5;
      roundRect(ctx, cardX, cardY, cardW, cardH, 14);
      ctx.stroke();

      ctx.fillStyle = isUnlocked ? gun.color : 'rgba(239, 68, 68, 0.4)';
      roundRect(ctx, cardX, cardY, cardW, 6, 4);
      ctx.fill();

      ctx.fillStyle = isUnlocked ? '#ffffff' : COLOR_MUTED;
      ctx.font = `bold 15px 'Segoe UI', system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText(gun.name, cardX + cardW / 2, cardY + 36);

      ctx.fillStyle = isUnlocked ? gun.color : 'rgba(255, 255, 255, 0.1)';
      ctx.fillRect(cardX + 16, cardY + 52, cardW - 32, 1.5);

      ctx.font = `11px 'Segoe UI', system-ui, sans-serif`;
      ctx.fillStyle = COLOR_MUTED;
      ctx.textAlign = 'left';
      ctx.fillText('Damage / Shot:', cardX + 16, cardY + 78);

      ctx.textAlign = 'right';
      ctx.font = `bold 12px 'Segoe UI', system-ui, sans-serif`;
      ctx.fillStyle = isUnlocked ? gun.color : COLOR_MUTED;
      const dmgLabel = gun.id === 'sniper' ? '10 (20 HS)' : `${gun.damage} DMG`;
      ctx.fillText(dmgLabel, cardX + cardW - 16, cardY + 78);

      const maxPipSlots = 5;
      const pipW = Math.floor((cardW - 32 - (maxPipSlots - 1) * 4) / maxPipSlots);
      for (let p = 0; p < maxPipSlots; p++) {
        const pipH = 5;
        const pipX = cardX + 16 + p * (pipW + 4);
        const pipY = cardY + 88;
        const filled = gun.id === 'sniper' ? true : p < gun.damage;
        ctx.fillStyle = filled
          ? (isUnlocked ? gun.color : 'rgba(255, 255, 255, 0.2)')
          : 'rgba(255, 255, 255, 0.08)';
        roundRect(ctx, pipX, pipY, pipW, pipH, 2);
        ctx.fill();
      }

      ctx.font = `11px 'Segoe UI', system-ui, sans-serif`;
      ctx.fillStyle = COLOR_MUTED;
      ctx.textAlign = 'left';
      ctx.fillText('Cycle Rate:', cardX + 16, cardY + 116);

      ctx.textAlign = 'right';
      ctx.font = `bold 12px 'Segoe UI', system-ui, sans-serif`;
      ctx.fillStyle = isUnlocked ? '#38bdf8' : COLOR_MUTED;
      const speedLabel = gun.id === 'pistol' ? '300ms (RAPID)' : gun.id === 'shotgun' ? '900ms (SPREAD)' : gun.id === 'railgun' ? '1500ms (BEAM)' : '1800ms (SNIPER)';
      ctx.fillText(speedLabel, cardX + cardW - 16, cardY + 116);

      ctx.fillStyle = 'rgba(255, 255, 255, 0.03)';
      roundRect(ctx, cardX + 12, cardY + 134, cardW - 24, 80, 8);
      ctx.fill();

      ctx.fillStyle = isUnlocked ? COLOR_TEXT : COLOR_MUTED;
      ctx.font = `11px 'Segoe UI', system-ui, sans-serif`;
      ctx.textAlign = 'center';
      wrapText(ctx, gun.desc, cardX + cardW / 2, cardY + 158, cardW - 30, 16);

      const btnW = cardW - 28;
      const btnH = 36;
      const btnX = cardX + 14;
      const btnY = cardY + cardH - 48;

      if (isUnlocked) {
        const btnGrad = ctx.createLinearGradient(btnX, btnY, btnX, btnY + btnH);
        btnGrad.addColorStop(0, isHover ? gun.color : 'rgba(255, 255, 255, 0.12)');
        btnGrad.addColorStop(1, isHover ? gun.color : 'rgba(255, 255, 255, 0.05)');
        ctx.fillStyle = btnGrad;
        roundRect(ctx, btnX, btnY, btnW, btnH, 8);
        ctx.fill();

        ctx.strokeStyle = gun.color;
        ctx.lineWidth = 1.5;
        roundRect(ctx, btnX, btnY, btnW, btnH, 8);
        ctx.stroke();

        ctx.fillStyle = isHover ? '#000000' : '#ffffff';
        ctx.font = `bold 12px 'Segoe UI', system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillText('SELECT WEAPON', btnX + btnW / 2, btnY + btnH / 2);
      } else {
        ctx.fillStyle = 'rgba(239, 68, 68, 0.1)';
        roundRect(ctx, btnX, btnY, btnW, btnH, 8);
        ctx.fill();

        ctx.strokeStyle = 'rgba(239, 68, 68, 0.4)';
        ctx.lineWidth = 1;
        roundRect(ctx, btnX, btnY, btnW, btnH, 8);
        ctx.stroke();

        ctx.fillStyle = '#ef4444';
        ctx.font = `bold 10px 'Segoe UI', system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillText(`🔒 LOCKED (${gun.requiredScore} PTS)`, btnX + btnW / 2, btnY + btnH / 2);
      }
    }

    if (canvas) {
      canvas.style.cursor = hoveredUnlocked ? 'pointer' : 'default';
    }

    ctx.fillStyle = COLOR_MUTED;
    ctx.font = `12px 'Segoe UI', system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText('Click any unlocked weapon card to begin the boss battle', cx, cy + 245);
  }

  function wrapText(context, text, x, y, maxWidth, lineHeight) {
    const words = text.split(' ');
    let line = '';
    let currY = y;

    for (let n = 0; n < words.length; n++) {
      const testLine = line + words[n] + ' ';
      const metrics = context.measureText(testLine);
      const testWidth = metrics.width;
      if (testWidth > maxWidth && n > 0) {
        context.fillText(line.trim(), x, currY);
        line = words[n] + ' ';
        currY += lineHeight;
      } else {
        line = testLine;
      }
    }
    context.fillText(line.trim(), x, currY);
  }

  function renderBossIntro(vw, vh, dt = 1) {
    const cx = vw / 2;
    const cy = vh / 2;

    const barH = 34;
    ctx.fillStyle = '#dc2626';
    ctx.fillRect(0, 0, vw, barH);
    ctx.fillStyle = '#991b1b';
    ctx.fillRect(0, vh - barH, vw, barH);

    ctx.fillStyle = '#ffffff';
    ctx.font = `bold 14px 'Segoe UI', system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('⚠️ WARNING: HIGH-LEVEL TELEMETRY ENTITY DETECTED ⚠️', cx, barH / 2);
    ctx.fillText('⚠️ BITE ATTACK INCOMING: SHOOT DURING 1s BITE TO PARRY ⚠️', cx, vh - barH / 2);

    ctx.shadowColor = '#ea580c';
    ctx.shadowBlur = 24;
    ctx.fillStyle = '#ea580c';
    ctx.font = `bold 32px 'Segoe UI', system-ui, sans-serif`;
    ctx.fillText('GOOGLE ANALYTICS', cx, cy + 80);
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;

    ctx.fillStyle = COLOR_TEXT;
    ctx.font = `16px 'Segoe UI', system-ui, sans-serif`;
    ctx.fillText(`Health Source: 50 Base HP + (${totalAdsFound} Ads × 2) = ${bossMaxHP} HP`, cx, cy + 118);

    ctx.fillStyle = '#fbbf24';
    ctx.font = `bold 14px 'Segoe UI', system-ui, sans-serif`;
    ctx.fillText(`Equipped: ${selectedGun.name}`, cx, cy + 146);

    const pulse = 0.5 + Math.sin(frameCount * 0.12) * 0.5;
    ctx.globalAlpha = pulse;
    ctx.fillStyle = COLOR_MUTED;
    ctx.font = `13px 'Segoe UI', system-ui, sans-serif`;
    ctx.fillText('[ Click anywhere to skip intro and engage ]', cx, cy + 180);
    ctx.globalAlpha = 1;
  }

  function renderBoss(dt = 1) {
    ctx.save();
    ctx.translate(bossX, bossY);

    let scale = 1.0;
    if (bossState === 'BITING') {
      const lungeProg = 1 - Math.max(0, biteTimer / BOSS_PARRY_WINDOW_MS);
      scale = 1.0 + Math.sin(lungeProg * Math.PI) * 0.45;
    } else if (bossState === 'STUNNED') {
      scale = 0.94 + Math.sin(frameCount * 0.2) * 0.03;
    }
    ctx.scale(scale, scale);

    const s = bossSize;

    if (bossState === 'ENRAGED' || bossState === 'BITING') {
      const auraAlpha = 0.25 + Math.sin(frameCount * 0.15) * 0.15;
      ctx.fillStyle = `rgba(239, 68, 68, ${auraAlpha})`;
      ctx.beginPath();
      ctx.arc(0, 0, s * 0.72, 0, Math.PI * 2);
      ctx.fill();
    }

    const wingFlap = Math.sin(bossWingPhase) * 0.55;
    const wingW = s * 0.65;
    const wingH = s * 0.38;

    // Left Wing
    ctx.save();
    ctx.translate(-s * 0.22, -s * 0.05);
    ctx.rotate(-0.45 + wingFlap);
    const leftWingGrad = ctx.createLinearGradient(-wingW, -wingH, 0, 0);
    leftWingGrad.addColorStop(0, '#f97316');
    leftWingGrad.addColorStop(0.5, '#ea580c');
    leftWingGrad.addColorStop(1, '#1e293b');
    ctx.fillStyle = leftWingGrad;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(-wingW * 0.6, -wingH * 0.9);
    ctx.lineTo(-wingW, -wingH * 0.3);
    ctx.lineTo(-wingW * 0.8, wingH * 0.4);
    ctx.lineTo(-wingW * 0.3, wingH * 0.5);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = '#fde047';
    ctx.lineWidth = 2.5;
    ctx.stroke();
    ctx.restore();

    // Right Wing
    ctx.save();
    ctx.translate(s * 0.22, -s * 0.05);
    ctx.rotate(0.45 - wingFlap);
    const rightWingGrad = ctx.createLinearGradient(0, 0, wingW, -wingH);
    rightWingGrad.addColorStop(0, '#1e293b');
    rightWingGrad.addColorStop(0.5, '#ea580c');
    rightWingGrad.addColorStop(1, '#f97316');
    ctx.fillStyle = rightWingGrad;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(wingW * 0.6, -wingH * 0.9);
    ctx.lineTo(wingW, -wingH * 0.3);
    ctx.lineTo(wingW * 0.8, wingH * 0.4);
    ctx.lineTo(wingW * 0.3, wingH * 0.5);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = '#fde047';
    ctx.lineWidth = 2.5;
    ctx.stroke();
    ctx.restore();

    // Tail (Google Analytics 3-Bar Chart Feathers)
    const tailY = s * 0.35;
    const barWidth = 14;
    const barHeights = [28, 44, 60];
    const barColors = ['#fde047', '#f97316', '#38bdf8'];
    for (let b = 0; b < 3; b++) {
      const bx = -22 + b * 22;
      const bh = barHeights[b];
      ctx.fillStyle = barColors[b];
      roundRect(ctx, bx - barWidth / 2, tailY, barWidth, bh, 4);
      ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1;
      roundRect(ctx, bx - barWidth / 2, tailY, barWidth, bh, 4);
      ctx.stroke();
    }

    // Body
    ctx.shadowColor = 'rgba(0, 0, 0, 0.55)';
    ctx.shadowBlur = 20;
    ctx.shadowOffsetY = 6;

    const bodyGrad = ctx.createRadialGradient(0, 0, s * 0.05, 0, 0, s * 0.42);
    bodyGrad.addColorStop(0, '#f97316');
    bodyGrad.addColorStop(0.4, '#ea580c');
    bodyGrad.addColorStop(0.85, '#0f172a');
    bodyGrad.addColorStop(1, '#020617');

    ctx.fillStyle = bodyGrad;
    ctx.beginPath();
    ctx.ellipse(0, 0, s * 0.36, s * 0.44, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;

    ctx.strokeStyle = bossState === 'ENRAGED' ? '#ef4444' : '#f59e0b';
    ctx.lineWidth = 3;
    ctx.stroke();

    // Chestplate
    ctx.fillStyle = 'rgba(15, 23, 42, 0.7)';
    roundRect(ctx, -s * 0.18, -s * 0.12, s * 0.36, s * 0.26, 8);
    ctx.fill();

    const emblemH = [16, 26, 36];
    const emblemW = 8;
    for (let eb = 0; eb < 3; eb++) {
      const ebx = -16 + eb * 16;
      const ebh = emblemH[eb];
      ctx.fillStyle = barColors[eb];
      roundRect(ctx, ebx - emblemW / 2, s * 0.1 - ebh, emblemW, ebh, 3);
      ctx.fill();
    }

    // Head
    const headY = -s * 0.32;

    // Spiky evil crest protruding from back of skull
    ctx.fillStyle = '#0f172a';
    ctx.strokeStyle = '#ef4444';
    ctx.lineWidth = 2;
    const hornAngles = [-0.35, 0, 0.35];
    const hornLengths = [s * 0.18, s * 0.25, s * 0.18];
    for (let h = 0; h < 3; h++) {
      ctx.save();
      ctx.translate(0, headY);
      ctx.rotate(hornAngles[h]);
      ctx.beginPath();
      ctx.moveTo(-s * 0.05, 0);
      ctx.lineTo(0, -hornLengths[h]);
      ctx.lineTo(s * 0.05, 0);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }

    ctx.fillStyle = '#090d16';
    ctx.beginPath();
    ctx.ellipse(0, headY, s * 0.23, s * 0.21, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#dc2626';
    ctx.lineWidth = 2.5;
    ctx.stroke();

    // Demonic Evil Eye
    const eyeX = 0;
    const eyeY = headY - 4;
    ctx.shadowColor = '#ef4444';
    ctx.shadowBlur = 18;
    ctx.fillStyle = '#ef4444';
    ctx.beginPath();
    ctx.arc(eyeX, eyeY, 11, 0, Math.PI * 2);
    ctx.fill();

    // Sinister vertical slit pupil
    ctx.fillStyle = '#fde047';
    ctx.beginPath();
    ctx.ellipse(eyeX, eyeY, 3, 9, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(eyeX, eyeY, 1.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;

    // Beak & Wicked Evil Fangs
    const beakY = headY + 16;
    if (bossState === 'BITING') {
      // Jaws wide open with sharp jagged serrated fangs
      ctx.fillStyle = '#991b1b';
      ctx.beginPath();
      ctx.moveTo(-18, beakY);
      ctx.lineTo(0, beakY + 34);
      ctx.lineTo(18, beakY);
      ctx.closePath();
      ctx.fill();

      ctx.fillStyle = '#7f1d1d';
      ctx.beginPath();
      ctx.moveTo(-16, beakY + 14);
      ctx.lineTo(0, beakY + 52);
      ctx.lineTo(16, beakY + 14);
      ctx.closePath();
      ctx.fill();

      // Sharp upper fangs
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = '#ef4444';
      ctx.lineWidth = 1;
      const upperFangX = [-12, -4, 4, 12];
      for (const fx of upperFangX) {
        ctx.beginPath();
        ctx.moveTo(fx - 3, beakY + 8);
        ctx.lineTo(fx, beakY + 28);
        ctx.lineTo(fx + 3, beakY + 8);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }

      // Sharp lower fangs pointing UP
      const lowerFangX = [-8, 0, 8];
      for (const fx of lowerFangX) {
        ctx.beginPath();
        ctx.moveTo(fx - 3, beakY + 48);
        ctx.lineTo(fx, beakY + 28);
        ctx.lineTo(fx + 3, beakY + 48);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }
    } else if (bossState === 'STUNNED') {
      ctx.fillStyle = '#b45309';
      ctx.beginPath();
      ctx.moveTo(-15, beakY);
      ctx.lineTo(0, beakY + 28);
      ctx.lineTo(15, beakY);
      ctx.closePath();
      ctx.fill();

      // Exposed drooped fangs
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.moveTo(-10, beakY + 8);
      ctx.lineTo(-7, beakY + 22);
      ctx.lineTo(-4, beakY + 8);
      ctx.closePath();
      ctx.fill();

      ctx.beginPath();
      ctx.moveTo(4, beakY + 8);
      ctx.lineTo(7, beakY + 22);
      ctx.lineTo(10, beakY + 8);
      ctx.closePath();
      ctx.fill();
    } else {
      // Menacing predator beak with visible sharp fangs
      ctx.fillStyle = '#ea580c';
      ctx.beginPath();
      ctx.moveTo(-16, beakY);
      ctx.lineTo(0, beakY + 32);
      ctx.lineTo(16, beakY);
      ctx.closePath();
      ctx.fill();

      ctx.strokeStyle = '#9a3412';
      ctx.lineWidth = 2;
      ctx.stroke();

      // Two large wicked curved ivory fangs protruding from upper jaw
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = '#ef4444';
      ctx.lineWidth = 1;

      // Left curved fang
      ctx.beginPath();
      ctx.moveTo(-12, beakY + 12);
      ctx.quadraticCurveTo(-14, beakY + 24, -9, beakY + 35);
      ctx.quadraticCurveTo(-7, beakY + 22, -6, beakY + 12);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      // Right curved fang
      ctx.beginPath();
      ctx.moveTo(6, beakY + 12);
      ctx.quadraticCurveTo(7, beakY + 22, 9, beakY + 35);
      ctx.quadraticCurveTo(14, beakY + 24, 12, beakY + 12);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      // Interlocking lower fangs
      ctx.fillStyle = '#f8fafc';
      ctx.beginPath();
      ctx.moveTo(-4, beakY + 30);
      ctx.lineTo(-1, beakY + 22);
      ctx.lineTo(2, beakY + 30);
      ctx.closePath();
      ctx.fill();
    }

    // Stunned stars
    if (bossState === 'STUNNED') {
      for (let st = 0; st < 3; st++) {
        const starAngle = frameCount * 0.08 + (st * Math.PI * 2) / 3;
        const sx = Math.cos(starAngle) * (s * 0.38);
        const sy = headY - 26 + Math.sin(starAngle) * 14;
        ctx.fillStyle = '#fbbf24';
        ctx.font = 'bold 22px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('★', sx, sy);
      }
    }

    // Bite countdown arc
    if (bossState === 'BITING') {
      const remainingProgress = Math.max(0, biteTimer / BOSS_PARRY_WINDOW_MS);

      ctx.strokeStyle = 'rgba(239, 68, 68, 0.3)';
      ctx.lineWidth = 8;
      ctx.beginPath();
      ctx.arc(0, 0, s * 0.65, 0, Math.PI * 2);
      ctx.stroke();

      ctx.strokeStyle = '#ef4444';
      ctx.lineWidth = 8;
      ctx.beginPath();
      ctx.arc(0, 0, s * 0.65, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * remainingProgress);
      ctx.stroke();

      ctx.shadowColor = '#ef4444';
      ctx.shadowBlur = 16;
      ctx.fillStyle = '#ef4444';
      ctx.font = `bold 16px 'Segoe UI', system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText(`⚔️ SHOOT TO PARRY! (${(biteTimer / 1000).toFixed(1)}s)`, 0, -s * 0.58);
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;
    }

    ctx.fillStyle = '#ffffff';
    ctx.font = `bold 12px 'Segoe UI', system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText('GOOGLE ANALYTICS', 0, s * 0.58);

    ctx.restore();
  }

  function renderBossHUD(vw, vh) {
    const padding = 14;
    const barH = 50;

    ctx.fillStyle = 'rgba(20, 20, 35, 0.75)';
    ctx.fillRect(0, 0, vw, barH);

    const borderGrad = ctx.createLinearGradient(0, 0, vw, 0);
    borderGrad.addColorStop(0, 'rgba(234, 88, 12, 0)');
    borderGrad.addColorStop(0.3, '#f97316');
    borderGrad.addColorStop(0.7, '#f97316');
    borderGrad.addColorStop(1, 'rgba(234, 88, 12, 0)');
    ctx.fillStyle = borderGrad;
    ctx.fillRect(0, barH - 2, vw, 2);

    ctx.textBaseline = 'middle';
    const cy = barH / 2;

    // Left badge
    ctx.fillStyle = 'rgba(234, 88, 12, 0.2)';
    roundRect(ctx, padding, cy - 13, 140, 26, 13);
    ctx.fill();
    ctx.strokeStyle = '#f97316';
    ctx.lineWidth = 1;
    roundRect(ctx, padding, cy - 13, 140, 26, 13);
    ctx.stroke();

    ctx.fillStyle = '#f97316';
    ctx.font = `bold 12px 'Segoe UI', system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText('⚔️ STAGE 2: BOSS', padding + 70, cy);

    // Weapon Pill
    const wPillX = padding + 152;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.06)';
    roundRect(ctx, wPillX, cy - 13, 140, 26, 13);
    ctx.fill();

    ctx.fillStyle = selectedGun ? selectedGun.color : '#ffffff';
    ctx.font = `bold 11px 'Segoe UI', system-ui, sans-serif`;
    ctx.fillText(selectedGun ? selectedGun.name : 'PISTOL', wPillX + 70, cy);

    // Center Boss HP Bar
    const hpBarW = Math.min(vw * 0.42, 440);
    const hpBarH = 18;
    const hpBarX = vw / 2 - hpBarW / 2;
    const hpBarY = cy - hpBarH / 2;

    ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
    roundRect(ctx, hpBarX, hpBarY, hpBarW, hpBarH, 9);
    ctx.fill();

    const hpRatio = Math.max(0, Math.min(1, bossSmoothHP / bossMaxHP));
    const fillW = Math.max(8, hpBarW * hpRatio);
    const barColor = hpRatio > 0.5 ? '#10b981' : hpRatio > 0.25 ? '#f59e0b' : '#ef4444';
    ctx.fillStyle = barColor;
    roundRect(ctx, hpBarX, hpBarY, fillW, hpBarH, 9);
    ctx.fill();

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
    ctx.lineWidth = 1.5;
    roundRect(ctx, hpBarX, hpBarY, hpBarW, hpBarH, 9);
    ctx.stroke();

    ctx.fillStyle = '#ffffff';
    ctx.font = `bold 11px 'Segoe UI', system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText(`🦅 GOOGLE ANALYTICS: ${Math.max(0, bossHP)} / ${bossMaxHP} HP  |  ⚠️ BITE: ${bossBiteDamage} DMG`, vw / 2, cy);

    // Right: Player HP & Score
    const pHealthX = vw - padding - 180;
    ctx.fillStyle = '#ffffff';
    ctx.font = `bold 13px 'Segoe UI', system-ui, sans-serif`;
    ctx.textAlign = 'left';
    ctx.fillText(`❤️ ${playerHealth} / 10`, pHealthX, cy);

    ctx.fillStyle = COLOR_GREEN;
    ctx.font = `bold 14px 'Segoe UI', system-ui, sans-serif`;
    ctx.fillText(`🎯 ${score.toLocaleString()}`, pHealthX + 75, cy);

    ctx.fillStyle = COLOR_MUTED;
    ctx.font = `10px 'Segoe UI', system-ui, sans-serif`;
    ctx.textAlign = 'right';
    ctx.fillText('[ESC]', vw - padding, cy);
  }

  function renderBossCrosshair() {
    const r = CROSSHAIR_SIZE + 4;
    const wColor = selectedGun ? selectedGun.color : '#00e5ff';

    ctx.save();
    ctx.translate(mouseX, mouseY);
    ctx.rotate(frameCount * 0.02);
    ctx.strokeStyle = wColor;
    ctx.lineWidth = 1.5;
    ctx.globalAlpha = 0.45;
    ctx.beginPath();
    ctx.arc(0, 0, r + 8, 0, Math.PI * 2);
    ctx.stroke();
    for (let i = 0; i < 8; i++) {
      const angle = (Math.PI * 2 * i) / 8;
      ctx.beginPath();
      ctx.moveTo(Math.cos(angle) * (r + 5), Math.sin(angle) * (r + 5));
      ctx.lineTo(Math.cos(angle) * (r + 11), Math.sin(angle) * (r + 11));
      ctx.stroke();
    }
    ctx.restore();

    ctx.strokeStyle = wColor;
    ctx.lineWidth = 2;
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    ctx.arc(mouseX, mouseY, r, 0, Math.PI * 2);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(mouseX - r - 8, mouseY);
    ctx.lineTo(mouseX - r / 2.5, mouseY);
    ctx.moveTo(mouseX + r / 2.5, mouseY);
    ctx.lineTo(mouseX + r + 8, mouseY);
    ctx.moveTo(mouseX, mouseY - r - 8);
    ctx.lineTo(mouseX, mouseY - r / 2.5);
    ctx.moveTo(mouseX, mouseY + r / 2.5);
    ctx.lineTo(mouseX, mouseY + r + 8);
    ctx.stroke();

    ctx.fillStyle = wColor;
    ctx.beginPath();
    ctx.arc(mouseX, mouseY, 3, 0, Math.PI * 2);
    ctx.fill();

    if (gunCooldownTimer > 0 && selectedGun) {
      const maxCd = selectedGun.fireRateMs / 16.667;
      const progress = 1 - Math.max(0, gunCooldownTimer / maxCd);
      ctx.strokeStyle = '#fbbf24';
      ctx.lineWidth = 3.5;
      ctx.globalAlpha = 0.8;
      ctx.beginPath();
      ctx.arc(mouseX, mouseY, r + 15, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * progress);
      ctx.stroke();
    }

    ctx.globalAlpha = 0.6;
    ctx.fillStyle = wColor;
    ctx.font = `bold 9px 'Segoe UI', system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(selectedGun ? selectedGun.shortName : 'PISTOL', mouseX, mouseY + r + 14);
    ctx.globalAlpha = 1;
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

    // Draw body (texture with drop shadow)
    ctx.shadowColor = 'rgba(0, 0, 0, 0.5)';
    ctx.shadowBlur = 12;
    ctx.shadowOffsetX = 4;
    ctx.shadowOffsetY = 6;

    ctx.drawImage(
      bird.texture,
      -bird.size / 2, -bird.size / 2,
      bird.size, bird.size
    );

    // Reset shadow
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;

    // Pulsing glow ring for special birds
    if (bird.type === 'shiny') {
      const glowAlpha = 0.3 + Math.sin(frameCount * 0.08) * 0.2;
      ctx.globalAlpha = glowAlpha;
      ctx.strokeStyle = '#fbbf24';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(0, 0, bird.size * 0.6, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    } else if (bird.type === 'red_flasher') {
      const glowAlpha = 0.4 + Math.sin(frameCount * 0.12) * 0.3;
      ctx.globalAlpha = glowAlpha;
      ctx.strokeStyle = '#f87171';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(0, 0, bird.size * 0.6, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    ctx.restore();
  }

  function renderCrosshair() {
    const r = CROSSHAIR_SIZE;
    const weaponColor = currentWeapon === 'magnum' ? '#f87171'
                      : currentWeapon === 'shotgun' ? '#fb923c'
                      : COLOR_GREEN;

    // Outer rotating ring with tick marks
    ctx.save();
    ctx.translate(mouseX, mouseY);
    ctx.rotate(frameCount * 0.015);
    ctx.strokeStyle = weaponColor;
    ctx.lineWidth = 1.5;
    ctx.globalAlpha = 0.4;
    ctx.beginPath();
    ctx.arc(0, 0, r + 8, 0, Math.PI * 2);
    ctx.stroke();
    for (let i = 0; i < 8; i++) {
      const angle = (Math.PI * 2 * i) / 8;
      ctx.beginPath();
      ctx.moveTo(Math.cos(angle) * (r + 5), Math.sin(angle) * (r + 5));
      ctx.lineTo(Math.cos(angle) * (r + 11), Math.sin(angle) * (r + 11));
      ctx.stroke();
    }
    ctx.restore();

    // Inner static circle
    ctx.strokeStyle = weaponColor;
    ctx.lineWidth = 2;
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    ctx.arc(mouseX, mouseY, r, 0, Math.PI * 2);
    ctx.stroke();

    // Crosshair lines (gap in center)
    ctx.beginPath();
    ctx.moveTo(mouseX - r - 8, mouseY);
    ctx.lineTo(mouseX - r / 2.5, mouseY);
    ctx.moveTo(mouseX + r / 2.5, mouseY);
    ctx.lineTo(mouseX + r + 8, mouseY);
    ctx.moveTo(mouseX, mouseY - r - 8);
    ctx.lineTo(mouseX, mouseY - r / 2.5);
    ctx.moveTo(mouseX, mouseY + r / 2.5);
    ctx.lineTo(mouseX, mouseY + r + 8);
    ctx.stroke();

    // Center dot (pulsing)
    const dotPulse = 2.5 + Math.sin(frameCount * 0.1) * 0.8;
    ctx.fillStyle = weaponColor;
    ctx.beginPath();
    ctx.arc(mouseX, mouseY, dotPulse, 0, Math.PI * 2);
    ctx.fill();

    // Reload arc indicator
    if (reloadTimer > 0) {
      const w = WEAPONS[currentWeapon];
      const progress = 1 - (reloadTimer / w.reloadTime);
      ctx.strokeStyle = '#fbbf24';
      ctx.lineWidth = 3;
      ctx.globalAlpha = 0.7;
      ctx.beginPath();
      ctx.arc(mouseX, mouseY, r + 15, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * progress);
      ctx.stroke();
    }

    // Weapon icon label below crosshair
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = weaponColor;
    ctx.font = `bold 9px 'Segoe UI', system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const icon = currentWeapon === 'magnum' ? '⚡MAG' : currentWeapon === 'shotgun' ? '◉SHG' : '◎SNP';
    ctx.fillText(icon, mouseX, mouseY + r + 14);

    ctx.globalAlpha = 1;
  }

  function renderHUD(vw, vh) {
    const padding = 14;
    const barH = 48;

    // ── Glassmorphism background ──
    ctx.fillStyle = 'rgba(20, 20, 35, 0.65)';
    ctx.fillRect(0, 0, vw, barH);

    // Subtle gradient highlight on top edge
    const hudGrad = ctx.createLinearGradient(0, 0, 0, barH);
    hudGrad.addColorStop(0, 'rgba(124, 106, 255, 0.12)');
    hudGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = hudGrad;
    ctx.fillRect(0, 0, vw, barH);

    // Bottom border — glowing accent line
    const borderGrad = ctx.createLinearGradient(0, 0, vw, 0);
    borderGrad.addColorStop(0, 'rgba(124, 106, 255, 0)');
    borderGrad.addColorStop(0.3, COLOR_ACCENT);
    borderGrad.addColorStop(0.7, COLOR_ACCENT);
    borderGrad.addColorStop(1, 'rgba(124, 106, 255, 0)');
    ctx.fillStyle = borderGrad;
    ctx.fillRect(0, barH - 2, vw, 2);

    ctx.textBaseline = 'middle';
    const cy = barH / 2;
    let xCursor = padding;

    // ── Score with icon ──
    ctx.fillStyle = COLOR_GREEN;
    ctx.font = `bold 16px 'Segoe UI', system-ui, sans-serif`;
    ctx.textAlign = 'left';
    ctx.fillText(`🎯 ${score.toLocaleString()}`, xCursor, cy);
    xCursor += ctx.measureText(`🎯 ${score.toLocaleString()}`).width + 20;

    // ── Combo badge (pill-shaped) ──
    const multiplier = getComboMultiplier();
    if (multiplier > 1) {
      const comboPillW = 65;
      const comboPillH = 22;
      const comboPillY = cy - comboPillH / 2;
      // Pill bg
      ctx.fillStyle = 'rgba(245, 158, 11, 0.2)';
      roundRect(ctx, xCursor, comboPillY, comboPillW, comboPillH, 11);
      ctx.fill();
      ctx.strokeStyle = COLOR_AMBER;
      ctx.lineWidth = 1;
      roundRect(ctx, xCursor, comboPillY, comboPillW, comboPillH, 11);
      ctx.stroke();
      // Pill text
      ctx.fillStyle = COLOR_AMBER;
      ctx.font = `bold 12px 'Segoe UI', system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText(`×${multiplier} 🔥`, xCursor + comboPillW / 2, cy);
      xCursor += comboPillW + 14;
    }

    // ── Center: Birds remaining ──
    ctx.fillStyle = COLOR_TEXT;
    ctx.font = `13px 'Segoe UI', system-ui, sans-serif`;
    ctx.textAlign = 'center';
    let centerText = `🐦 ${birdsHit}/${totalBirds}`;
    if (shotsMissed > 0) centerText += `  ❌ ${shotsMissed}`;
    if (multikillCount > 0) centerText += `  ⚡ ${multikillCount}`;
    ctx.fillText(centerText, vw / 2, cy);

    // ── Health bar (right side) ──
    const hpBarW = 100;
    const hpBarH = 10;
    const hpBarX = vw - padding - hpBarW - 130;
    const hpBarY = cy - hpBarH / 2;
    const hpPct = playerHealth / MAX_HEALTH;

    // HP Background
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    roundRect(ctx, hpBarX, hpBarY, hpBarW, hpBarH, 5);
    ctx.fill();
    // HP Fill (green → amber → red)
    const hpColor = hpPct > 0.6 ? COLOR_GREEN : hpPct > 0.3 ? COLOR_AMBER : COLOR_RED;
    ctx.fillStyle = hpColor;
    roundRect(ctx, hpBarX, hpBarY, hpBarW * hpPct, hpBarH, 5);
    ctx.fill();
    // HP Label
    ctx.fillStyle = COLOR_TEXT;
    ctx.font = `bold 10px 'Segoe UI', system-ui, sans-serif`;
    ctx.textAlign = 'right';
    ctx.fillText(`❤️ ${playerHealth}`, hpBarX - 6, cy);

    // ── Weapon slots (right edge) ──
    const slotSize = 26;
    const slotGap = 4;
    const slotsX = vw - padding - (slotSize + slotGap) * 3 - 40;

    WEAPON_ORDER.forEach((wName, i) => {
      const sx = slotsX + i * (slotSize + slotGap);
      const sy = cy - slotSize / 2;
      const isActive = wName === currentWeapon;

      // Slot background
      ctx.fillStyle = isActive ? 'rgba(124, 106, 255, 0.3)' : 'rgba(255,255,255,0.05)';
      roundRect(ctx, sx, sy, slotSize, slotSize, 4);
      ctx.fill();
      if (isActive) {
        ctx.strokeStyle = COLOR_ACCENT;
        ctx.lineWidth = 1.5;
        roundRect(ctx, sx, sy, slotSize, slotSize, 4);
        ctx.stroke();
      }
      // Slot icon
      ctx.fillStyle = isActive ? '#fff' : COLOR_MUTED;
      ctx.font = `${isActive ? 'bold ' : ''}10px 'Segoe UI', system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const wIcon = wName === 'sniper' ? '◎' : wName === 'shotgun' ? '◉' : '⚡';
      ctx.fillText(wIcon, sx + slotSize / 2, cy);
    });

    // ── Ammo pips under weapon slots ──
    if (currentWeapon !== 'sniper') {
      const w = WEAPONS[currentWeapon];
      const pipR = 2.5;
      const pipGap = 7;
      const totalPipW = w.maxAmmo * pipGap;
      const pipStartX = slotsX + ((slotSize + slotGap) * 3 - totalPipW) / 2 + pipR;
      for (let i = 0; i < w.maxAmmo; i++) {
        const filled = i < ammo[currentWeapon];
        ctx.fillStyle = filled ? COLOR_AMBER : 'rgba(255,255,255,0.12)';
        ctx.beginPath();
        ctx.arc(pipStartX + i * pipGap, barH + 8, pipR, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // ── ESC hint (far right) ──
    ctx.fillStyle = COLOR_MUTED;
    ctx.font = `10px 'Segoe UI', system-ui, sans-serif`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText('[ESC]', vw - padding, cy);
  }

  function renderLoadingScreen(vw, vh, dt = 1) {
    // Full dark background with vignette
    ctx.fillStyle = '#0a0a14';
    ctx.fillRect(0, 0, vw, vh);

    // Radial vignette
    const vigGrad = ctx.createRadialGradient(vw / 2, vh / 2, 0, vw / 2, vh / 2, vw * 0.7);
    vigGrad.addColorStop(0, 'rgba(30, 20, 60, 0.3)');
    vigGrad.addColorStop(1, 'rgba(0, 0, 0, 0.6)');
    ctx.fillStyle = vigGrad;
    ctx.fillRect(0, 0, vw, vh);

    const cx = vw / 2;
    const cy = vh / 2;

    // ── Pulsing scope rings ──
    loadingAngle += 0.04 * dt;
    const pulse = Math.sin(loadingAngle * 2) * 0.15 + 0.85;

    // Outer ring (slow rotate)
    ctx.save();
    ctx.translate(cx, cy - 70);
    ctx.rotate(loadingAngle * 0.5);
    ctx.strokeStyle = 'rgba(52, 211, 153, 0.2)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(0, 0, 55, 0, Math.PI * 2);
    ctx.stroke();
    // Tick marks
    for (let i = 0; i < 12; i++) {
      const a = (Math.PI * 2 * i) / 12;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * 50, Math.sin(a) * 50);
      ctx.lineTo(Math.cos(a) * 55, Math.sin(a) * 55);
      ctx.stroke();
    }
    ctx.restore();

    // Main spinner arc
    ctx.save();
    ctx.translate(cx, cy - 70);
    ctx.rotate(loadingAngle);
    ctx.strokeStyle = COLOR_GREEN;
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(0, 0, 35 * pulse, 0, Math.PI * 1.4);
    ctx.stroke();
    ctx.restore();

    // Center scope dot
    ctx.fillStyle = COLOR_GREEN;
    ctx.globalAlpha = 0.5 + Math.sin(loadingAngle * 3) * 0.3;
    ctx.beginPath();
    ctx.arc(cx, cy - 70, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;

    // ── Title with glow ──
    ctx.shadowColor = COLOR_GREEN;
    ctx.shadowBlur = 20;
    ctx.fillStyle = COLOR_GREEN;
    ctx.font = `bold 28px 'Segoe UI', system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('🔫 SNIPING MODE', cx, cy + 10);
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;

    // ── Subtitle ──
    ctx.fillStyle = COLOR_TEXT;
    ctx.font = `14px 'Segoe UI', system-ui, sans-serif`;
    ctx.globalAlpha = 0.7 + Math.sin(loadingAngle * 1.5) * 0.3;
    ctx.fillText(loadingMessage, cx, cy + 48);
    ctx.globalAlpha = 1;

    // ── Animated progress bar with glow ──
    const barW = 340;
    const barH = 8;
    const barX = cx - barW / 2;
    const barY = cy + 75;

    // Track
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    roundRect(ctx, barX, barY, barW, barH, 4);
    ctx.fill();

    // Fill with gradient
    const progressW = barW * loadingProgress;
    if (progressW > 0) {
      const pGrad = ctx.createLinearGradient(barX, 0, barX + progressW, 0);
      pGrad.addColorStop(0, '#34d399');
      pGrad.addColorStop(1, '#6ee7b7');
      ctx.fillStyle = pGrad;
      roundRect(ctx, barX, barY, progressW, barH, 4);
      ctx.fill();

      // Glow on leading edge
      ctx.shadowColor = COLOR_GREEN;
      ctx.shadowBlur = 10;
      ctx.fillStyle = '#6ee7b7';
      ctx.beginPath();
      ctx.arc(barX + progressW, barY + barH / 2, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;
    }

    // ── Percentage text ──
    ctx.fillStyle = COLOR_MUTED;
    ctx.font = `11px 'Segoe UI', system-ui, sans-serif`;
    ctx.fillText(`${Math.round(loadingProgress * 100)}%`, cx, barY + barH + 18);
  }

  function renderGameOver(vw, vh, dt = 1) {
    gameOverAlpha = Math.min(1, gameOverAlpha + 0.02 * dt);

    const cx = vw / 2;
    const cy = vh / 2;

    const totalShots = birdsHit + shotsMissed;
    const accuracy = totalShots > 0 ? Math.round((birdsHit / totalShots) * 100) : (totalBirds > 0 ? 0 : 100);
    const isHighAccuracy = accuracy > 80;

    // Dark backdrop overlay
    ctx.globalAlpha = gameOverAlpha * 0.88;
    ctx.fillStyle = 'rgba(15, 15, 23, 0.92)';
    ctx.fillRect(0, 0, vw, vh);

    // Render celebratory fireworks around results if accuracy > 80% or boss defeated
    if (isHighAccuracy || bossDefeated) {
      renderFireworks();
    }

    ctx.globalAlpha = gameOverAlpha;

    // If Stage 2 was reached or Boss defeated, show dual-stage breakdown
    if (currentStage === 2 || bossDefeated) {
      const cardW = 540;
      const cardH = 480;

      ctx.shadowColor = 'rgba(0, 0, 0, 0.5)';
      ctx.shadowBlur = 30;
      ctx.shadowOffsetY = 8;

      ctx.fillStyle = COLOR_HUD_BG;
      roundRect(ctx, cx - cardW / 2, cy - cardH / 2, cardW, cardH, 16);
      ctx.fill();

      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;

      ctx.strokeStyle = bossDefeated ? '#fbbf24' : '#ef4444';
      ctx.lineWidth = 2.5;
      roundRect(ctx, cx - cardW / 2, cy - cardH / 2, cardW, cardH, 16);
      ctx.stroke();

      ctx.fillStyle = bossDefeated ? '#fbbf24' : '#ef4444';
      ctx.font = `bold 24px 'Segoe UI', system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const titleText = bossDefeated ? '🏆 VICTORY: GOOGLE ANALYTICS PURGED! 🏆' : '💀 DEFEAT: TELEMETRY TRIUMPHED';
      ctx.fillText(titleText, cx, cy - 205);

      ctx.fillStyle = COLOR_TEXT;
      ctx.font = `bold 20px 'Segoe UI', system-ui, sans-serif`;
      ctx.fillText(`Combined Score: ${score.toLocaleString()} PTS`, cx, cy - 170);

      // Stage 1 Summary Box
      ctx.fillStyle = 'rgba(255, 255, 255, 0.03)';
      roundRect(ctx, cx - 240, cy - 145, 480, 80, 10);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
      ctx.lineWidth = 1;
      roundRect(ctx, cx - 240, cy - 145, 480, 80, 10);
      ctx.stroke();

      ctx.fillStyle = '#38bdf8';
      ctx.font = `bold 13px 'Segoe UI', system-ui, sans-serif`;
      ctx.textAlign = 'left';
      ctx.fillText('── STAGE 1: AD TARGET SWARM ──', cx - 225, cy - 128);

      ctx.font = `12px 'Segoe UI', system-ui, sans-serif`;
      ctx.fillStyle = COLOR_MUTED;
      ctx.fillText(`Birds Vaporized:`, cx - 225, cy - 104);
      ctx.fillStyle = COLOR_TEXT;
      ctx.fillText(`${stage1BirdsHit || birdsHit} / ${stage1TotalBirds || totalBirds}`, cx - 110, cy - 104);

      ctx.fillStyle = COLOR_MUTED;
      ctx.fillText(`Accuracy:`, cx - 225, cy - 80);
      ctx.fillStyle = accuracy >= 80 ? COLOR_GREEN : COLOR_AMBER;
      ctx.fillText(`${accuracy}%`, cx - 110, cy - 80);

      ctx.fillStyle = COLOR_MUTED;
      ctx.fillText(`Best Combo:`, cx + 30, cy - 104);
      ctx.fillStyle = COLOR_AMBER;
      ctx.fillText(`×${Math.max(1, bestCombo)} 🔥`, cx + 130, cy - 104);

      ctx.fillStyle = COLOR_MUTED;
      ctx.fillText(`Stage 1 Score:`, cx + 30, cy - 80);
      ctx.fillStyle = COLOR_GREEN;
      ctx.fillText(`${stage1Score.toLocaleString()} PTS`, cx + 130, cy - 80);

      // Stage 2 Boss Summary Box
      ctx.fillStyle = 'rgba(255, 255, 255, 0.03)';
      roundRect(ctx, cx - 240, cy - 50, 480, 110, 10);
      ctx.fill();
      ctx.strokeStyle = 'rgba(234, 88, 12, 0.3)';
      roundRect(ctx, cx - 240, cy - 50, 480, 110, 10);
      ctx.stroke();

      ctx.fillStyle = '#f97316';
      ctx.font = `bold 13px 'Segoe UI', system-ui, sans-serif`;
      ctx.fillText('── STAGE 2: GOOGLE ANALYTICS BOSS ──', cx - 225, cy - 30);

      ctx.font = `12px 'Segoe UI', system-ui, sans-serif`;
      ctx.fillStyle = COLOR_MUTED;
      ctx.fillText(`Boss Status:`, cx - 225, cy - 4);
      ctx.fillStyle = bossDefeated ? COLOR_GREEN : COLOR_RED;
      ctx.fillText(bossDefeated ? `SLAIN (0 / ${bossMaxHP} HP)` : `ALIVE (${Math.max(0, bossHP)} / ${bossMaxHP} HP)`, cx - 110, cy - 4);

      ctx.fillStyle = COLOR_MUTED;
      ctx.fillText(`Weapon Chosen:`, cx - 225, cy + 20);
      ctx.fillStyle = selectedGun ? selectedGun.color : COLOR_TEXT;
      ctx.fillText(selectedGun ? selectedGun.name : 'PISTOL', cx - 110, cy + 20);

      ctx.fillStyle = COLOR_MUTED;
      ctx.fillText(`Parries Executed:`, cx + 30, cy - 4);
      ctx.fillStyle = '#fbbf24';
      ctx.font = `bold 12px 'Segoe UI', system-ui, sans-serif`;
      ctx.fillText(`${parriesLanded} ⚔️`, cx + 150, cy - 4);

      ctx.font = `12px 'Segoe UI', system-ui, sans-serif`;
      ctx.fillStyle = COLOR_MUTED;
      ctx.fillText(`Bite Damage Taken:`, cx + 30, cy + 20);
      ctx.fillStyle = bossDamageTaken === 0 ? COLOR_GREEN : COLOR_RED;
      ctx.fillText(`${bossDamageTaken} HP`, cx + 150, cy + 20);

      // Quit Game Button
      const btnW = 180;
      const btnH = 40;
      const btnX = cx - btnW / 2;
      const btnY = cy + 130;
      quitButtonBounds = { x: btnX, y: btnY, w: btnW, h: btnH };

      const isHover = mouseX >= btnX && mouseX <= btnX + btnW &&
                      mouseY >= btnY && mouseY <= btnY + btnH;

      if (canvas) {
        canvas.style.cursor = isHover ? 'pointer' : 'default';
      }

      const btnGrad = ctx.createLinearGradient(btnX, btnY, btnX, btnY + btnH);
      btnGrad.addColorStop(0, isHover ? '#ef4444' : '#dc2626');
      btnGrad.addColorStop(1, isHover ? '#dc2626' : '#991b1b');
      ctx.fillStyle = btnGrad;
      roundRect(ctx, btnX, btnY, btnW, btnH, 10);
      ctx.fill();

      ctx.strokeStyle = isHover ? '#fca5a5' : '#f87171';
      ctx.lineWidth = 1.5;
      roundRect(ctx, btnX, btnY, btnW, btnH, 10);
      ctx.stroke();

      ctx.fillStyle = '#ffffff';
      ctx.font = `bold 15px 'Segoe UI', system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('🚪 Quit Game', cx, btnY + btnH / 2);

      ctx.fillStyle = COLOR_MUTED;
      ctx.font = `11px 'Segoe UI', system-ui, sans-serif`;
      ctx.fillText('or press [ESC]', cx, btnY + btnH + 16);

      ctx.globalAlpha = 1;
      return;
    }

    const cardW = 500;
    const cardH = 430;

    // Card drop shadow
    ctx.shadowColor = 'rgba(0, 0, 0, 0.5)';
    ctx.shadowBlur = 30;
    ctx.shadowOffsetY = 8;

    // Card background
    ctx.fillStyle = COLOR_HUD_BG;
    roundRect(ctx, cx - cardW / 2, cy - cardH / 2, cardW, cardH, 16);
    ctx.fill();

    // Reset shadow
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;

    // Glass highlight stripe across top of card
    const glassGrad = ctx.createLinearGradient(cx - cardW / 2, cy - cardH / 2, cx + cardW / 2, cy - cardH / 2 + 60);
    glassGrad.addColorStop(0, 'rgba(255,255,255,0)');
    glassGrad.addColorStop(0.5, 'rgba(255,255,255,0.05)');
    glassGrad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = glassGrad;
    roundRect(ctx, cx - cardW / 2, cy - cardH / 2, cardW, 60, 16);
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

    // Stats Grid with Pill Backgrounds
    ctx.font = `14px 'Segoe UI', system-ui, sans-serif`;

    const statRows = [-70, -40, -10, 20];
    for (const rY of statRows) {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.03)';
      roundRect(ctx, cx - 195, cy + rY - 11, 185, 22, 6);
      ctx.fill();
      roundRect(ctx, cx + 18, cy + rY - 11, 185, 22, 6);
      ctx.fill();
    }

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

    // Gradient button background
    const btnGrad = ctx.createLinearGradient(btnX, btnY, btnX, btnY + btnH);
    btnGrad.addColorStop(0, isHover ? '#ef4444' : '#dc2626');
    btnGrad.addColorStop(1, isHover ? '#dc2626' : '#991b1b');
    ctx.fillStyle = btnGrad;
    roundRect(ctx, btnX, btnY, btnW, btnH, 10);
    ctx.fill();

    // Subtle inner highlight
    ctx.fillStyle = 'rgba(255, 255, 255, 0.12)';
    roundRect(ctx, btnX + 2, btnY + 2, btnW - 4, btnH / 2 - 2, 8);
    ctx.fill();

    // Button Border
    ctx.strokeStyle = isHover ? '#fca5a5' : '#f87171';
    ctx.lineWidth = 1.5;
    roundRect(ctx, btnX, btnY, btnW, btnH, 10);
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

  function gameLoop(timestamp) {
    // Compute normalized delta-time (dt = 1.0 at 60 FPS / 16.667ms per frame)
    let dt = 1.0;
    if (typeof timestamp === 'number') {
      if (lastFrameTime > 0) {
        const elapsed = timestamp - lastFrameTime;
        // Clamp dt between 0.1 and 3.0 to prevent physics breakdown on huge lags / background tab restore
        dt = Math.min(Math.max(elapsed / 16.667, 0.1), 3.0);
      }
      lastFrameTime = timestamp;
    }
    frameCount++;

    // Ensure canvas stays full screen without thrashing on fractional Retina viewports
    if (canvas) {
      const targetW = Math.round(window.innerWidth);
      const targetH = Math.round(window.innerHeight);
      if (Math.abs(canvas.width - targetW) > 1 || Math.abs(canvas.height - targetH) > 1) {
        canvas.width = targetW;
        canvas.height = targetH;
      }
    }

    if (gameState === 'PLAYING') {
      updateBirds(dt);
      updateParticles(dt);
      updateClouds(canvas.width, dt);

      // Auto-decay combo
      if (combo > 0 && Date.now() - lastHitTime > COMBO_DECAY_MS) {
        combo = 0;
      }
    } else if (gameState === 'STAGE_CLEAR') {
      updateParticles(dt);
      updateClouds(canvas.width, dt);
      stageClearTimer -= dt;
      if (stageClearTimer <= 0) {
        gameState = 'GUN_SELECT';
      }
    } else if (gameState === 'GUN_SELECT') {
      updateParticles(dt);
      updateClouds(canvas.width, dt);
    } else if (gameState === 'BOSS_INTRO') {
      updateParticles(dt);
      updateClouds(canvas.width, dt);
      updateBossIntro(dt);
    } else if (gameState === 'BOSS_FIGHT') {
      updateBoss(dt);
      updateParticles(dt);
      updateClouds(canvas.width, dt);
      if (gunCooldownTimer > 0) {
        gunCooldownTimer -= dt;
      }
    } else if (gameState === 'GAME_OVER') {
      updateParticles(dt);
      updateClouds(canvas.width, dt);
      const totalShots = birdsHit + shotsMissed;
      const accuracy = totalShots > 0 ? Math.round((birdsHit / totalShots) * 100) : (totalBirds > 0 ? 0 : 100);
      if (accuracy > 80 || bossDefeated) {
        const vw = canvas ? canvas.width : window.innerWidth;
        const vh = canvas ? canvas.height : window.innerHeight;
        updateFireworks(vw, vh, vw / 2, vh / 2, dt);
      }
    }

    render(dt);
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

    if (gameState === 'STAGE_CLEAR') {
      gameState = 'GUN_SELECT';
      return;
    }

    if (gameState === 'GUN_SELECT') {
      const clickX = e.clientX;
      const clickY = e.clientY;
      for (const b of gunCardsBounds) {
        if (clickX >= b.x && clickX <= b.x + b.w &&
            clickY >= b.y && clickY <= b.y + b.h) {
          if (b.unlocked) {
            selectedGun = b.gun;
            initBossFight();
            gameState = 'BOSS_INTRO';
            particles.push({
              x: canvas.width / 2,
              y: canvas.height / 2,
              vx: 0,
              vy: -1.5,
              life: 60,
              maxLife: 60,
              isText: true,
              text: `⚔️ EQUIPPED: ${b.gun.name.toUpperCase()}`,
              color: b.gun.color,
              size: 0,
            });
            break;
          } else {
            triggerScreenShake(3);
            particles.push({
              x: clickX,
              y: clickY - 20,
              vx: 0,
              vy: -1.2,
              life: 45,
              maxLife: 45,
              isText: true,
              text: `🔒 Need ${b.gun.requiredScore} PTS (You have ${score})`,
              color: COLOR_RED,
              size: 0,
            });
          }
        }
      }
      return;
    }

    if (gameState === 'BOSS_INTRO') {
      gameState = 'BOSS_FIGHT';
      bossState = 'PATROL';
      biteCooldown = 180;
      return;
    }

    if (gameState === 'BOSS_FIGHT') {
      e.preventDefault();
      e.stopPropagation();

      if (gunCooldownTimer > 0) {
        return;
      }

      const clickX = e.clientX;
      const clickY = e.clientY;

      gunCooldownTimer = selectedGun.fireRateMs / 16.667;
      shotsFired++;
      muzzleFlashTimer = 5;

      if (selectedGun.id === 'railgun') {
        const vw = canvas ? canvas.width : window.innerWidth;
        const vh = canvas ? canvas.height : window.innerHeight;
        railgunBeam = {
          startX: vw * 0.85,
          startY: vh,
          endX: clickX,
          endY: clickY,
          timer: 12,
        };
        triggerScreenShake(10);
      } else if (selectedGun.id === 'sniper') {
        const vw = canvas ? canvas.width : window.innerWidth;
        const vh = canvas ? canvas.height : window.innerHeight;
        sniperTracer = {
          startX: vw * 0.5,
          startY: vh,
          endX: clickX,
          endY: clickY,
          timer: 10,
        };
        triggerScreenShake(12);
        for (let i = 0; i < 8; i++) {
          const angle = Math.random() * Math.PI * 2;
          particles.push({
            x: clickX,
            y: clickY,
            vx: Math.cos(angle) * (3 + Math.random() * 4),
            vy: Math.sin(angle) * (3 + Math.random() * 4),
            life: 20,
            maxLife: 20,
            color: '#34d399',
            size: 2.5 + Math.random() * 2,
            isText: false,
          });
        }
      } else if (selectedGun.id === 'shotgun') {
        triggerScreenShake(6);
        for (let i = -1; i <= 1; i++) {
          const spreadAngle = i * 0.12;
          for (let p = 0; p < 3; p++) {
            particles.push({
              x: clickX + (Math.random() - 0.5) * 30,
              y: clickY + (Math.random() - 0.5) * 30,
              vx: Math.cos(spreadAngle) * (2 + Math.random() * 4),
              vy: Math.sin(spreadAngle) * (2 + Math.random() * 4),
              life: 25,
              maxLife: 25,
              color: '#ff6d00',
              size: 3 + Math.random() * 2,
              isText: false,
            });
          }
        }
      } else {
        triggerScreenShake(3);
      }

      // Hit test against boss
      let currentBossSize = bossSize;
      if (bossState === 'BITING') {
        const lungeProg = 1 - Math.max(0, biteTimer / BOSS_PARRY_WINDOW_MS);
        currentBossSize *= (1.0 + Math.sin(lungeProg * Math.PI) * 0.45);
      }
      const dist = Math.hypot(clickX - bossX, clickY - bossY);
      const hitRadius = currentBossSize * (bossState === 'BITING' ? 0.85 : 0.65);

      // Headshot detection (head center is at bossX, bossY - currentBossSize * 0.32, radius ~ currentBossSize * 0.24)
      const headDist = Math.hypot(clickX - bossX, clickY - (bossY - currentBossSize * 0.32));
      const isHeadshot = headDist <= currentBossSize * 0.24;

      if (dist <= hitRadius && bossState !== 'DYING') {
        // Calculate base weapon damage (Sniper deals 10 base, double = 20 on headshot)
        let baseDmg = selectedGun.damage;
        if (selectedGun.id === 'sniper' && isHeadshot) {
          baseDmg = selectedGun.headshotDamage || (selectedGun.damage * 2);
        }

        if (bossState === 'BITING') {
          // ── PARRY! ──
          bossState = 'STUNNED';
          stunTimer = 90; // 1.5s stun
          const dmg = baseDmg * 2;
          bossHP = Math.max(0, bossHP - dmg);
          parriesLanded++;
          score += 350 + (isHeadshot ? 250 : 0);

          bossX = bossLungeStartX;
          bossY = bossLungeStartY;

          triggerScreenShake(isHeadshot ? 18 : 14);
          spawnParrySparks(clickX, clickY);

          particles.push({
            x: bossX,
            y: bossY - 60,
            vx: 0,
            vy: -1.5,
            life: 80,
            maxLife: 80,
            isText: true,
            text: (selectedGun.id === 'sniper' && isHeadshot)
              ? `⚔️🎯 PARRY HEADSHOT! 2× DMG (-${dmg} HP)`
              : `⚔️ PARRY! 2× DMG (-${dmg} HP)`,
            color: '#fbbf24',
            size: 0,
          });
        } else {
          // Standard hit
          const dmg = baseDmg;
          bossHP = Math.max(0, bossHP - dmg);
          score += 50 * dmg + (isHeadshot ? 150 : 0);
          spawnBossHitParticles(clickX, clickY, (selectedGun.id === 'sniper' && isHeadshot) ? '#34d399' : selectedGun.color);

          particles.push({
            x: clickX,
            y: clickY - 30,
            vx: 0,
            vy: -1.2,
            life: 45,
            maxLife: 45,
            isText: true,
            text: (selectedGun.id === 'sniper' && isHeadshot)
              ? `🎯 CRITICAL HEADSHOT! (-${dmg} HP)`
              : `-${dmg} HP`,
            color: (selectedGun.id === 'sniper' && isHeadshot) ? '#34d399' : '#f87171',
            size: 0,
          });
        }

        if (bossHP <= 0) {
          bossState = 'DYING';
          bossDeathTimer = 100;
          triggerScreenShake(16);
          particles.push({
            x: canvas.width / 2,
            y: canvas.height * 0.35,
            vx: 0,
            vy: -1.0,
            life: 90,
            maxLife: 90,
            isText: true,
            text: '💥 GOOGLE ANALYTICS DESTROYED! 💥',
            color: '#fbbf24',
            size: 0,
          });
        }
      } else {
        shotsMissed++;
        for (let i = 0; i < 4; i++) {
          const angle = Math.random() * Math.PI * 2;
          particles.push({
            x: clickX,
            y: clickY,
            vx: Math.cos(angle) * 2,
            vy: Math.sin(angle) * 2,
            life: 15,
            maxLife: 15,
            color: 'rgba(239,68,68,0.6)',
            size: 2,
          });
        }
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
      canvas.width = Math.round(window.innerWidth);
      canvas.height = Math.round(window.innerHeight);
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
    lastFrameTime = 0;
    loadingAngle = 0;
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

    // 5. Create full-screen canvas with MAXIMUM Z-INDEX (integer rounded dimensions)
    canvas = document.createElement('canvas');
    canvas.id = 'adsniper-game-canvas';
    canvas.width = Math.round(window.innerWidth);
    canvas.height = Math.round(window.innerHeight);
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

    // Save total ad count for Stage 2 Boss HP (HP = 50 Base + 2 * total ads on page)
    totalAdsFound = adData.length;
    bossMaxHP = 50 + (totalAdsFound * 2);
    bossHP = bossMaxHP;
    bossSmoothHP = bossMaxHP;
    bossBiteDamage = 1;
    currentStage = 1;
    stage1Score = 0;
    stage1BirdsHit = 0;
    stage1TotalBirds = 0;
    stageClearTimer = 0;
    selectedGun = STAGE2_GUNS[0];
    bossDefeated = false;
    parriesLanded = 0;
    bossDamageTaken = 0;
    gunCooldownTimer = 0;
    railgunBeam = null;
    playerHealth = 10;

    // Create birds
    loadingProgress = 0.95;
    loadingMessage = `Found ${adData.length} target${adData.length > 1 ? 's' : ''} — preparing...`;
    await new Promise((r) => setTimeout(r, 500));

    // Initialize sky elements
    const vw = canvas.width;
    const vh = canvas.height;
    initClouds(vw, vh);
    initStars(vw, vh);

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
    lastFrameTime = 0;
    loadingAngle = 0;

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
    gunCardsBounds = [];
    railgunBeam = null;
    currentStage = 1;

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
