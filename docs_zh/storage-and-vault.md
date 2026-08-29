# 2. 加密存储与 Vault 安全

> English: [Encrypted Storage and Vault Security](../docs/storage-and-vault.md)

AgentBox 将设置、供应商凭据、模型、会话、Skills 和 MCP server 配置保存在主进程管理的本地加密 Vault 中。工作区文件不属于 Vault；会话只保存其工作目录的绝对路径。

---

## 🔐 信封加密模型

```text
+-------------------------------------------------------------------+
| Electron safeStorage · OS-backed credential protection            |
+-------------------------------------------------------------------+
                               |
               encryptString(base64-encoded 256-bit key)
                               v
+-------------------------------------------------------------------+
| <userData>/vault/master-key.bin                                   |
| safeStorage-wrapped random Vault key                              |
+-------------------------------------------------------------------+
                               |
            AES-256-GCM · random 12-byte IV · 16-byte tag
            AAD: "agentbox:vault:v1"
                               v
+-------------------------------------------------------------------+
| <userData>/vault/user-data.v1.enc                                 |
| One encrypted JSON envelope containing the complete Vault state   |
+-------------------------------------------------------------------+
```

供应商 API Key、MCP 环境变量/请求头和代理凭据是 Vault JSON 中的字段，由整份 Vault 的 AES-256-GCM 加密统一保护；它们并没有各自再套一层独立密文。Renderer 读取供应商、MCP server 或设置时只会得到脱敏视图。

### 1. 主密钥生成与封装

- [`EncryptedStore`](../src/electron/storage/encrypted-store.ts) 在首次初始化时生成 32-byte 随机密钥，将其编码为 Base64 后交给 Electron `safeStorage.encryptString()`，封装结果写入 `master-key.bin`。
- 如果 `safeStorage.isEncryptionAvailable()` 为 false，应用拒绝加载用户数据；Linux 若选中的后端是未加密的 `basic_text`，同样直接报错，不提供明文降级。
- 应用退出时会覆写并释放进程内的密钥 Buffer。密钥和已解密状态在应用运行期间仍必须存在于可信主进程内存中。
- 启动流程兼容旧 ChatBox Lite 用户目录和旧 AAD。目录迁移会复制或重新持久化旧数据；读取旧 AAD 后的下一次 Vault 写入使用当前 `agentbox:vault:v1` AAD。

### 2. Vault 加密与写入语义

- 每次持久化都会序列化完整状态，并使用新的随机 12-byte IV、AES-256-GCM 和 16-byte 认证标签生成版本为 1 的 JSON 信封。
- Mutations 由 Promise 队列串行执行：先克隆状态、应用变更并重新校验 Schema，持久化成功后才替换内存状态。
- 文件先写入同目录的唯一 `.tmp` 文件，使用 `flag: 'wx'` 和权限模式 `0600`；随后通过 `rename` 替换 Vault 路径，失败时清理临时文件。
- 当前实现**没有调用 `fsync`**。临时文件加重命名可以避免把半段 JSON 直接写进活动文件，但不承诺在操作系统或硬件突然掉电时实现持久化屏障。

### 3. 工作区边界与 Agent 恢复

- Vault 只持久化 `Conversation.workingDirectory` 的规范化绝对路径。源码、依赖、Git 数据和其他项目文件不会被 [`EncryptedStore`](../src/electron/storage/encrypted-store.ts) 导入或加密。
- 这不代表 Agent 工具永远只读：用户启用 Agent 模式并批准相应工具后，工作区文件写入或终端命令可以在该目录范围内执行。该行为与 Vault 存储相互独立。
- 深备份是唯一会递归读取整个工作目录的存储相关操作；它只读取源目录并把内容写入用户选择的 ZIP，不会把项目文件并入 Vault。
- Assistant 消息可以保存结构化 `interruption`、`agentTrace` 和工具执行结果。恢复时以这些持久化 checkpoint 为准，不依赖 renderer 的临时错误状态。
- LangGraph Runtime checkpoint 使用 `<userData>/vault/agent-checkpoints-v1/` 下的独立加密记录。AES-GCM 和文件名 HMAC 密钥从内存中 Vault 主密钥派生；逻辑 ID 和 payload 不用作文件名，也不以明文落盘。

