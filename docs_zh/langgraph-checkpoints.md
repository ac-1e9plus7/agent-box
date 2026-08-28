# LangGraph 加密 Checkpoint

> English: [Encrypted LangGraph Checkpoints](../docs/langgraph-checkpoints.md)

AgentBox 在 Vault 目录内的加密 record sidecar 之上实现 `BaseCheckpointSaver<number>`。Sidecar 保存本机 LangGraph 执行状态，不把高频 checkpoint 字段加入主 `VaultState` JSON 文档。

## 存储架构

主 Vault 仍是单个 AES-256-GCM 加密文档。Checkpoint 使用独立记录命名空间，因为 LangGraph 在每个 superstep 中可能多次写 checkpoint 和 pending write；如果写入 `VaultState`，每个图边界都需重写完整会话 Vault。

```text
Electron safeStorage
        |
操作系统封装的 Vault 主密钥
        |
        +-- 现有 AES-256-GCM Vault 文档
        +-- HKDF checkpoint data key -> 加密 record payload
        +-- HKDF checkpoint name key -> HMAC scope/record 名称
```

物理布局：

```text
<userData>/vault/agent-checkpoints-v1/
  scope-<hmac(thread_id)>/
    record-<hmac(logical_record_key)>.enc
```

单 thread 的逻辑记录包含加密 manifest、checkpoint/metadata、pending write、一份基础消息 snapshot，以及消息 delta 或回退 snapshot artifact。Conversation、message、checkpoint、task 和 channel ID 不出现在文件名中。

## Record 加密

`EncryptedRecordNamespace` 使用 HKDF-SHA-256 派生独立的 256-bit data key 和文件名 key。每条记录使用：

- AES-256-GCM；
- 新的随机 12-byte IV；
- 16-byte authentication tag；
- 包含存储格式、namespace、HMAC scope 和 HMAC record handle 的记录级 AAD；
- 带 format version 1 的二进制 `ABRN` envelope；
- 仅密文的临时文件、`0600` 权限和原子 rename。

Record 层在读取前拒绝超过 32 MiB 的文件，检测认证失败，并在所属 `EncryptedStore` 销毁时清零派生密钥。Electron `safeStorage` 不可用时没有明文回退。

## 分层

### 加密 record namespace

[`encrypted-record-namespace.ts`](../src/electron/storage/encrypted-record-namespace.ts) 负责密码学、HMAC handle、有界文件读取、原子写入、scope 删除、临时文件清理和加密损坏隔离。

### Checkpoint repository

[`checkpoint-repository.ts`](../src/electron/storage/checkpoint-repository.ts) 负责 manifest、配额计量、pending-write 索引、snapshot/artifact、生命周期 metadata、整 thread 回收和会话关联删除。Repository mutation 通过 Promise queue 串行化，应用单实例锁负责跨进程写者排他。

### LangGraph Saver 适配器

[`agentbox-checkpoint-saver.ts`](../src/electron/storage/agentbox-checkpoint-saver.ts) 负责 LangGraph config 和 serializer 语义。

| 方法                                             | 行为                                                                                                      |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `getTuple(config)`                               | 返回指定或最新 checkpoint、metadata、parent config 和 pending writes；缺失 `thread_id` 时返回 `undefined` |
| `list(config, options)`                          | 支持 thread/namespace/checkpoint、`before`、metadata 精确过滤、ID 降序和 limit                            |
| `put(config, checkpoint, metadata, newVersions)` | 校验 checkpoint v4，通过 `this.serde` 序列化，保存 parent relation，返回新 checkpoint config              |
| `putWrites(config, writes, taskId)`              | 使用 `(taskId, WRITES_IDX_MAP[channel] ?? inputIndex)`；普通索引 first-write-wins，特殊负索引可替换       |
| `deleteThread(threadId)`                         | 幂等删除 thread manifest、checkpoint、write、snapshot 和 artifact                                         |

继承的 parent-chain `getDeltaChannelHistory()` 仍可用。AgentBox 没有为 LangGraph 尚处于 beta 的 delta-channel 存储格式实现自定义路径。

## 消息 snapshot 与 delta artifact

普通 LangGraph last-value checkpoint 会重复完整 channel value。如果每个 Agent turn 都重复 `Message[]`，存储会近似二次方增长。

Saver 在序列化前把 `channel_values.messages` 以及初始/待应用 `messages` write 替换为已认证 AgentBox 引用：

1. 首个消息数组保存为 thread snapshot。
2. 后续数组与 parent materialization 比较。
3. 可以用删除 ID 和变更/追加消息精确表示时，保存 delta artifact。
4. 无法精确 replay 时，保存有界 snapshot artifact。
5. `getTuple()` 在返回 LangGraph 前递归认证并具象化引用链。

引用链上限为 512。Replay 校验 provider message ID 和精确顺序，不接受有损 delta。

## Thread 身份与 descriptor

Renderer 在启动 Agent 响应前创建 `responseMessageId`。Gateway 从 conversation/response ID 派生固定长度 thread ID，`EncryptedRecordNamespace` 再把逻辑 ID 转为 HMAC 目录名。

