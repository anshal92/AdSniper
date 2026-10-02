
const fs = require('fs');
const path = require('path');
const p = path.join(__dirname, 'adsniper', 'ai', 'nano-client.js');
let text = fs.readFileSync(p, 'utf-8');

const r1 = /async getOrCreateSession\(\) \{[\s\S]*?finally \{[\s\S]*?\}\s*\}/;
const rep1 = \sync getOrCreateSession() {
    if (this.session) return this.session;
    if (this._sessionInitPromise) return await this._sessionInitPromise;

    this._sessionInitPromise = (async () => {
      const lm = this.getLanguageModelAPI();
      if (!lm) return null;
      try {
        const systemPrompt = await this.getSystemPrompt();
        const createOptions = { systemPrompt, temperature: 0.2, topK: 3 };
        if (this.availabilityStatus === 'downloading') {
          createOptions.monitor = (m) => {
            m.addEventListener('downloadprogress', (e) => {
              if (e.total) this.downloadProgress = Math.round((e.loaded / e.total) * 100);
            });
          };
        }
        let sess;
        try { sess = await lm.create(createOptions); }
        catch (e) {
          try { sess = await lm.create({ systemPrompt }); }
          catch (e) { sess = await lm.create(); }
        }
        this.availabilityStatus = 'ready';
        this.statusMessage = 'Gemini Nano Ready (On-device)';
        return sess;
      } catch (err) {
        console.warn('[AdSniper AI] Session creation failed:', err);
        return null;
      }
    })();
    try {
      this.session = await this._sessionInitPromise;
      return this.session;
    } finally {
      this._sessionInitPromise = null;
    }
  }\;
text = text.replace(r1, rep1);

const r2 = /async getAssistantSession\(\) \{[\s\S]*?finally \{[\s\S]*?\}\s*\}/;
const rep2 = \sync getAssistantSession() {
    if (this.assistantSession) return this.assistantSession;
    if (this._assistantInitPromise) return await this._assistantInitPromise;

    this._assistantInitPromise = (async () => {
      const lm = this.getLanguageModelAPI();
      if (!lm) return null;
      try {
        const currentContext = '\n\n[SYSTEM CONTEXT]\nCurrent Date & Time: ' + new Date().toString();
        const systemPrompt = GeminiNanoClient.ASSISTANT_SYSTEM_PROMPT + currentContext;
        const createOptions = { systemPrompt, temperature: 0.7, topK: 3 };
        let sess;
        try { sess = await lm.create(createOptions); }
        catch (e) {
          try { sess = await lm.create({ systemPrompt }); }
          catch (e) { sess = await lm.create(); }
        }
        return sess;
      } catch (err) {
        console.warn('[AdSniper AI] Assistant Session creation failed:', err);
        return null;
      }
    })();
    try {
      this.assistantSession = await this._assistantInitPromise;
      return this.assistantSession;
    } finally {
      this._assistantInitPromise = null;
    }
  }\;
text = text.replace(r2, rep2);

fs.writeFileSync(p, text, 'utf-8');
console.log('Done!');