Record 格式、Saver 契约、配额与生命周期详见 [LangGraph 加密 Checkpoint](./langgraph-checkpoints.md)。

---

## 📦 Vault Schema

领域结构定义于 [`src/electron/storage/app-repository.ts`](../src/electron/storage/app-repository.ts)，共享实体定义于 [`src/shared/types.ts`](../src/shared/types.ts)：

```typescript
interface VaultState {
  schemaVersion: 1
  settings: AppSettings
  providers: StoredProvider[]
  models: ModelConfig[]
  conversations: Conversation[]
  skills?: Skill[]
  mcpServers?: McpServerConfig[]
}
```

`skills` 和 `mcpServers` 在接口中可选是为了兼容旧 Vault；加载和校验后都会补齐为数组。设置中缺失的较新字段也由 [`settings-schema.ts`](../src/electron/storage/settings-schema.ts) 迁移为安全默认值。

LangGraph checkpoint sidecar 刻意不是 `VaultState` 字段，superstep 写入因此不会重写完整会话 Vault。它是本机执行状态；`agentTrace` 仍位于会话 Schema 和可移植备份中。

`AppSettings.userNickname` 和 `userAvatar` 仅用于本地展示，不会进入模型提示词。昵称最多 50 个字符；头像接受 PNG/JPEG/WebP Base64 Data URL，最多 3,000,000 个字符，renderer 裁剪时将边长限制为 1,000 像素。首次缺少 `language` 的 Vault 会使用启动时传入的系统语言回退值。

Assistant 的 `usage` 同时保存聚合 token 计数和可选的 `modelRequests` 明细，后者按从 1 开始的 Agent 模型轮次标识。每条明细只允许有界非负整数计数，最多保存 101 次请求（100 个工具轮次加终态模型请求）。加载有效明细时会重新计算聚合总计；旧消息只有聚合 usage 时仍可原样读取。

Agent token 优化以相互独立的 `AppSettings` 偏好持久化；新建和旧版 Vault 均默认关闭全部优化。功能关闭时仍保留参数值：工具结果压缩使用 `agentToolResultMaxCharacters: 16000`（2,000–100,000），动态工具暴露使用 `agentDynamicToolLimit: 4`（1–16），Agent 单次运行上下文压缩默认在 70%（50%–95%）触发并保留最近 3 轮（1–10）。`agentProviderContextOptimizationMode` 接受 `off`、`auto`、`prefix-cache` 或 `native-continuation`，默认使用 `off`。设置规范化会拒绝未知模式、非布尔开关、非整数及越界参数，不会静默强制转换。

启用原生续接时，助手消息可以保存经过校验的 `providerContinuation`，其中包含 OpenAI Responses 句柄和从 1 开始的模型轮次。句柄最多 200 个安全标识符字符，只能属于助手消息，并保留在加密 Vault 中；会话备份也会把它作为消息 JSON 的一部分导出。它是不透明的服务方侧状态引用，不是 API 凭据；删除本地会话数据会移除本地引用，但不会覆盖服务方自己的数据保留政策。

---

## 📏 资源配额与校验

主要限制由 [`app-repository.ts`](../src/electron/storage/app-repository.ts)、[`vault-resource-limits.ts`](../src/electron/storage/vault-resource-limits.ts) 和 [`web-metadata-schema.ts`](../src/electron/storage/web-metadata-schema.ts) 执行：

| 资源                                          |          当前上限 |
| --------------------------------------------- | ----------------: |
| 供应商                                        |               100 |
| 模型                                          |             2,000 |
| 会话                                          |            10,000 |
| Skills                                        |               500 |
| MCP servers                                   |               100 |
| 单会话消息                                    |            20,000 |
| 单条消息正文或推理字段                        | 各 2,000,000 字符 |
| 单会话计入校验的总内容                        |   50,000,000 字符 |
| 全部会话序列化数据                            |            50 MiB |
| 全部会话消息 / 引用                           |        各 100,000 |
| 单条消息引用                                  |               100 |
| 单条消息附件                                  |                20 |
| 单个 Skill 文件数 / 单文件内容                | 50 / 500,000 字符 |
| 单个 MCP server 参数数 / 环境变量数           |          50 / 100 |
| 单项 MCP 参数或环境变量值                     |        8,192 字符 |
| 加密 checkpoint thread / 单 thread checkpoint |         256 / 512 |
| 单 thread / 完整 namespace checkpoint 数据    |  64 MiB / 256 MiB |

