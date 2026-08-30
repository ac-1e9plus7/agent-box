# 6. 前端 UI 与交互系统

> [English version](../docs/ui-and-components.md) · [返回中文文档索引](./README.md)

AgentBox 的渲染层基于 React 19 与 TypeScript，负责界面展示、临时交互状态和经 preload 白名单调用主进程；它永远不会从主进程接收已持久化的 API Key 值，但会暂时处理用户刚输入、用于测试或保存的密钥；它不直接请求模型服务。

## 渲染层组织

| 模块                                                                                                              | 职责                                                                                    |
| ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| [`src/renderer/src/App.tsx`](../src/renderer/src/App.tsx)                                                         | 启动数据装载、设置保存、功能协调与主界面组件组合                                        |
| [`src/renderer/src/hooks/useConversation.ts`](../src/renderer/src/hooks/useConversation.ts)                       | 会话 state/ref 同步、创建、持久化、活动分支更新与新对话快捷键                           |
| [`src/renderer/src/hooks/useChatStream.ts`](../src/renderer/src/hooks/useChatStream.ts)                           | 活动流注册、标准化事件归并、取消、工具审批、完成处理与错误 checkpoint                   |
| [`src/renderer/src/components/`](../src/renderer/src/components/)                                                 | 侧栏、顶部栏、消息区、输入框、新对话和 Settings 外壳等 React 组件                       |
| [`src/renderer/src/components/settings/`](../src/renderer/src/components/settings/)                               | 通用、运行时、Skills、MCP、模型、供应商、安全与关于 section，以及设置共用控件           |
| [`src/renderer/src/components/browser/BrowserPanel.tsx`](../src/renderer/src/components/browser/BrowserPanel.tsx) | 浏览器标签控件、浏览器会话命令、下载指示器和原生 View 边界上报                          |
| [`src/renderer/src/*.ts`](../src/renderer/src/)                                                                   | 会话上下文投影、标题清洗、附件处理、Markdown 预处理、快捷键和工作目录分组等可测试纯逻辑 |
| [`src/shared/conversation-tree.ts`](../src/shared/conversation-tree.ts)                                           | renderer 与测试共用的消息树遍历、分支切换和节点删除逻辑                                 |

Settings 外壳统一持有 `preferences`、模型、供应商和 API Key 的暂存改动，并由“保存更改”一次提交；各 section 按需维护自己的选择项、搜索、测试和弹窗等局部状态。Skills 与 MCP server 的变更仍通过各自的即时持久化 API 完成。

「设置 → 通用 → Agent token 优化」提供四个互相独立的 P1 开关和一个 P2 服务方上下文复用选择器。四个开关分别用于压缩模型可见工具结果、动态限制初始工具集、按需加载 Skill 参考资料与脚本，以及压缩长时间 Agent 执行中的较早轮次；选择器可使用关闭、自动服务方感知复用、前缀缓存或 Responses 原生续接。数值控件只在对应优化开启后显示，关闭开关不会丢失已经暂存或保存的合法参数值。自动和原生模式文案会提示服务方侧响应状态可能被保留，所有复用模式都说明兼容性自动降级行为。

主题通过 `document.documentElement.dataset.theme` 在 `system`、`light` 和 `dark` 之间切换；系统主题使用 `prefers-color-scheme`。宽度不超过 860px 时侧栏改为抽屉，680px 以下进一步压缩顶部栏与输入区；`prefers-reduced-motion` 会关闭非必要动画。

## 内置浏览器面板

浏览器需要先在「设置 → 通用 → 内置浏览器」全局启用；是否允许 Agent 使用，还需要在每个对话中单独开启。同一设置卡片允许配置主页 URL，默认值为 Google；新建会话和用户新建的标签页都会打开该主页。面板包含可横向滚动的标签栏，并默认支持把页面弹窗转换为标签、切换和关闭。没有 Agent 请求运行时，关闭最后一个标签页会结束完整浏览器 Session 并隐藏面板；Agent 执行期间，关闭最后标签或整个 Session 会变成可见的延迟请求，并提供“保持浏览器打开”撤销操作，其他标签的关闭按钮则会禁用；非破坏性的隐藏操作始终可用。工具栏控制当前活动标签的地址、后退、前进、刷新/停止、隐藏和关闭会话。宽屏布局下，可信聊天区域和浏览器共享 Chat Stage；窄屏下浏览器占满 Stage。React 只渲染标签栏、工具栏、状态和边界占位区，活动的主进程 `WebContentsView` 实际占据该矩形，因此 renderer 会通过类型化 IPC 报告边界；打开设置或新建对话框时会隐藏所有原生标签 View。Session 按需创建：全应用最多保留三个活动 Session，且同时只能显示一个。打开第四个浏览器 Session 会关闭最久未使用的隐藏 Session，因此隐藏面板只会在 Session 仍驻留时保留标签。

