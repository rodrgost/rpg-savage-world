import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { listCharacters, listCampaigns, listWorlds, startSession } from '../lib/api'
import { OwnerAvatar } from '../components/OwnerAvatar'
import type { Campaign, Character, World } from '../types'
import { ATTRIBUTES, dieLabel } from '../data/savage-worlds'

type Props = {
  uid: string
  ownerLabel: string
  ownerPhotoUrl?: string
}

const ATTR_SHORT: Record<string, string> = {
  agility: 'Agi',
  smarts: 'Ast',
  spirit: 'Esp',
  strength: 'For',
  vigor: 'Vig',
}

function cleanHindranceName(name: string): string {
  return name.replace(/\s*\((Menor|Maior|Minor|Major)\)\s*/gi, '').trim()
}

export function CharactersPage({ uid, ownerLabel, ownerPhotoUrl }: Props) {
  const navigate = useNavigate()
  const [characters, setCharacters] = useState<Character[]>([])
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [worlds, setWorlds] = useState<World[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [startingId, setStartingId] = useState<string | null>(null)
  const [playCharacter, setPlayCharacter] = useState<Character | null>(null)

  useEffect(() => {
    if (!uid) return
    setLoading(true)
    Promise.all([listCharacters(), listCampaigns(), listWorlds()])
      .then(([charItems, campaignItems, worldItems]) => {
        setCharacters(charItems)
        setCampaigns(campaignItems)
        setWorlds(worldItems)
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Falha ao carregar personagens'))
      .finally(() => setLoading(false))
  }, [uid])

  function openPlay(character: Character) {
    setError('')
    setPlayCharacter(character)
  }

  async function confirmPlay(campaignId?: string) {
    if (!playCharacter || startingId) return
    setStartingId(playCharacter.id)
    setError('')
    try {
      const { sessionId } = await startSession({
        characterId: playCharacter.id,
        ...(campaignId ? { campaignId } : {})
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
      <div className="page-list-header">
        <span className="page-list-icon">🧙</span>
        <div>
          <h2>Personagens</h2>
          <p className="page-list-subtitle muted">Fichas, atributos e a porta de entrada para a sessão.</p>
        </div>
        <button onClick={() => navigate('/characters/new')} type="button" className="page-list-cta">
          + Criar personagem
        </button>
      </div>

      {loading && (
        <div className="list-skeleton">
          {[1,2,3].map(i => <div key={i} className="skeleton-card skeleton-card--tall" />)}
        </div>
      )}

      {!loading && !characters.length && (
        <div className="list-empty-state">
          <span className="list-empty-icon">🧙</span>
          <p className="list-empty-title">Nenhum personagem ainda</p>
          <p className="list-empty-sub">Crie um personagem em um universo para começar a jogar.</p>
          <button type="button" onClick={() => navigate('/characters/new')}>+ Criar primeiro personagem</button>
        </div>
      )}

      <div className="character-card-grid">
        {characters.map((character) => {
          const campaign = campaigns.find((c) => c.id === character.campaignId)
          const world = worlds.find((w) => w.id === (character.worldId ?? campaign?.worldId))
          const worldName = world?.name ?? 'Universo desconhecido'
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
              {/* Topo: contexto + nome */}
              <header className="character-card-context">
                <p className="char-breadcrumb">
                  <span>{worldName}</span>
                </p>
                <h3 className="char-name">{character.name}</h3>
              </header>

              {/* Imagem */}
              {character.image && (
                <img
                  alt={`Avatar de ${character.name}`}
                  className="card-image card-image--character"
                  src={`data:${character.image.mimeType};base64,${character.image.base64}`}
                  loading="lazy"
                />
              )}

              {/* Dados gerais */}
              <div className="character-card-body">
                <div className="entity-card-meta">
                  <OwnerAvatar label={resolvedOwnerLabel} photoUrl={resolvedOwnerPhoto} />
                  <span className={`badge ${character.visibility === 'public' ? 'badge--success' : 'badge--warn'}`}>
                    {character.visibility === 'public' ? 'Público' : 'Privado'}
                  </span>
                </div>

                <p className="char-subtitle muted">
                  {[character.profession, character.race]
                    .filter(Boolean)
                    .join(' • ') || 'Sem profissão'}
                </p>

                {/* Atributos */}
                <div className="character-sheet-summary">
                  <p className="muted">Atributos</p>
                  <div className="char-attributes-grid">
                    {ATTRIBUTES.map((a) => (
                      <div key={a.key} className="char-attr-cell">
                        <span className="char-attr-label">{ATTR_SHORT[a.key] ?? a.label}</span>
                        <span className="char-attr-value">{dieLabel(character.attributes[a.key] ?? 4)}</span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Perícias */}
                {character.skills && Object.keys(character.skills).length > 0 && (
                  <div className="character-sheet-summary">
                    <p className="muted">Perícias</p>
                    <div className="char-chips">
                      {Object.entries(character.skills).map(([name, die]) => (
                        <span key={name} className="chip chip--skill">
                          {name} {dieLabel(die)}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {/* Vantagens */}
                {character.edges && character.edges.length > 0 && (
                  <div className="character-sheet-summary">
                    <p className="muted">Vantagens</p>
                    <div className="char-chips">
                      {character.edges.map((edge) => (
                        <span key={edge} className="chip chip--edge">{edge}</span>
                      ))}
                    </div>
                  </div>
                )}

                {/* Complicações */}
                {character.hindrances && character.hindrances.length > 0 && (
                  <div className="character-sheet-summary">
                    <p className="muted">Complicações</p>
                    <div className="char-chips">
                      {character.hindrances.map((h, i) => {
                        const baseName = cleanHindranceName(h.name)
                        const severityLabel = h.severity === 'major' ? 'Maior' : 'Menor'
                        return (
                          <span
                            key={i}
                            className={`chip ${h.severity === 'major' ? 'chip--major' : 'chip--minor'}`}
                          >
                            {baseName} ({severityLabel})
                          </span>
                        )
                      })}
                    </div>
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
                      openPlay(character)
                    }}
                  >
                    {startingId === character.id ? (
                      <><span className="btn-play-spinner" />Abrindo…</>
                    ) : (
                      <>▶ Jogar</>
                    )}
                  </button>
                ) : (
                  <span className="badge badge--muted">Somente leitura</span>
                )}
              </footer>
            </article>
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
              style={{ maxWidth: 440, width: '100%', maxHeight: '85vh', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 12, padding: 20 }}
            >
              <h3 style={{ margin: 0 }}>Escolha a campanha</h3>
              <p className="muted" style={{ margin: 0 }}>
                Em qual campanha jogar com <strong>{playCharacter.name}</strong>?
              </p>
              {playCampaigns.length === 0 ? (
                <p className="muted" style={{ margin: 0 }}>
                  Nenhuma campanha disponível neste universo. Você pode jogar sem campanha ou criar uma.
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
                className="button-primary"
                disabled={Boolean(startingId)}
                onClick={() => confirmPlay()}
              >
                {startingId === playCharacter.id ? 'Abrindo…' : '▶ Jogar sem campanha'}
              </button>
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
