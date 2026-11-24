## Pick a model

Issue Commit needs a chat model. Run **Issue Commit: Set Up Model…** and pick one:

| Option | What you need |
|---|---|
| **GitHub Copilot** | Nothing; it uses the Copilot models already in VS Code |
| OpenAI, DeepSeek, Qwen, Kimi, GLM, SiliconFlow, OpenRouter | An API key |
| Ollama / LM Studio | A model running on this machine |
| Anything else | An OpenAI-compatible `/chat/completions` URL |

The wizard lists the provider's models for you, stores the key in VS Code Secret Storage (not in `settings.json`), and sends one test request.

A small, cheap model is enough: one message costs roughly 6 short requests.
