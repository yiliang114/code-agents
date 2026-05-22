# Qwen Code /review 功能分析

> 基于 Qwen Code、Copilot Code Review、Claude Code、Gemini CLI、gstack 五方源码/架构对比，分析 Qwen Code `/review` 的当前能力、竞品差异和改进方向。
>
> 返回 [改进建议总览](./qwen-code-improvement-report.md) | [/review 命令对比](./review-command.md)

## 一、Qwen Code /review 架构

```
/review [PR号|PR-URL|文件路径] [--comment]
  │
  ├─ Step 1:  确定审查范围（qwen review fetch-pr → worktree + metadata 单调一次）
  │           + 增量审查（SHA + model 匹配 → 跳过；--comment 仍跑）
  │           + 跨仓库 lightweight mode（URL 无匹配 remote → 跳 worktree/lint/build/test）
  ├─ Step 2:  加载项目审查规则（qwen review load-rules，从 base branch 读防注入）
  │           sources: .qwen/review-rules.md → copilot-instructions.md
  │           → AGENTS.md `## Code Review` 段 → QWEN.md `## Code Review` 段
  ├─ Step 3:  确定性分析（qwen review deterministic 一站打包）              [零 LLM 成本]
  │           TS/JS (tsc + eslint) + Python (ruff) + Rust (cargo clippy) + Go (vet + golangci-lint)
  │           + mypy/flake8 inline + Java (Maven/Gradle/Makefile) + C/C++ (clang-tidy)
  │           + CI 配置自动发现（从 base branch 读防注入）
  ├─ Step 4:  9 个并行审查 Agent                                          [9 次 LLM 调用]
  │   ├─ Agent 1: Correctness（逻辑/边界/并发/类型/错误处理）
  │   ├─ Agent 2: Security（注入/XSS/SSRF/认证/敏感数据/弱加密/硬编码 secret）
  │   ├─ Agent 3: Code Quality（命名/重复/过度抽象/死代码）
  │   ├─ Agent 4: Performance & Efficiency（N+1/算法/缓存/bundle）
  │   ├─ Agent 5: Test Coverage（新增代码路径是否有测试 / 关键 branch 覆盖）
  │   ├─ Agent 6a: Undirected — Attacker mindset 攻击者视角
  │   ├─ Agent 6b: Undirected — 3 AM oncall mindset 凌晨 3 点 oncall 视角
  │   ├─ Agent 6c: Undirected — Six-months-later maintainer mindset 半年后维护者视角
  │   └─ Agent 7: Build & Test（执行 shell 命令）
  ├─ Step 5:  去重 → 批量验证（单 Agent 一次性验所有 finding）→ 聚合          [1 次 LLM 调用]
  │           + 低置信度 finding 保留为 "Needs Human Review"（不再 reject swallow）
  ├─ Step 6:  迭代反向审计（每轮见前轮累积 finding 列表）                    [1-3 次 LLM 调用]
  │           终止条件: 某轮返 "No issues found." OR 3 轮硬上限
  │           注: 反向审计 finding 跳验证（agent 已有完整上下文，inherent 高置信）
  ├─ Step 7:  输出 findings + verdict（终端含 internal stats；PR comment 不含）
  ├─ Step 8:  Autofix（用户确认 → 应用 → 重跑 per-file linter 验证 → commit & push from worktree）
  ├─ Step 9:  qwen review presubmit（self-PR / CI 状态 / 已有评论 4-bucket 分类一次性 JSON）
  │           → 用 Create Review API 单次提交（verdict + inline comments 合一）
  │           → downgradeApprove (CI red/pending) / downgradeRequestChanges (self-PR)
  │           → 仅高置信 Critical/Suggestion 进 comments array，Nice to have 不上 PR
  ├─ Step 10: 保存报告 + 增量缓存（SHA + model + 报告路径）
  └─ Step 11: qwen review cleanup（worktree + branch ref + temp files 一次清理）
