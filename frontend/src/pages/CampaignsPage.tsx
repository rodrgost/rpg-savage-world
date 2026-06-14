import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'

import { listCampaigns, listWorlds } from '../lib/api'
import { OwnerAvatar } from '../components/OwnerAvatar'
import type { Campaign, World } from '../types'

type Props = {
  uid: string
  ownerLabel: string
  ownerPhotoUrl?: string
}

export function CampaignsPage({ uid, ownerLabel, ownerPhotoUrl }: Props) {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()

  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [worlds, setWorlds] = useState<World[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const selectedWorldId = searchParams.get('worldId') ?? ''

  // Load worlds + campaigns
  useEffect(() => {
    if (!uid) return

    setLoading(true)
    Promise.all([
      listCampaigns(selectedWorldId || undefined),
      listWorlds()
    ])
      .then(([campaignData, worldData]) => {
        setCampaigns(campaignData)
        setWorlds(worldData)
      })
      .catch((loadError) => setError(loadError instanceof Error ? loadError.message : 'Falha ao carregar dados'))
      .finally(() => setLoading(false))
  }, [uid, selectedWorldId])

  function handleWorldFilter(worldId: string) {
    if (worldId) {
      setSearchParams({ worldId })
    } else {
      setSearchParams({})
    }
  }

  const selectedWorld = worlds.find((w) => w.id === selectedWorldId)

  // Build a world lookup for showing the world name on each campaign card
  const worldMap = new Map(worlds.map((w) => [w.id, w]))

  return (
    <section className="panel page-worlds">
      <div className="page-list-header">
        <span className="page-list-icon">⚔️</span>
        <div>
          <h2>Campanhas</h2>
          <p className="page-list-subtitle muted">Organize arcos narrativos e conecte universos aos aventureiros.</p>
        </div>
      </div>

      {/* ── Filtro por Universo ── */}
      <div className="page-list-toolbar">
        <select
          className="list-filter-select"
          value={selectedWorldId}
          onChange={(e) => handleWorldFilter(e.target.value)}
        >
          <option value="">Todos os universos</option>
          {worlds.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>

        <button
          onClick={() => {
            if (selectedWorldId) {
              navigate(`/worlds/${selectedWorldId}/campaigns/new`)
            } else if (worlds.length === 1) {
              navigate(`/worlds/${worlds[0].id}/campaigns/new`)
            } else {
              setError('Selecione um universo antes de criar uma campanha.')
            }
          }}
          type="button"
          disabled={!worlds.length}
          className="page-list-cta"
        >
          + Criar campanha
        </button>
      </div>

      {!worlds.length && !loading && (
        <div className="list-empty-state">
          <span className="list-empty-icon">🌍</span>
          <p className="list-empty-title">Nenhum universo encontrado</p>
          <p className="list-empty-sub">Crie um <button type="button" className="link-btn" onClick={() => navigate('/worlds/new')}>universo</button> primeiro para depois criar campanhas.</p>
        </div>
      )}

      {loading && (
        <div className="list-skeleton">
          {[1,2,3].map(i => <div key={i} className="skeleton-card" />)}
        </div>
      )}

      {!loading && worlds.length > 0 && !campaigns.length && (
        <div className="list-empty-state">
          <span className="list-empty-icon">⚔️</span>
          <p className="list-empty-title">Nenhuma campanha{selectedWorldId ? ` em "${selectedWorld?.name}"` : ''}</p>
          <p className="list-empty-sub">Selecione um universo e crie a primeira campanha para começar.</p>
        </div>
      )}

      <div className="world-card-grid">
        {campaigns.map((campaign) => {
          const world = worldMap.get(campaign.worldId)
          const isOwner = campaign.ownerId === uid
          const resolvedOwnerLabel = isOwner
            ? ownerLabel
            : campaign.ownerProfile?.displayName || `Jogador ${campaign.ownerId.slice(0, 8)}`
          const resolvedOwnerPhoto = isOwner
            ? ownerPhotoUrl
            : campaign.ownerProfile?.photoUrl

          return (
            <article
              className="world-card world-card-clickable"
              key={campaign.id}
              onClick={() => navigate(`/campaigns/${campaign.id}/edit`)}
            >
              {campaign.image && (
                <img
                  alt={`Capa da campanha ${campaign.name || ''}`}
                  className="card-image card-image--world"
                  src={`data:${campaign.image.mimeType};base64,${campaign.image.base64}`}
                />
              )}
              <header className="world-card-header">
                <div className="entity-card-meta">
                  <OwnerAvatar label={resolvedOwnerLabel} photoUrl={resolvedOwnerPhoto} />
                  <span className={`badge ${campaign.visibility === 'public' ? 'badge--success' : 'badge--warn'}`}>
                    {campaign.visibility === 'public' ? 'Pública' : 'Privada'}
                  </span>
                </div>
                <h3>{campaign.name || 'Campanha sem nome'}</h3>
                {world && !selectedWorldId && (
                  <p className="muted" style={{ fontSize: 12, marginTop: 2 }}>🌍 {world.name}</p>
                )}
              </header>

              <footer className="world-card-actions" onClick={(e) => e.stopPropagation()}>
                <button
                  className="button-secondary"
                  onClick={() => navigate(`/characters/new?campaignId=${campaign.id}`)}
                  type="button"
                >
                  Criar personagem
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
