# Claude Code Dynamic Workflows 深度分析

> **核心问题**：Claude Code 2026-05-28 随 Opus 4.8 同日发布的 dynamic workflows 是什么？它在 Claude Code 的并行化抽象谱系中处于什么位置？Qwen Code daemon 系列能借鉴什么？
>
> 返回 [Deep-Dive 索引](./deep-dive-index.md) · 关联 [多 Agent 架构](./multi-agent-deep-dive.md) · [Coordinator/Swarm 编排](./coordinator-swarm-orchestration-deep-dive.md) · [SubAgent 展示](./subagent-display-deep-dive.md)
>
> **证据强度说明**：本文基于 2026-05-28 公开发布后的官方文档（`code.claude.com/docs/en/workflows`）+ 官方博客 + v2.1.154 release notes + 3 个社区 issue 反编译 + TechCrunch 报道，经多源对抗性验证（10 个 high-confidence claim，0 被反驳）。标注 `[未验证]` 的为找不到独立第二来源的推断。

## TL;DR

**Dynamic Workflows** 是 Anthropic 于 **2026-05-28 在 Claude Code v2.1.154 与 Opus 4.8 同日发布**的 research preview 能力。本质：**让 Claude 即兴写一段 JavaScript 编排脚本、在与对话隔离的后台 runtime 中执行，单次 run 可 fan-out 几十到上百个 subagent**。

它不是另一个 subagent / skill 的同义词，而是**新增的一层 orchestration 抽象——「plan holder 从 Claude（逐 turn 决策）搬到代码（脚本决定控制流）」**。覆盖全付费 plan、四 provider、五 surface（CLI / Desktop / IDE / `claude -p` headless / Agent SDK），附带 bundled `/deep-research` workflow 和 `ultracode` effort 档位。灰度由 `CLAUDE_CODE_WORKFLOWS=1` env var + GrowthBook flag `tengu_workflows_enabled` 双层 gate 控制。

> **官方定义**："A dynamic workflow is a JavaScript script that orchestrates subagents at scale. Claude writes the script for the task you describe, and a runtime executes it in the background while your session stays responsive." [source: code.claude.com/docs/en/workflows]

---

## 一、在 Claude Code 并行化谱系中的位置

官方 `/agents` 比较页把 Claude Code 的并行化方式归为四类：**subagents / agent view / agent teams / workflows**。workflows 的定位是"a script that runs many subagents and cross-checks their results, **for work too big to coordinate one turn at a time or that needs more than a single pass**"。

| 维度 | Subagents | Skills | **Workflows** |
|---|---|---|---|
| 谁决定下一步 | Claude, turn by turn | Claude, 跟 prompt | **The script（代码）** |
| 中间结果落点 | Claude context | Claude context | **Script variables（不进 context）** |
| 规模 | 每 turn 几个委托 | 同左 | **几十到上百 agents/run** |
| 控制流 | LLM 即兴 | LLM 即兴 | **确定性（loop / 条件 / fan-out 写死在脚本）** |

[source: code.claude.com/docs/en/workflows]

**「dynamic」的精确含义**：脚本本身是 Claude 为**本次任务临时撰写**的，不是用户预先以 YAML/JSON DSL 声明的 static pipeline。**没有显式 DSL、没有 schema 文件、没有 declarative 配置**——这是它与 LangGraph 那种"预先声明 graph"的根本区别。换句话说，dynamic 不指"运行时动态分支"（那是脚本里的 `if`/`while` 负责），而指"**编排脚本本身由 LLM 在 plan 阶段动态生成**"。

```
                  谁持有 plan？
   ┌──────────────────┼──────────────────┐
   ▼                  ▼                  ▼
 LLM 逐 turn       脚本（LLM 即兴写）    开发者预声明
 = Subagents       = Dynamic Workflows   = LangGraph / CrewAI
 灵活但易漂移        确定性 + LLM 灵活      可控但有 DSL 学习成本
```

