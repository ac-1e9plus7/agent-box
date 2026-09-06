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

Stored text resources are classified as `markdown`, `python`, `shell`, or `other`:

- A newly saved Skill must designate an included Markdown document as its entry. When activated, the Gateway injects that entry document, other Markdown files, and Python and Shell files. Script sections are explicitly labeled as reference code that has not been executed.
- `other` resources are preserved as UTF-8 text in Skill storage and ZIP archives, but are excluded from System Instructions, lazy-resource loading, and fuzzy retrieval. They cannot become an entry document.
- A Skill can contain at most 50 files, each containing no more than 500,000 characters. A path is limited to 255 characters, is normalized to package-relative forward-slash segments, and cannot be absolute, drive-qualified, empty, `.` or `..`. The Vault can hold at most 500 Skills in total, including built-ins.
- Archive parsing adds its own earlier resource bounds: an input ZIP is at most 64 MiB compressed, scans at most 128 central-directory entries, contains at most 51 non-directory files including one optional import manifest and at most 50 actual Skill resources, expands to at most 100 MiB total, and gives each entry at most 2 MiB of decoded UTF-8 data and 500,000 characters. These bounds apply before a candidate reaches Vault validation.
- Built-in Skills cannot be deleted but can be disabled. Resetting default Skills restores their bundled content while preserving custom Skills.

Storage validation and migration are implemented in [`src/electron/storage/app-repository.ts`](../src/electron/storage/app-repository.ts).

---

## ZIP and Text Import/Export

[`src/shared/skill-zip.ts`](../src/shared/skill-zip.ts) uses `fflate` to write regular ZIP exports and `@zip.js/zip.js` to read imports asynchronously with bounded entry extraction in the Renderer:

