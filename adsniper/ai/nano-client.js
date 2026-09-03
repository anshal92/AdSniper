/**
 * AdSniper — Gemini Nano Static Singleton Client
 *
 * Provides on-device AI integration via Chrome's native Built-in AI (Prompt API).
 * Runs 100% locally with zero external dependencies and zero cloud round-trips.
 *
 * Implements lightweight MCP-style actions to:
 *   1. Analyze network requests and synthesize DNR block rules
 *   2. Remove anti-adblock modals, paywalls, and overlay backdrops
 *   3. Hide custom annoying DOM elements via CSS injection
 *   4. Extract clean readability text (ad-free reader mode)
 *   5. Toggle AdSniper protection engines programmatically
 */

'use strict';

class GeminiNanoClient {
  /** @type {GeminiNanoClient|null} */
  static _instance = null;

  /**
   * Returns the static singleton instance.
   * @returns {GeminiNanoClient}
   */
  static getInstance() {
    if (!GeminiNanoClient._instance) {
      GeminiNanoClient._instance = new GeminiNanoClient();
    }
    return GeminiNanoClient._instance;
  }

  constructor() {
    this.session = null;
    this.isInitializing = false;
    this.availabilityStatus = null; // 'ready' | 'downloading' | 'unsupported'
    this.statusMessage = '';
    this.downloadProgress = 0;
  }

  /**
   * Detects the browser's built-in AI interface.
   * Supports window.ai.languageModel, self.ai.languageModel, and global LanguageModel.
   */
  getLanguageModelAPI() {
    if (typeof window !== 'undefined') {
      if (window.ai && window.ai.languageModel) return window.ai.languageModel;
      if (window.ai && window.ai.assistant) return window.ai.assistant;
      if (window.LanguageModel) return window.LanguageModel;
    }
    if (typeof self !== 'undefined') {
      if (self.ai && self.ai.languageModel) return self.ai.languageModel;
      if (self.ai && self.ai.assistant) return self.ai.assistant;
      if (self.LanguageModel) return self.LanguageModel;
    }
    return null;
  }

  /**
   * Checks whether Gemini Nano is available on this Chrome instance.
   * @returns {Promise<{ status: string, message: string, progress?: number }>}
   */
  async checkAvailability() {
    const lm = this.getLanguageModelAPI();
    if (!lm) {
      this.availabilityStatus = 'unsupported';
      this.statusMessage = 'Chrome Prompt API not detected. Enable flags in chrome://flags';
      return { status: this.availabilityStatus, message: this.statusMessage };
    }

    try {
      let avail = null;
      if (typeof lm.availability === 'function') {
        avail = await lm.availability();
      } else if (typeof lm.capabilities === 'function') {
        const caps = await lm.capabilities();
        avail = caps && caps.available;
      }

      if (avail === 'readily') {
        this.availabilityStatus = 'ready';
        this.statusMessage = 'Gemini Nano Ready (On-device)';
      } else if (avail === 'after-download') {
        this.availabilityStatus = 'downloading';
        this.statusMessage = 'Model downloading via Chrome components...';
      } else {
        this.availabilityStatus = 'unsupported';
        this.statusMessage = 'Gemini Nano unavailable on this hardware/flag setup';
      }
    } catch (err) {
      console.warn('[AdSniper AI] Availability check failed:', err);
      this.availabilityStatus = 'unsupported';
      this.statusMessage = 'Prompt API error: ' + err.message;
    }

    return { status: this.availabilityStatus, message: this.statusMessage, progress: this.downloadProgress };
  }

