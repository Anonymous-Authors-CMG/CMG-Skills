# Changelog

## 1.0.0

First public release.

**Easier to start**
- **Set Up Model…**: pick GitHub Copilot or a provider (OpenAI, DeepSeek, Qwen, Kimi, GLM, SiliconFlow, OpenRouter, Ollama, LM Studio, or any OpenAI-compatible API), paste a key, choose from the provider's live model list, and get a connection test. The key goes to Secret Storage.
- GitHub Copilot and other VS Code language models work with no key (`model.provider: vscode-lm`).
- If no model is configured, you're offered the setup instead of an error.
- A Get Started walkthrough.

**Fewer clicks**
- The draft is written as soon as the search finishes; a strong match is pre-selected (`issues.autoSelect`, `workflow.autoGenerate`).
- **Revise**: ask for a change in plain words.
- Quick mode: pick the issue from a list and write straight to the commit box (`workflow.scmButton: quick`).
- One panel per repository; ✨ again reuses it. <kbd>⌘/Ctrl</kbd>+<kbd>Enter</kbd> uses the message; the panel closes after use.

**Better results**
- Issue numbers in branch names (`fix/123-…`) are always considered.
- Recent commit messages are used as style examples (`message.useHistory`).
- House rules via `message.instructions`; `message.format: plain` for projects without Conventional Commits.
- Short references: `Refs #12` in the home repository, `owner/repo#12` on the same host, a URL otherwise.
- Title scanning runs in parallel; small issue lists skip it; issue lists are cached (`issues.cacheMinutes`).
- Lock files, minified bundles and source maps are no longer sent.
- Off-format replies are retried once with feedback instead of failing; extra trailer lines from the model are removed.
- The What / Why score also sees the linked issue.
- English and Chinese UI; the message language follows VS Code by default.
- Clearer errors, including a hint to add a token when GitHub rate-limits.

## 0.1.x

Internal builds: native panel, two-stage issue retrieval, Secret Storage tokens, connection check.
