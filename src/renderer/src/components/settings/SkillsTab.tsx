import { useEffect, useMemo, useState } from 'react'
import type { JSX } from 'react'
import type { Skill, SkillFile, SkillInput } from '../../../../shared/types'
import { exportSkillToZip, parseSkillFromZip } from '../../../../shared/skill-zip'
import { t } from '../../../../shared/i18n'
import { Icon } from '../Icon'
import { SettingsToggle } from './SettingsControls'

interface SkillsTabProps {
  skills: Skill[]
  onRemoveSkill?: (id: string) => Promise<void>
  onResetDefaultSkills?: () => Promise<Skill[]>
  onToggleSkill?: (id: string, enabled: boolean) => Promise<Skill>
  onUpsertSkill?: (input: SkillInput) => Promise<Skill>
}

export function SkillsTab({
  skills,
  onRemoveSkill,
  onResetDefaultSkills,
  onToggleSkill,
  onUpsertSkill,
}: SkillsTabProps): JSX.Element {
  const [skillsList, setSkillsList] = useState<Skill[]>(skills)
  const [editingSkill, setEditingSkill] = useState<SkillInput | null>(null)
  const [installingSkill, setInstallingSkill] = useState(false)
  const [skillImportText, setSkillImportText] = useState('')
  const [skillImportError, setSkillImportError] = useState('')
  const [skillFilter, setSkillFilter] = useState<'all' | 'builtin' | 'custom'>('all')
  const [skillSearch, setSkillSearch] = useState('')
  const [skillActionError, setSkillActionError] = useState('')
  const [expandedSkillPromptIds, setExpandedSkillPromptIds] = useState<Set<string>>(new Set())
  const [activeSkillFileTabs, setActiveSkillFileTabs] = useState<Record<string, string>>({})

  useEffect(() => {
    setSkillsList(skills)
  }, [skills])

  const handleToggleSkill = async (id: string, enabled: boolean): Promise<void> => {
    if (!onToggleSkill) return
    setSkillActionError('')
    try {
      const updated = await onToggleSkill(id, enabled)
      setSkillsList((prev) => prev.map((s) => (s.id === id ? updated : s)))
    } catch (err) {
      setSkillActionError(err instanceof Error ? err.message : t("Failed to switch skill status"))
    }
  }

  const handleSaveSkill = async (input: SkillInput): Promise<void> => {
    if (!onUpsertSkill) return
    setSkillActionError('')
    try {
      const saved = await onUpsertSkill(input)
      setSkillsList((prev) => {
        const exists = prev.some((s) => s.id === saved.id)
        return exists ? prev.map((s) => (s.id === saved.id ? saved : s)) : [...prev, saved]
      })
      setEditingSkill(null)
    } catch (err) {
      setSkillActionError(err instanceof Error ? err.message : t("Failed to save the skill"))
    }
  }

  const handleRemoveSkill = async (id: string): Promise<void> => {
    if (!onRemoveSkill) return
    setSkillActionError('')
    try {
      await onRemoveSkill(id)
      setSkillsList((prev) => prev.filter((s) => s.id !== id))
    } catch (err) {
      setSkillActionError(err instanceof Error ? err.message : t("Failed to delete skill"))
    }
  }

  const handleResetSkills = async (): Promise<void> => {
    if (!onResetDefaultSkills) return
    setSkillActionError('')
    try {
      const reset = await onResetDefaultSkills()
      setSkillsList(reset)
    } catch (err) {
      setSkillActionError(err instanceof Error ? err.message : t("Failed to restore default skills"))
    }
  }

  const handleExportSkill = async (skill: Skill): Promise<void> => {
    setSkillActionError('')
    try {
      const zipData = await exportSkillToZip(skill)
      const blob = new Blob([zipData], { type: 'application/zip' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `skill-${skill.id || 'custom'}.zip`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch (err) {
      setSkillActionError(err instanceof Error ? err.message : t("Failed to export the skill archive."))
    }
  }

  const handleImportZipFile = async (file: File): Promise<void> => {
    setSkillImportError('')
    try {
      const buffer = await file.arrayBuffer()
      const candidate = await parseSkillFromZip(buffer)
      if (onUpsertSkill) {
        const saved = await onUpsertSkill(candidate)
        setSkillsList((prev) => {
          const exists = prev.some((s) => s.id === saved.id)
          return exists ? prev.map((s) => (s.id === saved.id ? saved : s)) : [...prev, saved]
        })
      }
      setInstallingSkill(false)
      setSkillImportText('')
    } catch (err) {
      setSkillImportError(err instanceof Error ? err.message : t("Could not parse or import the skill archive. Check the archive contents."))
    }
  }

  const handleImportTextOrFile = async (file: File): Promise<void> => {
    if (file.name.toLowerCase().endsWith('.zip')) {
      await handleImportZipFile(file)
      return
    }
    setSkillImportError('')
    try {
      const text = await file.text()
      setSkillImportText(text)
    } catch {
      setSkillImportError(t("Could not read the file. Try again."))
    }
  }

  const handleImportSkillText = async (): Promise<void> => {
    setSkillImportError('')
    if (!skillImportText.trim()) {
      setSkillImportError(t("Please enter or paste the skill JSON configuration."))
      return
    }
    try {
      const parsed = JSON.parse(skillImportText.trim())
      const items = Array.isArray(parsed) ? parsed : [parsed]
      for (const item of items) {
        if (!item || typeof item !== 'object') throw new Error(t("Invalid skill configuration format"))
        if (typeof item.name !== 'string' || !item.name.trim()) throw new Error(t("Skill is missing a valid name"))
        if (typeof item.systemPrompt !== 'string' || !item.systemPrompt.trim()) throw new Error(t("Skill is missing a valid system prompt (systemPrompt)"))

        const candidate: SkillInput = {
          id: typeof item.id === 'string' && item.id.trim() ? item.id.trim() : undefined,
          name: item.name.trim(),
          description: typeof item.description === 'string' ? item.description.trim() : '',
          icon: typeof item.icon === 'string' ? item.icon.trim() : undefined,
          entryFile: typeof item.entryFile === 'string' ? item.entryFile.trim() : 'SKILL.md',
          files: Array.isArray(item.files) ? item.files : undefined,
          systemPrompt: item.systemPrompt.trim(),
          author: typeof item.author === 'string' ? item.author.trim() : undefined,
          version: typeof item.version === 'string' ? item.version.trim() : '1.0.0',
          enabled: true
        }
        if (onUpsertSkill) {
          const saved = await onUpsertSkill(candidate)
          setSkillsList((prev) => {
            const exists = prev.some((s) => s.id === saved.id)
            return exists ? prev.map((s) => (s.id === saved.id ? saved : s)) : [...prev, saved]
          })
        }
      }
      setInstallingSkill(false)
      setSkillImportText('')
    } catch (err) {
      setSkillImportError(err instanceof Error ? err.message : t("Could not parse or import the configuration. Check its format."))
    }
  }

  const togglePromptExpanded = (id: string): void => {
    setExpandedSkillPromptIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const selectSkillFileTab = (skillId: string, filePath: string): void => {
    setActiveSkillFileTabs((prev) => ({
      ...prev,
      [skillId]: filePath
    }))
  }

  const filteredSkills = useMemo(() => {
    return skillsList.filter((skill) => {
      if (skillFilter === 'builtin' && !skill.isBuiltIn) return false
      if (skillFilter === 'custom' && skill.isBuiltIn) return false
      if (skillSearch.trim()) {
        const query = skillSearch.toLowerCase().trim()
        const matchName = skill.name.toLowerCase().includes(query)
        const matchDesc = skill.description.toLowerCase().includes(query)
        const matchAuthor = (skill.author ?? '').toLowerCase().includes(query)
        return matchName || matchDesc || matchAuthor
      }
      return true
    })
  }, [skillsList, skillFilter, skillSearch])


  return (
              <div className="settings-section-content skills-settings">
                <div className="skills-toolbar">
                  <div className="skills-toolbar-left">
                    <div className="skills-search-box">
                      <Icon name="search" size={15} />
                      <input
                        placeholder={t("Search for skill name, description or author…")}
                        value={skillSearch}
                        onChange={(e) => setSkillSearch(e.target.value)}
                      />
                      {skillSearch && (
                        <button className="icon-button" onClick={() => setSkillSearch('')} aria-label={t("Clear search")}>
                          <Icon name="close" size={13} />
                        </button>
                      )}
                    </div>
                    <div className="segmented-control">
                      {(['all', 'builtin', 'custom'] as const).map((filter) => (
                        <button
                          key={filter}
                          className={skillFilter === filter ? 'is-active' : ''}
                          onClick={() => setSkillFilter(filter)}
                        >
                          {filter === 'all'
                            ? t("All ({value0})", { value0: skillsList.length })
                            : filter === 'builtin'
                              ? t("Preset ({value0})", { value0: skillsList.filter((s) => s.isBuiltIn).length })
                              : t("Custom ({value0})", { value0: skillsList.filter((s) => !s.isBuiltIn).length })}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="skills-toolbar-right">
                    <button
                      className="skills-action-btn is-primary"
                      onClick={() => {
                        setEditingSkill({
                          name: '',
                          description: '',
                          icon: 'bot',
                          entryFile: 'SKILL.md',
                          files: [
                            {
                              path: 'SKILL.md',
                              content: t("# New Skill\n\nWrite the skill’s instructions and usage guidance here."),
                              kind: 'markdown'
                            }
                          ],
                          systemPrompt: '',
                          version: '1.0.0',
                          author: 'User',
                          enabled: true
                        })
                      }}
                    >
                      <Icon name="plus" size={14} />
                      <span>{t("New skill")}</span>
                    </button>
                    <button
                      className="skills-action-btn"
                      onClick={() => {
                        setInstallingSkill(true)
                        setSkillImportText('')
                        setSkillImportError('')
                      }}
                    >
                      <Icon name="upload" size={14} />
                      <span>{t("Import skill")}</span>
                    </button>
                    <button
                      className="skills-action-btn"
                      onClick={() => void handleResetSkills()}
                      title={t("Reset system preset skills and retain custom skills")}
                    >
                      <Icon name="refresh" size={14} />
                      <span>{t("Restore preset")}</span>
                    </button>
                  </div>
                </div>

                {skillActionError && (
                  <div className="settings-error-banner" role="alert">
                    <Icon name="info" size={15} />
                    <span>{skillActionError}</span>
                    <button className="icon-button" onClick={() => setSkillActionError('')}><Icon name="close" size={13} /></button>
                  </div>
                )}

                <div className="skills-grid">
                  {filteredSkills.length === 0 ? (
                    <div className="skills-empty">
                      <Icon name="bot" size={32} />
                      <p>{t("No matching skills found")}</p>
                      <small>{t("Select “New skill” or “Import skill” above to add capabilities; `.zip` skill archives are supported.")}</small>
                    </div>
                  ) : (
                    filteredSkills.map((skill) => {
                      const isExpanded = expandedSkillPromptIds.has(skill.id)
                      const iconName = (skill.icon as Parameters<typeof Icon>[0]['name']) || 'bot'
                      const files = skill.files && skill.files.length > 0
                        ? skill.files
                        : [{ path: skill.entryFile || 'SKILL.md', content: skill.systemPrompt || '', kind: 'markdown' as const }]
                      const mdCount = files.filter((f) => f.kind === 'markdown').length
                      const pyCount = files.filter((f) => f.kind === 'python').length
                      const shCount = files.filter((f) => f.kind === 'shell').length
                      const activeTabPath = activeSkillFileTabs[skill.id] || skill.entryFile || files[0]?.path || 'SKILL.md'
                      const activeFile = files.find((f) => f.path === activeTabPath) || files[0]

                      return (
                        <div key={skill.id} className={`skill-card ${!skill.enabled ? 'is-disabled' : ''}`}>
                          <div className="skill-card-header">
                            <div className="skill-icon-wrapper">
                              <Icon name={iconName} size={20} />
                            </div>
                            <div className="skill-info">
                              <div className="skill-title-row">
                                <h4>{skill.name}</h4>
                                <span className={`skill-badge ${skill.isBuiltIn ? 'is-builtin' : 'is-custom'}`}>
                                  {skill.isBuiltIn ? t("Preset") : t("Custom")}
                                </span>
                              </div>
                              <div className="skill-meta-row">
                                {skill.version && <span className="skill-version">v{skill.version}</span>}
                                {skill.author && <span className="skill-author">by {skill.author}</span>}
                              </div>
                            </div>
                            <div className="skill-toggle-wrapper">
                              <SettingsToggle
                                checked={skill.enabled}
                                label={skill.enabled ? t("Enabled") : t("Deactivated")}
                                onChange={(enabled) => void handleToggleSkill(skill.id, enabled)}
                              />
                            </div>
                          </div>

                          <p className="skill-description">{skill.description}</p>

                          <div className="skill-file-tags">
                            {mdCount > 0 && (
                              <span className="skill-tag skill-tag-md" title={t("{value0} Markdown documents", { value0: mdCount })}>
                                <Icon name="file" size={11} />
                                {mdCount} Markdown
                              </span>
                            )}
                            {pyCount > 0 && (
                              <span className="skill-tag skill-tag-py" title={t("{value0} Python 3 scripts", { value0: pyCount })}>
                                <Icon name="code" size={11} />
                                {pyCount} Python 3
                              </span>
                            )}
                            {shCount > 0 && (
                              <span className="skill-tag skill-tag-sh" title={t("{value0} Shell scripts", { value0: shCount })}>
                                <Icon name="tool" size={11} />
                                {shCount} Shell
                              </span>
                            )}
                          </div>

                          <div className="skill-prompt-section">
                            <button
                              className="skill-prompt-header-btn"
                              type="button"
                              onClick={() => togglePromptExpanded(skill.id)}
                            >
                              <span>{t("View skill files and specifications ({value0} files)", { value0: files.length })}</span>
                              <Icon name={isExpanded ? 'chevron-down' : 'chevron-right'} size={14} />
                            </button>
                            {isExpanded && (
                              <div className="skill-files-viewer">
                                <div className="skill-files-tabs">
                                  {files.map((file) => (
                                    <button
                                      key={file.path}
                                      className={`skill-file-tab ${file.path === activeTabPath ? 'is-active' : ''}`}
                                      onClick={() => selectSkillFileTab(skill.id, file.path)}
                                      type="button"
                                    >
                                      <Icon
                                        name={file.kind === 'python' ? 'code' : file.kind === 'shell' ? 'tool' : 'file'}
                                        size={12}
                                      />
                                      <span>{file.path}</span>
                                    </button>
                                  ))}
                                </div>
                                <pre className="skill-prompt-preview">
                                  <code>{activeFile?.content || ''}</code>
                                </pre>
                              </div>
                            )}
                          </div>

                          <div className="skill-card-footer">
                            <button
                              className="skill-footer-btn"
                              onClick={() => {
                                setEditingSkill({
                                  id: skill.id,
                                  name: skill.name,
                                  description: skill.description,
                                  icon: skill.icon,
                                  entryFile: skill.entryFile || 'SKILL.md',
                                  files: skill.files,
                                  systemPrompt: skill.systemPrompt,
                                  author: skill.author,
                                  version: skill.version,
                                  enabled: skill.enabled
                                })
                              }}
                            >
                              <Icon name="edit" size={13} />
                              <span>{t("Edit")}</span>
                            </button>
                            <button
                              className="skill-footer-btn"
                              onClick={() => void handleExportSkill(skill)}
                              title={t("Export this skill as a ZIP archive (.zip)")}
                            >
                              <Icon name="download" size={13} />
                              <span>{t("Export ZIP")}</span>
                            </button>
                            {!skill.isBuiltIn && (
                              <button
                                className="skill-footer-btn is-danger"
                                onClick={() => void handleRemoveSkill(skill.id)}
                                title={t("Delete this custom skill")}
                              >
                                <Icon name="trash" size={13} />
                                <span>{t("Delete")}</span>
                              </button>
                            )}
                          </div>
                        </div>
                      )
                    })
                  )}
                </div>

                {/* Skill Edit / Create Modal */}
                {editingSkill && (
                  <div className="skill-modal-backdrop" onClick={() => setEditingSkill(null)}>
                    <div className="skill-modal" onClick={(e) => e.stopPropagation()}>
                      <header className="skill-modal-header">
                        <h3>{editingSkill.id ? t("Edit skill") : t("New custom skill")}</h3>
                        <button className="icon-button" onClick={() => setEditingSkill(null)}><Icon name="close" size={16} /></button>
                      </header>
                      <div className="skill-modal-body">
                        <div className="skill-form-row">
                          <label className="skill-form-field" style={{ flex: 2 }}>
                            <span>{t("Skill name *")}</span>
                            <input
                              autoFocus
                              placeholder={t("For example: data analyst")}
                              value={editingSkill.name}
                              onChange={(e) => setEditingSkill({ ...editingSkill, name: e.target.value })}
                            />
                          </label>
                          <label className="skill-form-field" style={{ flex: 1 }}>
                            <span>{t("Icon")}</span>
                            <select
                              value={editingSkill.icon ?? 'bot'}
                              onChange={(e) => setEditingSkill({ ...editingSkill, icon: e.target.value })}
                            >
                              <option value="bot">{t("Agent (bot)")}</option>
                              <option value="code">{t("Code (code)")}</option>
                              <option value="chart">{t("Chart (chart)")}</option>
                              <option value="translate">{t("Translate (translate)")}</option>
                              <option value="sparkles">{t("Sparkles (sparkles)")}</option>
                              <option value="tool">{t("Tool (tool)")}</option>
                              <option value="search">{t("Search (search)")}</option>
                              <option value="file">{t("File (file)")}</option>
                              <option value="globe">{t("Globe (globe)")}</option>
                              <option value="zap">{t("Lightning (zap)")}</option>
                            </select>
                          </label>
                        </div>

                        <div className="skill-form-row">
                          <label className="skill-form-field" style={{ flex: 1 }}>
                            <span>{t("Author")}</span>
                            <input
                              placeholder={t("For example: Community/User")}
                              value={editingSkill.author ?? ''}
                              onChange={(e) => setEditingSkill({ ...editingSkill, author: e.target.value })}
                            />
                          </label>
                          <label className="skill-form-field" style={{ flex: 1 }}>
                            <span>{t("Version")}</span>
                            <input
                              placeholder={t("For example: 1.0.0")}
                              value={editingSkill.version ?? '1.0.0'}
                              onChange={(e) => setEditingSkill({ ...editingSkill, version: e.target.value })}
                            />
                          </label>
                        </div>

                        <label className="skill-form-field">
                          <span>{t("Skill description")}</span>
                          <input
                            placeholder={t("Briefly describe when to use this skill and what it does well…")}
                            value={editingSkill.description}
                            onChange={(e) => setEditingSkill({ ...editingSkill, description: e.target.value })}
                          />
                        </label>

                        <label className="skill-form-field">
                          <span>{t("Primary instruction file (SKILL.md) *")}</span>
                          <textarea
                            placeholder={t("Define the execution guidelines, reasoning guidance, and output format the Agent should follow when this Skill is active…")}
                            rows={8}
                            value={editingSkill.systemPrompt ?? ''}
                            onChange={(e) => setEditingSkill({ ...editingSkill, systemPrompt: e.target.value })}
                          />
                        </label>
                      </div>
                      <footer className="skill-modal-footer">
                        <button className="secondary-button" onClick={() => setEditingSkill(null)}>{t("Cancel")}</button>
                        <button
                          className="primary-button"
                          disabled={!editingSkill.name.trim() || !(editingSkill.systemPrompt || editingSkill.files?.length)}
                          onClick={() => void handleSaveSkill(editingSkill)}
                        >{t("Save skill")}</button>
                      </footer>
                    </div>
                  </div>
                )}

                {/* Skill Import Modal */}
                {installingSkill && (
                  <div className="skill-modal-backdrop" onClick={() => setInstallingSkill(false)}>
                    <div className="skill-modal" onClick={(e) => e.stopPropagation()}>
                      <header className="skill-modal-header">
                        <h3>{t("Import external skill")}</h3>
                        <button className="icon-button" onClick={() => setInstallingSkill(false)}><Icon name="close" size={16} /></button>
                      </header>
                      <div className="skill-modal-body">
                        <p className="skill-modal-hint">{t("Recommended: import a ZIP skill archive (.zip) containing SKILL.md, any Python 3 or shell scripts, and reference documents.")}</p>
                        <div className="skill-import-dropzone">
                          <label className="skill-file-upload-btn">
                            <Icon name="upload" size={16} />
                            <span>{t("Select a `.zip` skill archive or JSON file")}</span>
                            <input
                              type="file"
                              accept=".zip,.json,application/zip,application/json"
                              style={{ display: 'none' }}
                              onChange={(e) => {
                                const file = e.target.files?.[0]
                                if (file) void handleImportTextOrFile(file)
                              }}
                            />
                          </label>
                        </div>
                        <label className="skill-form-field" style={{ marginTop: '12px' }}>
                          <span>{t("Or paste a JSON configuration:")}</span>
                          <textarea
                            className="mono-input"
                            placeholder={t("{\n  \"name\": \"Mathematical deduction expert\",\n  \"description\": \"...\",\n  \"systemPrompt\": \"...\"\n}")}
                            rows={6}
                            value={skillImportText}
                            onChange={(e) => setSkillImportText(e.target.value)}
                          />
                        </label>
                        {skillImportError && (
                          <div className="settings-field-error" style={{ marginTop: '8px' }}>
                            {skillImportError}
                          </div>
                        )}
                      </div>
                      <footer className="skill-modal-footer">
                        <button className="secondary-button" onClick={() => setInstallingSkill(false)}>{t("Cancel")}</button>
                        <button
                          className="primary-button"
                          disabled={!skillImportText.trim()}
                          onClick={() => void handleImportSkillText()}
                        >{t("Import JSON")}</button>
                      </footer>
                    </div>
                  </div>
                )}
              </div>
  )
}
