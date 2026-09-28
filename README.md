# Code Sentinel — AI 辅助代码扫描评审

结合项目自身的 **bad case / good case / rule** 规则库，对代码变更做触发器扫描 + 引用影响面分析 + AI 评审，产出分级问题与行内评论，并支持 AI 修复走独立分支、由你决定是否合并。

## 功能

- **三种扫描入口**
  - 分支对比（`base...head`，模拟 PR 评审）
  - 提交范围（`from..to`）
  - 工作区改动（含未跟踪新文件）
- **规则库（存于目标项目 `.codescan/rules/*.yaml`，随 git 版本化、可团队共享）**
  - `bad_case`：触发器符号出现在新增代码 → 确定性命中，直接生成问题
  - `good_case`：推荐写法示例，注入 AI 上下文（不生成问题）
  - `rule`：需结合上下文判断的规则，命中符号生成待确认问题
  - 触发器：`paths`（glob）、`symbols`（词边界匹配新增行）、`languages`
- **AI 评审**：逐文件注入 diff、新版本内容、新增行 git blame 作者、导出符号的全仓库引用（影响面）、规则库全文，输出结构化问题
- **问题列表视图**：评审页双视图切换——「问题列表」按严重程度排序，支持程度多选（带计数）、来源、状态、文本搜索过滤，行内展开详情、勾选打包修复、一键跳转 diff 对应行；扫描进行中即可实时浏览已发现的问题
- **实时进度 + 可停止**：扫描运行时逐文件展示评审状态（评审中 / 完成+耗时+发现数 / 失败 / 豁免），进度条实时刷新（1s 轮询）；「停止扫描」随时中断 AI 请求，已完成文件的问题保留可继续处理
- **扫描配置（项目级）**：`include`（限定扫描范围，留空=全部）/ `exclude`（完全排除）/ `allowlist`（白名单豁免：diff 中标 🛡 显示，但不评审、不报问题、不耗 AI token）/ `maxFiles`（单次评审上限 1-200，超出的文件保留 diff 但跳过评审）。自研 glob：`src` ≡ `src/**`、`**/*.test.ts` 跨层级、`*.min.js`（不含 `/`）匹配任意层级文件名、`#` 注释行。优先级：include 圈定 → exclude → allowlist
- **问题分级**：Bug / 主要 / 重要 / 轻微 / 代码风格，支持等级、来源（规则命中 / AI 发现）、状态筛选
- **行内评论**：问题锚定在 diff 行上，展开显示触犯的规则（含 bad/good 示例）、AI 发现、修改建议、blame 作者
- **AI 修复**：勾选多个问题打包 → `fix/scan-N-M` 分支（工作区模式直接改文件，保留快照可撤销）→ SEARCH/REPLACE 块最小化修改 → 打包 commit → 你在前端决定**合并 / 丢弃**
- **代码浏览**：任意分支文件内容 + 每行 blame 作者 + 文件提交历史 + 导出符号被引用分析

## 快速开始

```bash
npm install          # 首次：npm 11 会拦截原生编译脚本，需批准
npm install-scripts approve better-sqlite3 esbuild   # 如被拦截
npm run dev          # server:5180 + vite:5174（开发）

npm run build && npm start   # 生产：直接访问 http://localhost:5180
```

首次使用：
1. 打开 `http://localhost:5180` → **AI 设置** → 「从 NoteFlow 导入」或手动添加 OpenAI 兼容 Provider（openrouter / deepseek / ollama 等均可）
2. 首页添加 git 仓库路径（优先 macOS 原生目录选择对话框，非 mac 自动降级网页目录浏览器）
3. 项目内「扫描」页发起扫描（发起前可看到生效的扫描配置摘要，「扫描配置」页可调整）
4. 评审页：「问题列表」视图按程度/来源/状态/文本过滤，点击文件定位跳到「Diff 视图」对应行；运行中可看实时进度并随时「停止」
5. 勾选问题 → 底部「AI 修复」
6. 「修复任务」页查看修复 diff → 合并或丢弃

## 架构

```
code-sentinel/
├── server/                # Node + Express + better-sqlite3
│   └── src/
│       ├── index.ts       # 入口（5180，生产托管 web/dist）
│       ├── config.ts      # 端口 / ~/.code-sentinel 数据目录
│       ├── db.ts          # SQLite：projects/scans/issues/fix_tasks/ai_providers
│       ├── git.ts         # git 命令封装（log/blame/diff/branch/merge/commit）
│       ├── diff.ts        # unified diff 解析
│       ├── refs.ts        # 导出符号提取 + git grep 引用分析
│       ├── rules.ts       # .codescan/rules 读写 + 触发器匹配（glob）
│       ├── ai.ts          # OpenAI 兼容 chat（支持 AbortSignal）+ 鲁棒 JSON 提取
│       ├── scanconfig.ts  # 项目扫描配置 + 自研 glob 匹配
│       ├── scanner.ts     # 扫描编排（并发 3，逐文件实时进度，可取消）
│       ├── fixer.ts       # AI 修复（SEARCH/REPLACE 应用 + fix 分支管理）
│       └── routes.ts      # REST API
└── web/                   # React 19 + Vite + Tailwind 4
    └── src/pages/         # Projects / ScanList / Review / Rules / Fixes / FileViewer / ScanConfig / Settings
```

扫描结果存 SQLite（`~/.code-sentinel/sentinel.sqlite3`）；规则只存项目内文件，工具不含状态。

## 规则文件格式（`<项目>/.codescan/rules/<id>.yaml`）

```yaml
id: no-moment
type: bad_case        # bad_case | good_case | rule
name: 禁止使用 moment
description: moment 包体积 300KB+，统一使用 dayjs
severity: major       # bug | major | important | minor | style
enabled: true
trigger:
  paths: ['**/*.ts', '**/*.tsx']   # 可选：匹配变更文件路径
  symbols: [moment]                # 可选：新增代码出现该符号 → 命中
  languages: [typescript]          # 可选
examples:
  bad: |
    import moment from 'moment'
  good: |
    import dayjs from 'dayjs'
```

## 行为要点

- 触发器 `symbols` 命中是**确定性**的（不依赖 AI）；AI 评审用于发现规则之外的问题、结合引用影响面判断连锁风险，并给命中问题补充上下文确认
- 分支/提交模式的 AI 修复要求工作区干净；修复在 `fix/scan-N-M` 分支上打包 commit，合并 = `git merge`（冲突会失败提示，不强推），丢弃 = 删分支
- 工作区模式的修复直接改工作区文件，修复前内容快照存库，可一键撤销
- 扫描时点的 diff 会被固化存库，后续分支推进不会导致历史评审行号错位
- `.codescan/` 目录本身不参与扫描（bad 示例会自命中）
- 扫描配置存 SQLite（`projects.scan_config`），只影响新发起的扫描；「已取消」的扫描保留已完成部分的问题，同样可创建 AI 修复
- 实时进度逐文件写入 `scans.stats.progress`，前端 1s 轮询渲染；停止 = 中断进行中的 AI 请求 + 不再取新文件

## 已知限制

- diff 无语法高亮（纯文本渲染）
- 引用分析基于 git grep 词边界匹配，非 AST 精确解析
- 单次扫描默认最多 40 个文件（可在「扫描配置」调整 1-200，按变更量截断）
- merge 冲突不自动解决，需人工处理后重试