保存会话时同时执行单会话和聚合配额。为避免新配额把旧数据永久锁死，旧 Vault 即使已经超过聚合上限也可以加载，并允许删除或缩小数据；任何仍会增大超限维度的保存都会被拒绝。

---

## 🧹 清除会话数据

「设置 → 数据与安全 → 清除全部会话数据」执行以下流程：

1. `ChatGateway.cancelAll()` 中止全部活动请求并结束待处理的工具审批。
2. 先清空加密 checkpoint namespace。清理失败时中止，不报告会话数据已清除。
3. Repository 将 `conversations` 替换为空数组；设置、供应商与 API Key、模型、Skills 和 MCP server 配置保持不变。
4. 完整 Vault 使用新的随机 IV 再次加密并写入；safeStorage 封装的主密钥不轮换。

该操作清除活动 Vault 中的会话，不是面向磁盘取证场景的安全擦除保证。

---

## 📦 会话 ZIP 备份

「设置 → 数据与安全 → 导出加密备份」调用 [`src/electron/backup/backup-export.ts`](../src/electron/backup/backup-export.ts)。Renderer 只提交模式和可选的一次性密码；系统保存对话框、Vault 快照读取和文件创建均在主进程中进行。

### 备份模式

- **浅备份（shallow）**：导出全部会话。每个会话同时包含一份完整 JSON 和一份可读 Markdown；JSON 保留会话树中的全部分支、附件、引用、用量、Skill 激活、工具执行、Agent trace 与中断元数据。
- **深备份（deep）**：在浅备份基础上，递归加入所有被会话引用的工作目录。实现使用 `realpath` 对同一目录去重；保留空目录和符号链接，但不跟随符号链接；跳过其他特殊文件并把路径写入清单警告。

### 加密与隐私边界

- 密码可选，最长 256 个字符。设置非空密码时，`@zip.js/zip.js` 对 ZIP 条目使用 WinZip AES-256（AE-2）；密码不写入设置或 Vault，AgentBox 也无法恢复密码。
- ZIP 中的 JSON、Markdown 和工作区文件在进入归档前都是原始内容。没有密码时可直接读取；有密码时由条目加密提供静态保护。
- ZIP 中央目录不加密条目名称。会话文件使用序号而不是标题；深备份的工作区相对文件名仍会出现在条目名称中。`manifest.json` 还包含工作目录绝对路径映射，但设置密码后其文件内容会被加密。
- 备份不包含供应商 API Key、认证凭据、Vault 主密钥、Vault 文件和本机 LangGraph checkpoint sidecar，也不包含供应商、模型、MCP server、Skill 或应用设置。`agentTrace` 仍位于会话 JSON 中，因此恢复可移植。会话正文和工作区本身仍可能包含敏感数据。

### 写入与替换

归档先写入目标目录中权限模式为 `0600` 的随机 `.partial` 文件。ZIP writer 正常关闭且输出流结束后才替换用户选择的目标文件；替换已有文件时会先把旧文件临时移开，失败则尝试恢复。失败路径会清理不完整文件。深备份会排除所选目标路径；扫描发生在 `.partial` 文件创建前，因此不会把正在生成的归档递归收进自身。

ZIP 根目录布局：

```text
manifest.json                         # 格式、模式、版本、内容计数和工作目录映射
README.txt                            # 面向用户的内容与安全说明
conversations/index.json             # 会话索引
conversations/conversation-0001.json # 完整会话数据
conversations/conversation-0001.md   # 可读会话文本
workspaces/workspace-0001/            # 仅深备份存在
```

当前清单标识为 `format: "agentbox-backup"`、`formatVersion: 1`；其 `encryption.method` 明确记录 `none` 或 `WinZip AES-256 (AE-2)`。
