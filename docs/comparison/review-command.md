# 7. /review 命令实现深度对比

> 基于四个工具的 review 命令完整源码逐行分析。面向 Code Agent 开发者的技术对比。

## 源码来源

| Agent | 源码文件 | 行数 | 获取方式 |
|------|---------|------|---------|
| **Claude Code** | `plugins/code-review/commands/code-review.md` | 109 | GitHub API |
| **Copilot CLI** | `definitions/code-review.agent.yaml` | 94 | 本地 npm 包提取 |
| **Qwen Code** | `packages/core/src/skills/bundled/review/SKILL.md` + `DESIGN.md` + `packages/cli/src/commands/review/` | 663 + 286 + 6 TS 子命令 | 本地源码 |
| **Codex CLI** | `codex review --help` + 二进制分析 | 37 | 本地 --help |
| **Qoder CLI** | 二进制 strings 提取 `/review-code` + `/review-pr` | — | Go 二进制反编译 |

> **Qwen Code `/review` 自分析以来已大幅演进**（2026 Q1）：从 4 agent / 123 行 SKILL.md 升级为 **9 agent + 批量验证 + 迭代反向审计 + 6 个 `qwen review` TS 子命令**，663 行 SKILL.md + 286 行 DESIGN.md。下文 Qwen Code 部分均基于当前源码。

---

## 一、架构设计对比

### Claude Code：编排者模式（Orchestrator）

```
用户 → /code-review [--comment]
  │
  ├── Step 1: Haiku 前置检查代理
  │     └── 检查: 已关闭? 草稿? trivial? 已审查?
  │
  ├── Step 2: Haiku 规范收集代理
  │     └── 搜集仓库中所有 CLAUDE.md 文件路径
  │
  ├── Step 3: Sonnet 摘要代理
  │     └── 生成 PR 变更结构化摘要
  │
  ├── Step 4: 4 并行审查代理 ──┬── Sonnet: CLAUDE.md 合规 #1
  │                            ├── Sonnet: CLAUDE.md 合规 #2（冗余）
  │                            ├── Opus: Bug 扫描（仅 diff）
  │                            └── Opus: 安全/逻辑分析（新增代码）
  │
  ├── Step 5: N 并行验证代理（每个问题一个）
  │     ├── Opus 验证 Bug（读取完整上下文确认）
  │     └── Sonnet 验证 CLAUDE.md 违规（确认规则范围）
  │
  ├── Step 6: 过滤未通过验证的问题
  │
  ├── Step 7: 终端输出
  │
  ├── Step 8: 内部自检（列出计划评论，不发布）
  │
  └── Step 9: 发布 PR 内联评论（如 --comment）
        └── mcp__github_inline_comment__create_inline_comment
```

**设计理念：高信号、低噪音。** 通过验证步骤（Step 5）和过滤步骤（Step 6）确保只有真正的问题被报告。宁可漏报也不误报。

**模型分层策略：**
- **Haiku**（最便宜）：前置检查、文件列表等低复杂度任务
- **Sonnet**（平衡）：摘要、合规审计、CLAUDE.md 验证
- **Opus**（最强）：Bug 检测、安全分析、Bug 验证（需要最深推理）

**代理数量：** 最少 7 个代理（2 Haiku + 1 Sonnet + 4 审查），若发现 N 个问题则再增加 N 个验证代理。

---

### Copilot CLI：单代理深度模式（Single-Agent Deep）

```
用户 → /review
  │
  └── code-review 代理 (claude-sonnet-4.5, tools: *)
        │
        ├── 1. git status → staged/unstaged/branch diff
        ├── 2. 读取周围代码理解上下文
        ├── 3. 尝试编译/测试验证
        └── 4. 仅报告高置信度问题
```

**设计理念："$20 bill in jeans"** — 每条反馈都应该是惊喜，不是噪音。

**与 Claude Code 的根本区别：** 没有独立的验证**代理**，但有**实际运行验证**。Claude Code 用独立 LLM 代理重新审查每个问题；Copilot CLI 用 `bash` 工具实际编译代码和运行测试来验证。这是两种不同的验证哲学：**LLM 推理验证 vs 代码执行验证。**

**验证能力（源码原文，tools: `"*"`）：**
```
3. **Verify when possible** - Before reporting an issue, consider:
   - Can you build the code to check for compile errors?
   - Are there tests you can run to validate your concern?
   - Is the "bug" actually handled elsewhere in the code?
   - Do you have high confidence this is a real problem?
```

```
Use `bash` to run git commands, build, run tests, execute code
```

> **重要发现：** Copilot CLI 拥有 `tools: ["*"]`（全部工具），prompt 明确指示它**编译代码、运行测试**来验证发现的问题。这意味着它的验证不是靠"第二个 LLM 思考"，而是靠**实际执行代码**。在某些场景下（如编译错误检测），这比 Claude Code 的 LLM 验证更可靠。

