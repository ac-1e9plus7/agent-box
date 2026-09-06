# 6. Renderer UI and Interaction System

> [简体中文版本](../docs_zh/ui-and-components.md) · [Back to the English documentation index](./README.md)

AgentBox's renderer is built with React 19 and TypeScript. It owns presentation and transient interaction state and calls the main process only through the preload allowlist. It never receives persisted API-key values from the main process, but transiently handles a key the user has just entered for testing or saving; it never calls model services directly.

## Renderer organization

| Module                                                                                                            | Responsibility                                                                                                                       |
| ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| [`src/renderer/src/App.tsx`](../src/renderer/src/App.tsx)                                                         | Initial data loading, settings persistence, feature coordination, and top-level composition                                          |
| [`src/renderer/src/hooks/useConversation.ts`](../src/renderer/src/hooks/useConversation.ts)                       | Conversation state/ref synchronization, creation, persistence, active-branch updates, and the New conversation shortcut              |
| [`src/renderer/src/hooks/useChatStream.ts`](../src/renderer/src/hooks/useChatStream.ts)                           | Active-stream registration, normalized event reduction, cancellation, tool approval, completion, and error checkpointing             |
| [`src/renderer/src/components/`](../src/renderer/src/components/)                                                 | React components for the sidebar, top bar, messages, composer, New conversation dialog, and Settings shell                           |
| [`src/renderer/src/components/settings/`](../src/renderer/src/components/settings/)                               | General, runtimes, Skills, MCP, models, providers, security, and About Settings sections plus shared controls                        |
| [`src/renderer/src/components/browser/BrowserPanel.tsx`](../src/renderer/src/components/browser/BrowserPanel.tsx) | Browser tab controls, browser-session commands, download indicators, and native-view bounds reporting                                |
| [`src/renderer/src/*.ts`](../src/renderer/src/)                                                                   | Testable logic for context projection, title cleanup, attachments, Markdown preprocessing, keyboard behavior, and workspace grouping |
| [`src/shared/conversation-tree.ts`](../src/shared/conversation-tree.ts)                                           | Message-tree traversal, branch selection, and node deletion shared by the renderer and tests                                         |

The Settings shell owns the staged `preferences`, model, provider, and API-key changes that are committed together by **Save changes**. Each Settings section owns its local selection, search, test, and modal state where applicable. Skills and MCP server mutations continue to use their dedicated immediate-persistence APIs.

**Settings → General → Agent token optimization** exposes four independent P1 switches plus a P2 provider-context-reuse selector. The switches compact model-visible tool results, dynamically limit the initially exposed tool set, load Skill references and scripts only when needed, and compact older turns within a long-running Agent execution. The provider selector chooses off, automatic provider-aware reuse, prefix caching, or Responses native continuation. Numeric controls appear only when their corresponding optimization is enabled, while their last valid value remains staged and persisted when the switch is off. Automatic and native modes warn that provider-side response state may be retained, and every reuse mode documents automatic compatibility fallback.

The renderer sets `document.documentElement.dataset.theme` to `system`, `light`, or `dark`; system mode follows `prefers-color-scheme`. At widths up to 860px, the sidebar becomes a drawer, and below 680px the top bar and composer are further condensed. The stylesheet also honors `prefers-reduced-motion`.

## Built-in browser panel

The browser is globally opt-in under **Settings → General → Built-in browser** and separately opt-in for Agent access in each conversation. The same Settings card exposes a home-page URL, defaulting to Google; it is opened for new sessions and user-created tabs. The panel includes a horizontally scrollable tab strip; page-created windows, switching, and closing are supported by default. Closing the final tab closes the complete browser session and hides the panel when no Agent request is active. During Agent execution, the final-tab/session close becomes a visible deferred request with a **Keep browser open** undo action, while other tab close buttons are disabled; the non-destructive Hide action remains available. The toolbar controls the active tab's address, back, forward, reload/stop, hide, and session close. On wide layouts the trusted chat pane and browser share the chat stage; on narrow layouts the browser occupies the stage. React renders only the tab strip, toolbar, status, and a bounds placeholder. The active main-process `WebContentsView` occupies that rectangle, so the renderer reports bounds through typed IPC and hides every native tab view whenever Settings or the New conversation dialog is open. Sessions are created on demand: at most three remain live application-wide and only one can be visible. Opening a fourth browser session closes the least-recently-used hidden session, so hiding a panel preserves tabs only while that session remains resident.

