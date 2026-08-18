# 4. Agent 技能（Skills）系统

AgentBox 的技能系统允许用户通过结构化文档与执行脚本，为大模型注入行业专家级工作流与规范。

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

### 优先采用 Python 3 规范
- 在需要执行沙箱算法、数据清洗、正则校验与格式化时，**优先编写 Python 3 脚本**（`scripts/*.py`），确保跨平台一致性与可维护性。

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
1. `ChatGateway` 扫描所有处于启用状态（`enabled: true`）的技能。
2. 将技能的主指令（`SKILL.md`）、Python 3 脚本（`scripts/*.py`）与参考标准（`references/*.md`）组装为清晰的结构化 XML/Markdown 块。
3. 作为 System Instructions 注入到每次 API 请求的顶部，赋予模型专家级推理与执行能力。