**关键约束（源码原文）：**
```
CRITICAL: You Must NEVER Modify Code.
You have access to all tools for investigation purposes only:
- Use `bash` to run git commands, build, run tests, execute code
- Use `view` to read files and understand context
- Use `grep` and `glob` to find related code
- Do NOT use `edit` or `create` to change files
```

这是唯一**同时禁止修改代码但允许运行代码**的实现——可以编译和测试，但不能修改。

---

### Qwen Code：并行维度模式（Parallel Dimensions，11 步流水线）

```
用户 → /review [PR号 | PR-URL | 文件路径] [--comment]
  │
  ├── Step 1: 确定审查范围（qwen review fetch-pr → ephemeral worktree + metadata）
  │     ├── 无参数 → git diff + git diff --staged
  │     ├── PR 号/同仓库 URL → worktree 流程 + 增量审查检查（SHA + model 缓存）
  │     ├── 跨仓库 URL（无匹配 remote）→ lightweight mode（gh pr diff，跳 worktree/lint/build/test）
  │     └── 文件路径 → git diff HEAD -- <file>
  │
  ├── Step 2: 加载审查规则（qwen review load-rules，从 base branch 读防注入）
  ├── Step 3: 确定性分析（qwen review deterministic：TS/JS/Python/Rust/Go linter+typecheck）[零 LLM]
  │
  ├── Step 4: 9 并行审查代理 ──┬── Agent 1: Correctness
  │                            ├── Agent 2: Security
  │                            ├── Agent 3: Code Quality
  │                            ├── Agent 4: Performance & Efficiency
  │                            ├── Agent 5: Test Coverage
  │                            ├── Agent 6a: Undirected — Attacker mindset
  │                            ├── Agent 6b: Undirected — 3 AM oncall mindset
  │                            ├── Agent 6c: Undirected — 6-months-later maintainer mindset
  │                            └── Agent 7: Build & Test（执行 shell 命令）
  │
  ├── Step 5: 去重 → 批量验证（单 Agent 一次性验所有 finding）→ pattern 聚合
  ├── Step 6: 迭代反向审计（1-3 轮，"No issues found." 或 3 轮硬上限收敛）
  ├── Step 7: 输出 Summary + Findings + Needs Human Review + Verdict
  ├── Step 8: Autofix（用户确认 → 应用 → per-file linter 验证 → commit & push from worktree）
  ├── Step 9: qwen review presubmit → Create Review API 单次提交（--comment）
  ├── Step 10: 保存报告 + 增量缓存
  └── Step 11: qwen review cleanup（worktree + branch ref + temp files）
```

**设计理念：全维度覆盖 + 自由探索 + 确定性验证。** 6 个 review 维度 + 1 build/test 覆盖已知维度，Undirected 拆 3 personas（attacker / 3am-oncall / maintainer）强制不同 mental traversal 捕获维度盲区。

**与 Claude Code 的关键差异：**
1. **有验证步骤** — 批量验证（单 Agent 验所有 finding，O(1) not O(N)）+ 迭代反向审计
2. **有确定性分析前置** — `qwen review deterministic` 跑 linter/typecheck，零 LLM 成本提供 ground truth
3. **无 CLAUDE.md 合规检查** — 但支持 `.qwen/review-rules.md` / `copilot-instructions.md` / `AGENTS.md` `## Code Review` 段（从 base branch 读防注入）
4. **worktree 隔离** — 用 `git worktree` 而非 stash+checkout，用户工作树不被触碰（消除 stash orphan / wrong-branch 一整类 bug）
5. **diff 不复制** — 源码要求"Do NOT paste the full diff into each agent's prompt"，让代理自己获取
6. **有 Verdict + Autofix + PR 评论** — 输出 Approve/Request changes/Comment；可自动修复；`--comment` 用 Create Review API 发 inline 评论
7. **跨仓库支持** — lightweight mode 是唯一支持跨仓库 PR 审查的 CLI 工具

---

### Codex CLI：CLI-first 模式（非交互式）

```
codex review [--uncommitted] [--base BRANCH] [--commit SHA] [--title TITLE] [PROMPT]
  │
  └── 单代理审查（GPT-5 系列模型）
        ├── 确定审查目标（uncommitted/base/commit）
        └── 生成审查报告
```

**设计理念：CI/CD 优先。** 作为 CLI 子命令（非交互式斜杠命令），可直接嵌入 GitHub Actions、GitLab CI 等。

**与其他工具的根本区别：**
- 不在交互式会话中运行
- 支持从 stdin 读取指令（`echo "check errors" | codex review -`）
- 支持 `@codex review` PR 评论触发
- 可指定审查范围（`--uncommitted` / `--base` / `--commit`）

---

## 二、审查维度深度对比

### 维度定义（源码逐字提取）

