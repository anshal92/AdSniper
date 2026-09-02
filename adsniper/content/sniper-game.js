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
  let lastHitTime = 0;
  let totalBirds = 0;
  let birdsHit = 0;
  let mouseX = 0, mouseY = 0;
  let animFrameId = null;
  let frameCount = 0;
  let loadingProgress = 0;
  let loadingMessage = 'Scanning for ads...';
  let gameOverAlpha = 0; // Fade-in for game over screen

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
  function scanForAds() {
    const results = [];
    const seen = new WeakSet();

    // Scan iframes
    document.querySelectorAll('iframe').forEach((iframe) => {
      if (seen.has(iframe)) return;
      const src = (iframe.src || iframe.dataset?.src || '').toLowerCase();
      const label = `${iframe.className || ''} ${iframe.id || ''} ${iframe.name || ''}`;

      const isAd = AD_CONTAINER_RE.test(label) ||
                   AD_IFRAME_PATS.some((p) => src.includes(p));

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

      if (AD_IFRAME_PATS.some((p) => src.includes(p))) {
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
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return null; }
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

      // Spawn position: random edge
      const fromLeft = Math.random() > 0.5;
      const x = fromLeft ? -size : vw + size;
      const y = Math.random() * (vh - size * 2) + size;
      const direction = fromLeft ? 1 : -1;

      // Zigzag parameters — slight randomization for variety
      const a1 = ZIGZAG_A1 * (0.7 + Math.random() * 0.6);
      const f1 = ZIGZAG_F1 * (0.8 + Math.random() * 0.4);
      const a2 = ZIGZAG_A2 * (0.6 + Math.random() * 0.8);
      const f2 = ZIGZAG_F2 * (0.7 + Math.random() * 0.6);

      return {
        id: i,
        x, y,
        baseY: y,
        size,
        direction,
        speed: BIRD_SPEED * (0.8 + Math.random() * 0.4),
        a1, f1, a2, f2,
        phase: Math.random() * Math.PI * 2,
        points,
        alive: true,
        texture,
        label: ad.label,
        tagName: ad.tagName,
        color: BIRD_COLORS[i % BIRD_COLORS.length],
        rotation: 0,
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

    for (const bird of birds) {
      if (!bird.alive) continue;

      // Horizontal movement
      bird.x += bird.speed * bird.direction;

      // Dual-component zigzag vertical motion
      const t = frameCount + bird.phase;
      const yOffset = bird.a1 * Math.sin(bird.f1 * t) +
                      bird.a2 * Math.sin(bird.f2 * t);
      bird.y = bird.baseY + yOffset;

      // Clamp Y to viewport
      bird.y = Math.max(bird.size / 2, Math.min(vh - bird.size / 2, bird.y));

      // Slight rotation based on vertical velocity
      const yVel = bird.a1 * bird.f1 * Math.cos(bird.f1 * t) +
                   bird.a2 * bird.f2 * Math.cos(bird.f2 * t);
      bird.rotation = yVel * 0.02 * bird.direction;

      // Wing flap
      bird.wingPhase += bird.wingSpeed;

      // Respawn when fully off screen
      if ((bird.direction > 0 && bird.x > vw + bird.size * 2) ||
          (bird.direction < 0 && bird.x < -bird.size * 2)) {
        // Respawn from opposite edge
        bird.direction *= -1;
        bird.x = bird.direction > 0 ? -bird.size : vw + bird.size;
        bird.baseY = Math.random() * (vh - bird.size * 2) + bird.size;
        bird.phase = Math.random() * Math.PI * 2;
      }
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

    // Birds remaining
    ctx.fillStyle = COLOR_TEXT;
    ctx.font = `13px 'Segoe UI', system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText(`🐦 ${birdsHit}/${totalBirds} Birds`, vw / 2, cy);

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

    ctx.globalAlpha = gameOverAlpha * 0.85;
    ctx.fillStyle = 'rgba(15, 15, 23, 0.9)';
    ctx.fillRect(0, 0, vw, vh);
    ctx.globalAlpha = gameOverAlpha;

    const cx = vw / 2;
    const cy = vh / 2;

    // Card background
    ctx.fillStyle = COLOR_HUD_BG;
    roundRect(ctx, cx - 200, cy - 140, 400, 280, 16);
    ctx.fill();

    ctx.strokeStyle = COLOR_ACCENT;
    ctx.lineWidth = 2;
    roundRect(ctx, cx - 200, cy - 140, 400, 280, 16);
    ctx.stroke();

    // Title
    ctx.fillStyle = COLOR_GREEN;
    ctx.font = `bold 28px 'Segoe UI', system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('🎯 GAME OVER', cx, cy - 90);

    // Score
    ctx.fillStyle = COLOR_TEXT;
    ctx.font = `bold 20px 'Segoe UI', system-ui, sans-serif`;
    ctx.fillText(`Score: ${score.toLocaleString()}`, cx, cy - 40);

    // Stats
    ctx.fillStyle = COLOR_MUTED;
    ctx.font = `14px 'Segoe UI', system-ui, sans-serif`;
    ctx.fillText(`Birds Hit: ${birdsHit}/${totalBirds}`, cx, cy);
    ctx.fillText(`Best Combo: ×${Math.max(1, combo)}`, cx, cy + 28);

    // Accuracy
    const accuracy = totalBirds > 0 ? Math.round((birdsHit / totalBirds) * 100) : 0;
    ctx.fillStyle = accuracy >= 80 ? COLOR_GREEN : accuracy >= 50 ? COLOR_AMBER : COLOR_RED;
    ctx.fillText(`Accuracy: ${accuracy}%`, cx, cy + 56);

    // Exit instructions
    ctx.fillStyle = COLOR_ACCENT;
    ctx.font = `bold 13px 'Segoe UI', system-ui, sans-serif`;
    ctx.fillText('Press ESC or click to exit', cx, cy + 100);

    ctx.globalAlpha = 1;
  }

  // ═══════════════════════════════════════════════
  //  GAME LOOP
  // ═══════════════════════════════════════════════

  function gameLoop() {
    frameCount++;

    if (gameState === 'PLAYING') {
      updateBirds();
      updateParticles();

      // Auto-decay combo
      if (combo > 0 && Date.now() - lastHitTime > COMBO_DECAY_MS) {
        combo = 0;
      }
    } else if (gameState === 'GAME_OVER') {
      updateParticles();
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
      endGame();
      return;
    }

    if (gameState !== 'PLAYING') return;

    e.preventDefault();
    e.stopPropagation();

    const clickX = e.clientX;
    const clickY = e.clientY;

    // Check hit on any alive bird (AABB collision)
    let hit = false;
    // Check birds in reverse order (last drawn = visually on top)
    for (let i = birds.length - 1; i >= 0; i--) {
      const bird = birds[i];
      if (!bird.alive) continue;

      const halfSize = bird.size / 2;
      if (clickX >= bird.x - halfSize && clickX <= bird.x + halfSize &&
          clickY >= bird.y - halfSize && clickY <= bird.y + halfSize) {
        handleHit(bird);
        hit = true;
        break; // Only hit one bird per click
      }
    }

    if (!hit) {
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
    lastHitTime = 0;
    birdsHit = 0;
    frameCount = 0;
    particles = [];
    gameOverAlpha = 0;
    loadingProgress = 0;
    loadingMessage = 'Scanning for ads...';

    // Create full-screen canvas
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
      zIndex: '2147483646',
      cursor: 'none',
    });
    document.documentElement.appendChild(canvas);
    ctx = canvas.getContext('2d');

    // Start game loop (shows loading screen)
    gameState = 'LOADING';
    animFrameId = requestAnimationFrame(gameLoop);

    // Wire input
    document.addEventListener('mousemove', onMouseMove, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('resize', onResize);

    // Animate loading progress
    const loadStart = Date.now();
    const loadInterval = setInterval(() => {
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
    const adData = scanForAds();
    clearInterval(loadInterval);

    if (adData.length === 0) {
      // No ads found — show message and exit
      loadingProgress = 1;
      loadingMessage = 'No ad components found on this page!';
      await new Promise((r) => setTimeout(r, 2000));
      endGame();
      return;
    }

    // Create birds
    loadingProgress = 0.95;
    loadingMessage = `Found ${adData.length} ad${adData.length > 1 ? 's' : ''} — preparing targets...`;
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
  function endGame() {
    gameState = null;

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

    // Notify content script to restore blocking state
    // (game runs in page main world, can't call chrome.* APIs directly)
    window.postMessage({
      type: 'ADSNIPER_GAME_ENDED',
      score,
      birdsHit,
      totalBirds,
    }, '*');

    // Clear references
    birds = [];
    particles = [];
  }

  // Public API
  return { launchGame, endGame };

})();
