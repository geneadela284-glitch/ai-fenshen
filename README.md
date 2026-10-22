# AI Fenshen （AI分身）

**A local-first personal AI assistant with long-term memory, voice chat, and meeting intelligence.**

AI Fenshen is a personal AI "second self" that lives on your own devices. Your data stays local first; the assistant remembers your context across conversations, talks with you by voice, and turns meetings into summaries, decisions, and action items. It is model-agnostic: a built-in AI gateway routes each task to the most suitable model provider, with automatic fallback.

> Status: early development (v0.2.0). This repository is a reviewed source snapshot of the production codebase. Private configuration, user data, and deployment credentials are not included.

## Features

- **Voice chat** — real-time spoken conversation with the assistant, tuned for natural back-and-forth.
- **Meeting center** — recordings become structured results: summary first, then decisions and action items, with detail on demand. Exports to DOCX and PPTX.
- **Long-term memory** — a dedicated memory layer (210 source files) that persists people, context, and history across sessions.
- **Multi-model gateway** — provider routing, protocol compatibility, and fallback across model vendors, so no single API is a hard dependency.
- **Privacy by design** — local-first storage, API-key masking, and log redaction that strips keys, prompts, and personal paths before anything is written to diagnostics.
- **Desktop + mobile** — Electron-style desktop app, a server component, and a native mobile shell (Swift).

## Architecture

| Directory | Contents |
|---|---|
| `apps/` | Desktop application and UI components |
| `core/` | AI gateway, memory engine, settings, security |
| `server/` | Backend services and APIs |
| `memory/` | Long-term memory storage and retrieval |
| `mobile/` | Native mobile shell |
| `scripts/` | Release assembly, project-state, and model-evaluation tooling |

## Quick start

Requires Node.js (see `package.json` engines) and pnpm. The server runtime additionally needs `node:sqlite` support.

```bash
pnpm install --frozen-lockfile
pnpm dev        # desktop dev preview
pnpm build      # production build
```

This snapshot is not a deployment bundle: it contains no accounts, model API keys, user data, or deployment configuration. Supply your own provider keys via environment variables at runtime.

## Roadmap

See [ROADMAP.md](ROADMAP.md) and [CHANGELOG.md](CHANGELOG.md).

## Contributing

Issues and pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). Please never commit API keys, user data, or private configuration.

## License

Original code is released under the [MIT License](LICENSE), © geneadela284-glitch. Third-party code and assets retain their own licenses.

---

# AI分身（中文）

**一款本地优先、带永久记忆的个人 AI 助手，支持语音聊天与会议智能。**

AI分身是住在你自己设备上的"数字分身"：数据本地优先保存，跨会话记住你的上下文，能用语音自然对话，能把会议自动整理成摘要、决定和待办。它不绑定单一大模型——内置 AI 网关会按任务选择最合适的模型，并支持自动兜底切换。

当前状态：早期开发版（v0.2.0）。本仓库是经脱敏审查的生产源码快照，不含私有配置、用户数据和部署凭据。

核心功能：

- **语音聊天**：实时语音对话，专为自然往返交流优化
- **会议中心**：录音自动生成摘要、决定、待办，可导出 DOCX / PPTX
- **永久记忆**：独立的记忆层，跨会话保存人物、背景与历史
- **多模型网关**：多家模型路由、协议兼容与故障兜底
- **隐私设计**：本地优先存储、密钥打码、日志自动脱敏

本地运行（需要 Node.js 与 pnpm）：

```bash
pnpm install --frozen-lockfile
pnpm dev
```

原创代码采用 [MIT 许可证](LICENSE)。欢迎提 Issue 和 PR，见 [CONTRIBUTING.md](CONTRIBUTING.md)。
