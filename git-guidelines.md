# AI Agent Git & Modification Guidelines

This document contains strict guardrails for AI coding assistants. Include this file in your prompts or configure it in your AI's context (e.g., via `.cursorrules` or `.windsurfrules`) to prevent destructive actions and regressions.

## 1. Git Guardrails (Ban on Destructive Commands)
- **No Indiscriminate Checkouts:** NEVER run `git checkout <file>`, `git checkout .`, `git restore .`, or `git reset --hard` to bail out of syntax errors or bad replacements without explicit user permission.
- **Manual Undo:** If an automated code replacement fails or causes syntax errors, manually undo the specific lines or ask the user how they would like to proceed.
- **Use Feature Branches:** When making significant structural changes, rewriting logic, or attempting complex refactors, use a temporary branch (e.g., `git checkout -b ai-fixes-<feature>`).
- **Diff Before Commit:** Always run and review `git diff` before committing. Ensure that no recent features, bug fixes, or unrelated event listeners were inadvertently deleted during code modification.
- **Never Commit/Push to Master:** Absolutely NO commits or pushes directly to the `master` branch. All AI work must be done on a separate branch, and the user will handle merges.

## 2. Code Modification Guardrails (Ban on Large String Replacements)
- **Surgical Edits Only:** DO NOT replace entire functions, classes, or files using large, hardcoded string replacements (e.g., via PowerShell `$code -replace` blocks or massive sed commands).
- **Use AST / Precise Ranges:** Use Abstract Syntax Tree (AST) editing tools, precise line-by-line tools (e.g., `replace_file_content` with strict `StartLine` and `EndLine` ranges), or provide the exact diff for the user to apply.
- **Preserve Context:** The AI must ensure it is operating on the *current* state of the file, not an outdated version in its memory.

## 3. Chrome Extension / Service Worker Guardrails
- **Service Worker Constraints:** Code running in a Chrome Extension Service Worker (`background.js`, `service-worker.js`) MUST NOT reference DOM objects like `window` or `document`.
- **Linting:** Ensure ESLint is configured with the `serviceworker` and `webextensions` environments, and ensure it passes before committing changes that move execution from the foreground to the background.
- **Message Passing:** Rely strictly on `chrome.runtime.sendMessage` and `chrome.runtime.onMessage.addListener` for communication between UI scripts and the background worker, rather than `window.dispatchEvent`.
