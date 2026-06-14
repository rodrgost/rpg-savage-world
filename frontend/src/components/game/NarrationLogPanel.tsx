import { useCallback, useEffect, useRef, useState } from 'react'
import { getNarrationLog, type NarrationLogEntry } from '../../lib/api'

type Props = {
  sessionId: string
  isOpen: boolean
  onClose: () => void
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function actionTypeLabel(type: string): string {
  const map: Record<string, string> = {
    custom: 'Ação livre',
    trait_test: 'Teste',
    attack: 'Ataque',
    travel: 'Viagem',
    flag: 'Flag',
    soak_roll: 'Absorção',
    spend_benny: 'Benny',
    recover_shaken: 'Recuperar'
  }
  return map[type] ?? type
}

function engineEventLabel(type: string): string {
  const map: Record<string, string> = {
    trait_test: 'Teste',
    attack_hit: 'Acerto',
    attack_miss: 'Erro',
    soak_roll: 'Absorção',
    recover_shaken: 'Recuperação',
    recover_shaken_failed: 'Recuperação falhou',
    heal_success: 'Cura',
    heal_failure: 'Cura falhou',
    npc_attack_hit: 'NPC acertou',
    npc_attack_miss: 'NPC errou'
  }
  return map[type] ?? type
}

function NarrationEntry({ entry }: { entry: NarrationLogEntry }) {
  const [expanded, setExpanded] = useState(false)
  const [showNarrative, setShowNarrative] = useState(false)
  const [showOptions, setShowOptions] = useState(false)
  const [showRaw, setShowRaw] = useState(false)

  const hasChanges = entry.itemChanges.length > 0 || entry.statusChanges.length > 0
  const hasAttacks = entry.npcAttackEvents.length > 0
  const hasNpcs = entry.npcs.length > 0
  const hasEngineEvents = entry.engineEvents.length > 0

  return (
    <div className={`nlog-entry ${entry.isFallback ? 'nlog-entry--fallback' : ''}`}>
      <button
        className="nlog-entry-header"
        onClick={() => setExpanded(!expanded)}
        type="button"
      >
        <span className="nlog-turn">T{entry.turn}</span>
        <span className="nlog-action-type">{actionTypeLabel(entry.playerAction.type)}</span>
        <span className="nlog-action-desc">{entry.playerAction.description}</span>
        <span className="nlog-meta">
          {formatDuration(entry.durationMs)}
          {entry.isFallback && <span className="nlog-fallback-badge">FALLBACK</span>}
          <span className="nlog-time">{formatTime(entry.timestamp)}</span>
        </span>
        <span className="nlog-chevron">{expanded ? '▲' : '▼'}</span>
      </button>

      {expanded && (
        <div className="nlog-body">
          {/* Engine events */}
          {hasEngineEvents && (
            <div className="nlog-section">
              <div className="nlog-section-label">Engine</div>
              <div className="nlog-tags">
                {entry.engineEvents.map((ev, i) => (
                  <span key={i} className={`nlog-tag nlog-tag--engine nlog-tag--${ev.type}`}>
                    {engineEventLabel(ev.type)}
                    {ev.payload && typeof ev.payload === 'object' && 'result' in ev.payload && (
                      <span className="nlog-tag-sub">{String((ev.payload as Record<string, unknown>).result)}</span>
                    )}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* NPC attacks */}
          {hasAttacks && (
            <div className="nlog-section">
              <div className="nlog-section-label">Ataques de NPC</div>
              <div className="nlog-tags">
                {entry.npcAttackEvents.map((ev, i) => {
                  const p = ev.payload as Record<string, unknown>
                  const hit = ev.type === 'npc_attack_hit'
                  return (
                    <span key={i} className={`nlog-tag ${hit ? 'nlog-tag--hit' : 'nlog-tag--miss'}`}>
                      {p.npcName as string ?? ev.payload.npcId}
                      {hit && p.wounds ? ` +${p.wounds}W` : ''}
                      {!hit && ' errou'}
                    </span>
                  )
                })}
              </div>
            </div>
          )}

          {/* NPCs mentioned */}
          {hasNpcs && (
            <div className="nlog-section">
              <div className="nlog-section-label">NPCs</div>
              <div className="nlog-tags">
                {entry.npcs.map((npc) => (
                  <span key={npc.id} className="nlog-tag nlog-tag--npc">
                    {npc.name} <span className="nlog-tag-sub">{npc.action}</span>
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Item/status changes */}
          {hasChanges && (
            <div className="nlog-section">
              <div className="nlog-section-label">Mudanças</div>
              <div className="nlog-tags">
                {entry.itemChanges.map((c, i) => (
                  <span key={i} className={`nlog-tag nlog-tag--item nlog-tag--${c.changeType}`}>
                    {c.name}
                    {c.quantity !== undefined && ` ×${c.quantity}`}
                    <span className="nlog-tag-sub">{c.changeType}</span>
                  </span>
                ))}
                {entry.statusChanges.map((c, i) => (
                  <span key={`s${i}`} className={`nlog-tag nlog-tag--status nlog-tag--${c.changeType}`}>
                    {c.name} <span className="nlog-tag-sub">{c.changeType}</span>
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Narrative */}
          <div className="nlog-section">
            <button className="nlog-toggle" onClick={() => setShowNarrative(!showNarrative)} type="button">
              Narrativa {showNarrative ? '▲' : '▼'}
            </button>
            {showNarrative && (
              <p className="nlog-narrative">{entry.narrative}</p>
            )}
          </div>

          {/* Options */}
          <div className="nlog-section">
            <button className="nlog-toggle" onClick={() => setShowOptions(!showOptions)} type="button">
              Opções ({entry.options.length}) {showOptions ? '▲' : '▼'}
            </button>
            {showOptions && (
              <div className="nlog-options">
                {entry.options.map((opt, i) => (
                  <div key={opt.id} className={`nlog-option ${!opt.feasible ? 'nlog-option--infeasible' : ''}`}>
                    <div className="nlog-option-header">
                      <span className="nlog-option-num">{i + 1}</span>
                      <span className="nlog-option-type">{actionTypeLabel(opt.actionType)}</span>
                      {!opt.feasible && <span className="nlog-option-infeasible">inviável</span>}
                      {opt.diceCheck?.required && (
                        <span className="nlog-option-dice">
                          🎲 {opt.diceCheck.skill ?? opt.diceCheck.attribute} TN{opt.diceCheck.tn ?? 4}
                        </span>
                      )}
                    </div>
                    <div className="nlog-option-text">{opt.text}</div>
                    {opt.playerSpeech && (
                      <div className="nlog-option-speech">"{opt.playerSpeech}"</div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Raw JSON */}
          <div className="nlog-section">
            <button className="nlog-toggle" onClick={() => setShowRaw(!showRaw)} type="button">
              JSON bruto {showRaw ? '▲' : '▼'}
            </button>
            {showRaw && (
              <pre className="nlog-raw">{JSON.stringify(entry, null, 2)}</pre>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export function NarrationLogPanel({ sessionId, isOpen, onClose }: Props) {
  const [entries, setEntries] = useState<NarrationLogEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const load = useCallback(async () => {
    if (!sessionId) return
    try {
      const data = await getNarrationLog(sessionId)
      setEntries(data)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao carregar log')
    }
  }, [sessionId])

  useEffect(() => {
    if (!isOpen) {
      if (intervalRef.current) clearInterval(intervalRef.current)
      return
    }
    setLoading(true)
    load().finally(() => setLoading(false))
    intervalRef.current = setInterval(load, 8000)
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [isOpen, load])

  if (!isOpen) return null

  return (
    <>
      <div className="sidebar-overlay" onClick={onClose} />
      <div className="nlog-panel">
        <div className="nlog-panel-header">
          <div className="nlog-panel-title">
            Log de Narração
            <span className="nlog-count">{entries.length} turnos</span>
          </div>
          <div className="nlog-panel-actions">
            <button className="nlog-refresh-btn" onClick={load} type="button" title="Atualizar">
              ↻
            </button>
            <button className="sidebar-close" onClick={onClose} type="button">×</button>
          </div>
        </div>

        <div className="nlog-panel-body">
          {loading && entries.length === 0 && (
            <p className="nlog-empty">Carregando...</p>
          )}
          {error && (
            <p className="nlog-error">{error}</p>
          )}
          {!loading && entries.length === 0 && !error && (
            <p className="nlog-empty">Nenhum turno registrado ainda. Jogue alguma ação para ver o log.</p>
          )}
          {entries.map((entry) => (
            <NarrationEntry key={entry.id} entry={entry} />
          ))}
        </div>

        <div className="nlog-panel-footer">
          <span className="nlog-footer-hint">Atualiza automaticamente a cada 8s</span>
        </div>
      </div>
    </>
  )
}
