import { useEffect, useMemo, useState } from 'react'
import { getSystemPrompt, listSystemPrompts, resetSystemPrompt, updateSystemPrompt } from '../lib/api'
import type { SystemPromptDto } from '../types'

type Props = {
  uid: string
}

export function SystemPromptsPage({ uid: _uid }: Props) {
  const [promptsList, setPromptsList] = useState<SystemPromptDto[]>([])
  const [selectedKey, setSelectedKey] = useState<string>('narrator')
  const [currentPrompt, setCurrentPrompt] = useState<SystemPromptDto | null>(null)
  const [editedPrompt, setEditedPrompt] = useState<string>('')
  const [loading, setLoading] = useState<boolean>(true)
  const [saving, setSaving] = useState<boolean>(false)
  const [resetting, setResetting] = useState<boolean>(false)
  const [error, setError] = useState<string>('')
  const [successMessage, setSuccessMessage] = useState<string>('')
  const [showOriginalModal, setShowOriginalModal] = useState<boolean>(false)
  const [showResetConfirm, setShowResetConfirm] = useState<boolean>(false)

  // Carregar lista de prompts de sistema
  useEffect(() => {
    async function load() {
      setLoading(true)
      setError('')
      try {
        const list = await listSystemPrompts()
        setPromptsList(list)
        const narrator = list.find((p) => p.key === 'narrator')
        if (narrator) {
          setCurrentPrompt(narrator)
          setEditedPrompt(narrator.customPrompt ?? narrator.defaultPrompt ?? '')
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Falha ao carregar prompts de sistema.')
      } finally {
        setLoading(false)
      }
    }
    void load()
  }, [])

  // Atualizar quando selecionar outro prompt
  async function handleSelectPrompt(key: string, enabled: boolean) {
    if (!enabled) return
    setSelectedKey(key)
    setError('')
    setSuccessMessage('')
    setLoading(true)
    try {
      const data = await getSystemPrompt(key)
      setCurrentPrompt(data)
      setEditedPrompt(data.customPrompt ?? data.defaultPrompt ?? '')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao carregar prompt selecionado.')
    } finally {
      setLoading(false)
    }
  }

  const isDirty = useMemo(() => {
    if (!currentPrompt) return false
    const original = currentPrompt.customPrompt ?? currentPrompt.defaultPrompt ?? ''
    return editedPrompt !== original
  }, [currentPrompt, editedPrompt])

  const characterCount = editedPrompt.length
  const estimatedTokens = Math.max(0, Math.round(characterCount / 4))

  async function handleSave() {
    if (!currentPrompt) return
    setSaving(true)
    setError('')
    setSuccessMessage('')
    try {
      const updated = await updateSystemPrompt(selectedKey, editedPrompt)
      setCurrentPrompt(updated)
      setEditedPrompt(updated.customPrompt ?? updated.defaultPrompt ?? '')
      // Atualizar lista lateral
      setPromptsList((prev) =>
        prev.map((p) => (p.key === selectedKey ? { ...p, ...updated } : p))
      )
      setSuccessMessage(
        updated.isCustomized
          ? 'Prompt personalizado salvo com sucesso! Ele será utilizado nas próximas rodadas das suas sessões.'
          : 'Prompt restaurado para o padrão com sucesso.'
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao salvar o prompt.')
    } finally {
      setSaving(false)
    }
  }

  async function handleConfirmReset() {
    if (!currentPrompt) return
    setResetting(true)
    setError('')
    setSuccessMessage('')
    setShowResetConfirm(false)
    try {
      const reseted = await resetSystemPrompt(selectedKey)
      setCurrentPrompt(reseted)
      setEditedPrompt(reseted.defaultPrompt ?? '')
      setPromptsList((prev) =>
        prev.map((p) => (p.key === selectedKey ? { ...p, ...reseted } : p))
      )
      setSuccessMessage('Prompt restaurado para o padrão oficial com sucesso!')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao restaurar o prompt padrão.')
    } finally {
      setResetting(false)
    }
  }

  function handleDiscardChanges() {
    if (!currentPrompt) return
    setEditedPrompt(currentPrompt.customPrompt ?? currentPrompt.defaultPrompt ?? '')
    setError('')
    setSuccessMessage('Alterações não salvas foram descartadas.')
  }

  function handleCopyDefaultToEditor() {
    if (!currentPrompt?.defaultPrompt) return
    setEditedPrompt(currentPrompt.defaultPrompt)
    setShowOriginalModal(false)
    setSuccessMessage('Conteúdo do prompt padrão carregado no editor.')
  }

  return (
    <div className="page-prompts panel">
      <header className="page-prompts-header">
        <div>
          <h2>🧠 Prompts de Sistema</h2>
          <p className="muted">
            Configure e personalize as diretrizes e instruções de comportamento da Inteligência Artificial do jogo.
          </p>
        </div>
      </header>

      {error ? <div className="alert alert-error">{error}</div> : null}
      {successMessage ? <div className="alert alert-success">{successMessage}</div> : null}

      <div className="prompts-layout">
        {/* Sidebar / Menu de Prompts */}
        <aside className="prompts-sidebar">
          <span className="prompts-sidebar-title">Prompts Disponíveis</span>
          <nav className="prompts-nav-list">
            {promptsList.map((item) => {
              const isSelected = item.key === selectedKey
              return (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => void handleSelectPrompt(item.key, item.enabled)}
                  className={`prompts-nav-item ${isSelected ? 'active' : ''} ${!item.enabled ? 'disabled' : ''}`}
                  disabled={!item.enabled}
                  title={!item.enabled ? 'Disponível em breve' : item.description}
                >
                  <div className="prompts-nav-item-top">
                    <span className="prompts-nav-item-name">{item.name}</span>
                    {item.enabled ? (
                      item.isCustomized ? (
                        <span className="prompt-badge prompt-badge--custom" title="Customizado por você">
                          Editado
                        </span>
                      ) : (
                        <span className="prompt-badge prompt-badge--default" title="Padrão do sistema">
                          Padrão
                        </span>
                      )
                    ) : (
                      <span className="prompt-badge prompt-badge--soon">Em breve</span>
                    )}
                  </div>
                  <span className="prompts-nav-item-desc">{item.description}</span>
                </button>
              )
            })}
          </nav>
        </aside>

        {/* Área Principal de Edição */}
        <main className="prompts-editor-area">
          {loading ? (
            <div className="prompts-loading">
              <p>Carregando prompt de sistema...</p>
            </div>
          ) : currentPrompt ? (
            <div className="prompts-editor-container">
              {/* Header do Prompt Atual */}
              <div className="prompts-editor-top">
                <div className="prompts-editor-meta">
                  <div className="prompts-editor-title-row">
                    <h3>{currentPrompt.name}</h3>
                    {currentPrompt.isCustomized ? (
                      <span className="prompt-status-tag prompt-status-tag--custom">
                        ✏️ Versão Personalizada Ativa
                      </span>
                    ) : (
                      <span className="prompt-status-tag prompt-status-tag--default">
                        🛡️ Padrão Oficial do Sistema
                      </span>
                    )}
                    {isDirty ? (
                      <span className="prompt-status-tag prompt-status-tag--dirty">
                        ⚠️ Alterações Não Salvas
                      </span>
                    ) : null}
                  </div>
                  <p className="muted">{currentPrompt.description}</p>
                </div>

                {/* Toolbar de Ações */}
                <div className="prompts-editor-actions">
                  <button
                    type="button"
                    className="button-secondary button-sm"
                    onClick={() => setShowOriginalModal(true)}
                    title="Ver o texto padrão original deste prompt"
                  >
                    🔍 Ver Padrão Oficial
                  </button>

                  {currentPrompt.isCustomized ? (
                    <button
                      type="button"
                      className="button-secondary button-sm button-danger-hover"
                      onClick={() => setShowResetConfirm(true)}
                      disabled={resetting || saving}
                      title="Voltar ao prompt padrão do sistema"
                    >
                      {resetting ? 'Restaurando...' : '🔄 Restaurar Padrão'}
                    </button>
                  ) : null}

                  {isDirty ? (
                    <button
                      type="button"
                      className="button-secondary button-sm"
                      onClick={handleDiscardChanges}
                      disabled={saving}
                      title="Descartar alterações feitas no editor"
                    >
                      Descartar
                    </button>
                  ) : null}

                  <button
                    type="button"
                    className="button-primary button-sm"
                    onClick={() => void handleSave()}
                    disabled={saving || !isDirty}
                  >
                    {saving ? 'Salvando...' : '💾 Salvar Alterações'}
                  </button>
                </div>
              </div>

              {/* Informações e Métricas */}
              <div className="prompts-metrics-bar">
                <div className="prompts-metrics-items">
                  <span className="prompts-metric">
                    <strong>{characterCount.toLocaleString('pt-BR')}</strong> caracteres
                  </span>
                  <span className="prompts-metric">
                    ~<strong>{estimatedTokens.toLocaleString('pt-BR')}</strong> tokens estimados
                  </span>
                </div>
                <div className="prompts-hint-tag">
                  💡 Os blocos de Universo, Campanha, Ficha e Resumo Canônico continuam sendo injetados automaticamente.
                </div>
              </div>

              {/* Campo Textarea do Editor */}
              <div className="prompts-textarea-wrapper">
                <textarea
                  className="prompts-textarea"
                  value={editedPrompt}
                  onChange={(e) => setEditedPrompt(e.target.value)}
                  placeholder="Digite as instruções do prompt de sistema..."
                  rows={24}
                  spellCheck={false}
                />
              </div>

              {/* Card de Dicas de Personalização */}
              <section className="prompts-help-card">
                <h4>💡 Dicas para uma boa personalização do Narrador</h4>
                <ul>
                  <li>
                    <strong>Hierarquia Canônica:</strong> Mantenha a instrução de que os eventos já jogados no resumo
                    autoritativo têm precedência sobre os textos prévios da lore.
                  </li>
                  <li>
                    <strong>Esquema JSON:</strong> O motor do jogo depende estritamente do retorno em JSON com os campos{' '}
                    <code>segments</code>, <code>options</code>, <code>npcs</code>, <code>itemChanges</code>,{' '}
                    <code>statusChanges</code> e <code>npcAttacks</code>. Evite alterar essa estrutura técnica para não
                    gerar respostas de fallback.
                  </li>
                  <li>
                    <strong>Ritmo e Elipse Temporal:</strong> O narrador usa o conceito de elipse para avançar períodos
                    sem perigo diretamente para o próximo ponto de interesse relevante.
                  </li>
                  <li>
                    <strong>Tom e Atmosfera:</strong> Você pode ajustar a linguagem para torná-la mais sombria,
                    poética, investigativa, cinematográfica ou bem-humorada conforme a proposta da sua mesa.
                  </li>
                </ul>
              </section>
            </div>
          ) : (
            <div className="prompts-empty">
              <p>Selecione um prompt na barra lateral para começar a edição.</p>
            </div>
          )}
        </main>
      </div>

      {/* Modal de Confirmação para Restaurar Padrão */}
      {showResetConfirm ? (
        <div className="modal-backdrop" onClick={() => setShowResetConfirm(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <h3>Confirmar Restauração</h3>
            <p>
              Tem certeza de que deseja restaurar o <strong>{currentPrompt?.name}</strong> para o padrão oficial de
              fábrica?
            </p>
            <p className="muted">Suas modificações personalizadas salvas serão descartadas.</p>
            <div className="modal-actions">
              <button
                type="button"
                className="button-secondary"
                onClick={() => setShowResetConfirm(false)}
                disabled={resetting}
              >
                Cancelar
              </button>
              <button
                type="button"
                className="button-danger"
                onClick={() => void handleConfirmReset()}
                disabled={resetting}
              >
                {resetting ? 'Restaurando...' : 'Sim, Restaurar Padrão'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* Modal para Visualizar o Padrão Oficial Original */}
      {showOriginalModal && currentPrompt?.defaultPrompt ? (
        <div className="modal-backdrop" onClick={() => setShowOriginalModal(false)}>
          <div className="modal-card modal-card--wide" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>🛡️ Prompt Padrão Oficial: {currentPrompt.name}</h3>
              <button
                type="button"
                className="button-close"
                onClick={() => setShowOriginalModal(false)}
                aria-label="Fechar"
              >
                ✕
              </button>
            </div>
            <p className="muted">
              Este é o prompt oficial fornecido com a instalação do sistema. Você pode usá-lo como referência ou
              substituir o conteúdo do seu editor por ele.
            </p>
            <div className="prompts-modal-code-wrapper">
              <pre className="prompts-modal-code">{currentPrompt.defaultPrompt}</pre>
            </div>
            <div className="modal-actions">
              <button
                type="button"
                className="button-secondary"
                onClick={() => void navigator.clipboard.writeText(currentPrompt.defaultPrompt ?? '')}
              >
                📋 Copiar Texto
              </button>
              <button
                type="button"
                className="button-primary"
                onClick={handleCopyDefaultToEditor}
              >
                📥 Carregar no Editor
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