手动浏览本身不会向模型暴露工具。Composer 的“浏览器工具”开关只控制持久化的 `Conversation.browserToolEnabled`，不会改变面板显隐；浏览器导航事件也保持在后台。只有顶部栏的“浏览器”按钮可以打开或隐藏面板。Renderer 异步回调绑定当前挂载的对话，关闭事件会清除缓存标签元数据，因此迟到的初始化或关闭结果不会恢复旧面板。`browser:event` 为每个标签发送使用 `activeTabId` 和标签 `id` 的脱敏元数据，以及临时下载名称/进度元数据；它从不发送浏览器绝对路径。页面文本和截图字节只有作为经过策略授权的 Agent 工具结果才会进入 renderer/模型，并成为加密对话数据。设置项可独立启用加密 Cookie 持久化、Agent 截图、文件上传、下载和环回 HTTP。启用上传会恢复用户操作的系统文件选择器，因此手动上传可选择操作系统允许的任意文件；独立的 Agent 上传路径只接受经过批准的工作区相对文件。手动下载进入系统“下载”目录，Agent 下载创建不覆盖已有文件的工作区相对文件；两条路径都受 100 MiB 下载上限约束。非持久 Session 使用临时 Chromium 缓存，避免重复下载相同页面资源。关闭 Session 会立即移除原生 View，再尽力保存可选 Cookie 快照并清理缓存/网络数据；活动站点存储和 DOM 状态会被丢弃。

## 本地用户资料

- 「设置 → 通用 → 个人资料」支持昵称与头像编辑，昵称最多 50 个字符且不能包含换行。
- [`avatar-helper.ts`](../src/renderer/src/avatar-helper.ts) 在 340px 方形视口内提供拖动、方向键移动和 1–3 倍缩放。源文件上限为 30 MB；拒绝 SVG、边长超过 20,000px 或总像素超过 1 亿的图片。
- 裁剪结果优先编码为 WebP，不会放大原始裁剪区域，输出边长不超过 1,000px；必要时逐步降低质量和尺寸，以满足头像 Data URL 的存储上限。
- 当前资料统一显示在侧栏设置入口和所有用户消息旁。历史消息不复制昵称或头像，因此修改资料后会同步改变历史消息的展示。
- `userNickname` 与 `userAvatar` 仅用于本地展示。上下文估算只读取 `systemPrompt`，网关也只接收显式系统提示词、会话消息和附件，资料不会进入模型请求。

## 树状会话与版本管理

每条消息通过 `id` 和 `parentMessageId` 组成树，`Conversation.currentLeafId` 指向当前分支。旧的线性消息缺少 `parentMessageId` 时，[`ensureMessageTree`](../src/shared/conversation-tree.ts) 会按原存储顺序补齐父链。

- **活动分支**：[`getActiveMessageChain`](../src/shared/conversation-tree.ts) 从 `currentLeafId` 回溯到根；没有有效叶节点时，按每个分叉点最后写入的子节点选择默认分支。
- **版本分页**：同一父节点下、角色相同的消息视为兄弟版本。消息气泡显示 `2 / 3` 等分页器；切换版本时会选择该版本下最深的最新后代。
- **重新生成回答**：在同一用户消息下追加新的 assistant 兄弟节点，原回答及其后代仍保留为其他分支。
- **编辑用户消息**：选择“仅保存”会原位修改当前节点并保留后代；选择“保存并重新生成”会追加新的 user 兄弟节点和 assistant 子节点，原分支不会被删除。
- **删除消息**：删除目标节点及其全部后代；若存在兄弟版本则切换到相邻版本，否则回退到父节点下可用的最深叶节点。

