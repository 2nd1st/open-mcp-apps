# open-mcp-apps

[English](README.md) | **简体中文**

> 给你的 AI 一个持久、可复用的 UI。它把组件搭一次——你永久拥有。

**open-mcp-apps** 是一个基于 [MCP Apps](https://modelcontextprotocol.io/extensions/apps/overview)
标准(`ui://`, SEP-1865)构建的开放引擎。它给任何支持 MCP Apps 的 host(Claude Desktop、claude.ai
……)提供标准本身不提供的三样东西:

1. **一个 AI 可写入的组件 registry。** 想要一个还不存在的 UI——AI 读一份 authoring guide,针对一个
   极小的 `window.oma` API 写出单文件 HTML 组件并保存。从那一刻起 `open_<name>` 就是一个 tool,在
   这个对话和以后每个对话里都在。
2. **持久、带版本的数据——与 UI 分离。** 组件绑定到通用的 *collections*(item 的集合),背后是 SQLite
   加一条 append-only 的 `change_event` ledger。每次修改都是幂等的 domain command(`command_id`),带
   乐观并发(`expected_version`)。AI 和人编辑同一份 store——widget 只是一个视图。
3. **一个让 AI 写的组件真正能跑的 shell runtime。** 在提供 `ui://` 时,引擎用官方 MCP App bridge、
   host 主题(Claude 的 design tokens,明/暗)、和 `window.oma` 数据 API 把组件包起来。一个组件约
   50 行视图代码;协议、持久化、幂等、主题都是引擎的事。

## The loop(循环)

```
"给我做个 kanban"
      │
      ▼
list_components ── 已存在? ──► open_kanban          (复用,秒开)
      │ 否
      ▼
get_component_guide ──► AI 写 HTML ──► save_component
      │
      ▼
open_kanban  →  内联渲染、带主题、持久——以后每个对话都能复用
```

组件会不断积累。每个都是单一用途、彼此独立的——一块看板、一个追踪器、一个分账器——为你眼前的任务
铸造,并为你下次需要时留存。

## 安装

open-mcp-apps 是一个本地 MCP server。先把它**接上**你的 host(见下);之后 **onboarding 在 host 里
单独发生**——那才是 AI 建你第一个 app 的地方。安装需要 shell,所以聊天 app(Claude Desktop、Codex)
自己装不了,用下面之一:

**普通用户——一条命令:**

```bash
curl -fsSL https://raw.githubusercontent.com/2nd1st/open-mcp-apps/main/install.sh | sh
```

它会弹一个简短选择器,让你勾选注册到哪些 host —— **Claude Desktop、Claude Code、Codex** —— 以及权限偏好。
加 `-s -- --yes` 跳过选择器,或 `-s -- --host codex` 只装某个 host。(或自己 clone 后跑:
`git clone https://github.com/2nd1st/open-mcp-apps && cd open-mcp-apps && node install.mjs`。)

**用编码 agent**(Claude Code、Codex CLI——它们有 shell),粘:

> Read https://raw.githubusercontent.com/2nd1st/open-mcp-apps/main/install.md and follow it.

两种方式最终都靠 `install.mjs` 把 server 幂等注册进你勾选的每个 host(Claude Desktop、Claude Code、Codex)——
不覆盖其它 server,pin 住那个 `node`(原生 SQLite ABI),报告改了什么,并清理 rename 前的旧 entry。你的数据
存在一个**固定的用户级 store**(不在 clone 里),所以每个 host 看到同一份 app 和数据。**装完/更新后,彻底退出
并重开 host**(Cmd-Q,不是关窗)—— 不彻底退出,它会一直挂着连旧数据的旧 server 进程。*remote / 一键安装
(不用 shell)之后再做。*

**然后开始用——在 host 里。** 重启 host。第一次用?对 AI 说一句,比如 **"我刚装了 open-mcp-apps,
给我介绍下怎么用、给几个例子,并建议几个适合我的 app。"** 它会看自己能建什么、翻它对你的了解(记忆 +
历史对话,不够就问你几句),然后为你建一两个贴合的 app。这一步与安装分开、在 host 里。或者直接问:

- *"给我做个板子管我现在手头的事"* → AI 现写、填初始数据、打开(持久)
- *"make me a habit tracker"* → 看它读 guide、写组件、保存、打开
- 关掉 app、重开、再问一次 → 一切都还在