| 维度 | Claude Code | Copilot CLI | Qwen Code |
|------|------------|-------------|-----------|
| **编译/解析错误** | "code will fail to compile or parse (syntax errors, type errors, missing imports, unresolved references)" | 通过实际 `bash` 编译验证（非声明维度，但实际执行） | Step 3 确定性分析（tsc/clippy/go vet）+ Agent 7 Build & Test |
| **逻辑错误** | "code will definitely produce wrong results regardless of inputs (clear logic errors)" | "Bugs and logic errors" | Agent 1: "Logic errors and incorrect assumptions" |
| **安全漏洞** | "security issues, incorrect logic" (Agent 4) | "Security vulnerabilities" | 整个 Agent 2: injection / XSS / SSRF / path traversal / 认证 bypass / 敏感数据 / 弱加密 / 硬编码 secret / CSRF |
| **竞态条件** | — | "Race conditions or concurrency issues" | Agent 1: "Race conditions and concurrency issues" |
| **内存泄漏** | — | "Memory leaks or resource management problems" | Agent 4: "Memory leaks or excessive memory usage" |
| **错误处理** | — | "Missing error handling that could cause crashes" | Agent 1: "Error handling gaps and exception propagation" |
| **数据假设** | — | "Incorrect assumptions about data or state" | Agent 1: "null/undefined" edge cases + "Type safety issues" |
| **API 破坏** | — | "Breaking changes to public APIs" | Cross-file impact analysis（Agents 1-6 grep 调用者）: "Breaking changes to exported APIs" |
| **性能问题** | — | "Performance issues with measurable impact" | 整个 Agent 4: "N+1 queries, inefficient algorithms, missing caching, bundle size" |
| **代码质量** | — | — | 整个 Agent 3: "style consistency, naming, duplication, over-engineering, comments, dead code" |
| **测试覆盖** | — | — | 整个 Agent 5: "new code paths 是否有测试 / critical branches 覆盖 / assertions 真验证行为" |
| **构建/测试** | — | 通过 `bash` 实际执行 | 整个 Agent 7: 检测 build system → 跑 build + test 命令 |
| **CLAUDE.md 合规** | 整个 Agents 1+2: "CLAUDE.md compliance" | — | review-rules（`.qwen/review-rules.md` / `copilot-instructions.md` / `AGENTS.md`）注入 Agents 1-6 |
| **自由审计** | — | — | 整个 Agent 6（3 personas）: "business logic, boundary interactions, implicit assumptions, side effects" |

**统计：**
- Claude Code: 3 个明确维度 + CLAUDE.md 合规（独有）
- Copilot CLI: **8 个明确维度**
- Qwen Code: **9 个代理维度**（6 review dim + 3 personas + build/test），每个含 5-7 个子项 ≈ **45+ 检查项**（最细）+ Step 3 确定性分析多语言 linter

---

## 三、假阳性控制对比

### Claude Code 的三层过滤（业界最严格）

**第一层：Prompt 指令排除（源码原文）**
```
Do NOT flag:
- Code style or quality concerns
- Potential issues that depend on specific inputs or state
- Subjective suggestions or improvements
```

**第二层：显式假阳性清单（6 类）**
```
- Pre-existing issues（已有代码中的问题，非 PR 引入）
- Something that appears to be a bug but is actually correct
- Pedantic nitpicks that a senior engineer would not flag
- Issues that a linter will catch (do not run the linter to verify)
- General code quality concerns unless explicitly required in CLAUDE.md
- Issues mentioned in CLAUDE.md but explicitly silenced in the code (via lint ignore comment)
```

**第三层：独立验证代理（唯一拥有此机制的工具）**
每个被标记的问题由独立的验证代理重新审查，未通过验证的问题被移除。这相当于"二次确认"——发现者和验证者是不同的代理实例。

### Copilot CLI 的三层过滤（含代码执行验证）

**第一层：Prompt 核心原则**
```
If you're unsure whether something is a problem, DO NOT MENTION IT.
```

**第二层：显式排除清单（8 类，源码原文）**
```
CRITICAL: What You Must NEVER Comment On:
- Style, formatting, or naming conventions
- Grammar or spelling in comments/strings
- "Consider doing X" suggestions that aren't bugs
- Minor refactoring opportunities
- Code organization preferences
- Missing documentation or comments
- "Best practices" that don't prevent actual problems
- Anything you're not confident is a real issue
```

**第三层：代码执行验证（独有）**

prompt 明确指示在报告问题前尝试**编译和运行测试**：
```
Verify when possible:
- Can you build the code to check for compile errors?
- Are there tests you can run to validate your concern?
```

> **这与 Claude Code 的验证步骤形成互补：** Claude Code 用独立 LLM 代理做"第二意见"验证；Copilot CLI 用 `bash` 实际运行代码验证。**编译错误和测试失败是 100% 确定的**——不存在 LLM 幻觉问题。