Manual browsing never exposes tools to the model by itself. The Composer's Browser tools switch controls only the persisted `Conversation.browserToolEnabled` flag and never changes panel visibility; browser navigation events also remain in the background. The top-bar Browser button is the only control that opens or hides the panel. Renderer callbacks are scoped to the mounted conversation, and closing events clear cached tab metadata so late initialization or close results cannot restore an old panel. `browser:event` carries sanitized metadata for every tab using `activeTabId` and tab `id`, plus transient download name/progress metadata; it never carries a browser absolute path. Page text and screenshot bytes reach the renderer/model only through policy-authorized Agent tool results, where they become encrypted conversation data. Settings independently enable encrypted Cookie persistence, Agent screenshots, file uploads, downloads, and loopback HTTP. Enabling uploads restores the normal user-operated system file chooser, so manual uploads may select any OS-permitted file; the separate Agent upload path accepts only approved workspace-relative files. Manual downloads use the system Downloads directory, while Agent downloads create non-overwriting workspace-relative files; both paths share the 100 MiB download cap. The non-persistent session uses a temporary Chromium cache to avoid re-downloading repeated page assets. Closing a session immediately removes its native view, then saves the optional Cookie snapshot and clears cache/network data on a best-effort basis; live site storage and DOM state are discarded.

## Local user profile

- **Settings → General → Profile** lets the user set a nickname and avatar. Nicknames are limited to 50 characters and cannot contain line breaks.
- [`avatar-helper.ts`](../src/renderer/src/avatar-helper.ts) provides a 340px square viewport with dragging, arrow-key movement, and 1–3× zoom. Source files are limited to 30 MB. SVG, dimensions above 20,000px, and images above 100 million pixels are rejected.
- The crop is preferably encoded as WebP. It is never upscaled beyond the sampled source area, and its output edge is capped at 1,000px. Quality and dimensions are reduced progressively when required to fit the stored Data URL limit.
- The current profile is rendered in the sidebar settings entry and beside every user message. Messages do not copy profile fields, so changing the profile updates how historical messages appear.
- `userNickname` and `userAvatar` are display-only settings. Context estimation reads `systemPrompt`, while the gateway receives only explicit system instructions, conversation messages, and attachments; profile data is not sent to a model.

## Conversation tree and versions

Messages form a tree through `id` and `parentMessageId`, while `Conversation.currentLeafId` selects the active branch. For legacy linear messages without `parentMessageId`, [`ensureMessageTree`](../src/shared/conversation-tree.ts) reconstructs a parent chain in storage order.

- **Active branch:** [`getActiveMessageChain`](../src/shared/conversation-tree.ts) walks from `currentLeafId` back to the root. If no valid leaf is selected, it follows the last stored child at each branch point.
- **Version pagination:** Messages with the same parent and role are sibling versions. A message bubble can show a paginator such as `2 / 3`; selecting a version activates its deepest, most recently stored descendant.
- **Regenerate an answer:** A new assistant sibling is appended beneath the same user message. The previous answer and its descendants remain available on their original branch.
- **Edit a user message:** **Save only** updates the selected node in place and keeps its descendants. **Save & regenerate** appends a new user sibling and assistant child without deleting the original branch.
- **Delete a message:** The selected node and all descendants are removed. Selection moves to an adjacent sibling version when possible, otherwise to the deepest available leaf below the parent.

When an Agent response is interrupted by cancellation, rate limiting, a network/API error, an output limit, or the tool-turn limit, AgentBox retains `interruption`, completed tool results, and `agentTrace`. Only the final interrupted response on the active branch can be resumed. **Resume from checkpoint** creates a new user/assistant branch and uses the preceding response as the checkpoint; **Regenerate** creates a clean answer version from the original parent user message.

