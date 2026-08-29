# 8. 会话工作目录与开发运行时

> [English documentation](../docs/workspaces-and-runtimes.md)

工作目录为每个会话提供项目上下文，并决定内置文件工具的安全根目录、集成终端的初始 `cwd` 以及项目级 Python 环境的探测位置。它不是所有工具共享的操作系统沙箱。

---

## 会话工作目录

- 每个新会话必须保存一个绝对本地目录；旧版本遗留的无目录会话仍可读取，但再次发送前必须补选目录。
- Vault 只保存规范化后的目录路径引用。项目文件不会因创建会话而被复制、封装或加密。
- 全局“新建对话”面板可复用当前目录、设置中的默认目录或最多 6 个仍被现有会话引用的最近工作目录，也可打开系统目录选择器。该列表由保留的会话路径重建，并不是独立持久化的目录历史。候选项按规范化完整路径去重。
- 侧边栏按完整路径分组，标签只显示末级目录名；同名但路径不同的目录不会合并。每组都有在该目录中新建对话的快捷入口。
- 顶栏目录按钮可更换当前会话目录，或为旧版会话补选目录。更换目录只更新引用，不迁移项目文件。
- Agent System Instructions 会收到当前目录并要求把相对路径和项目操作限制在该边界。

### 深备份

只有用户显式选择“深备份”时，[`src/electron/backup/backup-export.ts`](../src/electron/backup/backup-export.ts) 才会只读遍历所有会话引用的工作目录：

- 使用真实路径去重，相同目录只归档一次，同时记录引用它的会话。若工作目录解析后位于当前 AgentBox user-data 根目录之内，会拒绝该深备份。
- 空目录会保留；在已解析工作目录根下遇到的符号链接会以链接条目归档，不跟随其目标；若工作目录根本身是符号链接，会先解析到目标后再校验和去重。
- 备份输出文件、临时路径和当前 AgentBox user-data 根目录会从遍历中排除，避免把正在生成的归档或活动应用数据再次打包。
- 任一被引用的工作目录根缺失、不可读或不是目录时，整个深备份会在写入归档前失败；应改用浅备份或修正过期路径。
- 这不会改变 Vault 仍只保存路径引用的日常存储模型。

---

## 工作区文件工具与终端边界

### `agentbox_read_file` / `agentbox_write_file`

这两个工具以工作目录的 `realpath` 作为根，并在主进程中直接处理文件：

- 只接受相对路径，拒绝盘符绝对路径、POSIX 绝对路径、UNC 路径、空路径、NUL/换行和任何 `..` 段。
- 拒绝路径中已存在的符号链接；创建父目录后会再次检查，防止通过链接越过根目录。
- 读取仅支持 UTF-8 普通文件，文件上限 2 MiB；默认读取 400 行，单次最多 2,000 行，工具结果最多约 96,000 字符并提供续读行号。
- 写入支持 `create`、`overwrite`（默认）和 `append`，默认自动创建父目录。单次内容同时受 100,000 字符和 512 KiB 限制。
- 默认审批策略下，读取可自动执行，写入需要批准；Full Access 只跳过审批，不会放宽上述路径和大小限制。

写入源码、配置或多行文本时应优先使用文件工具，避免 PowerShell、cmd、Bash 对引号、换行、反引号和 `$` 再次解释。实现见 [`src/electron/api/workspace-files.ts`](../src/electron/api/workspace-files.ts)。

### `agentbox_run_terminal`

终端进程以会话目录作为初始 `cwd`，但**没有文件系统沙箱**。获批命令可使用绝对路径或 `..`、访问目录外文件、启动子进程和访问网络。因此：

- 除 Full Access 外，每条模型生成的命令都必须审批。
- 工作目录是默认上下文和提示词边界，不是对 Shell 的强制目录隔离。
- Full Access 只应与可信模型、命令和项目一起使用。

---

## Integrated terminal Shell

Shell 在“设置 → 通用 → Integrated terminal shell”中选择。

### 自动探测顺序

- **Windows**：`pwsh.exe` → `powershell.exe` → `ComSpec`/`COMSPEC` → `cmd.exe`。
- **macOS**：环境变量 `SHELL` → `/bin/zsh` → `/bin/bash` → `/bin/sh`。
- **Linux/其他 POSIX**：环境变量 `SHELL` → `/bin/bash` → `/usr/bin/bash` → `/bin/zsh` → `/usr/bin/fish` → `/bin/sh`。

候选 Shell 会通过 2 秒的空操作命令测试，并缓存第一个可用结果。指定模式接受最长 2,000 字符的可执行文件名或路径，以及最多 64 个、每项最长 4,096 字符的逐行启动参数。PowerShell、cmd、Fish 和常见 POSIX Shell 会自动添加各自的命令参数；其他自定义 Shell 可在启动参数中使用 `{command}` 占位符。运行时路径输入最长 4,096 字符，并拒绝 NUL/换行。