---

## 二、技术架构

### 2.1 Runtime 与隔离

> "The workflow runtime executes the script in an isolated environment, separate from your conversation. Intermediate results stay in script variables instead of landing in Claude's context." [source: code.claude.com/docs/en/workflows]

- **隔离环境**：脚本在与对话隔离的 runtime 跑，中间结果留在 script variables，**不污染 Claude 主对话 context**——这是它能 fan-out 上百 agent 而不爆 context 的关键。
- **后台执行**：run 期间主 session 保持响应；进度通过 task panel / `/workflows` 命令查看。
- **Resume**：runtime 跟踪每个 agent 的结果，支持**同 session 内** resume；**退出 Claude Code 再启动会从头跑**（不跨 session 持久化）。
- **基础设施复用**：从 v2.1.154 同 release 的大量 background-session 修复（worktree-isolation guard、idle grace period、pinned session 重生、bg-pty-host orphan）推断，dynamic workflows **复用了既有 background session 基础设施**而非独立子系统 [medium 置信度，source: github.com/anthropics/claude-code/releases/tag/v2.1.154]。

### 2.2 API shape（部分披露）

社区 Issue #63876 披露了 Workflow tool 的调用 API：

```js
// 按已注册名字调用
Workflow({ name: "deep-research", args: {...} })
// 按脚本路径调用
Workflow({ scriptPath: "/path/to/workflow.mjs", args: {...} })
// 脚本内通过全局变量读参数
const question = args.question
```

- 脚本格式：**`.mjs` ES Module** [source: github.com/anthropics/claude-code/issues/63876]
- 含 **8 个 primitives** 基础原语，用户自定义 workflow 可在约 220 行 JS 内调用全部 8 个 [medium 置信度，source: github.com/anthropics/claude-code/issues/61637]
- 具体原语命名（如 `agent` / `parallel` / `pipeline` / `phase` / `log` / `args` / `budget` 等）**官方文档未列举**，`[未验证]`

### 2.3 与 Claude Agent SDK 的关系

Workflows 在 Agent SDK 中可用，与 CLI / Desktop / IDE / `claude -p` headless 共享同一禁用层级。Agent SDK 调用方可触发 workflow，而 workflow 内部又能反过来调用 session-scoped subagent（subagents 文档定义了 `--agents` JSON flag 与 SDK `agents` option）。**workflow → subagent → tool 形成三层委托链**。[source: code.claude.com/docs/en/workflows, code.claude.com/docs/en/sub-agents]

---

## 三、典型 use case 与质量 pattern

### 3.1 官方点名场景

> "Examples include a codebase-wide bug sweep, a 500-file migration, a research question that needs sources cross-checked against each other, and a hard plan worth drafting from several independent angles before you commit to one." [source: code.claude.com/docs/en/workflows]

| 场景 | 为什么适合 workflow |
|---|---|
| **Codebase-wide bug sweep** | 需扫描海量文件，单 context 装不下；fan-out N agent 各扫一块 |
| **500-file migration** | 规模大，需逐文件 transform + 验证；脚本 pipeline 控制 |
| **研究问题交叉核对** | 需多源搜索 + 相互验证；adversarial pattern |
| **多角度起草 hard plan** | judge panel：N 个独立方案 + 评分 + 综合 |

**Hero case**（TechCrunch + 官方博客）：Jarred Sumner 用 workflows 把 **Bun 从 Zig 移植到 Rust**（11 天 / 75 万行 / 99.8% 测试套件兼容）。⚠️ 博客中**无 Jarred 本人直接引语**，是第三方叙述 [source: claude.com/blog/introducing-dynamic-workflows-in-claude-code]。

### 3.2 可重复的质量 pattern

> "It can have independent agents adversarially review each other's findings before they're reported, or draft a plan from several angles and weigh them against each other, so you get a more trustworthy result than a single pass." [source: code.claude.com/docs/en/workflows]

