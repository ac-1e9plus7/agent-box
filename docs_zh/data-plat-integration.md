# data-plat 数据平台集成

> [English documentation](../docs/data-plat-integration.md)

AgentBox 可将一个 HTTP MCP 服务器配置为 data-plat 受治理连接，复用平台工具、精确确认和 AI 外发策略。配套 agentbox-data-skills 工程提供 8 个可导入技能，Skill 本身不授予执行权限。

## 配置

在 MCP 服务器编辑框选择 Remote HTTP，填入 MCP endpoint，勾选“使用 data-plat 受治理认证”。填写核心 API 基础地址（不含 /api/agent/v1）、Agent ID 和当前平台用户的登录 JWT。默认本地核心为 http://localhost:8080，MCP 为 http://localhost:8081/mcp；远程必须 HTTPS。API 地址拒绝 userinfo、query 和 fragment。

DataPlatConfig 存在 McpServerConfig.dataPlat：apiBaseUrl、agentId、loginToken。登录令牌加密存入 Vault，Renderer 视图只返回遮罩，保持遮罩保存会复用原值；传 null 明确移除配置。登录令牌到期需用户在平台重新获取后更新；短期 OBO 按请求签发，不保存回服务器配置。

本版本支持平台内建 HMAC OBO 签发，企业 JWKS 外部发行器需要专用适配。控制请求遵循代理、禁止重定向，最长 15 秒、最大 256 KiB；远程 MCP 请求保留 60 秒工具预算和取消信号。连接测试同样应用地址约束，不允许用未保存配置绕过 HTTPS 要求。

## 执行

Gateway 为每个请求创建 DataPlatSession，保存本轮真实 query_plan/report_plan。query_run/report_run/query_cancel 必须获得平台精确确认，Full Access 也不会跳过。确认卡的参数包含 serverPlan，展示服务端 normalizedQuery、资产名称、来源、检查、预算、TTL 和有效执行参数。

审批对象仅在主进程存活且只能用一次，绑定服务器、工具、参数和包含凭据的配置指纹。批准后调用 confirmations，再获取审批绑定 OBO；服务端返回参数必须与批准的有效参数相同。计划到期或配置变化会拒绝执行。每次操作独立 MCP client，绝不通过共享 headers 切换审批 token。

所有 token、确认令牌和供应商 key 均不进入模型或事件。代理错误只回显受控提示；实际数据仍由平台的 scope、领域权限、plan/run 与 AI 策略校验。适配器不开放治理写 API、任意 SQL 或通用认证 HTTP。

## 执行日志和取消

Vault.dataPlatOperations 保存最多 1000 条紧凑引用，不含结果、凭据、SQL 或过滤值。确认后、派发前原子写入；写失败不派发。相同会话/服务器身份/工具/planId 再次 run 会查询原 executionId，不因 pageSize 或模型 call ID 变化创建新执行。

新写入回收超过 24 小时的记录；删除会话或清空历史同时清理引用。日志是恢复索引，平台仍保存业务审计。写入后发送前崩溃可能留下尚未执行的引用；不会自动补跑，需用户明确新计划与确认。重复取消恢复已有状态；accepted/CANCEL_REQUESTED 不表示 CANCELLED，停止生成不表示 JDBC 已终止。

## 历史与恢复

受治理数据会话不恢复旧图 checkpoint，不使用 provider native continuation；新请求保留用户输入，移除所有旧 assistant 派生正文、推理、附件、工具结果及摘要，重新授权读取最近最多 5 条执行日志引用并去重。失败只保留 executionId 和 unavailable，不填回旧缓存。

data-plat-context 事件在派生回答保存 governedData 标记，随 Vault/备份保存，普通更新不能取消已有标记。即使服务器后来删除、停用或只有摘要而无工具调用，仍保持保守回放。旧版本通过平台工具名识别兼容。只影响给模型的新输入，不删除已显示的本地历史，也无法撤回已经外发的数据。

用户自行复制到新输入的内容无法追溯识别。混合会话中旧 assistant 上下文会丢失，这是首版保守策略。恢复结果来自当前 query_status 及平台 AI 策略，不把过期、裁剪或拒绝当作零行。

## Schema、技能和测试

参数校验按 $schema 分流：2020-12 使用 Ajv2020；无声明和 draft-07 使用既有 Ajv；未知方言拒绝。编译独立副本，避免对象修改后错误复用内部缓存。普通 MCP 的其它行为保持原样。

技能 JSON 固定 ID 支持更新；ZIP 不保留工程 ID。规划合集的报表入口不执行，完整集合包含取数和恢复。平台执行开关、权限与 AI 策略仍需正确配置。

相关源码：src/electron/mcp/data-plat-session.ts、data-plat-state.ts、mcp-manager.ts、tool-policy.ts、Gateway、AppRepository、DataPlatFields 和 useChatStream。相关测试：data-plat-schema、session、repository、ui、gateway。HTTP 测试使用真实 SDK 与本地 fixture；平台 Java 隔离测试和真实业务模型验收是另外的层次。

修改后执行 pnpm check、pnpm build；跨仓库同步更新技能工程的中文接入文档、契约和对应测试。外部发行器与实际业务模型上线验收不由离线测试替代。