### Qwen Code 的多层过滤（已对齐 Claude Code / Copilot）

**第一层：显式 Exclusion Criteria（10 类，源码原文，应用于 Step 4 审查 + Step 5 验证）**
```
- Pre-existing issues in unchanged code (focus on the diff only)
- Style, formatting, or naming that matches surrounding codebase conventions
- Pedantic nitpicks that a senior engineer would not flag
- Issues that a linter or type checker would catch automatically
- Subjective "consider doing X" suggestions that aren't real problems
- If you're unsure whether something is a problem, do NOT report it
- Minor refactoring suggestions that don't address real problems
- Missing documentation or comments unless the logic is genuinely confusing
- "Best practice" citations that don't point to a concrete bug or risk
- Issues already discussed in existing PR comments
```

**第二层：批量验证 Agent（Step 5）** — 单个验证 Agent 一次性收所有非 pre-confirmed finding，逐条读实际代码 + 检查上下文（callers / 类型定义 / 测试），返回 confirmed (high/low confidence) / rejected。**单 Agent 验所有 finding 而非 N 个独立验证 Agent**——成本 O(1) not O(N)，且单 Agent 看得到 cross-finding 关系。

**第三层：迭代反向审计（Step 6）** — 验证后再跑 1-3 轮反向审计，每轮见所有前轮累积 finding，专找前面漏掉的盲区。"No issues found." 或 3 轮硬上限收敛。

**第四层：低置信度分流** — 不确定的 finding 不直接 reject（避免 silent swallow valid concerns），而是降级为 "confirmed (low confidence)" → 终端 "Needs Human Review" 区显示，**不上 PR inline 评论**，不影响 verdict。reject 仅留给"factually wrong about the code" / 匹配 Exclusion Criterion / 无 concrete evidence 的 vague suspicion。

**第五层：确定性 ground truth（Step 3）** — linter/typecheck/build/test 结果是客观事实，pre-confirmed 跳过 Step 5 验证。

> **从"一层 Guidelines"演进到"五层过滤"**：早期 Qwen Code `/review` 只有 Guidelines 指导、无验证步骤；当前版本已对齐甚至超过 Claude Code（独立验证）+ Copilot（代码执行验证）—— 既有 LLM 推理验证（批量验证 + 迭代反向审计），又有代码执行验证（Step 3 + Agent 7）。

### Codex CLI

**无公开的假阳性控制机制。** 审查行为由模型内部判断决定。

---

## 四、输入/输出协议对比

### 输入方式

| 输入类型 | Claude Code | Copilot CLI | Qwen Code | Codex CLI |
|---------|------------|-------------|-----------|-----------|
| 未提交更改 | ✓ | ✓（自动检测） | ✓（`git diff` + `--staged`） | ✓（`--uncommitted`） |
| 分支 diff | ✓（自动） | ✓（`git diff main...HEAD`） | ✓（PR worktree 隔离） | ✓（`--base BRANCH`） |
| 特定 PR | ✓（PR 号） | ✗（需手动 checkout） | ✓（PR 号/同仓库 URL） | ✗ |
| 跨仓库 PR | ✗ | ✗ | ✓（**lightweight mode**，唯一支持的 CLI） | ✗ |
| 特定 commit | ✗ | ✗ | ✗（增量审查内部用 SHA） | ✓（`--commit SHA`） |
| 特定文件 | ✗ | ✗ | ✓（文件路径） | ✗ |
| 增量审查 | ✗ | ✓（新 commit 触发） | ✓（SHA + model 缓存，匹配则跳过） | ✗ |
| 自定义指令 | ✗ | ✗ | ✗ | ✓（`[PROMPT]` 或 stdin） |

### 输出格式

**Claude Code：** 问题列表 + 可选 PR 内联评论
```markdown
## Code review
Found 3 issues:
1. Missing error handling for OAuth callback (CLAUDE.md says "Always handle OAuth errors")
   https://github.com/owner/repo/blob/abc123/src/auth.ts#L67-L72
```
- 链接格式要求：完整 SHA + `#L` 标记 + 至少 1 行上下文
- 可提交建议：小修复包含 committable suggestion block，大修复只描述

**Copilot CLI：** 结构化问题报告
```markdown
## Issue: [Brief title]
**File:** path/to/file.ts:123
**Severity:** Critical | High | Medium
**Problem:** Clear explanation
**Evidence:** How you verified this
**Suggested fix:** Brief description (but do not implement it)
```
- 无问题时："No significant issues found in the reviewed changes."
- 无填充："Do not pad your response with filler. Do not summarize what you looked at. Do not give compliments."