```

**LLM 调用 11-13 次**（同仓库；跨仓库 lightweight 10-12，跳 Agent 7）。具体取决于反向审计跑了几轮——多数 PR 1-2 轮收敛，3 轮硬上限防 runaway。

**Step 4 agent 数从 5 → 9 的演进**（[DESIGN.md](https://github.com/QwenLM/qwen-code/blob/main/packages/core/src/skills/bundled/review/DESIGN.md)）：原 5 agent 把 Correctness+Security 合一、Undirected 单 pass，召回率有天花板；现 6 个 review 维度 + 1 build/test + Undirected 拆 3 personas 强制不同 mental traversal，并行执行成本仅约 1×（time）但召回率显著提升。

**`qwen review` 子命令**（PR#3754 把 SKILL.md 内联的 shell 逻辑提到 TS 子命令）：`qwen review fetch-pr` / `pr-context` / `load-rules` / `deterministic` / `presubmit` / `cleanup` —— 减少 prompt token 成本、消除 prompt-描述 与 LLM-合成的双源 drift、TS 模块化跨平台路径 / CRLF 处理、可单测。

源码：`packages/core/src/skills/bundled/review/SKILL.md`（663 行）+ `DESIGN.md`（286 行）+ `packages/cli/src/commands/review/{cleanup,deterministic,fetch-pr,load-rules,pr-context,presubmit}.ts`

## 二、竞品分析

### 2.1 Copilot Code Review——生产规模数据

GitHub 截至 2026-03 的官方数据（来源：[60 Million Copilot Code Reviews](https://github.blog/ai-and-ml/github-copilot/60-million-copilot-code-reviews-and-counting/)）：

| 指标 | 数值 |
|------|------|
| 累计审查量 | 6000 万+（占 GitHub 全部 code review 的 20%+） |
| 采用组织数 | 12,000+ |
| 无评论比例 | 29%（Agent 选择保持沉默） |
| 有行动反馈比例 | 71% |
| 平均评论数 | ~5.1 条/次 |
| Agentic 架构升级效果 | 正面反馈 +8.1%（2026-03-05） |

### 2.2 Copilot CLI code-review prompt 设计哲学

从 Copilot CLI 二进制反编译提取的 `code-review.agent.yaml`（94 行，见 `docs/tools/copilot-cli/EVIDENCE.md`）中的关键设计原则：

> *"Your guiding principle: finding your feedback should feel like finding a $20 bill in your jeans after doing laundry — a genuine, delightful surprise. Not noise to wade through."*

> *"Silence is better than noise. Every comment you make should be worth the reader's time."*

> *"If you're unsure whether something is a problem, DO NOT MENTION IT."*

**8 个审查维度（白名单）**：Bugs、Security、Race conditions、Memory leaks、Missing error handling、Incorrect assumptions、Breaking API changes、Performance issues

**8 个排除维度（黑名单）**：Style/formatting、Grammar、"Consider doing X"、Minor refactoring、Code organization、Missing docs、"Best practices" without real problems、Anything uncertain

**独特设计**：允许 `bash` 运行 build/test 验证，允许 `view`/`grep`/`glob` 读取代码，但 **禁止 `edit`/`create` 修改代码**——只读验证，不碰源码。

### 2.3 Claude Code /ultrareview 云端多 Agent 架构

Claude Code 除本地 `/review`（30 行 prompt）外，还有 `/ultrareview`——远程 CCR 云端审查：

- **Fleet 规模**：默认 **5 个并行 Agent**（可配置 5-20，源码: `BUGHUNTER_FLEET_SIZE`）
- **时长控制**：总墙钟 10-25 分钟（`BUGHUNTER_MAX_DURATION`）
- **三阶段流水线**：finding → verifying → synthesizing
- **付费门控**：免费层有次数限制，Enterprise 无限制

源码: `commands/review/reviewRemote.ts`（316 行）

### 2.4 gstack /review 的结构化审查方法论

[gstack](https://github.com/garrytan/gstack)（Y Combinator CEO Garry Tan 的开源工作流）提供了一个 1,467 行的 `/review` Skill，其审查维度设计值得参考：

**审查分类**（不同于 Copilot 的 8 维度通用审查）：

| 分类 | 说明 | Qwen Code /review 覆盖 |
|------|------|:----------------------:|
| SQL 安全 | 注入、未参数化查询、权限过宽 | ⚠️ 部分（Agent 1 安全） |
| LLM 信任边界 | 用户输入直传 LLM、prompt 注入 | ❌ 未覆盖 |
| 条件副作用 | 条件分支中的不可逆操作 | ⚠️ 隐式覆盖 |
| 结构性问题 | CI 通过但 prod 会挂的问题 | ✅ Agent 4 无方向审计 |

**gstack 独特设计**：
- **Proactive 触发**：Skill 描述中内置 `"Proactively suggest when the user is about to merge or land code changes"`——Agent 主动建议审查而非被动等待命令
- **与 `/qa` 联动**：审查后可直接触发 `/qa` 用真实浏览器验证前端变更
- **与 `/ship` 联动**：review → test → bump → push → PR 一键流水线

**对 Qwen Code 的启发**：
1. 增加 **LLM 信任边界** 审查维度——检测 prompt injection 和用户输入直传 LLM 的安全风险
2. 增加 **Proactive 触发**——当检测到用户即将 push/merge 时主动建议审查
3. 考虑 `/review` → `/qa` 联动——审查后自动验证前端变更

### 2.5 为什么 GitHub PR 里的 Copilot 体感更好

Copilot Code Review 效果好，核心不只是模型能力，而是**任务约束 + 平台优势 + 确定性工具 + 高 precision 策略**四者叠加。

**PR review 是强约束任务**：

PR review 天然比通用聊天更适合高质量输出，因为输入输出都被强约束：

- 输入不是"整个仓库"，而是**这次 diff + base branch + PR 元数据**
- 输出不是长篇解释，而是**具体文件/具体行的 review comment**
- 目标不是开放式问答，而是**发现高风险问题**

这意味着 Qwen Code 的 `/review` 天然也具备做好的条件——diff 是明确的，PR 元数据可以通过 `gh pr view` 获取。

**平台 vs CLI 能力边界**：GitHub PR 页面拥有 CLI 不具备的原生上下文（评论历史、checks、code scanning alerts）。从 Copilot CLI 二进制分析可确认 CLI 端也有 `code-review` agent，但跨 PR 记忆、CodeQL 深度集成、事件驱动审查属于平台级能力。

**"沉默优于噪声"**：29% 的 Copilot 审查返回零评论——这是设计使然。少量高价值评论比大量泛化建议更有用。学术研究表明 LLM 正确性判定准确率仅 68.5%（GPT-4o），低质量反馈导致"狼来了效应"。

**用户反馈飞轮**：每个评论有 👍/👎 反馈，6000 万次审查 × 5.1 条评论 = 持续改进的数据飞轮。这是 CLI 工具无法复制的生产规模反馈闭环。

### 2.6 竞品架构深度剖析

1. **Copilot Code Review（平台级）**：
   - **Agentic 工作流**：从 prompt 架构重构为 agentic tool-calling 架构（2026-03-05），Agent 主动收集仓库上下文（代码、目录结构、引用）来理解变更如何融入整体架构。升级后正面反馈 +8.1%。
   - **边读边捕获**：阅读代码时实时记录问题，避免传统"读完再总结"导致的早期发现遗忘。
   - **跨 PR 记忆**：识别出的代码模式可存储并在后续审查中复用，打破单次审查孤立性。
   - **显式规划策略**：针对超长/复杂 PR 提前生成审查路径图，防止上下文丢失。
   - **CodeQL 深度集成**：将 LLM 概率推理与 CodeQL 确定性语义/安全分析融合。CodeQL 提供安全漏洞和数据流的 Ground Truth，LLM 负责解释并过滤噪音，极大降低幻觉。
   - **Autofix**：提供一键修复建议，并通过 `copilot-instructions.md` 注入团队审查规范。
   - **用户反馈闭环**：每个评论 👍/👎，👎 需提供原因，直接用于模型迭代。

2. **Claude Code（`/review` + `/ultrareview` 双层架构）**：
   - **`/review`（本地）**：采用 Prompt 包装模式（`LOCAL_REVIEW_PROMPT`），用 `gh pr diff` 获取差异，给出单次全面审查。拥有 tools: *（所有工具），模型可自主探索代码。
   - **`/ultrareview`（云端多 Agent 编排）**：
     - **Fleet 规模**：默认 **5 个并行 Agent**（可配置 5-20），每个 Agent 独立寻找 Bug。
     - **三阶段流水线**：`finding`（发现）→ `verifying`（验证）→ `synthesizing`（去重合成）。
     - **验证过滤**：每个发现的 Bug 由独立验证 Agent 确认，置信度 < 8 的被过滤。17+ 类误报排除规则。
     - **Live 进度**：每 ~10 秒推送 `<remote-review-progress>` 标签，包含 bugs_found / bugs_verified / bugs_refuted 计数。
     - **时长控制**：总墙钟时间上限 22-27 分钟，单 Agent 超时 10-30 分钟。
     - **计费门控**：免费层有次数限制，Enterprise 用户无限制，用完后需确认 Extra Usage 计费（最低 $10 余额）。
     - 源码：`commands/review.ts`、`commands/review/reviewRemote.ts`、`commands/review/ultrareviewCommand.tsx`（Claude Code 本地源码 `/root/git/claude-code-leaked/`）

3. **Gemini CLI（`async-pr-review` Skill）**：
   - **异步模式**：通过 `is_background: true` 在后台分离执行，用 `gemini -p`（headless 模式）实现纯后台 LLM 推理。
   - **5 并行后台任务**（源码：`.gemini/skills/async-pr-review/scripts/async-review.sh`）：
     | 任务 | 内容 |
     |------|------|
     | `[1/5] pr-diff` | `gh pr diff` 捕获差异 |
     | `[2/5] build-and-lint` | `npm ci && npm run build && npm run lint:ci && npm run typecheck` |
     | `[3/5] review` | `gemini --policy policy.toml -p "/review-frontend <pr_number>"`（headless） |
     | `[4/5] npm-test` | 等待 build-and-lint 完成后，`gh pr checks` + 选择性本地测试 |
     | `[5/5] test-execution` | headless Gemini 手动操作变更代码，验证交互行为 |
   - **Ephemeral Worktree**：在 `.gemini/tmp/async-reviews/pr-<number>/worktree` 创建临时工作树，不污染主工作区。
   - **codebase_investigator 子 Agent**：专用的只读深度调查 Agent（Flash 模型，3 分钟限时），构建完整的代码调用链心智模型，输出结构化 JSON 报告。
   - **review-duplication Skill**：专门的重复代码检测技能，使用 `codebase_investigator` 深度搜索项目中是否已存在相同逻辑。
   - **闭环验证**：所有任务完成后，headless Gemini 合成 `final-assessment.md`，整合测试日志、lint 结果、LLM Review。
   - 源码：`.gemini/skills/async-pr-review/`（Gemini CLI 本地源码 `/root/git/gemini-cli/`）

4. **Qwen Code（`/review` Skill）**：
   - **9 Agent 并行维度**：Correctness / Security / Code Quality / Performance / **Test Coverage** / **Undirected ×3 personas (attacker / 3am-oncall / 6-months-later maintainer)** / **Build & Test**。原 5 agent 演进到 9 agent —— Correctness+Security 拆分让两个 mindset 都拿满 attention；Test Coverage 独立 dimension 防系统盲点；Undirected 拆 3 personas 强制不同 mental traversal 显著提升召回率。
   - **确定性分析前置**：`qwen review deterministic` 一站打包 TS/JS/Python/Rust/Go (6 语言 linter+typecheck) + Java/C++ inline + **CI 配置自动发现**（从 base branch 读防注入），零 LLM 成本。
   - **批量验证 + 低置信保留**：单 Agent 批量验证所有 findings（O(1) not O(N)）；不确定的 finding 保留为 "Needs Human Review"（终端显示，不上 PR comment）—— 不再 reject silently swallow valid concerns。
   - **迭代反向审计**：每轮 agent 见所有前轮累积 finding，"No issues found." 或 3 轮硬上限收敛；反向审计 finding 跳验证（agent 已有完整上下文，inherent 高置信）。
   - **Pre-submission checks**: `qwen review presubmit` 一次性 JSON 报告 (self-PR / CI 状态 / 已有评论 4-bucket 分类)：CI red/pending → APPROVE 自动 downgrade COMMENT；self-PR → REQUEST_CHANGES 自动 downgrade COMMENT（GitHub 422 阻止）；overlap 已有评论 → 阻塞提交。
   - **Create Review API 单次提交**：verdict + inline comments 一次 API 调用提交（替原多次 `gh api .../comments`）。
   - **Autofix 闭环**：用户确认 → 自动应用 + per-file linter 验证 → commit & push from worktree（push 失败 fork 场景保留 worktree 待用户手动 push）。
   - **跨仓库 lightweight mode**：URL 无 local remote 匹配 → `gh pr diff <url>` 直拉 diff，跳 worktree/lint/build/test/autofix。CLI 工具能做的极限。
   - **语言匹配**：PR 英文 → 评论英文，PR 中文 → 评论中文；local review 跟用户输入语言。
   - **安全加固**：审查规则 + CI 配置都从 base branch 读（防 PR 端注入 "永不报安全问题" 这类毒规则）；PR 描述标记为 DATA。
   - **`qwen review` TS 子命令**（PR#3754）：6 个子命令把 prompt 里的 shell 逻辑提到 TypeScript（`fetch-pr` / `pr-context` / `load-rules` / `deterministic` / `presubmit` / `cleanup`），减少 prompt token / 消除双源 drift / 跨平台 path 处理 / 可单测。
   - **LLM 调用 11-13 次**（cross-repo 10-12）：9 agent + 1 verify + 1-3 iterative reverse。
   - 源码：`packages/core/src/skills/bundled/review/SKILL.md`（663 行）+ `DESIGN.md`（286 行）+ `packages/cli/src/commands/review/`

### 2.7 对比矩阵

| 能力 | Qwen Code | Copilot Code Review | Claude Code | Gemini CLI |
|------|-----------|-------------------|-------------|-----------|
| 并行审查 Agent | ✅ **9 个并行**（6 review dim + 3 personas + 1 build/test） | ✓ Agentic（单 agent 多工具）| ✓ 本地 1 个 + 云端 5 个（/ultrareview） | ✓ 5 个异步任务 + Headless |
| 独立验证 | ✅ **批量验证（1 Agent）** | — | ✓ 验证 Agent（/ultrareview） | — |
| 确定性分析（linter/typecheck） | ✅ **6 语言内置** | ✓ CodeQL + ESLint | — | ✓ 自动前置检查脚本 |
| 构建/测试执行 | ✅ **Agent 5 并行** | ✓（Actions CI 集成） | — | ✓ 临时工作树中跑测试 |
| 跨文件影响分析 | ✅ **grep 调用者** | ✓ 追踪 import 链与调用流 | ✓ tools: * 自主探索 | ✓ `codebase_investigator` |
| 重复代码检测 | — | — | — | ✓ `review-duplication` skill |
| 异步/后台审查 | ❌ | ✓ GitHub Actions 后台 | ✓ /ultrareview 云端后台 | ✓ Native Background Shells |
| 项目规则自定义 | ✅ **.qwen/review-rules.md** | ✓ `copilot-instructions.md` | ✓ CLAUDE.md（全局指令） | ✓ `.gemini/skills` 体系 |
| 评论聚合 | ✅ **同模式合并 + top 3** | ✓ 同模式合并 | ✓ 去重合成（/ultrareview） | — |
| 自动修复（Autofix） | ✅ **用户确认 + 验证 + commit** | ✓ 基于分析结果一键修复 | — | — |
| 增量审查 | ✅ **SHA + model 缓存** | ✓ 新 commit 触发 | — | — |
| 跨 PR 记忆 | — | ✓ | — | — |
| Live 进度反馈 | — | — | ✓ 10 秒轮询进度 | ✓ .exit 文件状态跟踪 |
| 置信度过滤 | ✅ **High/Low 分级** | — | ✓ 置信度 < 8 过滤 | — |
| 用户反馈闭环 | — | ✓ 👍/👎 + 原因 | — | — |
| 反向审计 | ✅ **迭代反向审计**（1-3 轮收敛 / 3 轮硬上限 / 跳验证） | — | — | — |
| Test Coverage 专 Agent | ✅ **专用 Agent 5**（新增 code path 是否带测试 + critical branch 覆盖） | — | — | — |
| Undirected 多 persona | ✅ **3 personas**（attacker / 3am-oncall / 6-months-later maintainer） | — | — | — |
| Pre-submission checks | ✅ **`qwen review presubmit` 一次性 JSON**（self-PR / CI / 4-bucket comment） | ✓ 平台级 CI 集成 | — | — |
| Create Review API 单次提交 | ✅ verdict + inline comments 合一 | ✓（平台原生） | — | — |
| CI 红 → APPROVE downgrade | ✅ **自动 downgrade COMMENT + body 解释** | ✓ 平台 CI 集成 | — | — |
| 已有评论 4-bucket 分类 | ✅ **stale/resolved/overlap/no-conflict 优先级匹配**，仅 overlap 阻塞 | — | — | — |
| Worktree 隔离 | ✅ **临时 worktree** | — | — | ✓ 临时工作树 |
| PR 评论去重 | ✅ **获取已有评论** | — | — | — |
| 报告持久化 | ✅ **.qwen/reviews/** | — | — | ✓ final-assessment.md |
| 跨仓库 PR | ✅ **gh pr diff URL** | ✓ | — | — |
| PR 噪声控制 | ✅ **仅高置信 Critical/Suggestion** | ✓ | — | — |

### 2.8 剩余差距

| 差距 | 竞品参考 | 难度 |
|------|---------|:----:|
| **异步后台审查** | Gemini CLI `async-pr-review`、Claude Code `/ultrareview` | 中（需 BundledSkillLoader 改动） |
| **跨 PR 记忆** | Copilot（识别的代码模式可在后续审查中复用） | 大（需持久化 + 模式提取） |
| **用户反馈闭环** | Copilot 👍/👎 + 原因反馈，直接用于模型迭代 | 大（需后端服务） |
| **LLM 信任边界审查** | gstack /review（检测 prompt injection + 用户输入直传 LLM） | 小（SKILL.md 加维度） |
| **重复代码检测** | Gemini CLI `review-duplication` skill | 中 |
| **Proactive 触发** | gstack（检测到 push/merge 时主动建议审查） | 小（SKILL.md 描述） |
| **审查→QA 联动** | gstack `/review` → `/qa` 浏览器验证前端变更 | 中（需 browse 能力） |
| **远程云端审查** | Claude Code `/ultrareview`（5-20 Agent fleet，10-25 分钟） | 大（需云端基础设施） |

## 三、Qwen Code /review 基础设施

> 以下基础设施在 SKILL.md 中实际使用。

### 3.1 通用工具与服务

| 基础设施 | 源码 | 用于 |
|---------|------|------|
| `task` 工具 + 9 并行 Subagent | `packages/core/src/tools/agent.ts` | Step 4: 9 Agent 并行审查（6 review dim + 3 personas + 1 build/test） |
| `run_shell_command` | `packages/core/src/tools/shell.ts` | Step 3: linter/typecheck + Agent 7: build/test |
| `grep_search` + `read_file` | `packages/core/src/tools/grep.ts` | 跨文件调用方搜索 + 签名检查 |
| `write_file` + `edit` | `packages/core/src/tools/write-file.ts` | Step 8: Autofix + Step 10: 报告持久化 |
| `gh` CLI | SKILL.md 多步使用 | PR diff、Create Review API 单次提交、已有评论去重 |
| `git worktree` | SKILL.md Step 1/11 | PR 审查临时隔离 + 清理 |
| `BundledSkillLoader` | `packages/cli/src/services/BundledSkillLoader.ts` | `{{model}}` 模板变量注入 |

### 3.2 `qwen review` 专用子命令（PR#3754）

> 把 SKILL.md 内联的复杂 shell 逻辑提取到 TypeScript 子命令，减少 prompt token、消除双源 drift、可单测。

| 子命令 | 源码 | 用于 | 输出 |
|---|---|---|---|
| `qwen review fetch-pr` | `packages/cli/src/commands/review/fetch-pr.ts` | Step 1: 清 stale worktree + fetch PR HEAD + `gh pr view` + 创建 ephemeral worktree | JSON: worktreePath / baseRefName / headRefName / fetchedSha / isCrossRepository / diffStat |
| `qwen review pr-context` | `packages/cli/src/commands/review/pr-context.ts` | Step 1: PR metadata + 已讨论 issues 单文件聚合 | Markdown: PR title/description/base/head + Already discussed + Open inline comments (含完整回复链) |
| `qwen review load-rules` | `packages/cli/src/commands/review/load-rules.ts` | Step 2: 从 base ref 读 4 个 rule sources 防注入 | Markdown: .qwen/review-rules.md + copilot-instructions.md + AGENTS.md `## Code Review` + QWEN.md `## Code Review` |
| `qwen review deterministic` | `packages/cli/src/commands/review/deterministic.ts` | Step 3: 多语言 linter/typecheck 一站打包 | JSON: findings[] (pre-confirmed Critical/Nice to have) + toolsRun[] + toolsSkipped[] |
| `qwen review presubmit` | `packages/cli/src/commands/review/presubmit.ts` | Step 9: 3 个 deterministic gh API check 合一 | JSON: isSelfPr / ciStatus (4-class) / existingComments (4-bucket) / downgradeApprove / downgradeRequestChanges / downgradeReasons / blockOnExistingComments |
| `qwen review cleanup` | `packages/cli/src/commands/review/cleanup.ts` | Step 11: worktree + branch ref + temp files 一次清理（幂等） | - |

