# 会话工作目录与开发运行时

## 会话工作目录

- 每个新会话必须保存一个绝对本地目录作为项目边界；旧版本遗留的无目录会话仍可读取，但继续发送前必须补选目录。
- Vault 只保存目录路径引用；目录中的项目文件不会被复制、封装或加密。只有用户批准的终端/工具操作才可能按其命令修改项目文件。
- 全局「新建对话」会打开工作目录面板，可显式复用当前目录、设置中的默认目录或最近使用目录，也可通过系统目录选择器指定其他目录。
- 侧边栏的每个工作目录分组提供快捷新建入口，直接在该目录下创建对话；相同目录只展示一次候选项。
- 顶栏目录按钮用于更换当前会话目录，或为旧版无目录会话补选目录；新建会话不再提供清空目录操作。
- 侧边栏按完整目录分组；相同末级目录名但不同完整路径不会合并。
- `agentbox_run_terminal` 以会话目录作为 `cwd`，Agent System Instructions 也会收到相同目录边界。
- Agent 模式内置 `agentbox_read_file` 与 `agentbox_write_file`：前者支持按行分段读取 UTF-8 文本，后者直接使用本机文件 API 创建、覆盖或追加文件，并可创建父目录。两者均拒绝绝对路径、`..` 穿越和符号链接。
- 写入代码或多行文本时优先使用工作区文件工具，避免 PowerShell/cmd/bash 对引号、换行、反引号和 `$` 的二次解释；终端工具主要用于编译、包管理和系统命令。

## 默认开发运行时

在「设置 → 开发运行时」中配置并检测：

- **JDK**：自动使用 `JAVA_HOME/bin/java` 或 PATH 中的 `java`；指定模式填写 JDK 根目录。
- **Go**：自动使用 `GOROOT/bin/go` 或 PATH 中的 `go`；指定模式支持 Go 可执行文件和 GOROOT。
- **PHP**：自动使用 PATH 中的 `php`，或指定 CLI 可执行文件。
- **Python**：
  - 自动：工作目录 `.venv` → `venv` → `VIRTUAL_ENV` → `CONDA_PREFIX` → 系统 Python 3。
  - 系统：指定或自动探测系统解释器。
  - venv：Windows 使用 `<venv>/Scripts/python.exe`，macOS/Linux 使用 `<venv>/bin/python`。
  - Conda：输入有效的 `conda`/`conda.exe` 后自动读取环境列表并提供下拉选择，保存所选环境的实际 prefix 路径；仍兼容手动填写环境名称或绝对 prefix。
  - 自定义：直接指定 Python 可执行文件。

Windows 上可直接粘贴资源管理器复制的反斜杠路径（包括“复制文件地址”产生的外层双引号）；保存时会去除引号并存储原生规范化后的有效路径。Conda 环境在 Windows 使用 `<prefix>/python.exe`，与 venv 的 `Scripts/python.exe` 布局分开解析。

解析后的运行时目录会注入 Integrated terminal 的 PATH；JDK/Go 同时设置 `JAVA_HOME`/`GOROOT`，Python venv/Conda 设置 `VIRTUAL_ENV`/`CONDA_PREFIX`。环境变量中的 API Key、Token、密码等敏感项仍会在终端子进程启动前过滤。
