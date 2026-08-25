# 8. Conversation Working Directories and Developer Runtimes

> [中文文档](../docs_zh/workspaces-and-runtimes.md)

A working directory gives each conversation project context. It determines the enforced root for built-in file tools, the integrated terminal's initial `cwd`, and the location used to discover project-level Python environments. It is not an operating-system sandbox shared by every tool.

---

## Conversation Working Directories

- Every new conversation must store an absolute local directory. Legacy conversations without one remain readable, but a directory must be selected before sending another message.
- The Vault stores only a normalized directory-path reference. Creating a conversation does not copy, package, or encrypt project files.
- The global **New conversation** dialog can reuse the current directory, the default from Settings, or a recently used directory (up to 6 displayed), and can open the system directory picker. Candidates are deduplicated by normalized full path.
- The sidebar groups conversations by full path while displaying the last path component as the label. Different paths with the same final directory name remain separate. Each group has a shortcut for starting a conversation in that directory.
- The directory control in the top bar can change the current conversation's directory or assign one to a legacy conversation. Changing it updates only the reference and does not move project files.
- Agent System Instructions receive the current directory and direct the model to keep relative paths and project operations within that boundary.

### Deep backups

Only when the user explicitly selects a deep backup does [`src/electron/backup/backup-export.ts`](../src/electron/backup/backup-export.ts) walk every working directory referenced by a conversation in read-only mode:

- Real paths are deduplicated, so the same directory is archived once while retaining the conversations that reference it.
- Empty directories are preserved. A symbolic link is stored as a link entry, and its target is not followed.
- The backup output and temporary output paths are excluded from traversal to avoid archiving the file being generated.
- This does not change the normal Vault model, which continues to store path references only.

---

## Workspace File Tools and Terminal Boundaries

### `agentbox_read_file` / `agentbox_write_file`

These tools use the working directory's `realpath` as their root and operate through native APIs in the main process:

- They accept relative paths only and reject drive-letter paths, POSIX absolute paths, UNC paths, empty paths, NUL/newline characters, and every `..` segment.
- Existing symbolic links in the path are rejected. After creating parent directories, the path is checked again to prevent link-based escapes.
- Reads support regular UTF-8 files up to 2 MiB. A read returns 400 lines by default and at most 2,000 lines; tool output is limited to about 96,000 characters and includes the next line number when more data remains.
- Writes support `create`, `overwrite` (the default), and `append`, and create parent directories by default. One write is constrained by both 100,000 characters and 512 KiB.
- Under the default approval policy, reads can run automatically and writes require approval. Full Access skips approval but does not relax any path or size restriction.

Prefer the file tools for source code, configuration, and multiline text so PowerShell, cmd, or Bash cannot reinterpret quotes, newlines, backticks, or `$`. The implementation is in [`src/electron/api/workspace-files.ts`](../src/electron/api/workspace-files.ts).

### `agentbox_run_terminal`

The terminal process starts with the conversation directory as its `cwd`, but it has **no filesystem sandbox**. An approved command can use absolute paths or `..`, access files outside the directory, launch child processes, and use the network. Consequently:

- Every model-generated command requires approval except under Full Access.
- The working directory is the default context and a prompt boundary, not enforced Shell isolation.
- Full Access should be used only with trusted models, commands, and projects.

---

## Integrated Terminal Shell

The Shell is selected under **Settings → General → Integrated terminal shell**.

### Automatic discovery order

- **Windows**: `pwsh.exe` → `powershell.exe` → `ComSpec`/`COMSPEC` → `cmd.exe`.
- **macOS**: the `SHELL` environment variable → `/bin/zsh` → `/bin/bash` → `/bin/sh`.
- **Linux/other POSIX platforms**: the `SHELL` environment variable → `/bin/bash` → `/usr/bin/bash` → `/bin/zsh` → `/usr/bin/fish` → `/bin/sh`.

Each candidate is tested with a no-op command and a 2-second timeout, and the first working result is cached. Custom mode accepts an executable name or path plus one launch argument per line. PowerShell, cmd, Fish, and common POSIX shells receive the appropriate command flag automatically. Other custom shells can use a `{command}` placeholder in a launch argument.

Execution limits:

- A command is limited to 100,000 characters and has a 20-second default timeout. An Agent tool call can request between 0.5 and 60 seconds.
- stdout and stderr are collected together, up to 500,000 characters.
- Before launch, environment variables whose names contain patterns such as token, secret, password, API key, authorization, credential, cookie, or private key are filtered out.
- The process uses a hidden window and accepts a cancellation signal. See [`src/electron/api/terminal-shell.ts`](../src/electron/api/terminal-shell.ts).

---

## Developer Runtime Resolution

JDK, Go, PHP, and Python are configured and tested individually under **Settings → Developer Runtimes**. Resolution is implemented in [`src/electron/api/runtime-environments.ts`](../src/electron/api/runtime-environments.ts).

| Runtime | Automatic mode                                   | Custom mode                                                             |
| ------- | ------------------------------------------------ | ----------------------------------------------------------------------- |
| JDK     | Tries `JAVA_HOME/bin/java`, then `java` on PATH. | Takes a JDK root and resolves `<home>/bin/java`.                        |
| Go      | Tries `GOROOT/bin/go`, then `go` on PATH.        | Accepts a Go executable directly; if empty, resolves `<GOROOT>/bin/go`. |
| PHP     | Tries `php` on PATH.                             | Takes a PHP CLI executable.                                             |

JDK is probed with `java -version`, Go with `go version`, and PHP with `php -v`. Absolute JDK, Go, and PHP candidates are checked for existence before launch, and their probe process has a 3-second default timeout.

### Python modes

| Mode                   | Resolution rule                                                                                                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Automatic**          | Working-directory `.venv` → `venv` → `VIRTUAL_ENV` → `CONDA_PREFIX` → a retained custom executable, if present, or system candidates.                                                 |
| **System**             | Uses the entered executable, or platform system candidates when the field is empty.                                                                                                   |
| **venv**               | Uses `<venv>/Scripts/python.exe` on Windows or `<venv>/bin/python` on macOS/Linux.                                                                                                    |
| **Conda**              | Resolves an absolute prefix directly, or looks up an environment name through `conda env list --json`. Uses `<prefix>/python.exe` on Windows or `<prefix>/bin/python` on macOS/Linux. |
| **Custom interpreter** | Probes the entered Python executable directly.                                                                                                                                        |

System candidate order is `python.exe` → `python3.exe` → `py.exe -3` on Windows and `python3` → `python` on macOS/Linux. Resolution uses `--version` to confirm executability but does not separately reject Python 2, so select Python 3 explicitly, especially for `agentbox_run_code`.

### Conda environment discovery

- The Conda executable defaults to `conda`, or it can be the full path to `conda`/`conda.exe`.
- In Conda mode, the UI runs `conda env list --json` with a 5-second timeout and parses `root_prefix`, `active_prefix`, and deduplicated `envs` entries.
- After successful discovery, the list first matches the existing configuration, otherwise selects the active environment or the first environment, and stores its actual prefix path. If discovery fails, a name or absolute prefix can still be entered manually.
- Python is started directly from the resolved prefix; AgentBox does not invoke `conda activate` or `conda run`.

On Windows, paths copied from File Explorer can be pasted with their surrounding double quotes. [`src/electron/runtime-path.ts`](../src/electron/runtime-path.ts) removes those quotes and normalizes the path for the host platform. The Windows Conda interpreter at the prefix root must remain distinct from the venv `Scripts` layout.

---

## How Runtimes Affect the Terminal and Code Runner

Before each terminal command, AgentBox resolves all four runtime categories and builds an environment:

- Deduplicated directories containing the resolved executables are prepended to `PATH`.
- `JAVA_HOME` and `GOROOT` are set when a usable runtime root is available.
- `VIRTUAL_ENV` is set for a Python venv, while `CONDA_PREFIX` is set for Conda.
- The terminal's sensitive-name environment filter is applied afterward.

The Python branch of `agentbox_run_code` reuses the same Python resolution result but does not inherit the complete terminal environment. It invokes the selected interpreter with `-I`, a minimal environment, and the constrained wrapper. The JavaScript branch runs in an independent Worker and does not use these developer runtimes.

See [Agent Skills System](skills-system.md) for when Skill scripts can be executed, and [MCP Integration and Intelligent Tool Retrieval](mcp-integration.md) for the shared tool-approval rules.