执行边界：

- 命令最长 100,000 字符，默认超时 20 秒；Agent 工具可请求 0.5–60 秒。
- stdout 与 stderr 合并记录，最多保留 500,000 字符。
- 启动前会过滤名称包含 token、secret、password、API key、authorization、credential、cookie、private key 等模式的环境变量。
- 进程使用隐藏窗口并接受取消信号。实现见 [`src/electron/api/terminal-shell.ts`](../src/electron/api/terminal-shell.ts)。

---

## 开发运行时解析

在“设置 → 开发运行时”中配置 JDK、Go、PHP 与 Python，并可分别执行版本探测。解析实现见 [`src/electron/api/runtime-environments.ts`](../src/electron/api/runtime-environments.ts)，并按运行时类型、设置、Python 工作目录和平台缓存。新建/删除项目环境、改变相关进程环境变量或安装运行时后，可能需要变更配置键、等待缓存淘汰或重启应用才会重新探测。

| 运行时 | 自动模式                                               | 指定模式                                                 |
| ------ | ------------------------------------------------------ | -------------------------------------------------------- |
| JDK    | 先尝试 `JAVA_HOME/bin/java`，再尝试 PATH 中的 `java`。 | 填写 JDK 根目录，解析 `<home>/bin/java`。                |
| Go     | 先尝试 `GOROOT/bin/go`，再尝试 PATH 中的 `go`。        | 可直接填写 Go 可执行文件；留空时使用 `<GOROOT>/bin/go`。 |
| PHP    | 尝试 PATH 中的 `php`。                                 | 填写 PHP CLI 可执行文件。                                |

JDK 使用 `java -version`，Go 使用 `go version`，PHP 使用 `php -v`；绝对路径在启动前会先检查是否存在，探测进程默认 3 秒超时。

### Python 模式

| 模式           | 解析规则                                                                                                                                            |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **自动**       | 当前工作目录 `.venv` → `venv` → `VIRTUAL_ENV` → `CONDA_PREFIX` → 已保留的指定 executable（若有）或系统候选。                                        |
| **系统**       | 使用填写的 executable；留空时尝试平台系统候选。                                                                                                     |
| **venv**       | Windows 使用 `<venv>/Scripts/python.exe`，macOS/Linux 使用 `<venv>/bin/python`。                                                                    |
| **Conda**      | 绝对 prefix 直接解析；环境名称通过 `conda env list --json` 查找后解析。Windows 使用 `<prefix>/python.exe`，macOS/Linux 使用 `<prefix>/bin/python`。 |
| **指定解释器** | 直接探测填写的 Python 可执行文件。                                                                                                                  |

系统候选顺序为：Windows `python.exe` → `python3.exe` → `py.exe -3`；macOS/Linux `python3` → `python`。解析器通过 `--version` 验证可执行性，但不会单独拒绝 Python 2，因此应明确选择 Python 3，尤其是供 `agentbox_run_code` 使用时。

### Conda 环境发现

- Conda 可执行文件默认是 `conda`，也可填写 `conda`/`conda.exe` 的完整路径。
- UI 在 Conda 模式下调用 `conda env list --json`，5 秒超时，解析 `root_prefix`、`active_prefix` 和去重后的 `envs`。
- 成功发现后，列表优先匹配当前配置，并保存该环境的实际 prefix 路径。非空但未匹配的配置会保留，供用户手动修正；只有空配置才会回退选择活动环境或首个环境。发现失败时仍可手动填写环境名称或绝对 prefix。
- 运行 Python 时直接启动该 prefix 内的解释器，不使用 `conda activate` 或 `conda run`。

Windows 可直接粘贴资源管理器复制的带外层双引号路径；[`src/electron/runtime-path.ts`](../src/electron/runtime-path.ts) 会去除引号并按本机格式规范化。Conda 的 Windows 根目录解释器布局与 venv 的 `Scripts` 布局必须区分。

---

## 运行时如何影响终端与代码运行器

每次终端执行前，会读取四类运行时的缓存解析结果并构造环境：

- 把已解析可执行文件所在目录去重后置于 `PATH` 前端。
- 为 JDK/Go 设置 `JAVA_HOME` / `GOROOT`（有可用根目录时）。
- 为 Python venv 设置 `VIRTUAL_ENV`，为 Conda 设置 `CONDA_PREFIX`。
- 随后再执行终端环境变量敏感名称过滤。

`agentbox_run_code` 的 Python 分支复用同一 Python 解析结果，但不会继承完整的终端环境；它用所选解释器、`-I` 和最小环境运行受限包装器。JavaScript 分支在独立 Worker 中运行，不使用上述开发运行时。

有关 Skill 脚本何时可以执行，见 [Agent 技能系统](skills-system.md)；有关统一工具审批，见 [MCP 外部工具协议与智能检索](mcp-integration.md)。