**Qwen Code：** 四段式报告 + Verdict
```markdown
### Summary
1-2 句概述（终端含验证统计 "X reported, Y confirmed"；PR 评论不含 internal stats）

### Findings
- **Critical** — Must fix before merging.
- **Suggestion** — Recommended improvement.
- **Nice to have** — Optional optimization.

### Needs Human Review
低置信度 finding（前缀 "Possibly:"，仅终端显示，不上 PR 评论，不影响 verdict）

### Verdict
Approve | Request changes | Comment（仅基于高置信 finding）
```
- 每个 finding 包含：文件:行号 + Source tag（`[linter]`/`[typecheck]`/`[build]`/`[test]`/`[review]`）+ 问题 + 影响 + 建议修复
- Pattern 聚合：同模式问题合并（>5 处 non-Critical 显示 top 3 + "and N more"；Critical 全列）
- **唯一输出 Verdict（审查决定）的工具**
- verdict 后附 follow-up tip（"type `fix these issues`" / "type `post comments`" / "type `commit`"）

**Codex CLI：** 无公开的输出格式规范（由模型自由生成）

---

## 五、工具权限对比

| Agent | 允许的工具 | 禁止的工具 | 约束方式 |
|------|-----------|-----------|---------|
| **Claude Code** | `Bash(gh:*)`, `mcp__github_inline_comment__*` | 所有其他工具 | **Frontmatter `allowed-tools` 白名单**（最严格） |
| **Copilot CLI** | `*`（全部） | edit, create | **Prompt 文本禁止**（"You Must NEVER Modify Code"） |
| **Qwen Code** | task, run_shell_command, grep_search, read_file, write_file, edit, glob | 其他 | **Frontmatter `allowedTools` 白名单** |
| **Codex CLI** | 全部（CLI 子命令，非 Skill） | — | 由审批模式控制 |

**关键设计差异：**
- Claude Code 只允许 `gh` CLI 和一个 MCP 工具——**连文件读取都不在白名单中**（代理必须通过 `gh pr diff` 获取代码）
- Copilot CLI 给了全部工具但用 prompt 约束——**可以运行测试、编译代码来验证问题，但 NEVER 修改代码**
- Qwen Code 是**唯一白名单含 `write_file` / `edit` 的实现**——支持 Step 8 Autofix（用户确认后自动修复）；通过 `run_shell_command` 调 `gh` 实现 PR 评论发布（Create Review API），并不需要 GitHub MCP 工具

---

## 六、PR 评论集成

| 维度 | Claude Code | Copilot CLI | Codex CLI | Qwen Code |
|------|------------|-------------|-----------|-----------|
| **触发方式** | `/code-review --comment` | `/review` 后手动 | `@codex review` PR 评论 | `/review <pr> --comment` 或事后 "post comments" |
| **评论位置** | **内联评论**（代码行级别） | 终端输出（需手动复制） | **PR 评论** | **内联评论**（Create Review API） |
| **评论工具** | MCP `create_inline_comment` | — | GitHub API | `gh api .../pulls/.../reviews`（Create Review API 单次提交） |
| **可提交建议** | ✓（小修复包含 suggestion block） | ✗ | ✗ | ✓（` ```suggestion ` 块一键修复） |
| **去重** | ✓（"Only post ONE comment per unique issue"） | — | — | ✓（`qwen review presubmit` 4-bucket 分类，overlap 阻塞） |
| **无问题评论** | ✓（"No issues found"模板） | ✓（"No significant issues"） | — | ✓（"No issues found. LGTM! ✅" + 模型署名） |
| **链接格式** | 完整 SHA + `#Lstart-Lend` | `file:line` | — | `comments` array `line` 字段（diff 行锚定） |
| **verdict 提交** | — | — | — | ✓ APPROVE/REQUEST_CHANGES/COMMENT（CI 红/self-PR 自动 downgrade） |
| **模型署名** | — | — | — | ✓（每条评论 footer `— <model> via Qwen Code /review`） |

---

## 七、性能与成本考量

| 维度 | Claude Code | Copilot CLI | Qwen Code | Codex CLI |
|------|------------|-------------|-----------|-----------|
| **LLM 调用数** | 7+N（N=问题数） | 1 | **11-13**（9 代理 + 1 批量验证 + 1-3 迭代反向审计；跨仓库 10-12） | 1 |
| **使用的模型** | Haiku+Sonnet+Opus（3 级） | claude-sonnet-4.5（1 级） | 继承主模型（1 级） | GPT-5 系列（1 级） |
| **估算 token** | 高（多代理冗余） | 中 | 高（9 代理无 fork subagent 时 system prompt 冗余 ~570-680K input） | 低（单次） |
| **估算延迟** | 30-120 秒 | 10-60 秒（含编译/测试时间） | 1-3 分钟（>500 行 diff SKILL.md 明示 "may take a few minutes"） | 5-15 秒 |
| **并行度** | 高（Step 4: 4 并行 + Step 5: N 并行） | 低（串行） | 高（Step 4: 9 并行 + Step 5 批量验证单 Agent） | 低（单次） |

