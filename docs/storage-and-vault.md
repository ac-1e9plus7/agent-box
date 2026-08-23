# 2. 加密存储与 Vault 安全

AgentBox 的本地存储架构旨在提供坚固的静态数据保护，确保所有聊天记录、自定义技能、API 密钥与偏好设置在写入磁盘前均经过强加密。

---

## 🔐 双层密钥加密模型

```text
+-------------------------------------------------------------------+
| 操作系统安全凭据设施 (safeStorage)                                 |
| Windows DPAPI / macOS Keychain / Linux Secret Service             |
+-------------------------------------------------------------------+
                               |
                   加密封装 (Encrypt Master Key)
                               v
+-------------------------------------------------------------------+
| 256-bit 随机主密钥 (Master Vault Key)                              |
+-------------------------------------------------------------------+
                               |
                   AES-256-GCM (Random IV + Auth Tag)
                               v
+-------------------------------------------------------------------+
| 本地加密 Vault 文件 (app.getPath('userData')/vault/data.enc)       |
| 包含：Conversations, Models, Providers (Encrypted Keys), Skills,  |
|      MCP Servers, App Preferences                                 |
+-------------------------------------------------------------------+
```

### 1. 密钥生成与封装
- 主进程首次启动时，生成高熵的 256-bit 加密主密钥。
- 该主密钥直接调用 Electron `safeStorage.encryptString()` 交由操作系统底层凭据设施进行硬件/凭据封装，并保存为独立的文件。
- **无明文降级原则**：若检测到系统 `safeStorage` 不可用，或在 Linux 下回退到未加密的 `basic_text` 后端，应用将明确报错并拒绝将敏感密钥以明文落盘。

### 2. AES-256-GCM 数据落盘
- 每次保存数据时，整份 Vault 使用随机生成的 12-byte IV 及 AES-256-GCM 算法进行加密，生成密文与 16-byte 认证标签（Auth Tag）。
- **原子替换写入（Atomic Write）**：写入时先将加密密文写入临时的 `.tmp` 文件并强制刷新（fsync），校验无误后通过重命名（rename）原子覆盖原数据文件，防止写入中断造成文件损坏。
- **项目目录边界**：会话只在 Vault 中保存工作目录的绝对路径字符串。工作目录内的源码、依赖、Git 数据和其他项目文件不会复制进 Vault，也不会被 AgentBox 加密或改写。
- **显式深备份例外**：只有用户在「数据与安全」中主动选择深备份并确认保存位置时，独立备份模块才会只读遍历会话工作目录并写入目标 ZIP；该流程不会把项目文件导入 Vault。
- **Agent 中断现场**：助手消息可保存结构化 `interruption` 元数据以及既有 `agentTrace`。应用重启后仍能识别失败回复、重放已完成工具结果并继续执行；运行时错误 UI 状态本身不作为恢复依据。

---

## 📦 数据结构与实体 Schema

Vault 内部存储结构定义于 [`src/electron/storage/app-repository.ts`](../src/electron/storage/app-repository.ts) 与 [`src/shared/types.ts`](../src/shared/types.ts)：

```typescript
interface VaultState {
  version: number
  preferences: AppSettings
  providers: StoredProvider[]
  models: ModelConfig[]
  conversations: StoredConversation[]
  skills: Skill[]
  mcpServers: McpServerConfig[]
}
```

### 资源配额与上限校验（Resource Quotas）
为了防止恶意输入或数据膨胀耗尽内存，存储层实施了严格的配额检查：
- `MAX_PROVIDERS`: 50 个
- `MAX_MODELS`: 200 个
- `MAX_CONVERSATIONS`: 1,000 个
- `MAX_MESSAGES_PER_CONVERSATION`: 2,000 条
- `MAX_SKILLS`: 100 个
- `MAX_SKILL_FILES_COUNT`: 每个技能最多 50 个文件
- `MAX_MCP_SERVERS`: 50 个
- `MAX_MCP_ARG_CHARACTERS`: 参数单项最大 8,192 字符

---

## 🧹 清除会话数据机制

在「设置 → 数据与安全」中提供了「清除全部会话数据」功能：
1. 主进程首先中止所有当前正在运行的流式请求。
2. 保持已配置的供应商、模型、API 密钥与自定义技能不变。
3. 清空 `conversations` 列表，并使用全新的随机 IV 重新加密落盘 Vault 文件。

---

## 📦 会话 ZIP 备份

「设置 → 数据与安全 → 导出加密备份」由主进程实现，renderer 只提交模式与一次性密码并接收结果，不会读取解密后的 Vault、API 密钥或主密钥。

- **浅备份**：导出全部会话。每个会话同时包含一份无损 JSON 和一份便于阅读的 Markdown；JSON 保留完整消息树、所有分支、附件、引用、用量、工具执行与 Agent trace。
- **深备份**：在浅备份基础上，递归加入所有会话引用的工作目录。相同真实路径只备份一次；空目录与符号链接会保留，符号链接不会被跟随到工作目录之外；普通特殊文件会跳过并记录在清单警告中。
- **密码策略**：密码可选，但 UI 明确建议设置。设置密码时，每个文件条目使用 WinZip AES-256 AE-2；密码只在当前 IPC 调用和归档过程的内存中存在，不写入设置或 Vault。标准 ZIP 的中央目录不会因此隐藏条目名称，所以深备份的目录与文件名仍可能可见。
- **明文语义**：JSON、Markdown 与工作目录文件写入 ZIP 前均保持原始明文；未设置密码的 ZIP 可被直接读取。设置密码后由 ZIP 条目加密提供静态保护。
- **排除内容**：不导出供应商 API 密钥、认证凭据、Vault 主密钥、加密 Vault 文件、服务商/模型/MCP/技能或应用设置。会话正文自身可能包含用户粘贴的敏感内容，因此备份始终应按敏感数据保管。
- **写入安全**：先在目标目录生成权限收紧的随机 `.partial` 文件，成功关闭 ZIP 后再替换用户确认的目标文件；失败时清理不完整文件。若目标位于被备份工作目录内，目标路径会从深备份内容中排除。

ZIP 根目录布局：

```text
manifest.json                         # 格式版本、模式、加密方式、计数与工作目录映射
README.txt                            # 面向用户的内容与安全说明
conversations/index.json             # 会话索引
conversations/conversation-0001.json # 无损会话数据
conversations/conversation-0001.md   # 可读会话文本
workspaces/workspace-0001/            # 仅深备份存在
```

清单格式当前为 `format: "agentbox-backup"`、`formatVersion: 1`。会话文件名使用序号而非标题，避免浅备份在未解密中央目录中暴露会话标题。
