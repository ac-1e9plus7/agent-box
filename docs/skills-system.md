# 4. Agent 技能（Skills）系统

AgentBox 的技能系统允许用户通过结构化文档与参考脚本，为大模型注入行业专家级工作流与规范。脚本源码不会被应用隐式执行。

---

## 📁 多文件技能规范

每个技能以独立的虚拟目录形式组织，包含以下核心文件结构：

```text
skill-package/
├── SKILL.md                 # 核心技能规范文档（含 YAML Frontmatter 元数据）
├── references/              # 辅助参考标准、词库与行业规范文档
│   ├── patterns.md
│   └── standards.md
└── scripts/                 # 配套执行脚本（优先采用 Python 3，亦支持 Shell）
    ├── runner.py
    └── validator.py
```

### Python 3 参考脚本规范
- `scripts/*.py` 和 Shell 文件仍是被选中技能的参考实现，不会被自动执行。
- 启用 Agent 模式后，模型可通过内置 `agentbox_run_code` 对短小、无外部依赖的算法或统计代码进行实际验证：JavaScript 使用隔离 Worker；Python 仅在本机存在 Python 3 时使用受限解释器。
- 代码运行器带有超时、内存/输出限制，并遵循工具审批策略；默认 `sensitive` 策略下必须由用户确认后才会执行。

---

## 📦 Zip 压缩包生态（Import / Export）

在 [`src/shared/skill-zip.ts`](../src/shared/skill-zip.ts) 中实现了纯 TypeScript 的零依赖 Zip 打包与解析引擎：
- **一键导出（Export）**：将技能的所有 Markdown 文档与脚本打包为标准的 `.zip` 压缩包。
- **一键导入（Import）**：选择外部 `.zip` 文件时，自动解压并解析 `SKILL.md` 的 Frontmatter 元数据（`name`, `description`, `version`, `author`, `icon`），自动建立多文件索引。

---

## 🏛️ 5 大系统内置技能

系统默认内置了 5 个经过深度调优的专业技能：
1. **代码执行与算法助手**：包含 Python 3 沙箱测试用例执行脚本与算法模式库。
2. **数据分析与表格可视化**：包含 Python 3 描述性统计计算脚本与图表格式规范。
3. **研报萃取与长文精读**：包含 Python 3 正文降噪清洗脚本与关键指标提炼标准。
4. **专业多语言精翻与本地化**：包含 Python 3 术语一致性校验脚本与本地化对照准则。
5. **提示词工程专家**：包含 Python 3 提示词结构诊断脚本与经典 Prompt 模式集。

---

## ⚡ Gateway 动态提示词注入（Prompt Augmentation）

当开启会话的 **Agent 模式** 时：
1. `ChatGateway` 扫描处于启用状态（`enabled: true`）的技能，并注入由名称、ID 和描述构成的轻量目录。
2. 会话固定的技能以及 `$skill-id` / 完整技能名会直接加载；否则根据最近 3 条用户消息、附件名称、MIME 类型和有限文本摘要检索最多 2 个相关技能。
3. 仅把命中技能的 `SKILL.md`、参考文档和参考脚本注入 System Instructions，避免所有技能同时占用上下文或产生角色冲突。
4. 若初始路由不足，模型可调用只读内部工具 `agentbox_load_skill` 按 ID 加载目录中的其他技能；加载后 Gateway 会重建下一轮 System Instructions。
5. 每次自动、显式或模型按需激活都会发送 `skill-activated` 事件，并在回答中展示激活来源。技能脚本仍不会被隐式执行。
6. 代码或数据技能需要实算时可调用 `agentbox_run_code`；只有成功工具结果才能作为“已执行”的证据。
7. 需要包管理器、编译器或系统命令时可调用 `agentbox_run_terminal`。该工具使用“设置 → 通用 → Integrated terminal shell”中的跨平台 Shell 配置，并遵循敏感工具审批策略。