  /**
   * Lazily creates or reuses the active LanguageModel session.
   * @returns {Promise<any>}
   */
  async getOrCreateSession() {
    if (this.session) return this.session;
    if (this.isInitializing) {
      // Wait for initialization to complete
      while (this.isInitializing) {
        await new Promise((r) => setTimeout(r, 50));
      }
      return this.session;
    }

    const lm = this.getLanguageModelAPI();
    if (!lm) return null;

    this.isInitializing = true;
    try {
      const systemPrompt = `You are AdSniper AI, an on-device Chrome extension assistant.
You help users inspect network traffic, eliminate annoying ads/trackers, remove paywalls and popups, and control the page.

You have access to the following MCP Actions:
- tool_add_block_rule(pattern, reason): Adds a DeclarativeNetRequest block rule (e.g. pattern="||tracker.example.com").
- tool_remove_overlay(): Removes anti-adblock modals, blur filters, and restores page scrolling.
- tool_hide_element_css(selector, reason): Hides elements matching a CSS selector (display: none !important).
- tool_extract_clean_content(): Extracts clean readable text of the page without ads/sidebars.
- tool_inspect_requests(category): Audits recent network requests captured on the tab.
- tool_toggle_feature(feature, state): Toggles 'mass_block', 'new_tab_block', 'dom_cleanup', or 'iframe_blocker'.

When an action is appropriate, provide a concise explanation (1-2 sentences), followed immediately by an action block formatted exactly as:
\`\`\`action
{"tool": "tool_name", "args": {"arg1": "value"}}
\`\`\`
If no action is needed, just answer concisely.`;

      const createOptions = {
        systemPrompt,
        temperature: 0.2,
        topK: 3,
      };

      // Add download progress monitor if supported
      if (this.availabilityStatus === 'downloading') {
        createOptions.monitor = (m) => {
          m.addEventListener('downloadprogress', (e) => {
            if (e.total) {
              this.downloadProgress = Math.round((e.loaded / e.total) * 100);
            }
          });
        };
      }

      this.session = await lm.create(createOptions);
      this.availabilityStatus = 'ready';
      this.statusMessage = 'Gemini Nano Ready (On-device)';
      return this.session;
    } catch (err) {
      console.warn('[AdSniper AI] Session creation failed:', err);
      return null;
    } finally {
      this.isInitializing = false;
    }
  }

