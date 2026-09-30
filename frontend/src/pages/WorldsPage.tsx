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
  const [selectedCampaignId, setSelectedCampaignId] = useState<string | null>(null)
  const [charsByWorld, setCharsByWorld] = useState<Record<string, Character[]>>({})
  const [loadingCharsWorldId, setLoadingCharsWorldId] = useState<string | null>(null)
  const [charsError, setCharsError] = useState('')

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
      setSelectedCampaignId(null)
      return
    }

    setExpandedWorldId(worldId)
    setSelectedCampaignId(null)
  }

  function toggleCampaign(worldId: string, campaignId: string) {
    setCharsError('')
    if (selectedCampaignId === campaignId) {
      setSelectedCampaignId(null)
      return
    }

    setSelectedCampaignId(campaignId)

    if (!charsByWorld[worldId]) {
      setLoadingCharsWorldId(worldId)
      listCharacters(worldId)
        .then((items) => setCharsByWorld((prev) => ({ ...prev, [worldId]: items })))
        .catch((e) => setCharsError(e instanceof Error ? e.message : 'Falha ao carregar personagens'))
        .finally(() => setLoadingCharsWorldId(null))
    }
  }

  async function handlePlay(campaignId: string, character: Character) {
    if (startingId) return
    setStartingId(character.id)
    setError('')
    try {
      const { sessionId } = await startSession({
        characterId: character.id,
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
          <p className="page-list-subtitle muted">Escolha seu cenário, selecione uma campanha e aventure-se com seu herói.</p>
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
          const worldCampaigns = campaigns.filter((c) => c.worldId === world.id)
          const worldCharacters = charsByWorld[world.id] ?? []
          const isLoadingChars = loadingCharsWorldId === world.id
          const selectedCampaign = worldCampaigns.find((c) => c.id === selectedCampaignId)

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
                      {isExpanded ? 'Ocultar campanhas ▲' : 'Ver campanhas ▼'}
                    </span>
                  </div>
                </div>
              </article>

              {isExpanded && (
                <div className="world-expanded-panel">
                  <div className="world-characters-panel-head">
                    <h4>
                      <span>⚔️</span>
                      Campanhas em {world.name || 'universo sem nome'}
                      <span className="badge badge--muted" style={{ marginLeft: 6 }}>
                        {worldCampaigns.length}
                      </span>
                    </h4>
                    <button
                      type="button"
                      className="page-list-cta"
                      onClick={() => navigate(`/worlds/${world.id}/campaigns/new`)}
                    >
                      + Criar campanha
                    </button>
                  </div>

                  {worldCampaigns.length === 0 && (
                    <div className="world-characters-empty">
                      <p className="muted">Nenhuma campanha criada neste universo ainda.</p>
                      <button
                        type="button"
                        className="button-primary"
                        onClick={() => navigate(`/worlds/${world.id}/campaigns/new`)}
                      >
                        + Criar primeira campanha
                      </button>
                    </div>
                  )}

                  {worldCampaigns.length > 0 && (
                    <div className="world-subcamp-grid">
                      {worldCampaigns.map((camp) => {
                        const isCampSelected = selectedCampaignId === camp.id
                        const campIsOwner = camp.ownerId === uid
                        const campOwnerLabel = campIsOwner
                          ? ownerLabel
                          : camp.ownerProfile?.displayName || `Jogador ${camp.ownerId.slice(0, 8)}`
                        const campOwnerPhoto = campIsOwner ? ownerPhotoUrl : camp.ownerProfile?.photoUrl

                        return (
                          <article
                            key={camp.id}
                            className={`world-subcamp-card ${isCampSelected ? 'is-selected-subcamp' : ''}`}
                            onClick={() => toggleCampaign(world.id, camp.id)}
                            role="button"
                            tabIndex={0}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault()
                                toggleCampaign(world.id, camp.id)
                              }
                            }}
                          >
                            <div className="world-subcamp-banner">
                              {camp.image ? (
                                <img
                                  src={`data:${camp.image.mimeType};base64,${camp.image.base64}`}
                                  alt={camp.name || 'Capa da campanha'}
                                  loading="lazy"
                                />
                              ) : (
                                <div className="world-subcamp-banner-placeholder" aria-hidden="true">⚔️</div>
                              )}
                            </div>
                            <div className="world-subcamp-body">
                              <div className="world-subcamp-body-top">
                                <h5 className="world-subcamp-title">{camp.name || 'Campanha sem nome'}</h5>
                                <span className={`badge ${camp.visibility === 'public' ? 'badge--success' : 'badge--warn'}`}>
                                  {camp.visibility === 'public' ? 'Pública' : 'Privada'}
                                </span>
                              </div>
                              {camp.storyDescription && (
                                <p className="world-subcamp-desc">{camp.storyDescription}</p>
                              )}
                              <div className="world-subcamp-footer">
                                <OwnerAvatar label={campOwnerLabel} photoUrl={campOwnerPhoto} />
                                <span className="world-subcamp-status-hint">
                                  {isCampSelected ? 'Ocultar personagens ▲' : 'Ver personagens ▼'}
                                </span>
                              </div>
                            </div>
                          </article>
                        )
                      })}
                    </div>
                  )}

                  {/* ─── Seção de Personagens (quando uma campanha estiver selecionada) ─── */}
                  {selectedCampaign && (
                    <div className="world-campaign-characters-section">
                      <div className="world-campaign-characters-head">
                        <h4>
                          <span>🧙</span>
                          Personagens disponíveis para <em>"{selectedCampaign.name || 'Campanha'}"</em>
                        </h4>
                        <div className="world-campaign-characters-actions">
                          <button
                            type="button"
                            className="button-secondary"
                            onClick={() => navigate(`/characters/new?worldId=${world.id}&campaignId=${selectedCampaign.id}`)}
                          >
                            + Criar personagem
                          </button>
                          {selectedCampaign.ownerId === uid && (
                            <button
                              type="button"
                              className="button-secondary"
                              onClick={() => navigate(`/campaigns/${selectedCampaign.id}/edit`)}
                              title="Editar campanha"
                            >
                              ✏️ Editar campanha
                            </button>
                          )}
                        </div>
                      </div>

                      {isLoadingChars && (
                        <div className="list-skeleton">
                          {[1, 2, 3].map((i) => <div key={i} className="skeleton-card" />)}
                        </div>
                      )}

                      {!isLoadingChars && charsError && (
                        <p className="error">{charsError}</p>
                      )}

                      {!isLoadingChars && !charsError && worldCharacters.length === 0 && (
                        <div className="world-characters-empty">
                          <p className="muted">Nenhum personagem encontrado neste universo ainda.</p>
                          <button
                            type="button"
                            className="button-primary"
                            onClick={() => navigate(`/characters/new?worldId=${world.id}&campaignId=${selectedCampaign.id}`)}
                          >
                            + Criar primeiro personagem
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

                            const isStartingThis = startingId === character.id

                            return (
                              <article
                                key={character.id}
                                className="world-subchar-card"
                                role={charIsOwner ? 'button' : undefined}
                                tabIndex={charIsOwner ? 0 : undefined}
                                onClick={() => {
                                  if (charIsOwner && !startingId) {
                                    handlePlay(selectedCampaign.id, character)
                                  }
                                }}
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
                                      <button
                                        type="button"
                                        className="world-subchar-play-btn"
                                        disabled={Boolean(startingId)}
                                        onClick={(e) => {
                                          e.stopPropagation()
                                          handlePlay(selectedCampaign.id, character)
                                        }}
                                      >
                                        {isStartingThis ? 'Iniciando…' : '▶ Jogar'}
                                      </button>
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
                </div>
              )}
            </Fragment>
          )
        })}
      </div>

      {error && <p className="error">{error}</p>}
    </section>
  )
}
