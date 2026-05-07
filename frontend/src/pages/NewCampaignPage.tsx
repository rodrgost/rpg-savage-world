import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'

import { createCampaign } from '../lib/api'

type Props = {
  uid: string
}

export function NewCampaignPage({ uid }: Props) {
  const navigate = useNavigate()
  const { worldId } = useParams<{ worldId: string }>()
  const [error, setError] = useState('')

  useEffect(() => {
    if (!worldId || !uid) return

    createCampaign({ worldId, thematic: 'Nova campanha', visibility: 'private' })
      .then((campaignId) => {
        navigate(`/campaigns/${campaignId}/edit`, { replace: true })
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Falha ao criar campanha')
      })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [worldId, uid])

  const backPath = worldId ? `/worlds/${worldId}/campaigns` : '/worlds'

  if (error) {
    return (
      <section className="panel">
        <h2>Erro ao criar campanha</h2>
        <p className="error">{error}</p>
        <button className="button-secondary" onClick={() => navigate(backPath)} type="button">
          Voltar para lista
        </button>
      </section>
    )
  }

  return (
    <section className="panel">
      <h2>Nova Campanha</h2>
      <p className="muted">Criando rascunho da campanha...</p>
    </section>
  )
}
