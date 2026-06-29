import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { listActivePlaythroughs, listCharacters, listCampaigns, listWorlds } from '../lib/api'
import type { ActivePlaythrough } from '../lib/api'
import type { Campaign, Character, World } from '../types'

type Props = {
  uid: string
}

export function PlaythroughsPage({ uid }: Props) {
  const navigate = useNavigate()
  const [playthroughs, setPlaythroughs] = useState<ActivePlaythrough[]>([])
  const [characters, setCharacters] = useState<Character[]>([])
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [worlds, setWorlds] = useState<World[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

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

  return (
    <section className="panel page-character">
      <div className="page-list-header">
        <span className="page-list-icon">🎲</span>
        <div>
          <h2>Jogos ativos</h2>
          <p className="page-list-subtitle muted">Suas partidas em andamento — continue de onde parou.</p>
        </div>
        <button onClick={() => navigate('/characters')} type="button" className="page-list-cta">
          + Nova partida
        </button>
      </div>

      {loading && (
        <div className="list-skeleton">
          {[1, 2, 3].map((i) => <div key={i} className="skeleton-card" />)}
        </div>
      )}

      {!loading && !playthroughs.length && (
        <div className="list-empty-state">
          <span className="list-empty-icon">🎲</span>
          <p className="list-empty-title">Nenhum jogo ativo</p>
          <p className="list-empty-sub">Escolha um personagem e uma campanha para começar a jogar.</p>
          <button type="button" onClick={() => navigate('/characters')}>Ir para personagens</button>
        </div>
      )}

      <div className="character-card-grid">
        {playthroughs.map((p) => {
          const character = charById.get(p.characterId)
          const campaign = campById.get(p.campaignId)
          const world = worldById.get(p.worldId ?? character?.worldId ?? campaign?.worldId ?? '')
          const characterName = character?.name ?? 'Personagem'
          const campaignName = campaign?.name || 'Campanha'
          const worldName = world?.name ?? 'Universo'

          return (
            <article className="character-card" key={p.sessionId}>
              <header className="character-card-context">
                <p className="char-breadcrumb">
                  <span>{worldName}</span>
                  <span className="char-breadcrumb-sep">›</span>
                  <span>{campaignName}</span>
                </p>
                <h3 className="char-name">{characterName}</h3>
              </header>

              {character?.image && (
                <img
                  alt={`Avatar de ${characterName}`}
                  className="card-image card-image--character"
                  src={`data:${character.image.mimeType};base64,${character.image.base64}`}
                  loading="lazy"
                />
              )}

              <footer className="character-card-actions">
                <button
                  className="btn-play"
                  type="button"
                  onClick={() => navigate(`/game/${p.sessionId}`)}
                >
                  ▶ Continuar
                </button>
              </footer>
            </article>
          )
        })}
      </div>

      {error && <p className="error">{error}</p>}
    </section>
  )
}
