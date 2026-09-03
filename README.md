# 🎯 AdSniper

> **Surgical Ad Blocking, Cookie Control & Gamified Ad Sniping for Chrome (Manifest V3)**

AdSniper is a powerful, privacy-first Chromium extension designed to give you surgical control over network traffic, intrusive popups, and cookies—while introducing a first-of-its-kind **Gamified Sniping Mode** that transforms irritating page ads into flying targets you can shoot down!

Built strictly on **Chrome Manifest V3**, AdSniper utilizes high-efficiency declarative rule engines (`declarativeNetRequest`), heuristic DOM sanitization, and isolated Canvas overlays without dragging down browser performance.

---

## 🚀 Key Features

### 🛡️ 1. Surgical Ad & Tracker Blocker
- **Declarative Rule Engine**: Built on Chrome's native `declarativeNetRequest` (DNR) API for lightning-fast request blocking with minimal memory and CPU overhead.
- **Mass-Block Filter List**: Bundled with comprehensive ad host definitions (Peter Lowe’s list and curated patterns) to block thousands of tracking, telemetry, and advertising servers.
- **Live Request Monitor**: Inspect outgoing network requests in real time per tab (up to 200 requests logged), complete with request types, domains, and single-click custom rule creation.
- **Per-Rule Hit Counters**: Track exactly how many ads each rule has eliminated with real-time badge counters.

### 🚫 2. Intrusive Pop-up & Anti-Adblock Interceptor
- **Block New Tab Ads**: Intercepts `main_frame` navigations and redirects to prevent deceptive links from spawning intrusive ad tabs.
- **Full-Screen Overlay Neutralization**: Employs immediate CSS injection (`injectAntiOverlayStyles`) and DOM mutation observers to obliterate anti-adblock modals, transparent click-hijacking overlays, and interstitials (`data-shb`, PopCash, Adsterra, Monetag).
- **Ad Message Sandboxing**: Captures and cancels obfuscated `postMessage` triggers sent between ad iframes and parent windows.

### 🎯 3. Element Picker & iFrame Purger
- **Visual Element Picker**: Click **🎯 Pick Element**, hover over any unwanted page component with a red highlight guide, and click to remove it and generate a persistent blocking rule.
- **Automated iFrame Eradicator**: Scans the DOM using multi-point heuristics (known ad sizes, suspicious source URLs, sandbox attributes) and completely removes sneaky ad iframes from the page.

### 🍪 4. Advanced Cookie Manager & Lock System
- **Cookie Inspector**: View, inspect, create, and edit cookies for the active domain.
- **Cookie Lock Protection**: Lock critical or sensitive cookies to prevent websites or third-party scripts from modifying or overwriting your session preferences during browsing.

### 🔫 5. Gamified Sniping Mode (Turn Ads into Targets!)
- **Ad Hunting**: Click **🔫 Sniping OFF** in the header to turn off ad-blocking on the current page, reload (or open in a new tab), scan all incoming ad elements, and turn them into flying bird targets!
- **Dynamic Physics & Sizing**:
  - **Inverse Sizing**: Small banner ads become large, easy targets; gigantic screen-covering ads become nimble, miniature birds.
  - **Flutter Trajectories**: Birds flap their wings and fly across your screen with dual-frequency sinusoidal wave paths (`y = A₁·sin(ω₁·t) + A₂·sin(ω₂·t)`), changing headings dynamically.
- **Marksman Scoring & Piercing Multikills**:
  - Consecutive hits build a combo multiplier up to **×5**.
  - Piercing crosshair allows **Double Kills**, **Triple Kills**, and **Multikills (4+)** when flying targets align.
  - Real-time HUD displays score, combo, birds hit, and missed shots.
  - **Celebration Fireworks**: Scoring an accuracy of **> 80%** triggers a celebratory fireworks display around the results screen!
  - **Interactive Results Screen**: Dedicated **🚪 Quit Game** button and `[ESC]` key handler to cleanly restore your ad-blocking settings.