> **Qwen Code 成本权衡**（[DESIGN.md](https://github.com/QwenLM/qwen-code/blob/main/packages/core/src/skills/bundled/review/DESIGN.md) "LLM call budget"）：11-13 次调用 biases toward 高召回——假设"每轮多发现问题"比"最小化单次成本"更有价值，因为每个漏掉的问题都迫使用户再跑一轮 `/review`。Fork Subagent（共享 prompt cache prefix）可把 token 从 ~620K 降到 ~75K（约 85-90% 节省），但需 platform-level 改动，尚未落地。

---

## 八、面向 Code Agent 开发者的设计洞察

### 1. 两种验证哲学

| Agent | 验证方式 | 原理 | 可靠性 |
|------|---------|------|--------|
| **Claude Code** | 独立 LLM 验证代理 | 每个问题一个独立 LLM 重新审查（O(N)） | 高（但 LLM 可能幻觉） |
| **Copilot CLI** | **编译+运行测试** | `bash` 实际执行代码验证 | **最高**（编译错误 = 100% 确定） |
| **Qwen Code** | **LLM 验证 + 代码执行验证 兼有** | 批量验证 Agent（O(1)）+ 迭代反向审计 + Step 3 确定性分析 + Agent 7 build/test | 高（双重验证） |
| **Codex CLI** | 无 | 信任模型 | 中 |

Claude Code 的 LLM 验证适合**逻辑错误和设计问题**（需要推理判断）。Copilot CLI 的代码执行验证适合**编译错误、类型错误、测试失败**（客观可验证）。

**开发者决策：** 理想的 /review 实现应该**两者结合**——用代码执行验证客观问题，用 LLM 验证主观问题。**Qwen Code 当前版本是唯一同时做到两者的工具**：Step 3 确定性分析 + Agent 7 Build & Test 提供代码执行 ground truth（pre-confirmed 跳验证），批量验证 Agent + 迭代反向审计提供 LLM 推理验证。相比 Claude Code 的 O(N) 独立验证，Qwen Code 的批量验证是 O(1) 且单 Agent 能看到 cross-finding 关系。

### 2. 多代理 vs 单代理

| 方案 | 优势 | 劣势 |
|------|------|------|
| **多代理**（Claude Code, Qwen Code） | 维度覆盖全、可并行、专注度高 | 成本高、需要编排逻辑、结果合并复杂 |
| **单代理**（Copilot CLI, Codex CLI） | 成本低、简单、上下文连贯 | 容易遗漏维度、无冗余 |

**Qwen Code 的 Agent 6 "Undirected Audit" 是一个优雅的设计：** 既利用了多代理的覆盖优势，又通过无预设维度避免了维度盲区。当前版本进一步拆成 **3 个 persona**（attacker / 3am-oncall / 6-months-later maintainer）并行——单个 undirected agent 有 prompt-induced bias 倾向于每次发现同类问题，三个 persona 强制完全不同的 mental traversal，并集召回率显著大于 1.5× 单 agent（[DESIGN.md](https://github.com/QwenLM/qwen-code/blob/main/packages/core/src/skills/bundled/review/DESIGN.md)：ensemble diversity 在 3-5 sampled path 后 drop 显著，3 是 sweet spot）。这是最值得其他工具借鉴的设计。

### 3. 项目规则合规检查的价值

Claude Code 的 CLAUDE.md 合规检查意味着团队可以将编码规范写入 CLAUDE.md，然后代码审查自动执行。这把"规范文档"变成了"可执行策略"——规范不再是建议，而是审查条件。

**Qwen Code 当前版本已实现类似机制**：`qwen review load-rules` 从 4 个 source 读项目规则——`.qwen/review-rules.md`、`copilot-instructions.md`、`AGENTS.md` 的 `## Code Review` 段、`QWEN.md` 的 `## Code Review` 段——并 prepend 到 Agents 1-6 的指令。关键安全设计：**PR 审查时规则从 base branch 读**（`git show <base>:<path>`），防止恶意 PR 注入 "永不报安全问题" 这类毒规则。Build & Test agent（Agent 7）不注入规则——它跑确定性命令，不做代码审查。

### 4. diff 传递策略

Qwen Code 明确禁止将完整 diff 粘贴给每个代理（"Do NOT paste the full diff — give each agent: the diff command + a one-sentence summary + its review focus"），而是让代理自己执行 git 命令获取。9 个 agent 的 prompt 必须各自 <200 词才能塞进单次响应并行执行——否则模型 fallback 到串行。这节省了大量 token 但增加了工具调用延迟。

Claude Code 走了不同路线——通过 `gh pr diff` 获取 diff，但代理工具白名单中没有 `Read`，说明它也不直接传递文件内容。

> **根因与未来方向**：9 个 agent 各自从 scratch 创建 subagent，system prompt（~50K tokens）独立发送，是当前 token 冗余的根源。Fork Subagent（fork 当前 conversation + 共享 prompt cache prefix）可让 "Do NOT paste the full diff" 这类 workaround 变得不必要——fork 已继承完整 context。详 [qwen-code-review-improvements.md §四 P1](./qwen-code-review-improvements.md)。

### 5. Worktree 隔离

早期 Qwen Code `/review` 用 `git stash` → `gh pr checkout` → 审查 → 恢复分支 → `git stash pop`。当前版本改为 **`git worktree` 隔离**：在 `.qwen/tmp/review-pr-<n>` 创建 ephemeral worktree，所有审查操作（linting / agents / build/test / autofix）都在 worktree 内进行，**用户工作树完全不被触碰**。

这消除了 stash 方案的一整类 bug：stash 在中断时 orphan、恢复失败时 wrong-branch、dirty-tree 阻塞 checkout。代价是需要在 worktree 内 `npm ci`（额外时间），但隔离收益远大于此。Step 1 在创建新 worktree 前会先清理上次中断遗留的 stale worktree。Gemini CLI 的 `async-pr-review` 也用临时工作树，是同一思路。

---

## 九、Qoder CLI /review（Go 二进制反编译）

> Qoder CLI 是较小众的闭源工具（QoderAI/阿里巴巴），以下分析基于 v0.1.35 Go 二进制反编译。

### 双命令架构

```
/review-code                    # 代码审查（当前文件/变更）
/review-pr                       # PR 审查（指定仓库和 PR 号）
  参数格式: REPO:<owner/repo> PR_NUMBER:<number> OUTPUT_LANGUAGE:<lang>
```

Qoder CLI 是唯一将代码审查和 PR 审查**分为两个独立命令**的工具。

### Skill 实现

`/review-code` 和 `/review-pr` 是 **Skill**（非内置命令）。系统提示原文：
> "When users reference a slash command or '/<something>' (e.g., '/commit', '/review-pr'), they are referring to a skill."

调用方式：`skill: "review-pr", args: "123"`

### Quest 场景特殊路由

二进制中存在 `isSpecReviewScenario` 函数（`core/agent/provider.(*qoderClient).isSpecReviewScenario`），表明 review 被视为特殊的 **Quest 场景**，有独立的模型选择逻辑。

### 服务端模板系统

错误消息 `failed to load code review template` 表明审查使用**服务端模板**而非硬编码 prompt——审查逻辑可由 Qoder 服务端**热更新**，无需客户端升级。

### GitHub Action 集成

```yaml
- name: Run Qoder Code Review
  uses: QoderAI/qoder-action@v0
  with:
    qoder_personal_access_token: ${{ secrets.QODER_PERSONAL_ACCESS_TOKEN }}
    prompt: |
      /review-pr
      REPO:${{ github.repository }} PR_NUMBER:${{ github.event.pull_request.number }}
      OUTPUT_LANGUAGE:English
```

### 与主流工具的设计差异

| 设计 | Claude Code | Copilot CLI | Qwen Code | Codex CLI | **Qoder CLI** |
|------|------------|-------------|-----------|-----------|---------------|
| 命令数 | 1（/code-review） | 1（/review） | 1（/review） | 1（codex review） | **2**（code + pr 分离） |
| 实现方式 | 插件 + 硬编码 | YAML 代理 | Bundled Skill + 6 个 `qwen review` TS 子命令 | CLI 子命令 | **Skill + 服务端模板** |
| 模板更新 | 需更新插件 | 需更新二进制 | 需更新 npm 包（SKILL.md 与子命令同 monorepo 版本对齐） | 需更新二进制 | **服务端热更新** |
| 多语言输出 | ✗ | ✗ | ✓（自动匹配 PR 语言 + local review 跟 `/language`） | ✗ | **✓（OUTPUT_LANGUAGE 显式参数）** |
| CI/CD | `claude -p` | `gh pr` | 跨仓库 lightweight mode（`gh pr diff <url>`） | `codex review` | **QoderAI/qoder-action** |

---

## 十、行业数据与设计哲学

### Claude Code /review 的生产效果（来源：[claude.com/blog/code-review](https://claude.com/blog/code-review)，2026-03-09）

| 维度 | 数据 |
|------|------|
| 部署前 PR 获得实质评论比例 | 16% |
| 部署后 PR 获得实质评论比例 | **54%** |
| 工程师不同意审查结论比例 | **< 1%** |
| 大 PR（1000+ 行）发现率 | 84%，平均 7.5 个问题 |
| 小 PR（< 50 行）发现率 | 31%，平均 0.5 个问题 |
| 单次审查成本 | $15-25，~20 分钟 |

> Anthropic 明确定位为**"优化深度，比轻量级方案更贵"**——这与 Copilot 的订阅制广度覆盖形成互补。

### GitHub Copilot Code Review 的规模数据（来源：[GitHub Blog](https://github.blog/ai-and-ml/github-copilot/60-million-copilot-code-reviews-and-counting/)，2026-03）

| 维度 | 数据 |
|------|------|
| 总审查次数 | **6000 万次**（2025-04 以来 10 倍增长） |
| 占 GitHub 全平台审查比例 | **> 1/5** |
| 使用组织数 | 12,000+ |
| 有可操作反馈的比例 | **71%** |
| 无评论的比例 | **29%**（设计使然） |
| 平均每次审查评论数 | ~5.1 |

> **"Silence is better than noise"**——GitHub 的核心设计理念是宁可不评论，也不产生噪声。29% 的审查未产生可操作反馈。

### 从 prompt 到 agentic：Copilot 审查架构演进（来源：[GitHub Blog](https://github.blog/changelog/2026-03-05-copilot-code-review-now-runs-on-an-agentic-architecture/)，2026-03-05）

Copilot 代码审查从基于 prompt 的架构重构为**agentic tool-calling 架构**——Agent 主动收集仓库上下文（代码、目录结构、引用）来理解变更如何融入整体架构。升级后正面反馈增加 **8.1%**（来源：[60 Million Copilot Code Reviews](https://github.blog/ai-and-ml/github-copilot/60-million-copilot-code-reviews-and-counting/)）。

### 学术研究：LLM 审查的可靠性边界

| 研究 | 关键发现 |
|------|---------|
| [Evaluating LLMs for Code Review](https://arxiv.org/abs/2505.20206)（Bilkent 大学，2025） | GPT-4o 正确分类代码正确性的准确率为 **68.5%**，Gemini 2.0 Flash 为 **63.9%**。结论："LLMs would be unreliable in a fully automated code review environment." |
| [Rethinking Code Review with LLM](https://arxiv.org/html/2505.16339v1)（WirelessCar，2025） | 开发者反馈："If they're not good enough, you stop reading them...you miss the real issues because you start ignoring the feedback."——**低质量 AI 反馈反而降低审查质量** |
| [CORE: Resolving Code Quality Issues](https://dl.acm.org/doi/10.1145/3643762)（ACM） | 二阶段 proposer+ranker 模式减少 **25.8%** 假阳性——与 Claude Code 的多代理验证异曲同工 |

### 行业共识：五层信任架构（来源：[Latent Space](https://www.latent.space/p/reviews-dead)）

核心主张：确定性质量关卡应该是测试套件而非代码审查——将人类监督从下游代码阅读移到上游规格编写。

| 层 | 机制 | 说明 |
|---|------|------|
| 1 | 竞争代理 | 多个代理解决同一问题，按测试通过率和 diff 大小排名 |
| 2 | 确定性护栏 | 自定义 linter、类型检查、契约验证——客观通过/失败 |
| 3 | BDD 验收标准 | 人类定义的行为规格 |
| 4 | 权限系统 | 按文件/任务限制代理范围 |
| 5 | 对抗验证 | 编码代理 + 验证代理 + 破坏者代理 |

**核心转变**：将人类监督从**下游代码阅读**移到**上游规格编写**。

### 设计哲学总结

| 哲学 | 代表 | 核心信条 |
|------|------|---------|
| **高信号深度** | Claude Code | <1% 工程师不同意率，$15-25/次，多代理验证 |
| **沉默优于噪声** | Copilot CLI | 29% 审查零评论，代码执行验证 |
| **全维度覆盖 + 高召回** | Qwen Code | 9 代理（含 3 personas）+ 批量验证 + 迭代反向审计，输出 Verdict + Autofix；11-13 LLM 调用 biases toward 召回 |
| **CI 优先** | Codex CLI | CLI 子命令，可嵌入管道 |
| **确定性门禁** | Latent Space | 测试套件是真正的质量关卡，LLM 审查是辅助咨询 |
| **分层验证** | 行业共识 | 确定性（测试/lint）+ 概率性（LLM）+ 人类终裁 |

---

## 证据来源

| Agent | 源码获取方式 | 完整性 |
|------|------------|--------|
| Claude Code | `gh api repos/anthropics/claude-code/contents/plugins/code-review/commands/code-review.md` | **完整 109 行 prompt** |
| Copilot CLI | `cat definitions/code-review.agent.yaml`（本地 npm 包） | **完整 94 行 YAML + prompt** |
| Qwen Code | 本地源码 `packages/core/src/skills/bundled/review/{SKILL,DESIGN}.md` + `packages/cli/src/commands/review/*.ts` | **完整 663 行 SKILL.md + 286 行 DESIGN.md + 6 个 TS 子命令** |
| Codex CLI | `codex review --help` + 二进制 strings | **CLI 接口完整，内部 prompt 不可见** |
| Qoder CLI | `strings qodercli` Go 二进制反编译 | **Skill 注册 + 函数名 + 错误消息 + GitHub Action 模板** |
