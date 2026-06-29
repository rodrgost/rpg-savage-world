import { Fragment, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { listWorlds, listCharacters, listCampaigns, startSession } from '../lib/api'
import { OwnerAvatar } from '../components/OwnerAvatar'
import type { Campaign, Character, World } from '../types'

type Props = {
  uid: string
  ownerLabel: string
  ownerPhotoUrl?: string
}

type WorldFilter = 'all' | 'public' | 'private' | 'mine' | 'recent'

const FILTERS: { value: WorldFilter; label: string }[] = [
  { value: 'all', label: 'Todos' },
  { value: 'public', label: 'Públicos' },
  { value: 'private', label: 'Privados' },
  { value: 'mine', label: 'Meus Universos' },
  { value: 'recent', label: 'Recentes' },
]

const RECENT_COUNT = 6

export function WorldsPage({ uid, ownerLabel, ownerPhotoUrl }: Props) {
  const navigate = useNavigate()
  const [worlds, setWorlds] = useState<World[]>([])
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState<WorldFilter>('all')
  const [query, setQuery] = useState('')

  const [expandedWorldId, setExpandedWorldId] = useState<string | null>(null)
  const [charsByWorld, setCharsByWorld] = useState<Record<string, Character[]>>({})
  const [loadingCharsWorldId, setLoadingCharsWorldId] = useState<string | null>(null)
  const [charsError, setCharsError] = useState('')

  const [playCharacter, setPlayCharacter] = useState<Character | null>(null)
  const [startingId, setStartingId] = useState<string | null>(null)

  useEffect(() => {
    if (!uid) return

    setLoading(true)
    Promise.all([listWorlds(), listCampaigns()])
      .then(([worldData, campaignData]) => {
        setWorlds(worldData)
        setCampaigns(campaignData)
      })
      .catch((loadError) => setError(loadError instanceof Error ? loadError.message : 'Falha ao carregar dados'))
      .finally(() => setLoading(false))
  }, [uid])

  const visibleWorlds = useMemo(() => {
    let result = worlds

    switch (filter) {
      case 'public':
        result = result.filter((w) => w.visibility === 'public')
        break
      case 'private':
        result = result.filter((w) => w.visibility === 'private')
        break
      case 'mine':
        result = result.filter((w) => w.ownerId === uid)
        break
      case 'recent':
        result = result.slice(-RECENT_COUNT).reverse()
        break
      default:
        break
    }

    const normalizedQuery = query.trim().toLowerCase()
    if (normalizedQuery) {
      result = result.filter((w) => (w.name || '').toLowerCase().includes(normalizedQuery))
    }

    return result
  }, [worlds, filter, query, uid])

  function toggleWorld(worldId: string) {
    setCharsError('')
    if (expandedWorldId === worldId) {
      setExpandedWorldId(null)
      return
    }

    setExpandedWorldId(worldId)

    if (!charsByWorld[worldId]) {
      setLoadingCharsWorldId(worldId)
      listCharacters(worldId)
        .then((items) => setCharsByWorld((prev) => ({ ...prev, [worldId]: items })))
        .catch((e) => setCharsError(e instanceof Error ? e.message : 'Falha ao carregar personagens'))
        .finally(() => setLoadingCharsWorldId(null))
    }
  }

  async function confirmPlay(campaignId: string) {
    if (!playCharacter || startingId) return
    setStartingId(playCharacter.id)
    setError('')
    try {
      const { sessionId } = await startSession({
        characterId: playCharacter.id,
        campaignId,
      })
      navigate(`/game/${sessionId}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao abrir sessão')
    } finally {
      setStartingId(null)
    }
  }

  return (
    <section className="panel page-worlds">
      <div className="page-list-header">
        <span className="page-list-icon">🌍</span>
        <div>
          <h2>Mesa Infinita - Seleção de Universos</h2>
          <p className="page-list-subtitle muted">Escolha seu cenário e comece sua jornada.</p>
        </div>
      </div>

      <div className="page-list-toolbar world-list-toolbar">
        <div className="world-filter-tabs" role="tablist" aria-label="Filtrar universos">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              role="tab"
              aria-selected={filter === f.value}
              className={`world-filter-tab ${filter === f.value ? 'is-active' : ''}`}
              onClick={() => setFilter(f.value)}
            >
              {f.label}
            </button>
          ))}
        </div>

        <div className="world-toolbar-actions">
          <label className="world-search">
            <span aria-hidden="true">🔍</span>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Buscar..."
              aria-label="Buscar universos"
            />
          </label>
          <button onClick={() => navigate('/worlds/new')} type="button" className="page-list-cta">
            + Criar universo
          </button>
        </div>
      </div>

      {loading && (
        <div className="list-skeleton">
          {[1,2,3].map(i => <div key={i} className="skeleton-card" />)}
        </div>
      )}

      {!loading && !worlds.length && (
        <div className="list-empty-state">
          <span className="list-empty-icon">🌍</span>
          <p className="list-empty-title">Nenhum universo ainda</p>
          <p className="list-empty-sub">Crie seu primeiro cenário para depois montar campanhas e personagens.</p>
          <button type="button" onClick={() => navigate('/worlds/new')}>+ Criar primeiro universo</button>
        </div>
      )}

      {!loading && worlds.length > 0 && !visibleWorlds.length && (
        <div className="list-empty-state">
          <span className="list-empty-icon">🔍</span>
          <p className="list-empty-title">Nenhum universo encontrado</p>
          <p className="list-empty-sub">Tente outro termo de busca ou outro filtro.</p>
        </div>
      )}

      <div className="world-card-grid">
        {visibleWorlds.map((world) => {
          const isOwner = world.ownerId === uid
          const resolvedOwnerLabel = isOwner
            ? ownerLabel
            : world.ownerProfile?.displayName || `Jogador ${world.ownerId.slice(0, 8)}`
          const resolvedOwnerPhoto = isOwner
            ? ownerPhotoUrl
            : world.ownerProfile?.photoUrl

          const isExpanded = expandedWorldId === world.id
          const worldCharacters = charsByWorld[world.id] ?? []
          const isLoadingChars = loadingCharsWorldId === world.id

          return (
            <Fragment key={world.id}>
              <article
                className={`world-card world-card-clickable ${isExpanded ? 'is-selected' : ''}`}
                onClick={() => toggleWorld(world.id)}
                aria-expanded={isExpanded}
              >
                <div className="card-image-frame">
                  {world.image ? (
                    <img
                      alt={`Imagem do universo ${world.name || 'sem nome'}`}
                      className="card-image card-image--world"
                      loading="lazy"
                      src={`data:${world.image.mimeType};base64,${world.image.base64}`}
                    />
                  ) : (
                    <div className="card-image card-image--world card-image--placeholder" aria-hidden="true" />
                  )}
                  <span className="card-image-overlay" aria-hidden="true" />

                  <div className="world-card-top">
                    <span className={`badge ${world.visibility === 'public' ? 'badge--success' : 'badge--warn'}`}>
                      {world.visibility === 'public' ? 'Público' : 'Privado'}
                    </span>
                    <div className="world-card-top-right">
                      {isOwner && (
                        <button
                          className="world-card-edit-action"
                          type="button"
                          aria-label={`Editar universo ${world.name || 'sem nome'}`}
                          title="Editar universo"
                          onClick={(e) => {
                            e.stopPropagation()
                            navigate(`/worlds/${world.id}/edit`)
                          }}
                        >
                          ✏️ Editar
                        </button>
                      )}
                      <OwnerAvatar label={resolvedOwnerLabel} photoUrl={resolvedOwnerPhoto} />
                    </div>
                  </div>

                  <div className="world-card-bottom">
                    <span className="world-card-expand-hint">
                      {isExpanded ? 'Ocultar personagens ▲' : 'Ver personagens ▼'}
                    </span>
                  </div>
                </div>
              </article>

              {isExpanded && (
                <div className="world-characters-panel">
                  <div className="world-characters-panel-head">
                    <h4>Personagens de {world.name || 'universo sem nome'}</h4>
                    <button
                      type="button"
                      className="world-card-link-action world-characters-campaigns-link"
                      onClick={() => navigate(`/campaigns?worldId=${world.id}`)}
                    >
                      Ver campanhas →
                    </button>
                  </div>

                  {isLoadingChars && (
                    <div className="list-skeleton">
                      {[1,2,3].map((i) => <div key={i} className="skeleton-card" />)}
                    </div>
                  )}

                  {!isLoadingChars && charsError && expandedWorldId === world.id && (
                    <p className="error">{charsError}</p>
                  )}

                  {!isLoadingChars && !charsError && worldCharacters.length === 0 && (
                    <div className="world-characters-empty">
                      <p className="muted">Nenhum personagem neste universo ainda.</p>
                      <button type="button" onClick={() => navigate('/characters/new')}>
                        + Criar personagem
                      </button>
                    </div>
                  )}

                  {!isLoadingChars && worldCharacters.length > 0 && (
                    <div className="world-subchar-grid">
                      {worldCharacters.map((character) => {
                        const charIsOwner = character.ownerId === uid
                        const charOwnerLabel = charIsOwner
                          ? ownerLabel
                          : character.ownerProfile?.displayName || `Jogador ${character.ownerId.slice(0, 8)}`
                        const charOwnerPhoto = charIsOwner
                          ? ownerPhotoUrl
                          : character.ownerProfile?.photoUrl

                        return (
                          <article
                            key={character.id}
                            className="world-subchar-card"
                            onClick={() => {
                              if (charIsOwner) {
                                setError('')
                                setPlayCharacter(character)
                              }
                            }}
                            role={charIsOwner ? 'button' : undefined}
                            tabIndex={charIsOwner ? 0 : undefined}
                          >
                            <div className="world-subchar-thumb">
                              {character.image ? (
                                <img
                                  alt={`Avatar de ${character.name}`}
                                  src={`data:${character.image.mimeType};base64,${character.image.base64}`}
                                  loading="lazy"
                                />
                              ) : (
                                <span aria-hidden="true">🧙</span>
                              )}
                            </div>
                            <div className="world-subchar-info">
                              <h5>{character.name}</h5>
                              <p className="muted">
                                {[character.profession, character.race].filter(Boolean).join(' • ') || 'Sem profissão'}
                              </p>
                              <div className="world-subchar-meta">
                                <OwnerAvatar label={charOwnerLabel} photoUrl={charOwnerPhoto} />
                                {charIsOwner ? (
                                  <span className="world-subchar-play">▶ Jogar</span>
                                ) : (
                                  <span className="badge badge--muted">Somente leitura</span>
                                )}
                              </div>
                            </div>
                          </article>
                        )
                      })}
                    </div>
                  )}
                </div>
              )}
            </Fragment>
          )
        })}
      </div>

      {playCharacter && (() => {
        const playWorldId = playCharacter.worldId
        const playCampaigns = campaigns.filter((c) => !playWorldId || c.worldId === playWorldId)
        return (
          <div
            onClick={() => { if (!startingId) setPlayCharacter(null) }}
            style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 16 }}
          >
            <div
              className="panel"
              onClick={(e) => e.stopPropagation()}
              style={{ maxWidth: 440, width: '100%', display: 'flex', flexDirection: 'column', gap: 12, padding: 20 }}
            >
              <h3 style={{ margin: 0 }}>Escolha a campanha</h3>
              <p className="muted" style={{ margin: 0 }}>
                Em qual campanha jogar com <strong>{playCharacter.name}</strong>?
              </p>
              {playCampaigns.length === 0 ? (
                <p className="muted" style={{ margin: 0 }}>
                  Nenhuma campanha disponível neste universo. Crie uma campanha para jogar.
                </p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {playCampaigns.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      className="button-secondary"
                      disabled={Boolean(startingId)}
                      onClick={() => confirmPlay(c.id)}
                    >
                      {startingId === playCharacter.id ? 'Abrindo…' : (c.name || 'Campanha sem nome')}
                    </button>
                  ))}
                </div>
              )}
              <button
                type="button"
                className="button-secondary"
                onClick={() => setPlayCharacter(null)}
                disabled={Boolean(startingId)}
              >
                Cancelar
              </button>
            </div>
          </div>
        )
      })()}

      {error && <p className="error">{error}</p>}
    </section>
  )
}
