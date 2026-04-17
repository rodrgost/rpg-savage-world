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
      <h2>Campanhas</h2>

      {/* ── Filtro por Universo ── */}
      <div className="row" style={{ alignItems: 'center', flexWrap: 'wrap', gap: 'var(--space-3)' }}>
        <select
          value={selectedWorldId}
          onChange={(e) => handleWorldFilter(e.target.value)}
          style={{ flex: '1 1 200px', maxWidth: 360 }}
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
              // No world selected and multiple worlds — ask to pick one first
              setError('Selecione um universo antes de criar uma campanha.')
            }
          }}
          type="button"
          disabled={!worlds.length}
        >
          Criar nova campanha
        </button>
      </div>

      {!worlds.length && !loading && (
        <p className="muted">
          Crie um <a onClick={() => navigate('/worlds/new')} style={{ cursor: 'pointer', textDecoration: 'underline' }}>universo</a> primeiro para depois criar campanhas.
        </p>
      )}

      {loading && <p className="muted">Carregando campanhas...</p>}
      {!loading && worlds.length > 0 && !campaigns.length && (
        <p className="muted">
          {selectedWorldId
            ? `Nenhuma campanha cadastrada no universo "${selectedWorld?.name ?? ''}".`
            : 'Nenhuma campanha cadastrada ainda.'}
        </p>
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
                  alt={`Capa da campanha ${campaign.thematic}`}
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
                <h3>{campaign.name || campaign.thematic || 'Campanha sem nome'}</h3>
                {campaign.thematic && campaign.name !== campaign.thematic && (
                  <p className="muted">{campaign.thematic}</p>
                )}
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