| Pattern | 机制 |
|---|---|
| **Adversarial verify** | spawn N 个独立 skeptic 各自尝试 refute 一个 finding，多数反驳则 kill |
| **Judge panel** | 从多角度生成 N 个方案 → 并行打分 → 综合 |
| **Multi-modal sweep** | N 个 agent 各用不同搜索方式（按容器/内容/实体/时间）|
| **Loop-until-dry** | 持续 spawn finder 直到 K 连续轮无新发现 |
| **Completeness critic** | 最后一个 agent 问"还缺什么"，发现的成为下一轮工作 |

### 3.3 bundled workflow：`/deep-research`

`/deep-research <question>` 是 Anthropic 内置的示范 workflow：**fan-out web 搜索 → 抓取 → 交叉核对 → 对每条 claim 投票 → 过滤掉未通过验证的 claim → 输出带引用的报告**，需 WebSearch tool 可用 [source: code.claude.com/docs/en/workflows]。

> 本文档本身即用同款模式产出——7 角度并行搜索 → 12 源深度读 → 10 claim 对抗性验证（0 反驳）→ 综合，是 deep-research workflow 的一次实战。

### 3.4 不适合的场景

- **需中途人工签字的多阶段流程**："No mid-run user input. Only agent permission prompts can pause a run. For sign-off between stages, run each stage as its own workflow"
- **小范围、单 turn 即可完成的任务**："Dynamic workflows can consume substantially more tokens than a typical Claude Code session"

---

## 四、与竞品对比

| 维度 | **Dynamic Workflows** | LangGraph | CrewAI / AutoGen / OpenAI Swarm |
|---|---|---|---|
| Plan 来源 | **LLM 即兴撰写 JS** | 开发者预先声明 graph | 开发者声明 agent 角色 + 任务 |
| 编排载体 | JS 脚本（`.mjs`） | StateGraph + 节点 | Crew / Team 配置 |
| 中间状态 | Script variables（不进 context） | Channel state | Memory / scratchpad |
| Resume | 同 session 内自动 | 通过 checkpointer 持久化 | 因框架而异 |
| Adversarial review | **内置在 quality pattern 推荐里** | 需自行连节点 | 需自行连 agent |
| Quality gate | 交叉验证 + 投票（deep-research 内置） | 自行实现 | 自行实现 |
| 集成形态 | **嵌进 IDE / CLI / Desktop / SDK 全 surface** | 独立 Python framework | 独立 framework |

**Claude Code workflow 的 4 点差异化**：
1. **生成期由 LLM 担纲**，跳过 graph DSL 学习成本——用户描述任务，Claude 写脚本
2. **天然嵌进全 surface**，不是独立 framework（无需 `pip install`）
3. **与 subagents 已有底层共用**——worktree isolation / acceptEdits / tool allowlist；workflow 内 spawn 的 subagent 始终以 acceptEdits 模式运行
4. **把 quality pattern（adversarial / 多角度 plan）写进官方 narrative**，而非留给开发者拼

---

## 五、限制与坑

### 5.1 官方明文限制

| 限制 | 值 |
|---|---|
| 并发 agent 上限 | **16**（低 CPU 机器更少）|
| 单 run agent 总数上限 | **1000**（防 runaway）|
| workflow 自身权限 | **无 fs / shell**，所有 IO 由 spawn 的 agent 完成 |
| mid-run user input | **无**（仅 agent 权限弹窗可暂停 run）|
| Resume 范围 | **仅同一 session**；退出 CLI 重启从头跑 |
| Token 消耗 | 显著高于普通对话，官方建议先在小范围试用 |

[source: code.claude.com/docs/en/workflows + claude.com/blog/...]

### 5.2 社区反馈中的槽点

