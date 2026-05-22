# 开源 Managed Code Agents 全景对比

> 自托管 + 完整 runtime + Code Agent 定位的开源平台横向对比，对标 [Anthropic Managed Agents](./qwen-code-daemon-design/06-roadmap.md)（闭源）。
>
> **更新日期**：2026-05-07
>
> **范围**：仅覆盖**专门面向编码任务的 Code Agent**——不包括通用 LLM application platform（Dify）、通用 agent runtime（LangGraph）、stateful chatbot framework（Letta）、IM/business agent（AgentScope/CrewAI）、general agent framework（AutoGen/Agno）。

## 一、TL;DR

```
开源 Code Agent 里，有完整 daemon / server runtime（= 准 Managed）的项目：

OpenHands   — Docker sandbox + Web UI（最接近 Anthropic Managed 综合能力）
OpenCode    — CLI daemon + Hono HTTP + 多 client（架构最现代）
Goose       — Rust + MCP-native daemon
Hermes      — 14 channels server + 闭环学习（Nous Research）
Qwen Code   — 设计中（[本系列](./qwen-code-daemon-design/README.md) Stage 6 SaaS）

仅 CLI 无 daemon（不算 Managed）：
Aider / Cline / Cursor / Codex CLI / Copilot CLI / SWE-agent / MetaGPT
```

**核心结论**：
- 真正"开源 Managed Code Agent"形态目前只有 **4 个项目**（OpenHands / OpenCode / Goose / Hermes），加上设计中的 Qwen Code daemon
- **Computer Use（GUI 自动化）几乎无开源对手**——OpenHands browser tool 最接近，能力有限
- **多租户**形态在开源 Code Agent 中**几乎不存在**——绝大多数是单租户 / 单密码自托管
- Anthropic Managed Agents 在 multi-tenant + Computer Use + 商业 console 上仍领先开源 1-2 年

## 二、什么算 "Managed Code Agent"

筛选 4 条标准：

| 标准 | 含义 |
|---|---|
| **Code Agent 定位** | 主要 use case 是编程（read/write/edit/bash 等代码工具）|
| **Runtime 完整** | 不仅是 SDK / framework，能跑成 server / daemon 接受 client 请求 |
| **Session 持久化** | 跨进程 / 跨 call 保留对话状态 |
| **Self-host 路径清晰** | 文档明确 self-host，不只能上厂商云 |

不满足上面 4 条不进入主对比表。

## 三、主对比项目（4 + 1）

### 3.1 OpenHands（前 OpenDevin）

