import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { listWorlds } from '../lib/api'
import { OwnerAvatar } from '../components/OwnerAvatar'
import type { World } from '../types'

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

// "Recentes" não tem um campo de data no tipo World — aproximamos pelos
// últimos itens retornados pela API (assume ordem de inserção/listagem).
const RECENT_COUNT = 6

export function WorldsPage({ uid, ownerLabel, ownerPhotoUrl }: Props) {
  const navigate = useNavigate()
  const [worlds, setWorlds] = useState<World[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState<WorldFilter>('all')
  const [query, setQuery] = useState('')

  useEffect(() => {
    if (!uid) return

    setLoading(true)
    listWorlds()
      .then((worldData) => setWorlds(worldData))
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

          return (
            <article
              className="world-card world-card-clickable"
              key={world.id}
              onClick={() => navigate(`/worlds/${world.id}/edit`)}
            >
<<<<<<< HEAD
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
=======
              <div className={`world-card-media ${world.image ? '' : 'world-card-media--empty'}`}>
                {world.image && (
                  <img
                    alt={`Imagem do universo ${world.name || 'sem nome'}`}
                    className="card-image card-image--world"
                    src={`data:${world.image.mimeType};base64,${world.image.base64}`}
                    loading="lazy"
                  />
                )}
                <div className="world-card-media-overlay">
                  <h3>{world.name || 'Universo sem nome'}</h3>
                </div>
              </div>
>>>>>>> 199b810ddc28410386ed62053793274694c73326

                <div className="world-card-top">
                  <span className={`badge ${world.visibility === 'public' ? 'badge--success' : 'badge--warn'}`}>
                    {world.visibility === 'public' ? 'Público' : 'Privado'}
                  </span>
                  <OwnerAvatar label={resolvedOwnerLabel} photoUrl={resolvedOwnerPhoto} />
                </div>
<<<<<<< HEAD
=======
              </header>
>>>>>>> 199b810ddc28410386ed62053793274694c73326

                <div className="world-card-bottom">
                  <h3>{world.name || 'Universo sem nome'}</h3>
                  <button
                    className="world-card-link-action"
                    onClick={(e) => {
                      e.stopPropagation()
                      navigate(`/campaigns?worldId=${world.id}`)
                    }}
                    type="button"
                  >
                    Ver campanhas →
                  </button>
                </div>
              </div>
            </article>
          )
        })}
      </div>

      {error && <p className="error">{error}</p>}
    </section>
  )
}
