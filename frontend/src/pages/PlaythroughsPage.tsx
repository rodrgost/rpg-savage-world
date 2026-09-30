import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { listActivePlaythroughs, listCharacters, listCampaigns, listWorlds, updateSessionStatus } from '../lib/api'
import type { ActivePlaythrough } from '../lib/api'
import type { Campaign, Character, World } from '../types'

type Props = {
  uid: string
}

function formatRelativeTime(millis: number): string {
  if (!millis) return 'Recentemente'
  const diff = Date.now() - millis
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return 'Agora mesmo'
  if (minutes < 60) return `há ${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `há ${hours} h`
  const days = Math.floor(hours / 24)
  if (days === 1) return 'Ontem'
  if (days < 30) return `há ${days} dias`
  return new Date(millis).toLocaleDateString('pt-BR')
}

export function PlaythroughsPage({ uid }: Props) {
  const navigate = useNavigate()
  const [playthroughs, setPlaythroughs] = useState<ActivePlaythrough[]>([])
  const [characters, setCharacters] = useState<Character[]>([])
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [worlds, setWorlds] = useState<World[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  // Filtros
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedWorldId, setSelectedWorldId] = useState('')

  // Estado para modal de encerramento
  const [sessionToClose, setSessionToClose] = useState<ActivePlaythrough | null>(null)
  const [closingId, setClosingId] = useState<string | null>(null)

  useEffect(() => {
    if (!uid) return
    setLoading(true)
    Promise.all([listActivePlaythroughs(), listCharacters(), listCampaigns(), listWorlds()])
      .then(([active, chars, camps, wrlds]) => {
        setPlaythroughs(active)
        setCharacters(chars)
        setCampaigns(camps)
        setWorlds(wrlds)
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Falha ao carregar jogos ativos'))
      .finally(() => setLoading(false))
  }, [uid])

  const charById = useMemo(() => new Map(characters.map((c) => [c.id, c])), [characters])
  const campById = useMemo(() => new Map(campaigns.map((c) => [c.id, c])), [campaigns])
  const worldById = useMemo(() => new Map(worlds.map((w) => [w.id, w])), [worlds])

  const filteredPlaythroughs = useMemo(() => {
    return playthroughs.filter((p) => {
      const char = charById.get(p.characterId)
      const camp = campById.get(p.campaignId)
      const resolvedWorldId = p.worldId ?? char?.worldId ?? camp?.worldId ?? ''

      if (selectedWorldId && resolvedWorldId !== selectedWorldId) {
        return false
      }

      if (searchQuery.trim()) {
        const query = searchQuery.toLowerCase()
        const charName = (char?.name ?? '').toLowerCase()
        const campName = (camp?.name ?? '').toLowerCase()
        if (!charName.includes(query) && !campName.includes(query)) {
          return false
        }
      }

      return true
    })
  }, [playthroughs, charById, campById, selectedWorldId, searchQuery])

  async function handleConfirmCloseSession() {
    if (!sessionToClose || closingId) return
    setClosingId(sessionToClose.sessionId)
    try {
      await updateSessionStatus(sessionToClose.sessionId, 'concluido')
      setPlaythroughs((prev) => prev.filter((p) => p.sessionId !== sessionToClose.sessionId))
      setSessionToClose(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao encerrar a partida')
    } finally {
      setClosingId(null)
    }
  }

  return (
    <section className="panel page-character page-games">
      <div className="page-list-header">
        <span className="page-list-icon">🎲</span>
        <div>
          <h2>Jogos iniciados</h2>
          <p className="page-list-subtitle muted">
            Partidas em andamento com seus personagens — continue de onde parou ou inicie uma nova mesa.
          </p>
        </div>
        <button onClick={() => navigate('/characters')} type="button" className="page-list-cta">
          + Iniciar novo jogo
        </button>
      </div>

      {/* ── Toolbar de Filtros ── */}
      <div className="page-list-toolbar" style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'center' }}>
        <input
          type="text"
          placeholder="Buscar por personagem ou campanha..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          style={{
            flex: '1 1 240px',
            padding: '8px 14px',
            borderRadius: 'var(--radius-sm)',
            border: '1px solid var(--border-default)',
            background: 'var(--bg-input, var(--bg-card))',
            color: 'var(--text-primary)'
          }}
        />

        {worlds.length > 1 && (
          <select
            className="list-filter-select"
            value={selectedWorldId}
            onChange={(e) => setSelectedWorldId(e.target.value)}
            style={{ minWidth: '180px' }}
          >
            <option value="">Todos os universos</option>
            {worlds.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        )}
      </div>

      {loading && (
        <div className="list-skeleton">
          {[1, 2, 3].map((i) => <div key={i} className="skeleton-card skeleton-card--tall" />)}
        </div>
      )}

      {!loading && !playthroughs.length && (
        <div className="list-empty-state">
          <span className="list-empty-icon">🎲</span>
          <p className="list-empty-title">Nenhum jogo em andamento</p>
          <p className="list-empty-sub">
            Quando você inicia uma partida com um personagem em uma campanha, ela fica salva aqui com todo o seu progresso.
          </p>
          <button type="button" className="button-primary" onClick={() => navigate('/characters')}>
            🧙 Escolher personagem e jogar
          </button>
        </div>
      )}

      {!loading && Boolean(playthroughs.length) && !filteredPlaythroughs.length && (
        <div className="list-empty-state">
          <span className="list-empty-icon">🔍</span>
          <p className="list-empty-title">Nenhum jogo encontrado com os filtros atuais</p>
          <p className="list-empty-sub">Tente alterar os termos de busca ou o universo selecionado.</p>
          <button
            type="button"
            className="button-secondary"
            onClick={() => {
              setSearchQuery('')
              setSelectedWorldId('')
            }}
          >
            Limpar filtros
          </button>
        </div>
      )}

      <div className="character-card-grid">
        {filteredPlaythroughs.map((p) => {
          const character = charById.get(p.characterId)
          const campaign = campById.get(p.campaignId)
          const world = worldById.get(p.worldId ?? character?.worldId ?? campaign?.worldId ?? '')
          const characterName = character?.name ?? 'Personagem'
          const campaignName = campaign?.name || (p.campaignId ? 'Campanha' : 'Sem campanha')
          const worldName = world?.name ?? 'Universo'
          const turnLabel = p.turn ? `Turno ${p.turn}` : 'Em andamento'
          const timeLabel = formatRelativeTime(p.updatedAtMillis)

          return (
            <article className="character-card game-card" key={p.sessionId}>
              {/* Topo do card: breadcrumb + badge de status do jogo */}
              <header className="character-card-context game-card-header">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, width: '100%' }}>
                  <p className="char-breadcrumb" style={{ margin: 0 }}>
                    <span>🌍 {worldName}</span>
                    <span className="char-breadcrumb-sep">›</span>
                    <span>⚔️ {campaignName}</span>
                  </p>
                  <span className="badge badge--game-active" title="Partida ativa">
                    <span className="pulse-dot" /> Ativa
                  </span>
                </div>
                <h3 className="char-name" style={{ marginTop: 6 }}>{characterName}</h3>
              </header>

              {/* Avatar do Personagem */}
              {character?.image ? (
                <div className="game-card-media">
                  <img
                    alt={`Avatar de ${characterName}`}
                    className="card-image card-image--character"
                    src={`data:${character.image.mimeType};base64,${character.image.base64}`}
                    loading="lazy"
                  />
                </div>
              ) : (
                <div
                  style={{
                    height: 110,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: 'linear-gradient(135deg, rgba(255,255,255,0.03), rgba(255,255,255,0.08))',
                    borderBottom: '1px solid var(--border-default)',
                    color: 'var(--text-muted)',
                    fontSize: '2.5rem'
                  }}
                >
                  🧙
                </div>
              )}

              {/* Metadados do Jogo */}
              <div className="character-card-body" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <p className="char-subtitle muted" style={{ margin: 0 }}>
                  {[character?.profession, character?.race].filter(Boolean).join(' • ') || 'Aventureiro'}
                </p>

                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '1fr 1fr',
                    gap: 8,
                    padding: '8px 12px',
                    borderRadius: 'var(--radius-sm)',
                    background: 'var(--bg-elevated, rgba(255,255,255,0.03))',
                    border: '1px solid var(--border-default)',
                    fontSize: 'var(--font-xs, 0.8rem)'
                  }}
                >
                  <div>
                    <span className="muted" style={{ display: 'block', marginBottom: 2 }}>Progresso</span>
                    <strong style={{ color: 'var(--text-primary)' }}>📜 {turnLabel}</strong>
                  </div>
                  <div>
                    <span className="muted" style={{ display: 'block', marginBottom: 2 }}>Última jogada</span>
                    <span style={{ color: 'var(--text-primary)' }}>⏱️ {timeLabel}</span>
                  </div>
                </div>
              </div>

              {/* Ações da Partida */}
              <footer className="character-card-actions" style={{ display: 'flex', gap: 8 }}>
                <button
                  className="btn-play"
                  type="button"
                  style={{ flex: 1 }}
                  onClick={() => navigate(`/game/${p.sessionId}`)}
                >
                  ▶ Continuar Jogo
                </button>
                <button
                  type="button"
                  className="button-secondary"
                  title="Encerrar esta partida"
                  onClick={() => setSessionToClose(p)}
                  style={{ padding: '0 12px', fontSize: '0.85rem' }}
                >
                  Encerrar
                </button>
              </footer>
            </article>
          )
        })}
      </div>

      {/* ── Modal de Confirmação de Encerramento ── */}
      {sessionToClose && (() => {
        const char = charById.get(sessionToClose.characterId)
        const camp = campById.get(sessionToClose.campaignId)
        return (
          <div
            onClick={() => { if (!closingId) setSessionToClose(null) }}
            style={{
              position: 'fixed',
              inset: 0,
              background: 'rgba(0,0,0,0.65)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              zIndex: 1000,
              padding: 16
            }}
          >
            <div
              className="panel"
              onClick={(e) => e.stopPropagation()}
              style={{ maxWidth: 440, width: '100%', padding: 24, display: 'flex', flexDirection: 'column', gap: 16 }}
            >
              <h3 style={{ margin: 0 }}>Encerrar partida?</h3>
              <p className="muted" style={{ margin: 0, lineHeight: 1.5 }}>
                Deseja encerrar o jogo em andamento com <strong>{char?.name ?? 'o personagem'}</strong> na campanha <strong>{camp?.name ?? 'atual'}</strong>?
              </p>
              <p className="muted" style={{ margin: 0, fontSize: '0.85rem', opacity: 0.8 }}>
                A partida será movida para o histórico e deixará de aparecer na lista de jogos ativos.
              </p>
              <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 8 }}>
                <button
                  type="button"
                  className="button-secondary"
                  onClick={() => setSessionToClose(null)}
                  disabled={Boolean(closingId)}
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  className="button-primary"
                  style={{ background: 'var(--color-danger, #e53e3e)' }}
                  onClick={handleConfirmCloseSession}
                  disabled={Boolean(closingId)}
                >
                  {closingId ? 'Encerrando…' : 'Sim, encerrar'}
                </button>
              </div>
            </div>
          </div>
        )
      })()}

      {error && <p className="error">{error}</p>}
    </section>
  )
}