| 维度 | 描述 |
|---|---|
| 仓库 | [All-Hands-AI/OpenHands](https://github.com/All-Hands-AI/OpenHands) |
| License | MIT |
| 语言 | Python（后端）+ TypeScript（前端）|
| 设计目标 | 自主 SWE agent 平台，"全功能软件工程师" |
| Code Agent 定位 | ✓ 核心定位 SWE agent |
| 关键能力 | EventStream 事件驱动核心 / Docker sandbox 一线 / Web UI / CLI / VSCode 集成 / browser tool（headless Chrome）/ 多 LLM |
| 多租户 | ❌（单租户设计）|
| Sandbox | **✓ Docker 一线**（开源 Code Agent 里最强）|
| Computer Use 等价 | ⚠ browser tool（headless Chrome 自动化）|
| 部署 | Docker compose / k8s helm |
| SWE-bench | ~55%（公开数据）|

**优势**：
- 开源 Code Agent 里 sandbox 最强（Docker 隔离 + EventStream 状态机）
- browser tool 能做 GUI 自动化（虽不及 Anthropic Computer Use）
- 社区活跃，迭代快，bench 成绩公开稳定

**不足**：
- 多租户能力弱（设计上单租户）
- Web UI 复杂度高，运维成本不低
- Tool 集成需要懂 EventStream 架构

**适合**：研究 SWE agent / 想要 Docker sandbox 的私有部署 / browser-based GUI 自动化任务

---

### 3.2 OpenCode

| 维度 | 描述 |
|---|---|
| 仓库 | [sst/opencode](https://github.com/sst/opencode) |
| License | MIT |
| 语言 | TypeScript（Bun runtime）|
| 设计目标 | self-host CLI daemon Code agent |
| Code Agent 定位 | ✓ 专门面向编码 |
| 关键能力 | HTTP daemon（Hono）/ multi-session 共进程 / SQLite + drizzle-orm / WebUI + TUI + 桌面 / mDNS 服务发现 / OpenAPI codegen / WebSocket / 多 LLM provider |
| 多租户 | ❌（单 password auth）|
| Sandbox | ✗（无内置 sandbox）|
| 部署 | npx / 二进制 |

**优势**：
- daemon 模式设计精良，是 [Qwen daemon 设计](./qwen-code-daemon-design/README.md) 的主要参照
- 协议层用 OpenAPI 自动生成 SDK
- 跨 client（CLI/Web/桌面）一致 UX
- TypeScript + Bun 启动快

**不足**：
- 单租户（OPENCODE_SERVER_PASSWORD 单密码）
- 无 sandbox、无 multi-tenant、无 console
- 定位是个人 / 小团队工具，不是企业平台

**适合**：个人 / 小团队 self-host code agent / 学习 daemon 架构 / 多 client 共 session 体验

---

### 3.3 Goose（Block）

| 维度 | 描述 |
|---|---|
| 仓库 | [block/goose](https://github.com/block/goose) |
| License | Apache-2.0 |
| 语言 | Rust |
| 设计目标 | MCP-native CLI agent（Block / Square 母公司出品）|
| Code Agent 定位 | ✓ 编码 + 通用 agent，工具生态偏 dev |
| 关键能力 | MCP 一线集成（不是后加）/ daemon 模式 / 多 LLM provider / GUI desktop app + CLI / 系统集成（终端 / 文件系统）|
| 多租户 | ❌ |
| Sandbox | ✗ |
| 部署 | brew / 二进制 |

**优势**：
- Rust 原生，启动快、内存低
- MCP 是核心架构（不是事后添加），所以 MCP 工具体验最好
- 跨平台 desktop app

**不足**：
- 单用户场景为主
- 工具能力受 MCP server marketplace 影响
- 文档相对其他项目薄一些

**适合**：MCP 重度用户 / Rust 偏好 / 跨平台 desktop 体验 / 不想要 web UI 复杂度

---

### 3.4 Hermes Agent（Nous Research）

| 维度 | 描述 |
|---|---|
| 仓库 | [NousResearch/hermes](https://github.com/NousResearch)（具体仓库见官网）|
| License | MIT |
| 语言 | Python（~369K 行代码体量）|
| 设计目标 | 自我改进 AI 伴侣 + 多消息渠道 |
| Code Agent 定位 | ⚠ 部分（既能编程也覆盖通用 chat / IM）|
| 关键能力 | **闭环学习系统**（冻结快照 Memory + 自主 Skill + FTS5 跨会话搜索 + 双计数器 Nudge）/ **14 个消息渠道**（Telegram / Discord / Slack 等）/ 后台 review subagent / 200+ LLM provider |
| 多租户 | ⚠ 通过 channel 区分 user，非真正 tenant 隔离 |
| Sandbox | ✗ |
| 部署 | self-host server |

**优势**：
- **闭环学习系统**是开源里独家——见 [Hermes 闭环学习深度对比](./closed-learning-loop-deep-dive.md)
- 14 消息渠道开箱即用（其他项目要自己接）
- 200+ provider + Credential Pool 多 Key 轮换

**不足**：
- 通用 agent 定位，编程不是唯一焦点
- 体量大（369K Python 行），二次开发门槛高
- 社区相对小（Stars < 1K 量级）

**适合**：跨 IM / Discord / Slack 部署 chat-style code agent / 需要长期学习记忆 / 多 IM 用户分发

---

### 3.5 Qwen Code daemon（设计中）

| 维度 | 描述 |
|---|---|
| 仓库 | [本系列设计文档](./qwen-code-daemon-design/README.md)（codeagents 项目内）|
| License | Apache-2.0（基础 Qwen Code）|
| 语言 | TypeScript（Node + Bun）|
| 设计目标 | Code Agent daemon + 多租户 + Stage 6 SaaS HA |
| Code Agent 定位 | ✓ 核心 Code Agent，Gemini CLI 分叉演进 |
| 关键能力 | ACP NDJSON 协议复用 / Channels 多渠道 / 多 client 共 session（live collaboration）/ 4 kinds background tasks / 5 种 sandbox 选择 / Stage 6 SaaS HA + Postgres + S3 + Redis |
| 多租户 | **✓ External Reference 设计中**（[§06 §五 multi-tenancy](./qwen-code-daemon-design/06-roadmap.md)）|
| Sandbox | ✓ 5 种（None / OS-user / namespace / container / remote）[§06 §五 Shell 沙箱方案](./qwen-code-daemon-design/06-roadmap.md) |
| 部署 | 当前 npm 单 CLI；daemon 设计中 |

**优势（设计上）**：
- 多 client 共 session（live collaboration）—— 开源 Code Agent 独有
- 5 种 sandbox 选择（含远程 sandbox）超 Anthropic Managed
- Stage 6 SaaS 架构完整，可直接对标 Anthropic Managed Agents
- 中文生态友好（DashScope 默认 + 中文 IM channels）

**不足（设计 vs 现实）**：
- daemon 模式仅在设计阶段，未实现
- 商业层（console / billing / 客服）仍需 ~6 月建设

**适合**：评估"开源对标 Anthropic Managed Agents"路径的工程蓝图 / 想自己 fork 实现的团队

---

## 四、能力对照矩阵（vs Anthropic Managed Agents）

| 能力 | Anthropic Managed | OpenHands | OpenCode | Goose | Hermes | Qwen daemon（设计）|
|---|---|---|---|---|---|---|
| **License** | 闭源 SaaS | MIT | MIT | Apache-2.0 | MIT | Apache-2.0 |
| **自托管** | ❌ | ✓ | ✓ | ✓ | ✓ | ✓（Stage 1+）|
| **Code Agent 定位** | ✓ | ✓ | ✓ | ✓ | ⚠ partial | ✓ |
| **多租户** | ✓ | ❌ | ❌ | ❌ | ⚠ channel-scoped | **✓ External Reference 设计**（[§06 §五](./qwen-code-daemon-design/06-roadmap.md)）|
| **Sandbox** | ✓ managed | **✓ Docker** | ✗ | ✗ | ✗ | **✓ 5 种**（[§06 §五](./qwen-code-daemon-design/06-roadmap.md)）|
| **Session 持久化** | ✓ | ✓ EventStream | ✓ JSONL+SQLite | ✓ | ✓ FTS5 长期 | ✓ JSONL→SQLite→Postgres（[§06 §五](./qwen-code-daemon-design/06-roadmap.md)）|
| **多 LLM provider** | ❌ Claude only | ✓ | ✓ | ✓ | ✓ 200+ | ✓ |
| **MCP 集成** | ✓ | partial | **✓ 一线** | **✓ 原生** | ✓ | ✓（[§02 §3 MCP 生命周期](./qwen-code-daemon-design/02-architectural-decisions.md)）|
| **Built-in tools** | web/code/file | bash/edit/web/browser | bash/edit/glob/grep | MCP-driven | 14 channels + tools | bash/edit/read/web 等（继承 Qwen Code）|
| **多 client 共 session** | ❌（每 SDK call 独立）| ❌ | ❌ | ❌ | ⚠ via IM channel | **✓ live collaboration 默认**（决策 [§02 §1+§6](./qwen-code-daemon-design/02-architectural-decisions.md)）|
| **Web Console** | ✓ | ✓ | ❌ | ✗（CLI/desktop）| limited | 设计中（Stage 6 商业层）|
| **Computer Use（GUI 自动化）**| ✓ | ⚠ browser tool | ✗ | ✗ | ✗ | ✗ |
| **离线 / Air-gapped** | ❌ | ✓ | ✓ | ✓ | ✓ | ✓ |
| **billing / quota** | ✓ | ✗ | ✗ | ✗ | ✗ | ✓ Stage 4+ quota（无 billing UI）|
| **协议标准** | 私有 API | EventStream | OpenAPI codegen | RPC | webhook+IM | **ACP NDJSON 标准**（[§04](./qwen-code-daemon-design/04-http-api.md)）|
| **SWE-bench 公开** | N/A | ~55% | N/A | N/A | N/A | N/A |
| **GitHub Stars (~)** | N/A | 30K+ | 9K+ | 12K+ | < 1K | N/A |

> Stars 数据是参考量级，反映社区关注度，不代表质量。具体以 GitHub 实时为准。

## 五、其他相关项目（非 Managed Code Agent）

下面是**Code Agent 但无 daemon / server**（不算 Managed），列在 [features.md](./features.md) 主对比中：

| 项目 | License | 形态 | 为何不入主表 |
|---|---|---|---|
| **Aider** | Apache-2.0 | 单进程 CLI | 无 daemon 模式 |
| **Cline** | Apache-2.0 | VS Code 扩展 | 不是 server |
| **Cursor** | 闭源 | IDE | 闭源 + 不是 server |
| **Continue** | Apache-2.0 | IDE 扩展 | 不是 server |
| **Codex CLI** | Apache-2.0 | 单进程 CLI（Rust）| 无 daemon |
| **Copilot CLI** | 闭源（SEA bundle）| 单进程 CLI | 闭源 + 无 daemon |
| **SWE-agent** | MIT | 研究框架 | 主要为 SWE-bench 实验，不是平台 |
| **MetaGPT** | MIT | 多 agent SWE 模拟 | research，无 production daemon |
| **Cody** | Apache-2.0（CLI 部分）| IDE / CLI | 主要 IDE，闭源后端 |
| **Tabby** | Apache-2.0 | 自托管 code completion | 不是 agent，是 inline 补全 |

完整对比见 [features.md](./features.md)。

## 六、能力分布速览

```
                  Sandbox  Multi-tenant  Persistence  GUI auto  MCP   Multi-client
Anthropic Managed   ✓✓        ✓✓            ✓           ✓✓       ✓     ✗
OpenHands          ✓✓        —             ✓           ⚠         ⚠     ✗
OpenCode            —         —             ✓           —         ✓✓    ✗
Goose               —         —             ✓           —         ✓✓    ✗
Hermes              —         —             ✓✓ FTS5     —         ✓     ⚠ via IM
Qwen daemon (设计) ✓✓ 5种    ✓✓ Stage4+    ✓           —         ✓✓    ✓✓ live collab
```

读法：
- **Sandbox**：是否内置进程 / 文件 / 网络隔离
- **Multi-tenant**：是否一个进程支持多租户隔离
- **Persistence**：session 状态跨重启保留
- **GUI auto**：Computer Use 类能力
- **MCP**：MCP server 集成深度
- **Multi-client**：同 session 多个 client 同时连接

## 七、选型决策树

```
Q1: 需要 Docker sandbox + 自主 SWE agent + Web UI？
  Yes → OpenHands
  No → Q2

Q2: CLI 优先 + 多 client 跨设备共 session？
  Yes → 看 Q3
  No → Q4

Q3: 现成可用 vs 设计中？
  现成 → OpenCode（HTTP daemon + 多 client 但不真正共 session）
  设计中能等 → Qwen Code daemon（live collaboration 模型）

Q4: MCP 重度 + Rust 偏好 + desktop app？
  Yes → Goose
  No → Q5

Q5: 多消息渠道 / IM bot 集成 + 长期学习记忆？
  Yes → Hermes Agent
  No → Q6

Q6: 多租户 SaaS 部署？
  Yes → 暂无成熟开源（最接近：等 Qwen daemon Stage 6 / 自己 fork OpenHands 加多租户）
  No → 看具体场景，回到 Q1
```

## 八、Computer Use 缺口

Anthropic Managed Agents 的 **Computer Use** 是当前最大的能力缺口：

| 项目 | 等价能力 | 完整度 |
|---|---|---|
| **OpenHands** browser tool | headless Chrome 自动化 | ⚠ 仅浏览器 |
| **Browser Use** ([browser-use/browser-use](https://github.com/browser-use/browser-use))| 浏览器自动化 framework | ⚠ 需自己集成进 agent |
| **Self-Operating Computer** ([OthersideAI/self-operating-computer](https://github.com/OthersideAI/self-operating-computer))| OS 级 GUI 自动化 | ⚠ research preview，不稳定 |
| Anthropic Claude Computer Use | OS 级 GUI（macOS/Linux/Windows）| ✓ 闭源唯一稳定 |

**结论**：开源 Code Agent 在 GUI 自动化能力上**显著落后** Anthropic。这可能是 Anthropic 短期内的护城河。

要在开源 Code Agent 上对标 Computer Use：
- 浏览器自动化：OpenHands browser tool / Browser Use 已可用（受限 web）
- OS 级：暂无成熟开源；Self-Operating Computer 等仍是 research preview

## 九、关键观察

1. **真正 "Managed Code Agent" 形态目前只有 4 个开源项目**（OpenHands / OpenCode / Goose / Hermes），加上设计中的 Qwen daemon。Anthropic Managed Agents 的对手非常稀少。

2. **多租户 + Code Agent 几乎无开源对标**——OpenHands / OpenCode / Goose 都是单租户设计；Hermes 通过 channel 间接支持但不是真正 tenant 隔离；Qwen daemon Stage 4+ 是设计阶段。

3. **OpenHands 综合能力最强但单租户**——sandbox + browser tool + Web UI 维度独家，但多租户是空白。

4. **OpenCode 协议层最现代**——OpenAPI codegen + Hono + Bun.serve 是最新技术栈；但功能相对 OpenHands 简洁。

5. **Goose 是 MCP-native 唯一 Rust 选项**——不需要 web UI 复杂度，desktop app 体验好。

6. **Hermes 的闭环学习独家**——但 Code Agent 不是它的唯一定位。

7. **Computer Use 是 Anthropic 护城河**——开源在 GUI 自动化上落后 1-2 年。

8. **Qwen Code daemon 是开源里最完整的设计提案**——架构对标 Anthropic Managed Agents，但需要落地。

## 十、典型部署场景

### 10.1 个人开发者：OpenCode 或 Goose

单用户自托管 + 多 client（CLI / Web）+ MCP 工具生态。OpenCode 偏 web UI，Goose 偏 desktop。

### 10.2 团队 SWE 自动化：OpenHands self-host

Docker sandbox + Web UI 跑长任务 + browser tool 做 GUI 任务。可作为团队内部 SWE agent 平台。

### 10.3 多 IM 渠道 chat code helper：Hermes

接 Telegram / Discord / Slack 让团队多人 IM 里调用 code agent。闭环学习记得每个用户偏好。

### 10.4 评估"开源对标 Anthropic Managed Agents"：参考 Qwen daemon 设计

[本系列](./qwen-code-daemon-design/README.md) 的设计提案给出 ~6 月可达 SaaS 完整产品的工程蓝图。可作为 fork 实现起点。

### 10.5 混合：OpenCode self-host + Anthropic API 作为 provider

用 OpenCode 自托管的 daemon + 调 Anthropic API 作为 LLM provider——保持自主性 + 用 Claude 模型能力。

## 十一、与本系列文档的关联

| 本表 | 相关 codeagents 文档 |
|---|---|
| OpenCode 详细架构分析 | [Qwen daemon §06 §六 OpenCode 详细对比](./qwen-code-daemon-design/06-roadmap.md) |
| Anthropic Managed Agents 详细 | [Qwen daemon §06 §七 vs Anthropic](./qwen-code-daemon-design/06-roadmap.md) |
| Goose / Aider / Hermes 等 CLI agent | [features.md](./features.md) 横向对比 |
| Hermes Agent 闭环学习独家能力 | [closed-learning-loop-deep-dive.md](./closed-learning-loop-deep-dive.md) |
| 多 client 共 session（Qwen 独家）| [Qwen daemon §04 §三 多 client 协调](./qwen-code-daemon-design/04-deployment-and-client.md) |
| 长跑稳定性（任何 daemon 都需要）| [Qwen daemon §06 §五 External Reference 长跑稳定性](./qwen-code-daemon-design/06-roadmap.md) |
| 5 种 sandbox 设计 | [Qwen daemon §06 §五 Shell 沙箱方案](./qwen-code-daemon-design/06-roadmap.md) |

## 十二、结论

**当前开源 Managed Code Agent 真空格局**：

| 维度领先 | 项目 | 备注 |
|---|---|---|
| **Sandbox + 综合能力** | OpenHands | Docker + browser tool + Web UI |
| **CLI daemon 协议层** | OpenCode | OpenAPI + Hono + Bun |
| **MCP 一线 + Rust** | Goose | Block 出品 |
| **多渠道 + 长期学习** | Hermes | Nous Research |
| **多租户 + live collaboration**（设计）| Qwen Code daemon | [本系列](./qwen-code-daemon-design/README.md) |
| **Multi-tenant SaaS-ready 完整产品** | **❌ 暂无成熟开源 Code Agent** | Anthropic 护城河 |
| **GUI 自动化 (Computer Use)** | **❌ 暂无成熟开源 Code Agent** | Anthropic 护城河 |

**展望**：
- 短期（6 月）：[Qwen Code daemon External Reference Architecture](./qwen-code-daemon-design/06-roadmap.md) 落地后，开源 Code Agent 多一个完整 SaaS-ready 选项
- 中期（1-2 年）：browser-based GUI 自动化在 OpenHands / Browser Use 等驱动下逐步成熟
- 长期：OS 级 Computer Use 是 Anthropic 大概率持续领先的领域

---

> **维护说明**：开源 Code Agent 生态变化快，本文每月应做一次状态校验。如发现项目 archive / fork / license 变化，请提交 PR 更新。
