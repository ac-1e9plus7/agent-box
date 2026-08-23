# 4. Agent Skills System

> [中文文档](../docs_zh/skills-system.md)

An AgentBox Skill is a reusable collection of local instructions, Markdown references, and reference scripts. When activated, relevant content is added to the Agent's System Instructions. Importing, enabling, or activating a Skill never executes its script files automatically.

> **Trust boundary:** Skill content influences high-priority model behavior. Import and enable only trusted Skills. Although scripts are not executed automatically, Skill instructions can still ask the model to invoke code, terminal, file, or MCP tools. Those calls remain subject to tool allowlists, argument validation, and approval policy.

---

## Multi-file Format and Storage Model

The recommended package structure is:

```text
skill-package/
├── SKILL.md                 # Entry instructions; may include simple YAML frontmatter
├── references/              # Markdown reference material
│   ├── patterns.md
│   └── standards.md
└── scripts/                 # Stored only as reference source
    ├── runner.py
    └── validator.sh
```

Stored files are classified as `markdown`, `python`, `shell`, or `other`:

- When a Skill is activated, the Gateway injects its entry document, other Markdown files, and Python and Shell files. Script sections are explicitly labeled as reference code that has not been executed.
- `other` files are preserved and included in ZIP import/export, but are not currently added to the Agent's System Instructions.
- A Skill can contain at most 50 files, each containing no more than 500,000 characters. A path is limited to 255 characters, must be relative to the package, and cannot be absolute or contain `..` traversal. The Vault can hold at most 500 Skills in total, including built-ins.
- Built-in Skills cannot be deleted but can be disabled. Resetting default Skills restores their bundled content while preserving custom Skills.

Storage validation and migration are implemented in [`src/electron/storage/app-repository.ts`](../src/electron/storage/app-repository.ts).

---

## ZIP and Text Import/Export

[`src/shared/skill-zip.ts`](../src/shared/skill-zip.ts) uses `fflate` to read and write regular ZIP archives in the Renderer:

- **Export** preserves every Skill file. If the entry document has no frontmatter, export adds `name`, `description`, `version`, `author`, and `icon` metadata.
- **ZIP import** ignores `__MACOSX` and `.DS_Store`. If every file shares one top-level directory, that directory is stripped. Entry-file precedence is a manifest-specified path, `SKILL.md`, `README.md`, the first Markdown file, then the first file.
- Metadata first comes from a root `skill.json` or `manifest.json`. Without a manifest, the importer reads simple frontmatter from the entry document. Missing values then fall back to its H1, first paragraph, or defaults.
- **JSON text import** in Settings accepts one object or an array. Each item requires a non-empty `name` and `systemPrompt`, and may include `files`, `entryFile`, author, and version fields.
- Newly imported Skills are enabled by default and still pass the main process's file-count, path, and content-size validation.

A Skill ZIP archive and a conversation backup are distinct formats. Conversation backups are generated as streams by [`src/electron/backup/backup-export.ts`](../src/electron/backup/backup-export.ts) and can use WinZip AES-256. A Skill ZIP archive contains no Vault keys, passwords, or external working directories and has no password-protection feature.

---

## Five Built-in Skills

[`src/electron/storage/default-skills.ts`](../src/electron/storage/default-skills.ts) currently provides:

1. **Code Execution and Algorithms** (`code-interpreter`): programming, debugging, algorithms, complexity, tests, and performance optimization.
2. **Data Analysis and Spreadsheet Visualization** (`data-analyst`): CSV/Excel data, statistics, trend analysis, and chart conventions.
3. **Research Extraction and Long-form Reading** (`web-extractor`): information extraction from PDFs, web pages, papers, research reports, and long documents.
4. **Professional Translation and Localization** (`translator-polyglot`): translation, localization, and terminology consistency.
5. **Prompt Engineering Expert** (`prompt-optimizer`): system prompts, task instructions, roles, and structured templates.

Bundled names, descriptions, and documents follow the application's selected language. User changes to enabled state and customized content are preserved.

---

## Gateway Routing and Progressive Loading

Skills participate in routing only in **Agent mode**:

1. The Gateway reads every Skill with `enabled: true` and builds a lightweight catalog from names, IDs, and descriptions.
2. Conversation-pinned `skillIds` take precedence. Otherwise, routing first recognizes `$id`, `@id`, a complete ID delimited in the query, or a full Skill name.
3. Without an explicit match, retrieval examines the latest 3 user messages. A text attachment contributes at most its first 2,000 characters; a binary attachment contributes only its file name and MIME type. At most 2 Skills meeting the threshold are activated automatically.
4. Only the activated Skills' entry documents, Markdown references, and Python/Shell reference source are added to System Instructions, avoiding the cost and conflicts of loading everything at once.
5. If initial routing is insufficient, the model can call the read-only `agentbox_load_skill` tool with a catalog `skill_id` to load another enabled Skill. The tool never executes scripts and does not require approval.
6. Automatic, explicit, and model-requested activation all emit a `skill-activated` event, and the Renderer records the activation source.

Retrieval is implemented in [`src/electron/api/skill-retriever.ts`](../src/electron/api/skill-retriever.ts); prompt assembly and on-demand loading are in [`src/electron/api/gateway.ts`](../src/electron/api/gateway.ts).

---

## Script and Tool Execution Boundaries

### Reference scripts are not executed code

Files such as `scripts/*.py`, Shell files, and code blocks are reference implementations for the model to read. AgentBox does not write them into the working directory or launch those files directly. The model may claim actual execution only after it explicitly calls an execution tool and receives a successful result.

### `agentbox_run_code`

The Gateway exposes the built-in code runner whenever at least one enabled Skill contains a Python file. It receives short source code supplied in the model's tool-call arguments; it does not automatically run a script from the Skill package:

- JavaScript runs in a separate Worker and `vm` context exposing only a constrained `console` and `input`. String-based code generation and WebAssembly are disabled, and Worker memory limits are applied.
- Python uses the interpreter resolved by **Settings → Developer Runtimes**, with fallback to an available local Python 3. Its wrapper uses `-I`, a minimal environment, constrained builtins, and a standard-library allowlist, and rejects file opening, dynamic execution, and double-underscore attribute access.
- Source is limited to 100,000 characters and output to 200,000 characters. The default timeout is 8 seconds; a call may request between 0.5 and 20 seconds.
- The code runner is a risk-reducing constrained environment, not a complete operating-system sandbox. Every run requires user approval except under Full Access.

### Workspace files and the integrated terminal

- `agentbox_read_file` and `agentbox_write_file` use native file APIs for UTF-8 files inside the conversation working directory and do not pass content through Shell quoting. Writes require approval under the default policy.
- `agentbox_run_terminal` invokes compilers, package managers, or system commands through the user's configured cross-platform Shell. It can produce arbitrary system side effects, so every command requires approval except under Full Access.
- The terminal starts in the conversation directory, but it is not directory-sandboxed. Prefer the boundary-enforced workspace file tools when creating source code or multiline text.

See [Conversation Working Directories and Developer Runtimes](workspaces-and-runtimes.md) for runtime and path rules, and [MCP Integration and Intelligent Tool Retrieval](mcp-integration.md) for the shared approval policy.