Agent 回复因取消、限流、网络/API 错误、输出上限或工具轮次上限而中断时，会保存 `interruption`、已完成的工具结果和 `agentTrace`。只有当前分支最后一条中断回复可“从中断处继续”；系统会创建新的 user/assistant 分支并把前一条回复作为 checkpoint。选择“重新生成”则从原父级用户消息创建全新回答版本。

完成或中断的 Assistant 消息会同时显示汇总后的 total、input、output、reasoning、cached-input、cache-write token 用量和模型请求次数。完成的回复把复制、重新生成、删除和版本控制放在独立操作行中；模型身份和 Token 计数则使用另一条可横向滚动的单行元信息带，避免单个计数在行内断开。因此，多轮 Agent 回复呈现的是全部请求成本，而不是只有最后一次模型调用；供应商未报告的计数显示为不可用，不会推断成零。供应商返回空响应时，用量仍保持可见。

## Markdown、代码与数学公式

[`ChatContent.tsx`](../src/renderer/src/components/ChatContent.tsx) 将持久化的 `message.content` 视为源数据，而不是渲染后的 HTML。用户消息使用转义后的纯文本和 `white-space: pre-wrap` 显示，因此换行、缩进与 Markdown 标点保持字面含义，也不会生成 `<br>` 元素。助手消息使用 `react-markdown`，并组合以下插件：

- `remark-gfm`：表格、任务列表、删除线和自动链接等 GitHub Flavored Markdown。
- `remark-breaks`：单次回车渲染为换行，适合聊天文本。
- `remark-math` 与 `rehype-katex`：解析并渲染 KaTeX，错误公式不会使整条消息崩溃。

[`markdown-helper.ts`](../src/renderer/src/markdown-helper.ts) 会在渲染前把 `\(...\)`、`\[...\]`、`math` / `latex-math` 代码块和独立的 `matrix`、`aligned`、`cases` 等环境归一为 Markdown 数学语法，同时保护行内代码、围栏代码和常见美元金额。代码块提供语言标签与复制按钮；超长代码和公式使用独立横向滚动。消息链接请求使用带 `noopener noreferrer` 的 `_blank`，但 Electron 会拒绝应用内新窗口，并只把通过校验且不含凭据的 HTTP(S) URL 交给操作系统的外部浏览器。

新建或编辑的用户消息只会把行尾规范为 LF，存储及发送给模型前不会裁剪正文。空消息校验可以检查裁剪后的副本；标题和渲染结果始终属于派生数据，不能回写到 `message.content`。

## 多模态附件

[`file-helper.ts`](../src/renderer/src/file-helper.ts) 支持文件选择、拖放和从剪贴板粘贴文件：

- 单个源文件最大 25 MB；主进程网关还会校验附件数量和字段大小。
- 图片保存为 Data URL。最大边超过 2,048px 时在 renderer 中等比缩小；PNG 保持 PNG，其他图片重编码为质量 0.9 的 JPEG。若浏览器无法解码或创建画布，则保留原始数据。
- 已知文本/代码格式以 UTF-8 文本读取；PDF 以 Data URL 读取。无法识别的文件先尝试按文本读取，再回退为 document Data URL。
- 图片附件可在消息中打开灯箱预览；文本和文档附件显示名称、类型图标与原始文件大小。
- 协议能力并不完全相同：图片和文本会转换为三种 API 格式各自的内容块；Anthropic Messages API 可发送 PDF document block，而当前 OpenAI Chat Completions API / OpenAI Responses API 适配器仅为 document 附件加入文件名占位文本。

## 输入框与快捷键

[`composer-helper.ts`](../src/renderer/src/composer-helper.ts) 将按键判定保持为纯函数，并忽略输入法组合过程中的 Enter：

| 设置                | 发送               | 换行                                                   |
| ------------------- | ------------------ | ------------------------------------------------------ |
| “按 Enter 发送”开启 | `Enter`            | `Shift + Enter`，或 `Ctrl/Cmd + Enter`（显式插入换行） |
| “按 Enter 发送”关闭 | `Ctrl/Cmd + Enter` | `Enter` 或 `Shift + Enter`                             |

输入框工具栏还承载 Agent 模式、Skills 路由、可用 MCP server、reasoning、web search 与上下文预算状态。上下文超限时，发送会被阻止，或在允许的情况下提供“本次裁剪并发送”。应用级 `Ctrl/Cmd + N` 打开新对话面板。
