import type { Skill } from '../../shared/types'

export const DEFAULT_SKILLS: Skill[] = [
  {
    id: 'code-interpreter',
    name: '代码执行与算法助手',
    description: '用于代码编写、报错调试、算法与数据结构、排序、复杂度分析、Python/TypeScript 实现、单元测试和性能优化',
    icon: 'code',
    entryFile: 'SKILL.md',
    files: [
      {
        path: 'SKILL.md',
        kind: 'markdown',
        content: `# 代码执行与算法助手 (Code Interpreter)

你当前作为高级算法工程师与代码执行专家。你的职责是协助用户进行代码实现、算法推演、单元测试与性能优化。

## 核心执行准则
1. **实际运行验证**：进行计算、数据验证、逻辑推导与测试时，必须优先调用 \`agentbox_run_code\`；跨平台默认使用 JavaScript，用户明确要求 Python 时可选择 Python。需要编译器、包管理器或项目命令时，调用 \`agentbox_run_terminal\`。
2. **结果保真**：只有工具返回成功结果后才能声称“已运行”或“测试通过”；Python 不可用时改用等价 JavaScript 验证，并明确说明运行语言。
3. **结构化与自包含**：提供的最终代码必须包含必要的导入、类型提示与边界断言；参考本技能附带的 \`scripts/sandbox_runner.py\` 组织测试用例。
4. **渐进式解析**：对于复杂算法问题，先进行复杂度分析（时间/空间复杂度），再提供清晰实现、样例与实际运行结果。`
      },
      {
        path: 'scripts/sandbox_runner.py',
        kind: 'python',
        content: `#!/usr/bin/env python3
"""
Code Interpreter Sandbox Runner
Safely executes and verifies user algorithm snippets with output capturing and assertion checks.
"""
import sys
import io
import time
import traceback
from typing import Any, Callable, Dict, List, Tuple

def run_test_suite(target_fn: Callable, test_cases: List[Tuple[Tuple, Any]]) -> Dict[str, Any]:
    """Runs test cases against target function and reports execution time & correctness."""
    results = []
    passed = 0
    start_time = time.perf_counter()
    
    for i, (args, expected) in enumerate(test_cases, 1):
        try:
            actual = target_fn(*args)
            is_match = actual == expected
            if is_match:
                passed += 1
            results.append({
                "case": i,
                "args": args,
                "expected": expected,
                "actual": actual,
                "passed": is_match
            })
        except Exception as e:
            results.append({
                "case": i,
                "args": args,
                "expected": expected,
                "error": str(e),
                "passed": False
            })
            
    elapsed_ms = (time.perf_counter() - start_time) * 1000
    return {
        "total": len(test_cases),
        "passed": passed,
        "success": passed == len(test_cases),
        "elapsed_ms": round(elapsed_ms, 3),
        "cases": results
    }

if __name__ == "__main__":
    print("Sandbox Runner ready for Python 3 code verification.")
`
      },
      {
        path: 'references/algorithm_patterns.md',
        kind: 'markdown',
        content: `# 算法模式与复杂度参考 (Algorithm Patterns)

## 常见模式
1. **双指针 / 滑动窗口**：适用于子串、区间、单调性问题，O(N) 时间，O(1) 空间。
2. **动态规划（DP）**：明确状态定义、状态转移方程、初始条件与空间压缩。
3. **单调栈 / 队列**：寻找下一个更大/更小元素，维护滑动窗口最值。
4. **回溯与剪枝**：排列组合、子集、图路径搜索。`
      }
    ],
    isBuiltIn: true,
    enabled: true,
    author: 'AgentBox System',
    version: '1.0.0',
    createdAt: '2026-08-16T00:00:00.000Z',
    updatedAt: '2026-08-16T00:00:00.000Z'
  },
  {
    id: 'data-analyst',
    name: '数据分析与表格可视化',
    description: '用于 CSV、Excel、表格与数据集分析、统计计算、趋势归因、图表和数据可视化',
    icon: 'chart',
    entryFile: 'SKILL.md',
    files: [
      {
        path: 'SKILL.md',
        kind: 'markdown',
        content: `# 数据分析与表格可视化 (Data Analyst)

你当前作为高级数据科学家与商业分析专家。你的职责是对结构化或非结构化数据进行深度统计、趋势归因与清晰可视化。

## 分析工作流
1. **数据清洗与概览**：先确认字段含义、样本量、缺失值与极值分布。
2. **统计计算**：调用 \`agentbox_run_code\` 实际计算均值、中位数、分位数、相关性与方差；默认使用 JavaScript，Python 可用且任务需要时可使用 Python（参考 \`scripts/data_summary.py\`）。
3. **归因分析**：结合业务上下文推演核心驱动因素。
4. **格式化输出**：使用 Markdown 规范表格与 Mermaid 图表呈现最终结论，并区分工具实算结果与推断。`
      },
      {
        path: 'scripts/data_summary.py',
        kind: 'python',
        content: `#!/usr/bin/env python3
"""
Data Analysis & Statistical Summary Utility
Computes descriptive statistics, distributions, and quantiles without external dependencies.
"""
import math
from typing import List, Dict, Any, Union

def compute_stats(numbers: List[Union[int, float]]) -> Dict[str, Any]:
    """Computes comprehensive statistical summary for numeric sequence."""
    if not numbers:
        return {"error": "Empty dataset"}
        
    valid = sorted([float(x) for x in numbers if math.isfinite(x)])
    n = len(valid)
    if n == 0:
        return {"error": "No valid finite numbers"}
        
    mean_val = sum(valid) / n
    variance = sum((x - mean_val) ** 2 for x in valid) / n
    std_dev = math.sqrt(variance)
    
    def quantile(p: float) -> float:
        idx = p * (n - 1)
        low = math.floor(idx)
        high = math.ceil(idx)
        if low == high:
            return valid[int(low)]
        return valid[int(low)] * (high - idx) + valid[int(high)] * (idx - low)
        
    return {
        "count": n,
        "min": valid[0],
        "max": valid[-1],
        "mean": round(mean_val, 4),
        "median": round(quantile(0.5), 4),
        "std_dev": round(std_dev, 4),
        "q25": round(quantile(0.25), 4),
        "q75": round(quantile(0.75), 4),
        "iqr": round(quantile(0.75) - quantile(0.25), 4)
    }

if __name__ == "__main__":
    sample = [12, 15, 18, 20, 22, 25, 29, 32, 45, 99]
    print("Sample Statistics:", compute_stats(sample))
`
      },
      {
        path: 'references/visualization_formats.md',
        kind: 'markdown',
        content: `# 可视化格式指南 (Visualization Formats)

## 表格规范
- 表头加粗并明确度量单位（如 \`金额 (万元)\`, \`占比 (%)\`）。
- 数值右对齐，文本左对齐。

## Mermaid 图表
- 趋势对比使用 \`graph LR\` 或 \`xychart-beta\`。
- 流程结构使用 \`flowchart TD\`。`
      }
    ],
    isBuiltIn: true,
    enabled: true,
    author: 'AgentBox System',
    version: '1.0.0',
    createdAt: '2026-08-16T00:00:00.000Z',
    updatedAt: '2026-08-16T00:00:00.000Z'
  },
  {
    id: 'web-extractor',
    name: '研报萃取与长文精读',
    description: '用于 PDF、网页、研报、论文和长文的总结、摘要、事实数据提取与精读',
    icon: 'search',
    entryFile: 'SKILL.md',
    files: [
      {
        path: 'SKILL.md',
        kind: 'markdown',
        content: `# 研报萃取与长文精读 (Web & Document Extractor)

你当前作为专业研究员与长文研读专家。你的职责是对长篇资讯、行业研报、学术论文或网页内容进行结构化萃取。

## 提炼规范
1. **执行摘要（Executive Summary）**：用 3 条以内的核心要点概括全局结论。
2. **核心论据链**：提取关键数据点、支撑事实与量化证据。
3. **风险与不确定性**：标明前提假设、潜在风险或限制条件。
4. **文本清洗**：遇到原始 HTML 或杂乱文本时，参考 \`scripts/text_cleaner.py\` 清理无关干扰。`
      },
      {
        path: 'scripts/text_cleaner.py',
        kind: 'python',
        content: `#!/usr/bin/env python3
"""
Text & Web Markdown Cleaning Utility
Strips HTML boilerplate, navigation noise, and extracts structured key-value points.
"""
import re
from typing import List, Dict

def clean_extracted_text(raw_text: str) -> str:
    """Removes web boilerplate tags, extra whitespace, and noisy artifacts."""
    text = re.sub(r"<(script|style)[^>]*>[\\s\\S]*?</\\1>", "", raw_text, flags=re.IGNORECASE)
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"[ \\t]+", " ", text)
    text = re.sub(r"\\n\\s*\\n+", "\\n\\n", text)
    return text.strip()

def extract_key_numbers(text: str) -> List[Dict[str, str]]:
    """Extracts percentage and monetary figures with their immediate context."""
    pattern = r"([^，。！？\\n]{0,25}(?:\\d+(?:\\.\\d+)?%|\\$\\d+(?:\\.\\d+)?|\\d+(?:\\.\\d+)?\\s*(?:亿元|万元|万|亿|dollars|USD))[^，。！？\\n]{0,25})"
    matches = re.findall(pattern, text)
    return [{"context": m.strip()} for m in matches[:20]]

if __name__ == "__main__":
    sample = "<div>2025年第三季度营收达到45.2亿元，同比增长18.5%，净利润达6.8亿元。</div>"
    print("Cleaned:", clean_extracted_text(sample))
    print("Numbers:", extract_key_numbers(sample))
`
      },
      {
        path: 'references/extraction_rubric.md',
        kind: 'markdown',
        content: `# 萃取评分标准 (Extraction Rubric)

- **保真度**：严禁篡改原研报中的统计数据。
- **客观性**：清晰区分作者观点（Opinion）与客观事实（Fact）。`
      }
    ],
    isBuiltIn: true,
    enabled: true,
    author: 'AgentBox System',
    version: '1.0.0',
    createdAt: '2026-08-16T00:00:00.000Z',
    updatedAt: '2026-08-16T00:00:00.000Z'
  },
  {
    id: 'translator-polyglot',
    name: '专业多语言精翻与本地化',
    description: '用于中文、英文及多语言翻译、本地化、译文润色、术语一致性与语言转换',
    icon: 'translate',
    entryFile: 'SKILL.md',
    files: [
      {
        path: 'SKILL.md',
        kind: 'markdown',
        content: `# 专业多语言精翻与本地化 (Translator Polyglot)

你当前作为母语级资深翻译专家与本地化工程师。你的职责是提供高水准、语境地道、术语严格一致的双语/多语转换。

## 三步翻译法
1. **初译（Accuracy）**：忠实传达原文全部事实与逻辑细节。
2. **意译（Fluency）**：摆脱原文句式束缚，符合目标语言母语表达习惯。
3. **润色（Polishing）**：结合行业领域（技术/法律/商业/文学）调整语气与专业用词（参考 \`scripts/terminology_matcher.py\` 校验术语一致性）。`
      },
      {
        path: 'scripts/terminology_matcher.py',
        kind: 'python',
        content: `#!/usr/bin/env python3
"""
Terminology Matcher & Consistency Verifier
Verifies that domain glossaries and brand terms are consistently translated.
"""
from typing import Dict, List, Tuple

def check_terminology_consistency(
    source_text: str,
    target_text: str,
    glossary: Dict[str, str]
) -> List[Tuple[str, str, str]]:
    """Identifies glossary terms present in source that are missing in target translation."""
    issues = []
    for src_term, expected_target in glossary.items():
        if src_term.lower() in source_text.lower():
            if expected_target.lower() not in target_text.lower():
                issues.append((src_term, expected_target, "术语未在译文中完全匹配"))
    return issues

if __name__ == "__main__":
    sample_glossary = {"token window": "上下文窗口", "reasoning effort": "思考力度"}
    src = "Please check the token window before submission."
    tgt = "提交前请检查 Token 大小。"
    print("Terminology Audits:", check_terminology_consistency(src, tgt, sample_glossary))
`
      },
      {
        path: 'references/localization_standards.md',
        kind: 'markdown',
        content: `# 本地化排版规范 (Localization Standards)

- 中英文混排在汉字与英文字符之间自然保留空格。
- 专有名词及函数名保持原样，不随意汉化。`
      }
    ],
    isBuiltIn: true,
    enabled: true,
    author: 'AgentBox System',
    version: '1.0.0',
    createdAt: '2026-08-16T00:00:00.000Z',
    updatedAt: '2026-08-16T00:00:00.000Z'
  },
  {
    id: 'prompt-optimizer',
    name: '提示词工程专家',
    description: '用于编写、优化和诊断系统提示词、Prompt、任务指令、角色设定与结构化模板',
    icon: 'sparkles',
    entryFile: 'SKILL.md',
    files: [
      {
        path: 'SKILL.md',
        kind: 'markdown',
        content: `# 提示词工程专家 (Prompt Optimizer)

你当前作为高级提示词工程师与 LLM 系统架构师。你的职责是将模糊、简略的用户意图转化为结构严谨、边界清晰、执行力极高的专业提示词（System Prompt / Task Prompt）。

## 提示词黄金架构 (CRISP-E)
1. **Context（背景语境）**：明确业务场景与系统定位。
2. **Role（角色设定）**：界定专家身份、专业技能与说话口吻。
3. **Instruction（具体任务）**：清晰分解核心执行步骤。
4. **Specification（输出规格）**：定义格式（JSON / Markdown / 代码 / 结构体）。
5. **Examples（少样本示例）**：提供优质 Input-Output 参照。`
      },
      {
        path: 'scripts/prompt_linter.py',
        kind: 'python',
        content: `#!/usr/bin/env python3
"""
System Prompt Linter & Structure Checker
Scans prompt text for common structural issues (lack of role, constraints, or format specification).
"""
import re
from typing import List, Dict, Any

def lint_prompt_structure(prompt_text: str) -> Dict[str, Any]:
    """Evaluates prompt completeness against standard engineering dimensions."""
    checks = {
        "has_role": bool(re.search(r"(角色|身份|你是|You are|As an?)", prompt_text, re.IGNORECASE)),
        "has_constraints": bool(re.search(r"(约束|禁止|不能|注意|必须|Constraints|Must|Do not)", prompt_text, re.IGNORECASE)),
        "has_format_spec": bool(re.search(r"(格式|输出|JSON|Markdown|Structure|Format)", prompt_text, re.IGNORECASE)),
        "has_examples": bool(re.search(r"(示例|例如|Example|Few-shot)", prompt_text, re.IGNORECASE)),
    }
    score = sum(1 for v in checks.values() if v) / len(checks) * 100
    return {
        "score": round(score, 1),
        "checks": checks,
        "suggestions": [k for k, v in checks.items() if not v]
    }

if __name__ == "__main__":
    test_prompt = "你是一个翻译官。请把英文翻译成中文，必须保持信达雅。"
    print("Lint Results:", lint_prompt_structure(test_prompt))
`
      },
      {
        path: 'references/prompt_patterns.md',
        kind: 'markdown',
        content: `# 常用提示词模式库 (Prompt Patterns)

- **CoT 思维链**："请分步骤思考并推导每一步原因..."
- **结构化输出**："严格输出为合法 JSON，不要包含外层 Markdown 代码块..."`
      }
    ],
    isBuiltIn: true,
    enabled: true,
    author: 'AgentBox System',
    version: '1.0.0',
    createdAt: '2026-08-16T00:00:00.000Z',
    updatedAt: '2026-08-16T00:00:00.000Z'
  }
]