---

## 📦 How to Install

AdSniper is an unpacked Chrome Extension (Manifest V3). Follow these simple steps to install it on **Google Chrome**, **Brave**, **Microsoft Edge**, or any Chromium-based browser:

### Step 1: Clone or Download the Repository
Clone the repository to your local machine using Git:
```bash
git clone https://github.com/anshal92/AdSniper.git
```
*(Or click **Code → Download ZIP** on GitHub and extract the contents to a folder).*

### Step 2: Open Chrome Extensions
1. Launch your browser.
2. Navigate to the extensions page by entering:
   ```text
   chrome://extensions/
   ```
   *(For Microsoft Edge: `edge://extensions/`)*

### Step 3: Enable Developer Mode
Look for the **Developer mode** toggle in the top-right corner of the Extensions page and turn it **ON**.

### Step 4: Load the Unpacked Extension
1. Click the **Load unpacked** button in the top-left menu.
2. In the folder selection dialog, navigate to the cloned repository and select the **`adsniper`** folder (the folder containing `manifest.json`).
3. Click **Select Folder**.

### Step 5: Pin & Enjoy!
1. Click the **Extensions** (puzzle piece) icon in your browser toolbar.
2. Pin **AdSniper** for quick access.
3. Open any website to monitor requests, block ads, or start **Sniping Mode**!

---

## 🎮 How to Play Sniping Mode

1. Navigate to any website containing ads.
2. Click the **AdSniper** icon in your toolbar to open the popup.
3. In the header bar, click **🔫 Sniping OFF** (optionally check the **New Tab** box to preserve your current tab).
4. The page will reload in gaming mode:
   - Ad blocking is temporarily lifted.
   - An overlay scans the page for ad elements and builds your targets.
   - Crosshair controls will appear on screen.
5. **Controls**:
   - **Aim**: Move your mouse.
   - **Fire**: Left-click to shoot targets. Align multiple targets for **Double** and **Triple Kills**!
   - **Exit**: Click **🚪 Quit Game** on the results card or press **`[ESC]`** at any time.

---

## 📂 Project Structure

```text
AdSniper/
├── adsniper/
│   ├── manifest.json              # Chrome Manifest V3 configuration
│   ├── service-worker.js          # Background service worker (DNR & state management)
│   ├── content/
│   │   ├── content.js             # Content script (DOM sanitization & picker bridge)
│   │   └── sniper-game.js         # Canvas 2D game engine (physics, targets & fireworks)
│   ├── popup/
│   │   ├── popup.html             # Extension dashboard interface
│   │   ├── popup.css              # Dark-mode styling and animations
│   │   └── popup.js               # Dashboard controller & request monitor
│   ├── rules/
│   │   └── rules.json             # Static declarativeNetRequest rulesets
│   ├── data/
│   │   └── ad-patterns.json       # Peter Lowe's ad host & telemetry rules
│   ├── Architecture.md            # Comprehensive system & technical documentation
│   └── ChangeLog.md               # Version history & update logs
└── README.md                      # Project overview & installation guide
```

---

## 🔒 Privacy & Permissions

AdSniper is built with privacy at its core:
- **No Remote Tracking or Telemetry**: All network request logs and cookie analyses happen **100% locally** on your device.
- **Manifest V3 Native**: Operates strictly within Google Chrome's latest security sandbox.
- **Permissions Explained**:
  - `declarativeNetRequest`: Used to block ad and tracking requests at browser level.
  - `storage`: Used to save custom rules and user preferences locally.
  - `cookies`: Used to inspect and lock cookies on the active tab.
  - `scripting` & `activeTab`: Used to inject the Element Picker and Sniping Mode canvas on user request.

---

## 📄 License

This project is licensed under the [MIT License](LICENSE). Contributions and feedback are welcome!
