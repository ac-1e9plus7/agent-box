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
