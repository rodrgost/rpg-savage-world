import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { listCharacters, listCampaigns, startSession } from '../lib/api'
import { OwnerAvatar } from '../components/OwnerAvatar'
import type { Campaign, Character } from '../types'
import { ATTRIBUTES, dieLabel } from '../data/savage-worlds'

type Props = {
  uid: string
  ownerLabel: string
  ownerPhotoUrl?: string
}

export function CharactersPage({ uid, ownerLabel, ownerPhotoUrl }: Props) {
  const navigate = useNavigate()
  const [characters, setCharacters] = useState<Character[]>([])
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [startingId, setStartingId] = useState<string | null>(null)

  useEffect(() => {
    if (!uid) return
    setLoading(true)
    Promise.all([listCharacters(), listCampaigns()])
      .then(([charItems, campaignItems]) => {
        setCharacters(charItems)
        setCampaigns(campaignItems)
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Falha ao carregar personagens'))
      .finally(() => setLoading(false))
  }, [uid])

  async function handlePlay(character: Character) {
    if (startingId) return
    setStartingId(character.id)
    setError('')
    try {
      const { sessionId } = await startSession({
        characterId: character.id,
        campaignId: character.campaignId
      })
      navigate(`/game/${sessionId}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao abrir sessão')
    } finally {
      setStartingId(null)
    }
  }

  return (
    <section className="panel page-character">
      <h2>Personagens</h2>

      <div className="row">
        <button onClick={() => navigate('/characters/new')} type="button">
          Criar personagem novo
        </button>
      </div>

      {!loading && !characters.length && <p className="muted">Nenhum personagem cadastrado ainda.</p>}
      {loading && <p className="muted">Carregando personagens...</p>}

      <div className="character-card-grid">
        {characters.map((character) => {
          const campaign = campaigns.find((c) => c.id === character.campaignId)
          const campaignName = campaign?.thematic ?? 'Campanha desconhecida'
          const isOwner = character.ownerId === uid
          const resolvedOwnerLabel = isOwner
            ? ownerLabel
            : character.ownerProfile?.displayName || `Jogador ${character.ownerId.slice(0, 8)}`
          const resolvedOwnerPhoto = isOwner
            ? ownerPhotoUrl
            : character.ownerProfile?.photoUrl

          return (
            <article
              className="character-card character-card-clickable"
              key={character.id}
              onClick={() => navigate(`/characters/${character.id}/edit`)}
            >
              {character.image && (
                <img
                  alt={`Avatar de ${character.name}`}
                  className="card-image card-image--character"
                  src={`data:${character.image.mimeType};base64,${character.image.base64}`}
                />
              )}
              <header className="character-card-header">
                <div className="entity-card-meta">
                  <OwnerAvatar label={resolvedOwnerLabel} photoUrl={resolvedOwnerPhoto} />
                  <span className={`badge ${character.visibility === 'public' ? 'badge--success' : 'badge--warn'}`}>
                    {character.visibility === 'public' ? 'Público' : 'Privado'}
                  </span>
                </div>
                <h3>{character.name}</h3>
                <p className="muted">
                  {character.characterClass ?? 'Sem classe'} • {character.profession ?? 'Sem profissão'}
                </p>
              </header>

              <div className="character-card-body">
                <p className="muted">Campanha: {campaignName}</p>

                {/* Atributos */}
                <div className="character-sheet-summary">
                  <p className="muted">Atributos</p>
                  <p>
                    {ATTRIBUTES.map((a) => (
                      <span key={a.key} style={{ marginRight: 8 }}>
                        <strong>{a.label}:</strong> {dieLabel(character.attributes[a.key] ?? 4)}
                      </span>
                    ))}
                  </p>
                </div>

                {/* Perícias */}
                {character.skills && Object.keys(character.skills).length > 0 && (
                  <div className="character-sheet-summary">
                    <p className="muted">Perícias</p>
                    <p>
                      {Object.entries(character.skills).map(([name, die]) => (
                        <span key={name} style={{ marginRight: 8 }}>
                          {name} {dieLabel(die)}
                        </span>
                      ))}
                    </p>
                  </div>
                )}

                {/* Vantagens */}
                {character.edges && character.edges.length > 0 && (
                  <div className="character-sheet-summary">
                    <p className="muted">Vantagens</p>
                    <p>{character.edges.join(', ')}</p>
                  </div>
                )}

                {/* Complicações */}
                {character.hindrances && character.hindrances.length > 0 && (
                  <div className="character-sheet-summary">
                    <p className="muted">Complicações</p>
                    <p>
                      {character.hindrances.map((h) => `${h.name} (${h.severity === 'major' ? 'Maior' : 'Menor'})`).join(', ')}
                    </p>
                  </div>
                )}
              </div>

              <footer className="character-card-actions">
                {isOwner ? (
                  <button
                    className="btn-play"
                    type="button"
                    disabled={startingId === character.id}
                    onClick={(e) => {
                      e.stopPropagation()
                      handlePlay(character)
                    }}
                  >
                    {startingId === character.id ? 'Abrindo…' : '▶ Jogar'}
                  </button>
                ) : (
                  <span className="badge badge--muted">Somente leitura</span>
                )}
              </footer>
            </article>
          )
        })}
      </div>

      {error && <p className="error">{error}</p>}
    </section>
  )
}
