import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { listWorlds } from '../lib/api'
import { OwnerAvatar } from '../components/OwnerAvatar'
import type { World } from '../types'

type Props = {
  uid: string
  ownerLabel: string
  ownerPhotoUrl?: string
}

export function WorldsPage({ uid, ownerLabel, ownerPhotoUrl }: Props) {
  const navigate = useNavigate()
  const [worlds, setWorlds] = useState<World[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!uid) return

    setLoading(true)
    listWorlds()
      .then((worldData) => setWorlds(worldData))
      .catch((loadError) => setError(loadError instanceof Error ? loadError.message : 'Falha ao carregar dados'))
      .finally(() => setLoading(false))
  }, [uid])

  return (
    <section className="panel page-worlds">
      <div className="page-list-header">
        <span className="page-list-icon">🌍</span>
        <div>
          <h2>Universos</h2>
          <p className="page-list-subtitle muted">Cenários, lore e imagens-base para suas campanhas.</p>
        </div>
        <button onClick={() => navigate('/worlds/new')} type="button" className="page-list-cta">
          + Criar universo
        </button>
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

      <div className="world-card-grid">
        {worlds.map((world) => {
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

              <header className="world-card-header">
                <div className="entity-card-meta">
                  <OwnerAvatar label={resolvedOwnerLabel} photoUrl={resolvedOwnerPhoto} />
                  <span className={`badge ${world.visibility === 'public' ? 'badge--success' : 'badge--warn'}`}>
                    {world.visibility === 'public' ? 'Público' : 'Privado'}
                  </span>
                </div>
              </header>

              <footer className="world-card-actions" onClick={(e) => e.stopPropagation()}>
                <button
                  className="button-secondary"
                  onClick={() => navigate(`/campaigns?worldId=${world.id}`)}
                  type="button"
                >
                  Ver campanhas
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