### 3.3 持久化路径

| 路径 | 写入步骤 | 用于 |
|---|---|---|
| `.qwen/review-rules.md` | Step 2 读 | 项目自定义审查规则 |
| `.qwen/reviews/<date>-<time>-<target>.md` | Step 10 写 | 审查报告持久化 |
| `.qwen/review-cache/pr-<n>.json` | Step 10 读写 | 增量审查缓存（lastCommitSha + lastModelId + lastReviewDate + findingsCount + verdict） |
| `.qwen/tmp/qwen-review-<target>-*.{json,md}` | Step 1/2/3/9 临时 | fetch report / PR context / rules / deterministic / presubmit / review JSON |
| `.qwen/tmp/review-pr-<n>/` | Step 1 创建 | ephemeral worktree（PR 审查独立 working tree） |

## 四、下一步改进建议

> 已实现的 9 项基础建议详见 [PR#2932](https://github.com/QwenLM/qwen-code/pull/2932)；后续 9 agent + iterative reverse audit + qwen review 子命令在 [PR#3754](https://github.com/QwenLM/qwen-code/pull/3754) 落地。以下为尚未实现的改进方向。

### P1：Fork Subagent — 大幅降 token 成本

**问题**：当前 11-13 次 LLM 调用各自从 scratch 创建 subagent，system prompt (~50K tokens) 独立发送给每个 agent，总输入 ~570-680K input tokens 冗余巨大。Agent 数从 5 涨到 9 之后，这个成本问题更突出。

**方案**：Fork Subagent —— fork 当前 conversation 而非新建 subagent，所有 fork 继承 parent 完整 context (system prompt + conversation history + Step 1/1.1/1.5 results) + 共享 prompt cache prefix。API 缓存 common prefix 一次，每个 fork 只付 unique delta (~2K per agent)。

**节省**：约 85-90% token reduction (~620K → ~75K)，零质量影响。

**额外好处**：
- Forked agent 继承 Step 3 linter results / PR context / review rules——不需要在每个 agent prompt 重复
- SKILL.md 当前的 workaround "Do NOT paste the full diff into each agent's prompt" 变得不必要
- Verification 和 reverse audit agent 自然继承所有 prior findings
- Agent 6 personas 可从 shared diff-loaded base fork，只付 persona-framing delta

**依赖**：[Fork Subagent proposal](./qwen-code-improvement-report-p0-p1-core.md#2-fork-subagentp0) —— platform-level 改动 ~400 行 / ~5 天，需改 `AgentTool` / `forkSubagent.ts` / `CacheSafeParams`。

### P2：异步后台审查

**问题**：审查大 PR（>500 行 diff）需要 2-3 分钟，期间阻塞 CLI。

**方案**：`BundledSkillLoader` 支持后台执行 + worktree 隔离。参考 Gemini CLI 的 `async-pr-review`（5 并行后台任务 + headless 模式）。

**实现成本**：SKILL.md +20 行 + `BundledSkillLoader` 后台执行支持（需代码改动）。

### P2：LLM 信任边界审查

**问题**：当前 Security Agent 未单独覆盖 AI 应用特有的安全风险——用户输入直传 LLM、prompt injection、agent self-corruption。

**方案**：在 Agent 2（Security）的审查维度中增加 LLM 信任边界检测。参考 gstack `/review` 的分类。

**实现成本**：SKILL.md Agent 2 指令增加 ~10 行。

### P3：Proactive 触发

**问题**：用户需要主动输入 `/review`，Agent 不会在检测到 push/merge 意图时主动建议。

**方案**：在 SKILL.md 描述中添加 proactive 触发条件。参考 gstack 的 `"Proactively suggest when the user is about to merge or land code changes"`。

### P3：审查→QA 联动

**问题**：前端变更审查后无法自动验证浏览器渲染效果。

**方案**：审查完成后建议运行 `/qa` 用真实浏览器验证。需要先实现浏览器集成（见 [Chrome Extension](./qwen-code-improvement-report-p2-tools-commands.md#item-5)）。

### P3：远程云端审查

**问题**：本地审查受限于单机性能和单次会话；11-13 LLM 调用在大 PR 上仍有 2-3 分钟 wall-clock。

**方案**：参考 Claude Code `/ultrareview`（5-20 Agent fleet、10-25 分钟云端审查）。需要云端基础设施。

### P3：用户反馈闭环

**问题**：当前 PR comment 没有 👍/👎 反馈机制；Copilot 的 6000 万次审查 × 5.1 条评论的飞轮无法复制。

**方案**：在 daemon 模式（[#4175 Wave plan](./qwen-code-daemon-design/06-roadmap.md)）落地后，daemon-side 状态可以记录 user 在哪些 inline comment 上点了 :+1: / :-1:，反哺 review-rules 迭代。

**依赖**：daemon 模式 + 后端服务。

## 五、设计哲学

> **"Silence is better than noise"** — 宁可少报，不误报。

Qwen Code `/review` 的设计遵循 Copilot Code Review 的核心原则：

- linter 警告 / Nice to have → 仅终端显示，不发 PR 评论
- 低置信度 findings 不删（避免 silent swallow valid concerns）但分流到终端 "Needs Human Review"，**不上 PR comment**
- 仅高置信 Critical/Suggestion 进 PR comment `comments` array（且必须有 `line` field 不允许 orphan）
- 同模式问题 pattern aggregation（>5 处 non-Critical 显示 top 3 + "and N more locations"；Critical 全列）
- Verdict 仅基于高置信 finding（低置信不影响 Approve/Request changes/Comment 判定）
- 不确定时 downgrade 到 low-confidence（不 reject）—— rejection 仅留给 "factually wrong about the code" / 匹配 Exclusion Criterion / 无 concrete evidence 的 vague suspicion
- **CI 红 / pending → APPROVE 自动 downgrade COMMENT**（LLM 静态审查看不到 runtime test failure，APPROVE 误导）
- **Self-PR → REQUEST_CHANGES/APPROVE 自动 downgrade COMMENT**（GitHub 422 阻止）
- 同 `(path, line)` 已有 Qwen comment → 阻塞提交（避免 visual duplicate）；stale/replied/no-overlap 3 类不阻塞，仅 log
- **语言匹配**: PR 英文 → 评论英文，PR 中文 → 评论中文；不切换语言
- **`#N` notation 禁用**: 避免 GitHub auto-link 到 issues/PRs

学术研究表明 LLM 正确性判定准确率仅 68.5%（GPT-4o）。低质量反馈会导致"狼来了效应"——开发者停止阅读所有 AI 评论，从而错过真正的问题。Copilot 生产数据 29% 审查返回零评论也是这个原则的体现。

### 5.1 关键设计抉择（[DESIGN.md](https://github.com/QwenLM/qwen-code/blob/main/packages/core/src/skills/bundled/review/DESIGN.md) 摘录）

| 抉择 | 理由 |
|---|---|
| **9 agent 而非 1 agent** | 9× LLM 成本可接受（并行执行 ~1× wall-clock）；维度分聚焦提升召回；3 personas 强制不同 mental traversal |
| **拆 Correctness / Security** | 合一时一个 dimension 主导输出另一个浅薄；不同 mindset ("does this do what it intends" vs "what unintended thing can hostile actor make this do") |
| **专门 Test Coverage agent** | Test gap 是系统盲点；bug-focused agent 很少看新 code 是否带充分测试 |
| **3 undirected personas** | Ensemble diversity 在 3-5 sampled paths 后 drop 显著；3 是 sweet spot |
| **批量验证而非 N 独立 agent** | 单 agent 验 15 finding 有 MORE context（看 cross-finding 关系）；成本 O(N) → O(1) |
| **iterative reverse audit (1-3 轮)** | 单 pass 漏 agent 自己漏的；3 轮硬上限防 stuck loop fabricate issue |
| **反向审计跳验证** | Agent 已有 full context（所有 confirmed + 全 diff），inherent 高置信 |
| **低置信保留而非 reject** | Rejection silently swallow valid concerns；用户在下一轮 /review 才发现 = 累积 pain |
| **Worktree 而非 stash + checkout** | 消除 stash orphan / wrong-branch / dirty-tree blocking 一整类 bug |
| **`qwen review` TS 子命令** | 减 prompt token / 消除 prompt 描述与 LLM 合成的双源 drift / 跨平台路径 / 可单测 |
| **Base-branch 读 review-rules + CI config** | 防恶意 PR 注入 "永不报安全问题" 这类毒规则 |
| **Follow-up tips 而非 blocking prompt** | Ghost text 不阻断终端流；Autofix 例外（改代码高 stake 需显式 y/n） |
| **CI red 不阻塞而是 downgrade** | LLM substantive work 不浪费；inline comment 仍提交；CI 状态自然 carry "do not merge" |
| **Cross-repo lightweight mode** | CLI 工具能做的极限（无 worktree/lint/build/test/autofix，但 GitHub API 还能跑） |
