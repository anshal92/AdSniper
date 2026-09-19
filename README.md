# 🎯 AdSniper

> **Surgical Ad Blocking, Cookie Control, On-Device AI Personal Assistant (Gemini Nano), Scratchpad & Todo Lists, and Gamified Ad Sniping for Chrome (Manifest V3)**

AdSniper is a powerful, privacy-first Chromium extension designed to give you surgical control over network traffic, intrusive popups, and cookies—featuring an **on-device Gemini Nano Personal Assistant** powered by Chrome's Built-in AI, an integrated **Scratchpad & Todo List** system, and a first-of-its-kind **Gamified Sniping Mode** that transforms irritating page ads into flying targets you can shoot down!

Built strictly on **Chrome Manifest V3**, AdSniper utilizes high-efficiency declarative rule engines (`declarativeNetRequest`), heuristic DOM sanitization, isolated Canvas overlays, and local LLM execution across four dedicated tabs—without dragging down browser performance or sending your data to external servers.

---

## 📑 Index

- [🚀 Key Features](#-key-features)
  - [🤖 1. On-Device Gemini Nano AI — Dual-Engine Architecture](#-1-on-device-gemini-nano-ai--dual-engine-architecture)
  - [🛡️ 2. Surgical Ad & Tracker Blocker](#️-2-surgical-ad--tracker-blocker)
  - [🎯 3. Element Picker & iFrame Purger](#-3-element-picker--iframe-purger)
  - [🔫 4. Gamified Sniping Mode (Turn Ads into Targets!)](#-4-gamified-sniping-mode-turn-ads-into-targets)
  - [📋 5. Scratchpad & Todo Lists](#-5-scratchpad--todo-lists)
  - [🚫 6. Intrusive Pop-up & Anti-Adblock Interceptor](#-6-intrusive-pop-up--anti-adblock-interceptor)
  - [🍪 7. Advanced Cookie Manager & Lock System](#-7-advanced-cookie-manager--lock-system)
- [📦 How to Install](#-how-to-install)
- [🧠 How to Enable Chrome Built-in AI (Gemini Nano)](#-how-to-enable-chrome-built-in-ai-gemini-nano)
- [🎮 How to Play Sniping Mode](#-how-to-play-sniping-mode)
- [📂 Project Structure](#-project-structure)
- [🔒 Privacy & Permissions](#-privacy--permissions)
- [📄 License](#-license)

---

## 🚀 Key Features

### 🤖 1. On-Device Gemini Nano AI — Dual-Engine Architecture
AdSniper runs **two independent AI engines** on-device, each with its own dedicated system prompt and session:

#### 🛡️ AdBlocker AI (Action-Only Engine)
- **100% Local Built-in AI**: Uses Chrome's native **Prompt API** (`window.ai.languageModel` / `LanguageModel`) to run Google's **Gemini Nano** directly on your device. Zero external cloud API calls, zero latency penalty, and zero private data leakage.
- **Strict Action-Only Prompt**: This engine is constrained to only emit MCP tool JSON—it never produces conversational text. Optimized for deterministic ad blocking commands.
- **Autonomous Model Context Protocol (MCP) Tools**:
  - `tool_inspect_requests`: Produces instant forensic ad & tracker audit reports, decoding exfiltrated query parameters (Publisher IDs, Auction Bids, User Tracking UUIDs, Topics/FLEDGE data).
  - `tool_remove_overlay`: Detects and scrubs anti-adblock modals, paywalls, sticky video overlays, and unfreezes locked body scrolling.
  - `tool_add_block_rule`: Synthesizes dynamic DeclarativeNetRequest block rules from natural language (e.g. *"Block analytics.foo.com"*).
  - `tool_hide_element_css`: Generates and injects custom CSS selector rules (`display: none !important`) to eliminate annoying banners and clutter.
  - `tool_extract_clean_content`: Extracts clean, readable article text stripped of sidebars, ads, and widgets.
  - `tool_toggle_feature`: Voice/text command shield switcher (`new_tab_block`, `mass_block`, `dom_cleanup`, etc.).
  - `tool_execute_js_script`: Executes custom JavaScript in the active tab to inspect, query, or extract DOM data.
- **Intent-First Deterministic Dispatcher**: Common commands (e.g., *"kill popups"*, *"audit trackers"*, *"remove on click new tab"*) execute with **0ms latency** via deterministic intent matching, guaranteeing browser action without waiting for model token generation.
- **Resilient Heuristics Fallback**: Even if Chrome flags are disabled or Gemini Nano is still downloading, AdSniper automatically runs all MCP tools via local deterministic heuristics.
- **Tri-State Status Indicator**:
  - 🟢 **Blinking Green**: Nano Ready (or Heuristics Mode active & running).
  - 🟡 **Pulsing Yellow**: Initializing or model downloading in Chrome components.
  - 🔴 **Static Red**: AI engine offline / unavailable.

#### ✨ Personal Assistant (Conversational Engine)
- **Dedicated Chat Interface**: A separate "✨ Personal Assistant" tab with a full chat history UI, message bubbles, and streaming responses.
- **Conversational System Prompt**: Uses a higher-temperature (0.7) session tuned for natural conversation—answering questions, performing calculations, fixing grammar, and summarizing text—without blindly triggering tools.
- **Live LLM Telemetry Dashboard**:
  - **Token Counter**: Displays `Input + Output / 32,768` context utilization in real time using `session.countPromptTokens()`.
  - **Generation Speed**: Shows tokens per second (`t/s`) during streaming.
  - **Adjustable Context Window**: Configurable conversation history retention (default: last 10 turns, max 50).
- **Quick-Action Feature Chips**: One-click prompt templates for common tasks: 📝 Summarise Page, 🧮 Calculator, ✍️ Grammar Fixer, 🗒️ Save Note, ✅ Add Todo.
- **MCP Tools (Selective)**: The assistant can call `tool_execute_js_script`, `tool_add_scratchpad`, and `tool_add_todo`—but **only when explicitly requested**. Normal questions are answered conversationally.

### 🛡️ 2. Surgical Ad & Tracker Blocker
- **Declarative Rule Engine**: Built on Chrome's native `declarativeNetRequest` (DNR) API for lightning-fast request blocking with minimal memory and CPU overhead.
- **Mass-Block Filter List**: Bundled with comprehensive ad host definitions (Peter Lowe’s list and curated patterns) to block thousands of tracking, telemetry, and advertising servers.
- **Live Request Monitor**: Inspect outgoing network requests in real time per tab (up to 200 requests logged), complete with request types, domains, and single-click custom rule creation.
- **Per-Rule Hit Counters**: Track exactly how many ads each rule has eliminated with real-time badge counters.

### 🎯 3. Element Picker & iFrame Purger
- **Visual Element Picker**: Click **🎯 Pick Element**, hover over any unwanted page component with a red highlight guide, and click to remove it and generate a persistent blocking rule.
- **Automated iFrame Eradicator**: Scans the DOM using multi-point heuristics (known ad sizes, suspicious source URLs, sandbox attributes) and completely removes sneaky ad iframes from the page.

### 🔫 4. Gamified Sniping Mode (Turn Ads into Targets!)
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

### 📋 5. Scratchpad & Todo Lists
- **Dedicated "📋 Lists" Tab**: A side-by-side panel with a persistent **Scratchpad** notepad and a **Todo List** task manager.
- **Manual & AI-Powered**: Add notes and tasks manually, or let the Personal Assistant write to them autonomously during chat (e.g., *"Summarize this article and save key points to my scratchpad"* or *"Add 'review PR' to my todo list"*).
- **Todo Management**: Add tasks, check them off, clear completed items, or delete individual tasks.
- **Persistent Storage**: All data is saved instantly to `chrome.storage.local` and persists across popup reopens and browser restarts.
- **Real-Time Sync**: AI writes are reflected instantly in the Lists tab via DOM custom events (`AST_SCRATCHPAD_UPDATE`, `AST_TODO_ADD`)—no manual refresh required.

### 🚫 6. Intrusive Pop-up & Anti-Adblock Interceptor
- **Block New Tab Ads**: Intercepts `main_frame` navigations and redirects to prevent deceptive links from spawning intrusive ad tabs.
- **Full-Screen Overlay Neutralization**: Employs immediate CSS injection (`injectAntiOverlayStyles`) and DOM mutation observers to obliterate anti-adblock modals, transparent click-hijacking overlays, floating video ads, and interstitials (`data-shb`, PopCash, Adsterra, Monetag).
- **Ad Message Sandboxing**: Captures and cancels obfuscated `postMessage` triggers sent between ad iframes and parent windows.

### 🍪 7. Advanced Cookie Manager & Lock System
- **Cookie Inspector**: View, inspect, create, and edit cookies for the active domain.
- **Cookie Lock Protection**: Lock critical or sensitive cookies to prevent websites or third-party scripts from modifying or overwriting your session preferences during browsing.

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

## 🧠 How to Enable Chrome Built-in AI (Gemini Nano)

AdSniper uses **Gemini Nano**, Google’s on-device AI that runs directly inside Chrome. No cloud servers, no API keys, and 100% private. 

If your AI status shows **🔴 Offline** or you just installed AdSniper, follow these simple steps to wake it up!

### Step 1: Open Chrome Settings
In your address bar, type `chrome://flags` and press Enter.

### Step 2: Turn on the AI Flags
Search for these two flags and enable them:
1. **Prompt API for Extension:** Search for `#prompt-api` and set it to **Enabled**.
2. **Bypass Hardware Checks (Optional but recommended):** Search for `#optimization-guide-on-device-model` and set it to **Enabled BypassPerfRequirement**. This forces Chrome to download the AI even if you don't have a high-end graphics card.

### Step 3: Relaunch & Wait for Download
1. Click the **Relaunch** button at the bottom of the screen.
2. Once Chrome restarts, it will quietly start downloading the Gemini Nano model in the background (about 1.5GB to 2.5GB). 

### Step 4: Check Download Status
Want to see how the download is doing?
- Go to `chrome://on-device-internals`. You'll see the exact download progress and model status there!
- Alternatively, go to `chrome://components/`, look for **Optimization Guide On Device Model**, and click "Check for update". 

Once it finishes, open the AdSniper popup, click **✨ Enable AI**, and your on-device personal assistant is ready to go!

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
│   │                              # (Dual-engine: AdBlocker AI + Personal Assistant)
│   ├── content/
│   │   ├── content.js             # Content script (DOM sanitization & picker bridge)
│   │   └── sniper-game.js         # Canvas 2D game engine (physics, targets & fireworks)
│   ├── popup/
│   │   ├── popup.html             # Four-tab extension dashboard (Ad Blocker, Assistant, Lists, Cookies)
│   │   ├── popup.css              # Dark-mode styling and animations
│   │   └── popup.js               # Dashboard controller, request monitor, chat & lists logic
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
