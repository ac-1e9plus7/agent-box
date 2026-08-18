# 3. API 协议与请求网关

AgentBox 网关层（`ChatGateway`）负责处理多模型服务商的请求构造、SSE 流式事件消费、错误脱敏、多轮工具调用循环及代理分发。

---

## 🌐 三种原生 API 格式适配

网关层将“模型”、“供应商连接”和“API 格式”彻底解耦，在 [`src/electron/api/request-adapters.ts`](../src/electron/api/request-adapters.ts) 与 [`src/electron/api/protocol-adapters.ts`](../src/electron/api/protocol-adapters.ts) 中提供了完整转换：

| API 格式 | 端点路径 | 请求体构造重点 | 流式 Delta 解析 |
| --- | --- | --- | --- |
| **OpenAI Chat Completions** | `/chat/completions` | `messages`, `tools`, `reasoning_effort` | `choices[0].delta.content`, `delta.tool_calls`, `reasoning_details` |
| **OpenAI Responses** | `/responses` | `input`, `instructions`, `tools` | `response.output_item.added`, `response.function_call_arguments.delta` |
| **Anthropic Messages** | `/messages` | `system`, `messages` (Content Blocks), `tools` | `content_block_delta` (`text_delta`, `thinking_delta`, `input_json_delta`) |

---

## 🧠 思考模式（Reasoning / Thinking）归一化

不同服务商和格式对思考模式的实现各不相同，AgentBox 在网关层完成了统一归一化：
1. **OpenRouter / Gemini 思考解析**：从 `reasoning_details`（`reasoning.text` / `reasoning.summary`）中解析思考内容；Gemini 经 OpenRouter 转发的思考 token（`thoughtsTokenCount`）会自动合并到用量的 `reasoningTokens` 中。
2. **OpenAI Responses 思考解析**：从 `reasoning` output item 中提取推理文本与耗时元数据。
3. **Anthropic 思考解析**：从 `thinking_delta` 中提取实时思维链文本。
4. **静默思考提示**：当大模型未返回可见思考文本但用量中包含 `reasoningTokens` 时，界面会明确展示“已推理 X tokens（模型未返回可见思考）”，避免误判。

---

## 🔍 OpenRouter 联网搜索集成

通过 OpenRouter 推荐的 `openrouter:web_search` server tool 实现：
- **模式选项**：`off`（关闭）、`auto`（自动搜索）、`native`（原生优先，不支持时自动回退）。
- **请求配额约束**：每次生成请求限制最多 2 次搜索、每次最多 5 个结果、合计最多 8 个结果。
- **结构化来源展示**：协议适配层安全提取搜索返回的 URL、标题与摘要，并在渲染层展示 Citation 卡片与搜索次数。

---

## 🛡️ 网络代理转发（ProxyAgent Dispatcher）

在「设置 → 通用 → 网络代理」中支持配置全局代理：
- 主进程基于 `undici` 的 `ProxyAgent` 创建自定义 `dispatcher`，作用于所有主进程 `fetch` 请求。
- **协议约束**：本机回环代理允许 `http://`（如 `http://127.0.0.1:7890`），远程代理强制要求 `https://`。
- **凭据保护**：代理用户名密码通过 URL Userinfo 传递，代理地址在日志和错误消息中严格脱敏。