加密 manifest descriptor 包含：

- conversation 和 response message ID；
- Runtime 版本；
- 已清洗基础上下文、model ID 和 API format 的 SHA-256 digest；
- `active`、`interrupted`、`completed` 或 `abandoned` 生命周期；
- 是否有已持久化 `agentTrace` 回退；
- 创建、更新和访问时间。

启动时，进程内 `active` thread 在有 trace 回退时改为 `interrupted`，否则改为 `abandoned`，避免崩溃进程留下永久受保护的 active 记录。

## 恢复与 `agentTrace`

`agentTrace` 继续保存在 Assistant 消息中，并进入会话备份。它是 Responses reasoning item、Anthropic thinking signature、tool call 和 tool result 的协议无关回放账本。

Gateway 只在以下条件全部成立时恢复原 graph thread：

- conversation 和中断 response ID 匹配；
- 上下文 digest 与当前基础分支匹配；
- 中断原因是限流、网络、超时或 API 错误。

Checkpoint 缺失或过期时，从现有已校验 provider-history/`agentTrace` 路径创建新 thread。取消、输出上限、工具上限和副作用不确定状态也使用这条路径，避免盲目重放 tool node。

Checkpoint 损坏和 I/O 失败会作为 checkpoint 错误上报，不会静默当作有效 trace 回退。

## 配额

Checkpoint 配额与会话配额独立。

| 维度                              |    上限 |
| --------------------------------- | ------: |
| Thread                            |     256 |
| 单 thread namespace               |       8 |
| 单 thread checkpoint              |     512 |
| 单 checkpoint pending write       |   1,024 |
| 序列化 checkpoint value           |   2 MiB |
| 序列化 metadata                   | 256 KiB |
| 单 pending-write value            |   1 MiB |
| 单 checkpoint pending-write value |   8 MiB |
| 基础消息 snapshot                 |  24 MiB |
| 单消息 artifact                   |   4 MiB |
| 单 thread                         |  64 MiB |
| 完整 checkpoint namespace         | 256 MiB |
| Manifest                          |   2 MiB |
| 单加密 record 文件                |  32 MiB |

Manifest 提交前按预计加密 record 大小计量，包括 envelope 开销和序列化 wrapper。已超限 thread 仍可读取和删除，但不能继续增长。

## 回收与删除

配额回收只删除完整非活跃 thread，不独立裁剪祖先 checkpoint 或 pending write。

回收顺序：

1. `abandoned` thread，最旧访问优先；
2. 清理失败遗留的 `completed` thread；
3. 有已校验 `agentTrace` 回退的 `interrupted` thread。

`active` thread 和没有 trace 回退的 interrupted thread 受保护。整 thread 回收仍无法满足 mutation 时，repository 抛出 `CheckpointQuotaError`。

生命周期删除：

- Agent 正常完成后删除 thread；
- provider 中断保留 thread；
- 成功恢复后删除复用 thread；
- 删除消息分支时，在保存破坏性会话 mutation 前删除被移除 Assistant ID 对应的 checkpoint thread；
- 删除会话时删除其所有 descriptor；
- 清除全部会话时，先清空 checkpoint namespace，再清空主 Vault 会话数组；
- Vault 重置包含 sidecar，因为它位于同一 Vault 目录下。

会话 ZIP 备份排除 checkpoint sidecar。可移植恢复继续依靠 `agentTrace`。

## 启动与故障恢复

Repository 初始化时：

- 删除原子写入中断留下的密文临时文件；
- 认证每个 manifest，不急切加载所有 checkpoint；
- 把损坏或缺失 manifest 的 scope 隔离到加密 `corrupt-*` 目录名下；
- 删除没有被有效 manifest 引用的加密 record；
- 重分类进程内 active 生命周期。

类型化 repository 错误区分无效输入、缺失记录、配额、损坏和 I/O。UI 错误只暴露本地化类别，不暴露解密记录或逻辑 ID。

## 隐私与可观测性

- 日志不包含逻辑 thread ID、消息内容、工具参数、checkpoint 字节或解密 manifest。
- 图调用前在 Electron 主进程中强制禁用 LangSmith/LangChain tracing，即使环境变量启用 tracing 也不上传。
- Renderer 没有 checkpoint 文件系统或 repository API。
- Provider key、代理凭据、MCP header 和进程环境不进入图状态。

## 测试覆盖

- `tests/encrypted-record-namespace.test.ts`：密文、HMAC 名称、篡改检测、删除和密钥销毁
- `tests/agentbox-checkpoint-saver.test.ts`：`MemorySaver` 对照、list、parent、write、配额、消息 artifact、损坏隔离和启动恢复
- `tests/checkpoint-lifecycle.test.ts`：分支、会话和清除全部删除
- `tests/gateway-mcp-loop.test.ts`：durable provider 失败恢复和过期 digest 回退
- `tests/langgraph-agent-runtime.test.ts`：图行为与环境 tracing 隔离