Completed or interrupted Assistant messages show aggregate total, input, output, reasoning, cached-input, and cache-write token usage together with the number of model requests. Completed replies keep copy, regenerate, delete, and version controls in a dedicated action row; model identity and token counters use a separate single-line, horizontally scrollable metadata strip so individual counters do not break across lines. Multi-turn Agent replies therefore expose the complete request cost rather than only the final model turn; unavailable provider counters are shown as unavailable instead of being inferred as zero. Usage remains visible for an empty provider response.

## Markdown, code, and math

[`ChatContent.tsx`](../src/renderer/src/components/ChatContent.tsx) treats stored `message.content` as source data rather than rendered HTML. User messages are rendered as escaped plain text with `white-space: pre-wrap`, so line breaks, indentation, and Markdown punctuation stay literal without generating `<br>` elements. Assistant messages use `react-markdown` and the following plugins:

- `remark-gfm` for GitHub Flavored Markdown tables, task lists, strikethrough, and autolinks;
- `remark-breaks` so a single line break is rendered as a line break in chat;
- `remark-math` and `rehype-katex` for KaTeX rendering without letting malformed math fail the whole message.

Before rendering, [`markdown-helper.ts`](../src/renderer/src/markdown-helper.ts) normalizes `\(...\)`, `\[...\]`, `math` / `latex-math` fences, and standalone environments such as `matrix`, `aligned`, and `cases`. It leaves inline code and ordinary fenced code untouched and protects common dollar-denominated amounts from accidental math parsing. Code blocks include a language label and copy action; long code and equations scroll horizontally. Message links request `_blank` with `noopener noreferrer`, but Electron denies in-app windows and passes only validated credential-free HTTP(S) URLs to the operating system's external browser.

New or edited user content is normalized to LF line endings but is never trimmed before storage or provider serialization. Empty-message checks may inspect a trimmed copy, while titles and rendered output remain derived data and are never fed back into `message.content`.

## Multimodal attachments

[`file-helper.ts`](../src/renderer/src/file-helper.ts) accepts files through the picker, drag and drop, or clipboard paste:

- Each source file is limited to 25 MB. The main-process gateway also validates attachment count and field sizes.
- Images are stored as Data URLs. If either edge exceeds 2,048px, the renderer scales the image down proportionally. PNG remains PNG; other decoded images are re-encoded as JPEG at quality 0.9. If decoding or canvas creation fails, the original data is retained.
- Known text and source-code formats are read as UTF-8 text. PDFs are read as Data URLs. An unrecognized file is first read as text, then falls back to a document Data URL if text reading fails.
- Image attachments open in a lightbox. Text and document attachments are shown as chips with their name, type icon, and original byte size.
- Protocol capabilities differ: image and text attachments are converted into native content shapes for all three APIs. Anthropic Messages API can receive a PDF document block, while the current OpenAI Chat Completions API and OpenAI Responses API adapters add only a filename placeholder for a document attachment.

## Composer and keyboard behavior

[`composer-helper.ts`](../src/renderer/src/composer-helper.ts) keeps keyboard decisions in a pure function and ignores Enter while an IME composition is active:

| Preference                       | Send               | Insert a line break                                              |
| -------------------------------- | ------------------ | ---------------------------------------------------------------- |
| **Press Enter to send** enabled  | `Enter`            | `Shift + Enter`, or `Ctrl/Cmd + Enter` for an explicit insertion |
| **Press Enter to send** disabled | `Ctrl/Cmd + Enter` | `Enter` or `Shift + Enter`                                       |

The composer toolbar also controls Agent mode, Skill routing, available MCP servers, reasoning, web search, and the context budget. When the projected context exceeds the input budget, sending is blocked or—when safe trimming is available—the UI offers a one-time **Trim and send** action. At application level, `Ctrl/Cmd + N` opens the New conversation dialog.

## data-plat

DataPlatFields adds API base URL, Agent ID, and a password input to Remote HTTP MCP settings. The data-plat-context stream event persists a governedData marker on derived messages. Approval cards display the actual server plan and effective arguments. See [data-plat integration](data-plat-integration.md).
