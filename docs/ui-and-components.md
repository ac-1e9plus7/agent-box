# 6. 前端 UI 与交互系统

AgentBox 的渲染层基于 React 19 构建，注重排版美学、数学表达、多模态处理与流畅的交互体验。

---

## 🌲 树状会话与分支版本管理（Conversation Tree）

在 [`src/shared/conversation-tree.ts`](../src/shared/conversation-tree.ts) 中实现了纯函数式的树状消息管理：

- **父子节点索引**：每条消息记录 `parentId` 与 `id`，支持任意分支分叉。
- **版本切换与分页**：当对某条历史消息重新生成或编辑时，系统自动创建兄弟版本，气泡下方展示版本分页器（如 `2 / 3`），支持随意在各个历史分支间自由切换。
- **编辑历史消息**：
  - **仅保存**：仅修改当前用户消息内容，保留其后的对话分支。
  - **保存并重新生成**：修改内容后丢弃后续节点，并以当前模型重新生成新分支。

---

## 📐 Markdown 排版与 LaTeX 数学公式渲染

- **自然换行（Natural Linebreaks）**：采用 `remark-breaks`，单次回车即渲染为正常换行，符合即时通讯使用直觉。
- **代码可读性**：行内代码、围栏代码块和工具输出统一使用跨平台等宽字体栈；块级代码保留空白与缩进，超长行通过独立横向滚动查看。
- **全格式 LaTeX 支持**：结合 `remark-math` 与 `rehype-katex`：
  - 行内公式：`$E = mc^2$` 与 `\(E = mc^2\)`
  - 块级独立公式：`$$\int_{-\infty}^\infty e^{-x^2} dx = \sqrt{\pi}$$` 与 `\[...\]`
  - 代码块与复杂环境：支持 `math` 代码块及矩阵（`matrix`, `pmatrix`, `bmatrix`）、方程组对齐（`aligned`, `cases`）。
  - **横向防溢出**：超宽公式支持优雅的横向滚动条，具备容错处理。

---

## 🖼️ 多模态附件与图片优化

- **多途径输入**：支持文件选择器、拖拽上传（Drag & Drop）与剪贴板直接粘贴图片（Paste）。
- **客户端智能压缩**：在 [`src/renderer/src/file-helper.ts`](../src/renderer/src/file-helper.ts) 中对图片进行智能缩放（最大边限制 2048px），大幅降低传输体积与 Token 开销。
- **原图灯箱（Lightbox）**：消息中的图片点击可唤起高清灯箱全屏预览。

---

## ⌨️ 快捷键与输入框交互

在 [`src/renderer/src/composer-helper.ts`](../src/renderer/src/composer-helper.ts) 中统一管理：
- `Enter`：默认发送消息（可在通用设置中切换为换行）。
- `Ctrl + Enter` / `Cmd + Enter`：在任何模式下均执行强制换行，避免意外误发送。