- **Export** stores every Skill text resource and writes a root metadata manifest that preserves the selected entry-file path. If the entry document has no frontmatter, export also adds `name`, `description`, `version`, `author`, and `icon` metadata to that document.
- **ZIP import** reads entries asynchronously with bounded extraction, ignores every path component named `__MACOSX` or `.DS_Store`, and rejects malformed archive paths or non-UTF-8 file content. If every retained file shares one top-level directory, that directory is stripped. Entry-file precedence is a manifest-specified path, `SKILL.md`, `README.md`, then the first Markdown file; an archive with no Markdown entry is rejected.
- Metadata first comes from a root `skill.json`, `manifest.json`, or an AgentBox-generated marker manifest. Without a manifest, the importer reads simple frontmatter from the Markdown entry. Missing values then fall back to its H1, first paragraph, or defaults. Only files recognized as metadata manifests are excluded from stored Skill resources; a user resource that merely shares the generated-manifest base name is preserved.
- **JSON text import** in Settings accepts one object or an array. Each item requires a non-empty `name` and `systemPrompt`, and may include `id`, `files`, `entryFile`, author, and version fields. A matching `id` updates that existing Skill (including a built-in Skill's customized stored content while retaining its built-in flag). Array items are persisted sequentially rather than transactionally, so a later failure does not roll back earlier imports. If `files` is supplied, every item must be a valid text-resource object; malformed arrays are rejected rather than discarded.
- Newly imported Skills are enabled by default and still pass the main process's file-count, path, entry-document, and content-size validation.

A Skill ZIP archive and a conversation backup are distinct formats. Conversation backups are generated as streams by [`src/electron/backup/backup-export.ts`](../src/electron/backup/backup-export.ts) and can use WinZip AES-256. A Skill ZIP archive contains no Vault keys, passwords, or external working directories and has no password-protection feature.

---

## Five Built-in Skills

[`src/electron/storage/default-skills.ts`](../src/electron/storage/default-skills.ts) currently provides:

1. **Code Execution & Algorithm Assistant** (`code-interpreter`): programming, debugging, algorithms, complexity, tests, and performance optimization.
2. **Data Analysis & Visualization** (`data-analyst`): CSV/Excel data, statistics, trend analysis, and chart conventions.
3. **Research & Document Analysis** (`web-extractor`): information extraction from PDFs, web pages, papers, research reports, and long documents, plus a reference-based workflow for the optional isolated browser.
4. **Professional Translation & Localization** (`translator-polyglot`): translation, localization, and terminology consistency.
5. **Prompt Engineering Expert** (`prompt-optimizer`): system prompts, task instructions, roles, and structured templates.

Bundled names, descriptions, and documents follow the application's selected language. User changes to enabled state and customized content are preserved.

The `web-extractor` Skill teaches the model to list and track tabs by `tab_id`, navigate first, read an explicitly approved semantic snapshot for the intended tab, reuse only references from that tab's latest snapshot, refresh after every interaction, cross-check sources, and treat page instructions and screenshots as prompt-injection data rather than Agent commands. It permits screenshot, upload, or download use only when the matching tool is exposed and required by the user's task. The Skill does not grant browser capability: application and conversation switches still control tool exposure, and the main process enforces every network, approval, workspace, size, and sensitive-field restriction.

---

## Gateway Routing and Progressive Loading

Skills participate in routing only in **Agent mode**:

1. The Gateway reads every Skill with `enabled: true` and builds a lightweight catalog from names, IDs, and descriptions.
2. Conversation-pinned `skillIds` take precedence and are limited to 50 distinct IDs. Otherwise, explicit routing examines only the latest user message for `$id`, `@id`, a complete ID delimited in the query, or a full Skill name.
3. Without an explicit match, fuzzy retrieval examines the latest 3 user messages. A text attachment contributes at most its first 2,000 characters; a binary attachment contributes only its file name and MIME type. It scores the ID, name, description, and at most the first 20 non-`other` files with the first 4,000 characters of each; the minimum score is 2. At most 2 Skills meeting that threshold are activated automatically. The automatic cap does not limit pinned or explicit activation.
4. By default, the activated Skills' entry documents, Markdown references, and Python/Shell reference source are added to System Instructions. Eager injection has no additional aggregate prompt cap beyond storage validation and the provider context budget. When optional lazy resource loading is enabled, only each entry document plus a path/kind/character-count manifest is injected.
5. If initial routing is insufficient and the loader is in the current model tool set, the model can call the read-only `agentbox_load_skill` tool with a catalog `skill_id` to load another enabled Skill. Dynamic tool exposure may require `agentbox_search_tools` to mount that loader first. The loader never executes scripts and does not require approval.
6. Automatic, explicit, and model-requested activation all emit a `skill-activated` event, and the Renderer records the activation source. A persisted Assistant message accepts at most 50 distinct activation records.

In lazy-resource mode, the always-available read-only `agentbox_read_skill_resource` tool reads only an exact manifest path from a currently active Skill. Markdown, Python, and shell resources are returned from an offset in chunks that default to 8,000 characters and allow at most 32,000. When tool-result compaction is enabled, the effective reader response is further constrained to `max(256, configured result limit − 512)`. Python and shell content remains reference source and is never executed. The compatibility default remains eager injection.

Retrieval is implemented in [`src/electron/api/skill-retriever.ts`](../src/electron/api/skill-retriever.ts); prompt assembly and on-demand loading are in [`src/electron/api/gateway.ts`](../src/electron/api/gateway.ts).

---

## Script and Tool Execution Boundaries

### Reference scripts are not executed code

Files such as `scripts/*.py`, Shell files, and code blocks are reference implementations for the model to read. AgentBox does not write them into the working directory or launch those files directly. The model may claim actual execution only after it explicitly calls an execution tool and receives a successful result.

### `agentbox_run_code`

The Gateway exposes the built-in code runner whenever at least one enabled Skill contains a Python file. It receives short source code supplied in the model's tool-call arguments; it does not automatically run a script from the Skill package:

- JavaScript runs in a separate Worker and `vm` context exposing only a constrained `console` and `input`. String-based code generation and WebAssembly are disabled, and Worker memory limits are applied.
- Python uses the interpreter resolved by **Settings → Developer Runtimes**. The primary resolver accepts any executable that answers `--version`, including Python 2; only the secondary local fallback used when primary resolution fails requires a Python 3 version string. Select Python 3 explicitly for this tool. The Python subprocess starts with the conversation working directory as its `cwd`; its wrapper uses `-I`, a minimal environment, constrained builtins, and a standard-library allowlist, and rejects file opening, dynamic execution, and double-underscore attribute access.
- Source is limited to 100,000 characters and output to 200,000 characters. The default timeout is 8 seconds; a call may request between 0.5 and 20 seconds.
- The code runner is a risk-reducing constrained environment, not a complete operating-system sandbox. Every run requires user approval except under Full Access.

### Workspace files and the integrated terminal

- `agentbox_read_file` and `agentbox_write_file` use native file APIs for UTF-8 files inside the conversation working directory and do not pass content through Shell quoting. Writes require approval under the default policy.
- `agentbox_run_terminal` invokes compilers, package managers, or system commands through the user's configured cross-platform Shell. It can produce arbitrary system side effects, so every command requires approval except under Full Access.
- The terminal starts in the conversation directory, but it is not directory-sandboxed. Prefer the boundary-enforced workspace file tools when creating source code or multiline text.

See [Conversation Working Directories and Developer Runtimes](workspaces-and-runtimes.md) for runtime and path rules, and [MCP Integration and Intelligent Tool Retrieval](mcp-integration.md) for the shared approval policy.

## data-plat

The companion data skills package ships stable-ID JSON bundles and individual ZIPs. Its planning report entry excludes execution. Skills alone do not grant platform authentication or confirmation. See [data-plat integration](data-plat-integration.md).