**首次权限:** 头几个 tool call 各弹一次批准框——选 **"Always allow"**。工具集刻意做得小而稳定:只读
tool 一般免批准,而单个 `open_component` tool 覆盖打开*每一个*组件(包括 AI 之后创建的),所以头几次点完
就永久零弹窗。你也可以在 **Settings → Connectors → open-mcp-apps → Tool permissions** 里批量设。注意:
Desktop 自动更新偶尔会重置这些决定(上游
[#56954](https://github.com/anthropics/claude-code/issues/56954))——重新允许即可。一个对话里多个
widget 并存没问题(kanban + notes + pomodoro 并排)。

## 盒子里有什么

| | |
|---|---|
| `src/server.mjs` | stdio MCP server;单一 `open_component` 打开路径(per-component `open_<name>` tool 需 opt-in) |
| `src/http.mjs` | `/mcp`(无状态 Streamable HTTP)+ `/view/<name>` 浏览器 viewer,绑定 `127.0.0.1` |
| `src/store.mjs` | SQLite:item + 组件 registry + `change_event` ledger(幂等,乐观并发) |
| `src/shell-runtime.js` | 注入每个组件的浏览器 runtime(`window.oma`) |
| `src/shell.mjs` | 在提供时用 runtime + design-token 兜底包裹存储的 HTML |
| `src/guide.mjs` | AI 生成组件前读的 authoring 契约 |
| `components/` | seed 时只装 2 个 system 组件(settings、dashboard)+ 6 个 example app 留作 repo 参考(kanban、todo、pomodoro、notes、expense-split、reading-list) |

```bash
node test/server-smoke.mjs   # 113 条断言,走真实 stdio——含运行时组件创建
node test/http-smoke.mjs     #  16 条断言,走 HTTP transport
node test/seed-smoke.mjs     #   7 条断言,验 seed / design-kit 流水线
```

## 设计取向(为什么这么建)

- **UI 和数据分开持久,都带版本。** 组件是视图;collections 是真相;ledger 是历史。换掉任一个不丢另一个。
- **AI 只说 domain command,从不碰 SQL、从不碰裸 state。** 这是人 + AI 并发编辑安全的原因(command 层
  的幂等 + 乐观并发)。
- **标准优先。** 一切走 MCP Apps 标准 bridge——没有 host 私有 API。一套代码应服务每个能渲染 `ui://`
  的 host。
- **单一用途,不做复合。** 每个 app 只占一个场景、绑自己的 collection;引擎宁可新铸一个,也不往旧 app
  里塞功能。system app(settings、dashboard)是刻意的例外——引擎自有、privileged、允许跨 collection 观察。

## 安全模型

信任按组件的来源分层。本地编写的组件和 system 组件跑在 **direct mode**。引擎同时内置一个 **runner**——
一个沙箱化的 `srcdoc` iframe,CSP-first 文档 + 最小只读 bridge——作为任何非本地可信组件的强制执行模式;
另有保留的 `security:*` / `policy:*` 配置 key(通用 data 写入碰不到)和一个 out-of-band 特权写入器。

**诚实的现状:** runner *已建成并测试过,但处于休眠*——目前还没有"从别处安装"的路径,所以今天没有任何
不可信内容真正走到它面前。它存在,是为了当共享库落地时,门已经是对的形状。请把它当作地基,而不是已交付
的保证。信任模型见 [`SECURITY.md`](SECURITY.md)。

## Host 支持(2026-07-22 实测)

| Host | 渲染 widget | 人点击 widget | AI 操作数据 | 同一 store |
|---|---|---|---|---|
| **Claude Desktop**(本地 stdio) | ✅ | ✅ 完整循环,含 `sendMessage` 回复 | ✅ | ✅ |
| **浏览器 viewer**(`/view/<name>`) | ✅ | ✅(无 chat 连接——`sendMessage` 降级为提示) | 经 CLI AI | ✅ |
| **Codex desktop**(ChatGPT app,`enable_mcp_apps` flag) | ✅ 实验性 | ❌ host 的 widget→server proxy 还没接([openai/codex#28912](https://github.com/openai/codex/issues/28912)) | ✅ | ✅ |
| **Claude Code**(CLI,`claude mcp`) | —(设计上走文本 fallback) | — | ✅ | ✅ |
| **codex CLI / IDE** | —(设计上走文本 fallback) | — | ✅ | ✅ |
| **ChatGPT web**(Work mode) | 标准支持——需远程 HTTPS(`/mcp` + tunnel),此处未测 | | | |

一切走标准 bridge,所以上游 host 的修复(如 #28912)不改一行也能让本项目受益。

## 状态 / 路线图

早期 v0——在 Claude Desktop 端到端验证;跨厂商渲染 + 共享 store 在 Codex desktop 和浏览器 viewer 上
验证。

- [x] 引擎:registry + shell + 通用 data command + ledger
- [x] 只装 system 组件(settings、dashboard);6 个 example app 留作 repo 参考
- [x] AI 组件创建循环(guide → save → 动态 tool)
- [x] in-context onboarding(问怎么用 → AI 翻你的历史/记忆,建一组贴合你的起手 app)
- [x] 安全地基:信任分层 + 沙箱 runner + 保留配置 key
- [ ] `npx` 一条命令安装
- [ ] 远程(Streamable HTTP)模式 → claude.ai / ChatGPT / 移动端
- [ ] 组件 export/import → 分享 → 社区库
- [ ] 为共享/不可信组件启用 runner 路径

MIT © [2nd1st](https://github.com/2nd1st)