- **双层 gate 静默失败**：v2.1.148 起客户端二进制有 `RB()` / `LB()` / `bp()` gate，env var `CLAUDE_CODE_WORKFLOWS=1` + GrowthBook `tengu_workflows_enabled` **必须同时通过**；任一缺失则 **0 日志 0 warning short-circuit 返回**，用户无法预测自己的功能面 [source: github.com/anthropics/claude-code/issues/61825, #61637]
- **Workflow dispatch 双模式互斥**（Bug #63876, v2.1.158）：`name` 模式 args 能透传但找不到用户级 `~/.claude/workflows/*.mjs`；`scriptPath` 模式能定位脚本但 args 丢失。两种模式都无法同时满足「全局可发现 + args 可透传」，跨 repo 复用 workflow 受阻
- `DISABLE_GROWTHBOOK=1` 本地绕过失效，证实 gate **实际在服务端而非二进制** [source: github.com/anthropics/claude-code/issues/61637]

### 5.3 需注意的未验证 / 推断

- Anthropic **Claude Opus 产品页未出现具名 "dynamic workflows"**，三次 WebFetch 交叉验证均未命中——"4.8 与 Workflows 同日捆绑发布"以 Claude Code 官方文档 + changelog + TechCrunch 报道为准，**不能用 Opus 产品页背书** `[未验证]`
- 记者把 4.8 加速发布节奏归因于 4.7 反馈 disappointing + OpenAI Codex / Gemini Flash 竞争压力，是 **TechCrunch 推断**而非 Anthropic 官方说法
- **8 个 primitives 的具体命名 / 调用约定 / return schema**：官方文档未披露 `[未验证]`

---

## 六、对 Qwen Code 的启发

### 6.1 相似 abstraction 对比

| 维度 | Claude Code Dynamic Workflows | Qwen Code daemon 系列 | chiga0 SDK | ytahdn web-shell |
|---|---|---|---|---|
| 后台执行 | workflow runtime（隔离） | daemon route + ACP HTTP + non-blocking `/prompt` | SDK 层 | 远端 shell |
| 多 agent 编排 | dozens-to-hundreds, JS 脚本驱动 | 当前以 jifeng MCP bridge 为主，**无显式 fan-out 抽象** | 暂无 | 无 |
| Plan holder | 代码（Claude 即兴写） | Claude / 用户 prompt | SDK 调用方 | 用户 |
| Quality pattern | adversarial review 内置 narrative | 暂无内置 | 暂无 | 不适用 |

**关键观察**：Qwen Code daemon 系列已经把"后台执行 + 多 client + 非阻塞 prompt"的**底层管道**铺好了（non-blocking `POST /prompt` 返 202 / context-usage API / ACP HTTP transport / MCP bridge），但**缺少最上面那层"让 LLM 即兴写编排脚本 + 在 daemon runtime 跑 fan-out"的胶水层**。这正是 dynamic workflows 填的位置。

### 6.2 借鉴价值

1. **「plan 搬进代码」是 Qwen Code 当前最缺的一层抽象**。daemon 系列底层已就绪，胶水层**不需从零造**——可直接用 daemon 现有 route + jifeng MCP bridge 当 agent runtime，workflow 脚本只做 plan / fan-out / 收敛逻辑。
2. **bundled workflow 是低成本 GA 抓手**。`/deep-research` 用一个高频研究场景示范 fan-out + 交叉核对 + 投票 + cited report，Qwen Code 可用同思路绑 deep-research / codebase-bug-sweep / migration-helper 三个 bundled flow 作 dogfooding 入口。
3. **`ultracode` effort 档位的打包思路**——一个开关把 xhigh reasoning + 自动 workflow 编排打包，session 内有效、新 session 重置。Qwen Code 可让 daemon 暴露一个 effort 切换 endpoint，不必新建配置项。
4. **避坑**：Anthropic 的双层 gate 静默失败是反例，Qwen Code 若引入 workflow 灰度务必**显式日志 + `/status` 暴露 feature flag 当前态**——daemon 系列已有 file logger（#4559）和 capability tag 机制，天然适合做这件事。

### 6.3 实施成本（high level）

| 模块 | 估算 | 复用点 |
|---|---|---|
| 基础 runtime（JS 沙箱 + agent dispatch + script variables 隔离） | ~3-5 人周 | daemon non-blocking `/prompt` + jifeng MCP bridge |
| 编排原语 8 件套 | ~2-3 人周 | 参照 LangGraph state machine + asyncio gather 混合 |
| `/workflows` 管理 UI（runs 列表 / phase 视图 / pause-resume） | ~2 人周 | daemon-react-sdk subpath 加载能力 |
| 1 个 bundled workflow（建议 deep-research / bug-sweep） | ~1-2 人周 | — |
| 灰度 + 关停层级（settings.json / env var / 组织级 managed settings 三档） | ~1 人周 | daemon capability tag + file logger |

**合计 ~9-13 人周**，可拆 3 个 Wave 增量交付；首版可只支持 `/workflow run <name>` + 1 个 bundled flow，不开放用户自定义。

---

## 七、引用

按相关度排序（primary source = 前 3）：

1. **[Orchestrate subagents at scale with dynamic workflows — Claude Code Docs](https://code.claude.com/docs/en/workflows)** — 官方权威定义页，覆盖语法 / runtime / 限制 / 触发方式 / 保存路径 / 禁用层级 / surface 覆盖。
2. **[Introducing dynamic workflows in Claude Code — Anthropic blog (2026-05-28)](https://claude.com/blog/introducing-dynamic-workflows-in-claude-code)** — 官方公告，narrative + Bun 移植案例。
3. **[Claude Code v2.1.154 Release notes](https://github.com/anthropics/claude-code/releases/tag/v2.1.154)** — Feature 在 changelog 首次出现，确认与 Opus 4.8 同日发布 + `/workflows` 命令 + task panel UI。
4. **[Issue #63876 — Workflow dispatch by scriptPath drops args](https://github.com/anthropics/claude-code/issues/63876)** — 披露 `Workflow({ name/scriptPath, args })` API shape、`.mjs` 格式、`~/.claude/workflows/` 解析 bug。
5. **[Issue #61637 — How to enable Workflow tool? GrowthBook gate](https://github.com/anthropics/claude-code/issues/61637)** — 启用机制反编译、双层 gate、8 primitives、schema-validated return。
6. **[Issue #61825 — CLAUDE_CODE_WORKFLOWS env var silently gates](https://github.com/anthropics/claude-code/issues/61825)** — `RB()` 反编译细节 + anti-pattern 归纳。
7. **[Create custom subagents — Claude Code Docs](https://code.claude.com/docs/en/sub-agents)** — workflow 赖以运行的底层 subagent 机制 + Agent SDK 关系。
8. **[Anthropic releases Opus 4.8 with new 'dynamic workflow' tool — TechCrunch (2026-05-28)](https://techcrunch.com/2026/05/28/anthropic-releases-opus-4-8-with-new-dynamic-workflow-tool/)** — 二手主流媒体，确认时间线 + codebase-scale migration hero use case。
9. **[Code w/ Claude SF 2026 — Anthropic blog](https://claude.com/blog/code-w-claude-sf-2026-sf)** — 公告前 22 天 Managed Agents orchestration 路线图 anchor。
10. **[Claude Opus 4.8 product page](https://www.anthropic.com/claude/opus)** — ⚠️ **此页未出现具名 dynamic workflows**，仅作 Opus 4.8 模型侧能力素材，不能背书 feature 本身。

> **免责声明**：以上数据基于 2026-05-28 公开发布后约 1 日内的官方文档 + 社区证据，feature 处于 research preview 阶段，API / 灰度 / 限制可能快速变化。8 primitives 具体命名等未披露细节标注 `[未验证]`。
