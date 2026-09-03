# 🎯 AdSniper

> **Surgical Ad Blocking, Cookie Control, On-Device AI Assistant (Gemini Nano) & Gamified Ad Sniping for Chrome (Manifest V3)**

AdSniper is a powerful, privacy-first Chromium extension designed to give you surgical control over network traffic, intrusive popups, and cookies—featuring an **on-device Gemini Nano AI Assistant** powered by Chrome's Built-in AI, alongside a first-of-its-kind **Gamified Sniping Mode** that transforms irritating page ads into flying targets you can shoot down!

Built strictly on **Chrome Manifest V3**, AdSniper utilizes high-efficiency declarative rule engines (`declarativeNetRequest`), heuristic DOM sanitization, isolated Canvas overlays, and local LLM execution without dragging down browser performance or sending your data to external servers.

---

## 🚀 Key Features

### 🛡️ 1. Surgical Ad & Tracker Blocker
- **Declarative Rule Engine**: Built on Chrome's native `declarativeNetRequest` (DNR) API for lightning-fast request blocking with minimal memory and CPU overhead.
- **Mass-Block Filter List**: Bundled with comprehensive ad host definitions (Peter Lowe’s list and curated patterns) to block thousands of tracking, telemetry, and advertising servers.
- **Live Request Monitor**: Inspect outgoing network requests in real time per tab (up to 200 requests logged), complete with request types, domains, and single-click custom rule creation.
- **Per-Rule Hit Counters**: Track exactly how many ads each rule has eliminated with real-time badge counters.

### 🚫 2. Intrusive Pop-up & Anti-Adblock Interceptor
- **Block New Tab Ads**: Intercepts `main_frame` navigations and redirects to prevent deceptive links from spawning intrusive ad tabs.
- **Full-Screen Overlay Neutralization**: Employs immediate CSS injection (`injectAntiOverlayStyles`) and DOM mutation observers to obliterate anti-adblock modals, transparent click-hijacking overlays, floating video ads, and interstitials (`data-shb`, PopCash, Adsterra, Monetag).
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

### 🤖 6. On-Device Gemini Nano AI Assistant & Autonomous MCP Tools
- **100% Local Built-in AI**: Uses Chrome's native **Prompt API** (`window.ai.languageModel` / `LanguageModel`) to run Google's **Gemini Nano** directly on your device. Zero external cloud API calls, zero latency penalty, and zero private data leakage.
- **Autonomous Model Context Protocol (MCP) Tools**:
  - `tool_inspect_requests`[WIP]: Produces instant forensic ad & tracker audit reports, decoding exfiltrated query parameters (Publisher IDs, Auction Bids, User Tracking UUIDs, Topics/FLEDGE data).
  - `tool_remove_overlay`: Detects and scrubs anti-adblock modals, paywalls, sticky video overlays, and unfreezes locked body scrolling.
  - `tool_add_block_rule`[WIP]: Synthesizes dynamic DeclarativeNetRequest block rules from natural language (e.g. *"Block analytics.foo.com"*).
  - `tool_hide_element_css`: Generates and injects custom CSS selector rules (`display: none !important`) to eliminate annoying banners and clutter.
  - `tool_extract_clean_content`: Extracts clean, readable article text stripped of sidebars, ads, and widgets.
  - `tool_toggle_feature`[WIP]: Voice/text command shield switcher (`new_tab_block`, `mass_block`, `dom_cleanup`, etc.).
- **Intent-First Deterministic Dispatcher**: Common commands (e.g., *"kill popups"*, *"audit trackers"*, *"remove on click new tab"*) execute with **0ms latency** via deterministic intent matching, guaranteeing browser action without waiting for model token generation.
- **Resilient Heuristics Fallback**: Even if Chrome flags are disabled or Gemini Nano is still downloading, AdSniper automatically runs all MCP tools via local deterministic heuristics.
- **Tri-State Status Indicator**:
  - 🟢 **Blinking Green**: Nano Ready[With issues] (or Heuristics Mode active & running).
  - 🟡 **Pulsing Yellow**: Initializing or model downloading in Chrome components.
  - 🔴 **Static Red**: AI engine offline / unavailable.

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

## 🧠 How to Enable Chrome Built-in AI (Gemini Nano) & Flags

AdSniper leverages Google's **Gemini Nano** via Chrome's native **Prompt API**. While AdSniper works immediately with its built-in **Heuristics Fallback Engine**, enabling Chrome's experimental flags unlocks generative on-device intelligence.

### 1. Prerequisites
- **Browser**: Google Chrome version **128+** (Dev, Canary, Beta, or Stable 131+).
- **Storage**: At least **22 GB free disk space** on your primary OS drive (required by Chrome to provision the model container).
- **GPU / Hardware**: Modern GPU with at least **4 GB VRAM**, or a recent CPU with DirectML / WebGPU support.
- **Network**: An unmetered connection for the initial on-device model download (~1.5 GB - 2.5 GB).

### 2. Configure Chrome Flags
Open a new tab in Chrome and configure the following flags:

1. **Enable the Prompt API**:
   - In modern Chrome builds (Chrome 131+), the flag is named **`#prompt-api`**:
     ```text
     chrome://flags/#prompt-api
     ```
   - *(In earlier Chrome 128–130 builds, it was named `chrome://flags/#prompt-api-for-gemini-nano`)*
   - Set the dropdown to **Enabled** (or **Enabled on user gesture**).

2. **Bypass Hardware Restrictions (If Available)**:
   - Search for:
     ```text
     chrome://flags/#optimization-guide-on-device-model
     ```
   - If present in your build, set the dropdown to **Enabled BypassPerfRequirement** (this ensures Chrome downloads Gemini Nano even if your device isn't on Google's strict GPU whitelist).

3. **Relaunch Chrome (CRITICAL)**:
   - Click the **Relaunch** button at the bottom of `chrome://flags` (or close all Chrome windows and reopen).
   - > [!IMPORTANT]
   - > If Chrome shows *"Nearly up to date! Relaunch Chrome to finish updating"*, you **must** relaunch Chrome for the browser update and the enabled flags to take effect. Until relaunched, `window.ai` will remain `undefined`.

### 3. Verify & Download the Gemini Nano Model
After relaunching, you can monitor and trigger the model download in two ways:

#### Option A: Dedicated AI Dashboard (Best & Easiest)
1. Navigate to:
   ```text
   chrome://on-device-internals
   ```
2. Check the **Model Status** and **Device Status**:
   - If the model is not installed or has an update, you can monitor download status, hardware capability, and file paths directly.

#### Option B: Chrome Components
1. Navigate to:
   ```text
   chrome://components/
   ```
2. Search for:
   ```text
   Optimization Guide On Device Model
   ```
3. Click **Check for update**.
   - Wait until the version changes to a non-zero number (e.g., `2024.x.x.x` or `2025.x.x.x`) and status shows **Up-to-date**.

### 4. Verify Model Availability in DevTools Console
In modern Chrome, the Prompt API is exposed via the standard **`LanguageModel`** interface (replacing the legacy `window.ai` namespace) and is scoped to Extension contexts:

1. **Open the Extension Console**:
   - Click the **AdSniper** puzzle piece icon in your toolbar to open the popup.
   - **Right-click** inside the popup and select **Inspect** (or "Inspect popup").
   - *(Note: Running in a standard web tab console may return undefined because Chrome isolates on-device AI from untrusted public websites).*
2. In the DevTools **Console**, test the global interface:
   ```javascript
   await (window.LanguageModel || window.ai?.languageModel).availability();
   ```
   *Or directly:*
   ```javascript
   await LanguageModel.availability();
   ```
3. **Interpreting Results**:
   - `'readily'`: Gemini Nano is fully downloaded, loaded in VRAM, and ready for instant use!
   - `'after-download'` / `'downloadable'`: Flags are active, but model download is pending. Run `await LanguageModel.create();` to trigger download.
   - `'unavailable'` / `'no'`: System hardware does not meet requirements, or `BypassPerfRequirement` was omitted.

### 5. Using AI Assistant in AdSniper
1. Click the **AdSniper** extension icon in your toolbar.
2. In the top action bar, click **✨ Enable AI**.
3. Look at the status pill:
   - 🟢 **Nano Ready**: Gemini Nano is running 100% on-device!
   - 🟢 **Heuristics Mode**: Gemini Nano flags are inactive or downloading, but AdSniper's on-device heuristic engine is running all MCP tools seamlessly.
   - 🟡 **Downloading X%**: Chrome is actively fetching model chunks.
4. Try sample commands:
   - Click **`🎯 Audit Trackers`** or type *"Audit suspicious tracking calls on this tab"*.
   - Click **`🧹 Kill Overlays`** or type *"Kill popups and modals"*.
   - Click **`📝 Reader View`** or type *"Extract clean article text"*.
   - Type *"Block doubleclick.net"* or *"Stop new tab ads"*.

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
│   ├── ai/
│   │   └── nano-client.js         # Gemini Nano on-device AI client & MCP tool dispatcher
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
- **100% Local On-Device AI**: All LLM queries and heuristic analyses run strictly on your local hardware using Gemini Nano. No prompt text, visited URLs, or network logs ever leave your machine.
- **No Remote Tracking or Telemetry**: All network request logs and cookie analyses happen **100% locally** on your device.
- **Manifest V3 Native**: Operates strictly within Google Chrome's latest security sandbox.
- **Permissions Explained**:
  - `declarativeNetRequest`: Used to block ad and tracking requests at browser level.
  - `storage`: Used to save custom rules and user preferences locally.
  - `cookies`: Used to inspect and lock cookies on the active tab.
  - `scripting` & `activeTab`: Used to inject the Element Picker, Sniping Mode canvas, and DOM sanitizers on user request.
  - `declarativeNetRequestFeedback`: Used in unpacked developer mode to provide hit counters and reactive DOM cleanup.

---

## 📄 License

This project is licensed under the [MIT License](LICENSE). Contributions and feedback are welcome!
