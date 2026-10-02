
const fs = require('fs');
const path = require('path');
const p = path.join(__dirname, 'adsniper', 'content', 'content.js');
let text = fs.readFileSync(p, 'utf-8');

// The listener ends around line 130-150. Let's find the end of the listener.
const listenerEndMatch = /\s*return true;\s*\}\);/g;
text = text.replace(listenerEndMatch, '
});');

// Add return true ONLY for AI_EXECUTE_SCRIPT
const execMatch = /case 'AI_EXECUTE_SCRIPT': \{[\s\S]*?sendResponse\(response\);\n      \}\);\n      break;\n    \}/;
const execRep = \case 'AI_EXECUTE_SCRIPT': {
      // Forward the execution to the background script to run in MAIN world
      chrome.runtime.sendMessage({
        type: 'AI_EXECUTE_SCRIPT_MAIN_WORLD',
        code: message.code
      }, (response) => {
        sendResponse(response);
      });
      return true; // Keep message channel open for async response
    }\;
text = text.replace(execMatch, execRep);

fs.writeFileSync(p, text, 'utf-8');
console.log('Fixed C3');