  /**
   * Classifies direct command intents from natural language prompts.
   * Ensures commands like "kill popups", "remove on click new tab", etc. ALWAYS execute.
   *
   * @param {string} promptText
   * @returns {{ tool: string, args: object, intentName: string } | null}
   */
  detectDirectIntent(promptText) {
    if (!promptText) return null;
    const lower = promptText.toLowerCase().trim();

    // 1. Popups / overlays / modals / backdrops / floating video / locked scroll
    if (
      /(kill|remove|close|stop|delete|hide|clear)\s+(popups?|overlays?|modals?|paywalls?|dialogs?|backdrops?|banners?|floating|sticky|videos?)/i.test(lower) ||
      /(unblock|enable|restore)\s*scroll/i.test(lower) ||
      lower === 'kill popups' ||
      lower === 'remove popup' ||
      lower === 'kill overlays' ||
      lower === 'clear overlays' ||
      lower === 'remove overlays'
    ) {
      return {
        tool: 'tool_remove_overlay',
        args: {},
        intentName: 'remove_overlay',
      };
    }

    // 2. New tab ads / On-click popunders / popup tabs
    if (
      /(remove|block|stop|prevent|disable|kill|turn\s*off)\s+(.*(on\s*click\s*)?new\s*tabs?|popup\s*tabs?|popunders?|new\s*windows?|opening\s*new)/i.test(lower) ||
      /(on\s*click\s*)?new\s*tabs?\s*(ads?|blocker|popups?)/i.test(lower) ||
      (lower.includes('new tab') && (lower.includes('block') || lower.includes('stop') || lower.includes('remove') || lower.includes('prevent') || lower.includes('click')))
    ) {
      return {
        tool: 'tool_toggle_feature',
        args: { feature: 'new_tab_block', state: true },
        intentName: 'block_new_tab',
      };
    }

    // 3. Mass ad blocking
    if (
      /(enable|activate|turn\s*on)\s*(mass\s*block|ad\s*blocker|all\s*shields)/i.test(lower) ||
      /block\s+all\s+(ads|trackers)/i.test(lower)
    ) {
      return {
        tool: 'tool_toggle_feature',
        args: { feature: 'mass_block', state: true },
        intentName: 'mass_block',
      };
    }

    // 4. Clean reader view / extract content
    if (
      /(reader\s*view|clean\s*article|extract\s*article|extract\s*content|read\s*mode|clean\s*reader)/i.test(lower)
    ) {
      return {
        tool: 'tool_extract_clean_content',
        args: {},
        intentName: 'extract_content',
      };
    }

    // 5. Audit trackers
    if (
      /(audit|inspect|check|scan).*?(tracker|request|telemetry|network|ad\s*call)/i.test(lower) ||
      lower.includes('audit') ||
      lower.includes('tracker') ||
      lower.includes('telemetry')
    ) {
      return {
        tool: 'tool_inspect_requests',
        args: { category: 'all' },
        intentName: 'inspect_requests',
      };
    }

    // 6. Block specific domain
    const blockMatch = promptText.match(/block\s+([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i);
    if (blockMatch && blockMatch[1]) {
      return {
        tool: 'tool_add_block_rule',
        args: { pattern: `||${blockMatch[1]}` },
        intentName: 'block_domain',
      };
    }

    return null;
  }

  /**
   * Robustly extracts an MCP action JSON object from markdown, raw strings, or native Gemini Nano format.
   * Handles:
   * 1. Triple backtick blocks (```action {"tool": ...} ```)
   * 2. Native Gemini Nano function calls (``tool_name{"arg": "val"}``)
   * 3. Balanced JSON containing "tool" with nested args objects
   *
   * @param {string} text
   * @returns {object|null}
   */
  extractActionJSON(text) {
    if (!text) return null;

    // 1. Triple backtick block: ```action ... ``` or ```json ... ``` or ``` ... ```
    const blockMatch = text.match(/```(?:action|json)?\s*([\s\S]*?)\s*```/i);
    if (blockMatch && blockMatch[1]) {
      try {
        const obj = JSON.parse(blockMatch[1].trim());
        if (obj && obj.tool) return obj;
      } catch (e) {}
    }

    // 2. Native Gemini Nano function call format:
    // e.g. ``tool_inspect_requests{"url": "...", "max_results": 10}``
    // or `tool_inspect_requests{...}` or tool_inspect_requests{...}
    const nativeMatch = text.match(/(?:`{1,3})?\s*(tool_[a-zA-Z0-9_]+)\s*(\{[\s\S]*?\})\s*(?:`{1,3})?/);
    if (nativeMatch) {
      const tool = nativeMatch[1];
      let args = {};
      try {
        args = JSON.parse(nativeMatch[2]);
      } catch (e) {}
      return { tool, args };
    }

    // 3. Parse balanced JSON containing "tool"
    const toolIdx = text.indexOf('"tool"');
    if (toolIdx !== -1) {
      const startBrace = text.lastIndexOf('{', toolIdx);
      if (startBrace !== -1) {
        let depth = 0;
        let inString = false;
        let escapeNext = false;

        for (let i = startBrace; i < text.length; i++) {
          const ch = text[i];
          if (escapeNext) {
            escapeNext = false;
            continue;
          }
          if (ch === '\\') {
            escapeNext = true;
            continue;
          }
          if (ch === '"') {
            inString = !inString;
            continue;
          }
          if (!inString) {
            if (ch === '{') depth++;
            else if (ch === '}') {
              depth--;
              if (depth === 0) {
                const candidate = text.slice(startBrace, i + 1);
                try {
                  const obj = JSON.parse(candidate);
                  if (obj && obj.tool) return obj;
                } catch (e) {}
                break;
              }
            }
          }
        }
      }
    }

    return null;
  }

  /**
   * Sanitizes reply text by stripping action code blocks, native Gemini Nano tool calls,
   * raw action JSON, and third-party recommendations.
   *
   * @param {string} text
   * @returns {string}
   */
  cleanActionFromReply(text) {
    if (!text) return '';

    // 1. Remove markdown code blocks with action or json
    let cleaned = text.replace(/```(?:action|json)?\s*[\s\S]*?```/gi, '');

    // 2. Remove native Gemini Nano tool calls: ``tool_name{...}`` or `tool_name{...}` or tool_name{...}
    cleaned = cleaned.replace(/(?:`{1,3})?\s*tool_[a-zA-Z0-9_]+\s*\{[\s\S]*?\}\s*(?:`{1,3})?/g, '');

    // 3. Remove balanced JSON object with "tool" if still present
    const toolIdx = cleaned.indexOf('"tool"');
    if (toolIdx !== -1) {
      const startBrace = cleaned.lastIndexOf('{', toolIdx);
      if (startBrace !== -1) {
        let depth = 0;
        let inString = false;
        let escapeNext = false;
        for (let i = startBrace; i < cleaned.length; i++) {
          const ch = cleaned[i];
          if (escapeNext) { escapeNext = false; continue; }
          if (ch === '\\') { escapeNext = true; continue; }
          if (ch === '"') { inString = !inString; continue; }
          if (!inString) {
            if (ch === '{') depth++;
            else if (ch === '}') {
              depth--;
              if (depth === 0) {
                cleaned = cleaned.slice(0, startBrace) + cleaned.slice(i + 1);
                break;
              }
            }
          }
        }
      }
    }

    return cleaned
      .replace(/1\.\s*Browser Extensions[\s\S]*?(\n\n|$)/gi, '')
      .replace(/.*(install|use)\s*(ublock|adblock|privacy badger).*/gi, '')
      .trim();
  }

  /**
   * Generates a forensic audit report detailing intercepted ad calls and exfiltrated data.
   *
   * @param {Array} requests
   * @param {Array} adHosts
   * @returns {string}
   */
  generateAuditReport(requests, adHosts = []) {
    if (!requests || requests.length === 0) {
      return `### 🔍 Network Ad & Tracker Audit Report\n\nNo network requests have been intercepted on this tab yet.\n\n*Tip: Browse or refresh the page to capture live ad and tracker network requests.*`;
    }

    const adHostSet = new Set((adHosts || []).map((h) => (h || '').toLowerCase()));

    const trackerKeywords = [
      'rqtrk', 'amxrtb', 'purpleads', '4dex', 'openx', 'prebid', 'creativecdn',
      'criteo', 'rubicon', 'doubleclick', 'googlesyndication', 'googleadservices',
      'google-analytics', 'adservice', 'telemetry', 'analytics', 'pixel', 'beacon',
      'metrics', 'collector', 'hotjar', 'clarity.ms', 'taboola', 'outbrain',
      'popads', 'adsterra', 'exoclick', 'adnxs', 'casalemedia', 'yieldmo',
      'pubmatic', 'smartadserver', 'inmobi', 'amazon-adsystem', 'imrworldwide',
      'statcounter', 'track', 'advert', 'banner', 'redinuid'
    ];

    const paramMeanings = {
      zpartnerid: 'Partner / Publisher ID',
      partnerid: 'Partner / Publisher ID',
      partner_id: 'Partner / Publisher ID',
      pub_id: 'Publisher Account ID',
      publisher_id: 'Publisher Account ID',
      pubid: 'Publisher Account ID',
      site_id: 'Target Website ID',
      siteid: 'Target Website ID',
      reqid: 'Auction Request ID',
      req_id: 'Auction Request ID',
      request_id: 'Auction Request ID',
      bid_id: 'Bidding Transaction ID',
      auction_id: 'Ad Auction ID',
      ref: 'Page Referrer / Origin URL',
      referrer: 'Page Referrer / Origin URL',
      domain: 'Host Domain Name',
      url: 'Origin Page URL',
      page: 'Current Page URL',
      tz: 'User Timezone Offset',
      res: 'Screen Resolution',
      screen: 'Display Dimensions',
      vw: 'Viewport Width',
      vh: 'Viewport Height',
      os: 'Client Operating System',
      browser: 'Browser User Agent',
      lang: 'Browser Language',
      uid: 'User / Visitor Tracking ID',
      uuid: 'Unique Identifier',
      visitor_id: 'Unique Visitor ID',
      cid: 'Client / Cookie ID',
      cookie: 'User Tracking Cookie',
      tid: 'Tracking Account ID',
      fledge: 'Protected Audience (FLEDGE) Auction Data',
      topics: 'Browsing Topics API Interest Profile',
      consent: 'Consent Management String',
      gdpr: 'GDPR Applicability Flag',
      gdpr_consent: 'TCF Consent String',
      ccpa: 'CCPA / US Privacy String',
      v: 'Measurement Protocol Version',
      en: 'Event Name',
      ep: 'Event Parameter',
    };

    const detected = [];
    const seenEndpoints = new Set();

    for (const req of requests) {
      const rawUrl = req.url || '';
      if (!rawUrl) continue;
      const lowerUrl = rawUrl.toLowerCase();

      let hostname = '';
      let pathname = '';
      const searchParams = [];
      try {
        const u = new URL(rawUrl);
        hostname = u.hostname.toLowerCase();
        pathname = u.pathname;
        u.searchParams.forEach((val, key) => {
          searchParams.push({ key, val });
        });
      } catch (e) {
        continue;
      }

      // Detect if URL matches adHosts or tracker keywords
      const isAdHost = adHostSet.has(hostname) || Array.from(adHostSet).some((h) => hostname.endsWith('.' + h));
      const isTrackerKeyword = trackerKeywords.some((kw) => lowerUrl.includes(kw));

      if (isAdHost || isTrackerKeyword) {
        const dedupKey = `${hostname}${pathname}`;
        if (seenEndpoints.has(dedupKey)) continue;
        seenEndpoints.add(dedupKey);

        let category = 'Ad Serving Network';
        if (/bid|auction|rtb|openx|prebid|creativecdn|criteo|amxrtb/i.test(lowerUrl)) {
          category = 'Real-Time Ad Auction / Bidding';
        } else if (/analytics|telemetry|stats|clarity|hotjar|mixpanel|imrworldwide|redinuid/i.test(lowerUrl)) {
          category = 'User Tracking & Telemetry';
        } else if (/pixel|beacon|tr\/|collect/i.test(lowerUrl)) {
          category = 'Tracking Pixel / Beacon';
        } else if (/popup|popunder|popads/i.test(lowerUrl)) {
          category = 'Popup / Popunder Network';
        }

        detected.push({
          hostname,
          pathname,
          fullUrl: rawUrl,
          type: req.type || 'script',
          method: req.method || 'GET',
          postData: req.postData || null,
          category,
          searchParams,
        });
      }
    }

    if (detected.length === 0) {
      return `### 🔍 Network Ad & Tracker Audit Report\n\n**Total requests monitored:** ${requests.length} | **Ad & Tracking calls detected:** 0\n\n✅ **Clean page!** No third-party ad networks, bidding exchanges, or telemetry trackers were detected in the recent network traffic for this tab.`;
    }

    let report = `### 🔍 Network Ad & Tracker Audit Report\n\n`;
    report += `**Total monitored requests:** ${requests.length} | **Ad/Tracker calls detected:** ${detected.length}\n\n`;
    report += `Below is the forensic breakdown of detected ad calls and data transmitted:\n\n`;

    detected.slice(0, 10).forEach((item, idx) => {
      report += `#### ${idx + 1}. 📡 **${item.hostname}** \`[${item.type}]\`\n`;
      report += `- **Category**: ${item.category}\n`;
      report += `- **Endpoint**: \`${item.hostname}${item.pathname}\`\n`;
      report += `- **HTTP Method**: \`${item.method}\`\n`;

      if (item.searchParams.length > 0) {
        report += `- **Data Sent (Exfiltrated Parameters)**:\n`;
        item.searchParams.slice(0, 8).forEach((p) => {
          const lowerKey = p.key.toLowerCase();
          const annotation = paramMeanings[lowerKey] ? ` *(${paramMeanings[lowerKey]})*` : '';
          const safeVal = p.val.length > 60 ? p.val.slice(0, 57) + '…' : p.val;
          report += `  • \`${p.key}\`: \`${safeVal}\`${annotation}\n`;
        });
        if (item.searchParams.length > 8) {
          report += `  • *...and ${item.searchParams.length - 8} more parameters*\n`;
        }
      } else {
        report += `- **Data Sent**: No URL query parameters attached (direct asset load).\n`;
      }

      if (item.postData) {
        const postSnippet = typeof item.postData === 'string'
          ? item.postData.slice(0, 120)
          : JSON.stringify(item.postData).slice(0, 120);
        report += `- **POST Payload Sent**: \`${postSnippet}\`\n`;
      }

      report += `\n`;
    });

    if (detected.length > 10) {
      report += `\n*(+ ${detected.length - 10} additional tracking endpoints monitored on this tab)*\n\n`;
    }

    report += `---\n**🛡️ Protection**: You can type *"Block ${detected[0].hostname}"* or *"Block all trackers"* to immediately add DeclarativeNetRequest dynamic rules!`;

    return report;
  }

  /**
   * Processes a user prompt with context, executing actions when triggered.
   * Includes fallback heuristic execution if Gemini Nano is not currently ready.
   *
   * @param {string} promptText
   * @param {object} context - { activeTabId, activeTabUrl, recentRequests }
   * @param {function} onToken - streaming callback (token) => void
   * @returns {Promise<{ reply: string, actionExecuted?: object }>}
   */
  async processPrompt(promptText, context, onToken = null) {
    const trimmed = promptText.trim();
    if (!trimmed) return { reply: 'Please enter a request.' };

    // ── Check Direct Intent First ──
    const directIntent = this.detectDirectIntent(trimmed);
    let preExecutedAction = null;

    if (directIntent) {
      preExecutedAction = await this.executeMcpAction(directIntent.tool, directIntent.args, context);

      // If user requested audit / inspect requests, return the forensic report immediately
      if (directIntent.intentName === 'inspect_requests' && preExecutedAction.report) {
        const reply = preExecutedAction.report;
        if (onToken) onToken(reply);
        return { reply, actionExecuted: preExecutedAction };
      }

      if (onToken) {
        onToken(`⚡ Executing action: ${preExecutedAction.message || directIntent.tool}…`);
      }
    }

    const session = await this.getOrCreateSession();

    if (session) {
      try {
        // Extract clean unique hostnames from recent requests (avoid dumping long query parameters)
        const hostnames = [];
        if (context.recentRequests && context.recentRequests.length > 0) {
          const seen = new Set();
          for (const r of context.recentRequests) {
            try {
              const h = new URL(r.url).hostname;
              if (h && !seen.has(h)) {
                seen.add(h);
                hostnames.push(h);
                if (hostnames.length >= 8) break;
              }
            } catch (e) {}
          }
        }

        let contextSnippet = `Active Page: ${context.activeTabUrl || 'Unknown'}\n`;
        if (hostnames.length > 0) {
          contextSnippet += `Detected Network Hosts: ${hostnames.join(', ')}\n`;
        }
        if (preExecutedAction) {
          contextSnippet += `AdSniper Executed Action: ${preExecutedAction.message}\n`;
        }

        const systemDirective = `[YOU ARE ADSNIPER, AN ACTIVE IN-BROWSER EXTENSION RUNNING ON THIS TAB]
You have direct browser automation tools to protect this tab.
NEVER tell the user to install other extensions (e.g. uBlock Origin, AdBlock).
If the user asks to block ads, kill popups, or stop new tabs, you MUST execute an action:
\`\`\`action
{"tool": "tool_name", "args": {...}}
\`\`\`
Available tools:
- tool_remove_overlay: clears popups, overlays, sticky video modals, paywalls, and restores scrolling.
- tool_toggle_feature: { "feature": "new_tab_block" } to block new-tab popup ads/clicks, or "mass_block" for all ad patterns.
- tool_add_block_rule: { "pattern": "||domain.com" } to block a network ad domain.
- tool_hide_element_css: { "selector": "..." } to hide DOM elements.
- tool_extract_clean_content: extracts clean reader text.
- tool_inspect_requests: audits recent network calls.`;

        const fullPrompt = `${systemDirective}\n\n${contextSnippet}\nUser Request: ${trimmed}`;

        let fullResponse = '';
        if (typeof session.promptStreaming === 'function' && onToken) {
          const stream = session.promptStreaming(fullPrompt);
          for await (const rawChunk of stream) {
            const chunk = typeof rawChunk === 'string' ? rawChunk : (rawChunk && rawChunk.text ? rawChunk.text : String(rawChunk || ''));
            if (!chunk) continue;

            if (fullResponse && chunk.startsWith(fullResponse)) {
              fullResponse = chunk;
            } else if (fullResponse && chunk === fullResponse) {
              continue;
            } else {
              fullResponse += chunk;
            }

            // Clean action block, native tool calls, and raw JSON while streaming so technical payloads do not flicker
            const displaySnippet = this.cleanActionFromReply(fullResponse);
            if (displaySnippet) {
              onToken(displaySnippet);
            }
          }
        } else {
          fullResponse = await session.prompt(fullPrompt);
          const displaySnippet = this.cleanActionFromReply(fullResponse);
          if (onToken && displaySnippet) onToken(displaySnippet);
        }

        // Parse action block (from markdown or raw JSON)
        const parsedAction = this.extractActionJSON(fullResponse);
        let actionResult = preExecutedAction;
        if (parsedAction && parsedAction.tool) {
          try {
            if (!actionResult || actionResult.tool !== parsedAction.tool) {
              actionResult = await this.executeMcpAction(parsedAction.tool, parsedAction.args || {}, context);
            }
          } catch (e) {
            console.warn('[AdSniper AI] Failed to parse/execute model action:', e);
          }
        }

        // If action was tool_inspect_requests, use its detailed report!
        if (actionResult && actionResult.tool === 'tool_inspect_requests' && actionResult.report) {
          return { reply: actionResult.report, actionExecuted: actionResult };
        }

        // If no action was executed yet, run fallback intent resolution
        if (!actionResult) {
          const fallbackIntent = this.detectDirectIntent(fullResponse) || this.detectDirectIntent(trimmed);
          if (fallbackIntent) {
            actionResult = await this.executeMcpAction(fallbackIntent.tool, fallbackIntent.args, context);
            if (actionResult.tool === 'tool_inspect_requests' && actionResult.report) {
              return { reply: actionResult.report, actionExecuted: actionResult };
            }
          }
        }

        // Post-processing sanitization: strip any raw JSON action blocks and third-party recommendations
        let cleanedReply = this.cleanActionFromReply(fullResponse);

        // If an action was executed, prepend confirmation banner
        if (actionResult && actionResult.success) {
          if (!cleanedReply) {
            cleanedReply = `✅ **${actionResult.message}**\n\nAdSniper has executed the requested action on this tab.`;
          } else if (!cleanedReply.toLowerCase().includes('executed') && !cleanedReply.toLowerCase().includes('removed') && !cleanedReply.toLowerCase().includes('activated') && !cleanedReply.toLowerCase().includes('cleared')) {
            cleanedReply = `✅ **${actionResult.message}**\n\n${cleanedReply}`;
          }
        }

        return { reply: cleanedReply || fullResponse, actionExecuted: actionResult };

      } catch (err) {
        console.warn('[AdSniper AI] Prompt execution failed, falling back to heuristics:', err);
      }
    }

    // If session is unavailable or failed, but we pre-executed action:
    if (preExecutedAction) {
      const reply = preExecutedAction.report || `✅ **${preExecutedAction.message}**\n\nAdSniper on-device engine executed your command immediately.`;
      if (onToken) onToken(reply);
      return { reply, actionExecuted: preExecutedAction };
    }

    // Fallback heuristic execution
    return await this.executeHeuristicFallback(trimmed, context, onToken);
  }

  /**
   * Fallback rule-based action processor for offline / pre-download states.
   */
  async executeHeuristicFallback(prompt, context, onToken) {
    const directIntent = this.detectDirectIntent(prompt);
    let reply = '';
    let actionResult = null;

    if (directIntent) {
      actionResult = await this.executeMcpAction(directIntent.tool, directIntent.args, context);
      reply = actionResult.report || (actionResult.success
        ? `✅ **${actionResult.message}**\n\nAdSniper on-device heuristics executed your request.`
        : `⚠️ Attempted to run ${directIntent.tool}: ${actionResult.error || 'Failed'}`);
      if (onToken) onToken(reply);
      return { reply, actionExecuted: actionResult };
    }

    const lower = prompt.toLowerCase();
    if (lower.includes('audit') || lower.includes('tracker') || lower.includes('inspect')) {
      reply = 'Auditing recent network calls for telemetry and trackers...';
      if (onToken) onToken(reply);
      actionResult = await this.executeMcpAction('tool_inspect_requests', { category: 'all' }, context);
      reply = actionResult.report || actionResult.summary || 'Audit complete.';
    } else if (lower.includes('reader') || lower.includes('clean') || lower.includes('read') || lower.includes('article') || lower.includes('text')) {
      reply = 'Extracting clean reader text from page...';
      if (onToken) onToken(reply);
      actionResult = await this.executeMcpAction('tool_extract_clean_content', {}, context);
      reply = actionResult.text ? `📖 Clean Content Extracted:\n\n${actionResult.text.slice(0, 400)}...` : 'Could not extract article text from this tab.';
    } else {
      reply = `[On-device AI Note: Gemini Nano is in "${this.availabilityStatus || 'initializing'}" mode. You can enable chrome://flags/#prompt-api for generative answers.]\n\nI can execute commands directly:\n• "Kill popups and overlays"\n• "Remove on click new tab"\n• "Audit trackers on this tab"\n• "Extract reader text"\n• "Block <domain>"`;
      if (onToken) onToken(reply);
    }

    return { reply, actionExecuted: actionResult };
  }

  /**
   * Dispatches and executes an MCP Action against AdSniper components.
   *
   * @param {string} toolName
   * @param {object} args
   * @param {object} context
   */
  async executeMcpAction(toolName, args = {}, context = {}) {
    const { activeTabId } = context;

    switch (toolName) {
      case 'tool_add_block_rule': {
        const pattern = args.pattern || (args.domain ? `||${args.domain}` : null);
        if (!pattern) return { success: false, error: 'No pattern specified' };

        try {
          const resp = await chrome.runtime.sendMessage({
            type: 'ADD_BLOCK_RULE',
            pattern,
          });
          return {
            success: resp && resp.ok !== false,
            tool: toolName,
            pattern,
            ruleId: resp ? resp.ruleId : null,
            message: `Rule ${pattern} added to blocklist`,
          };
        } catch (err) {
          return { success: false, error: err.message };
        }
      }

      case 'tool_remove_overlay': {
        try {
          const sendFn = (typeof sendToTab === 'function') ? sendToTab : (typeof window !== 'undefined' && typeof window.sendToTab === 'function' ? window.sendToTab : null);
          let removed = 0;
          if (sendFn) {
            const resp = await sendFn({ type: 'AI_REMOVE_OVERLAY' });
            removed = (resp && resp.removed) ? resp.removed : 0;
          } else if (activeTabId) {
            const resp = await chrome.tabs.sendMessage(activeTabId, { type: 'AI_REMOVE_OVERLAY' });
            removed = (resp && resp.removed) ? resp.removed : 0;
          }
          return {
            success: true,
            tool: toolName,
            removedCount: removed,
            message: `Overlays and popups cleared (${removed} elements removed, scroll unlocked)`,
          };
        } catch (err) {
          return { success: false, error: err.message };
        }
      }

      case 'tool_hide_element_css': {
        if (!args.selector) return { success: false, error: 'No selector provided' };
        try {
          const sendFn = (typeof sendToTab === 'function') ? sendToTab : (typeof window !== 'undefined' && typeof window.sendToTab === 'function' ? window.sendToTab : null);
          let count = 0;
          if (sendFn) {
            const resp = await sendFn({ type: 'AI_HIDE_SELECTOR', selector: args.selector });
            count = (resp && resp.count) ? resp.count : 0;
          }
          return {
            success: true,
            tool: toolName,
            selector: args.selector,
            hiddenCount: count,
            message: `Hidden elements matching ${args.selector}`,
          };
        } catch (err) {
          return { success: false, error: err.message };
        }
      }

      case 'tool_extract_clean_content': {
        try {
          const sendFn = (typeof sendToTab === 'function') ? sendToTab : (typeof window !== 'undefined' && typeof window.sendToTab === 'function' ? window.sendToTab : null);
          let text = '';
          let words = 0;
          if (sendFn) {
            const resp = await sendFn({ type: 'AI_EXTRACT_CONTENT' });
            text = (resp && resp.text) ? resp.text : '';
            words = (resp && resp.wordCount) ? resp.wordCount : 0;
          }
          return {
            success: true,
            tool: toolName,
            text: text,
            wordCount: words,
            message: `Extracted ${words} words of clean content`,
          };
        } catch (err) {
          return { success: false, error: err.message };
        }
      }

      case 'tool_inspect_requests': {
        const tabId = activeTabId;
        let requests = (context && context.recentRequests && context.recentRequests.length > 0)
          ? context.recentRequests
          : [];

        if (requests.length === 0 && tabId) {
          const stored = await chrome.storage.local.get(`requests_${tabId}`);
          requests = stored[`requests_${tabId}`] || [];
        }

        const { adHosts = [] } = await chrome.storage.local.get('adHosts');
        const report = this.generateAuditReport(requests, adHosts);

        return {
          success: true,
          tool: toolName,
          totalRequests: requests.length,
          report: report,
          message: `Audit complete: scanned ${requests.length} network requests`,
        };
      }

      case 'tool_toggle_feature': {
        const { feature, state } = args;

        if (feature === 'new_tab_block') {
          const toggleFn = (typeof toggleNewTabBlock === 'function') ? toggleNewTabBlock : (typeof window !== 'undefined' ? window.toggleNewTabBlock : null);
          if (toggleFn) {
            await toggleFn();
          } else {
            // Direct DNR rules creation for ad hosts (main_frame only)
            const { adHosts = [] } = await chrome.storage.local.get('adHosts');
            const rules = [];
            let id = 40001;
            for (const host of adHosts) {
              if (!host || id >= 50000) break;
              rules.push({
                id: id++,
                priority: 3,
                action: { type: 'block' },
                condition: { urlFilter: `||${host}`, resourceTypes: ['main_frame'] },
              });
            }
            if (rules.length > 0) {
              await chrome.declarativeNetRequest.updateDynamicRules({ addRules: rules, removeRuleIds: [] });
              await chrome.storage.local.set({ newTabBlockActive: true, newTabBlockRuleIds: rules.map((r) => r.id) });
            }
          }
          return {
            success: true,
            tool: toolName,
            feature,
            message: 'Block New Tab Ads has been activated',
          };
        }

        if (feature === 'mass_block') {
          const toggleFn = (typeof toggleMassBlock === 'function') ? toggleMassBlock : (typeof window !== 'undefined' ? window.toggleMassBlock : null);
          if (toggleFn) {
            await toggleFn();
          }
          return {
            success: true,
            tool: toolName,
            feature,
            message: 'Mass ad blocking rules toggled',
          };
        }

        return {
          success: true,
          tool: toolName,
          feature,
          state,
          message: `Feature ${feature} set to ${state}`,
        };
      }

      default:
        return { success: false, error: `Unknown tool: ${toolName}` };
    }
  }

  /**
   * Destroys the active session to immediately free RAM/VRAM.
   */
  destroy() {
    if (this.session) {
      try {
        if (typeof this.session.destroy === 'function') {
          this.session.destroy();
        }
      } catch (e) {
        console.warn('[AdSniper AI] Error destroying session:', e);
      }
      this.session = null;
    }
  }
}

// Attach to window for global popup access
if (typeof window !== 'undefined') {
  window.GeminiNanoClient = GeminiNanoClient;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = GeminiNanoClient;
}
