import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { listCharacters, listCampaigns, listWorlds, listActivePlaythroughs, startSession } from '../lib/api'
import type { ActivePlaythrough } from '../lib/api'
import { OwnerAvatar } from '../components/OwnerAvatar'
import type { Campaign, Character, World } from '../types'
import { dieLabel } from '../data/savage-worlds'

type Props = {
  uid: string
  ownerLabel: string
  ownerPhotoUrl?: string
}

function cleanHindranceName(name: string): string {
  return name.replace(/\s*\((Menor|Maior|Minor|Major)\)\s*/gi, '').trim()
}

export function CharactersPage({ uid, ownerLabel, ownerPhotoUrl }: Props) {
  const navigate = useNavigate()
  const [characters, setCharacters] = useState<Character[]>([])
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [worlds, setWorlds] = useState<World[]>([])
  const [activeGames, setActiveGames] = useState<ActivePlaythrough[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [startingId, setStartingId] = useState<string | null>(null)
  const [playCharacter, setPlayCharacter] = useState<Character | null>(null)

  useEffect(() => {
    if (!uid) return
    setLoading(true)
    Promise.all([listCharacters(), listCampaigns(), listWorlds(), listActivePlaythroughs()])
      .then(([charItems, campaignItems, worldItems, activeItems]) => {
        setCharacters(charItems)
        setCampaigns(campaignItems)
        setWorlds(worldItems)
        setActiveGames(activeItems)
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Falha ao carregar personagens'))
      .finally(() => setLoading(false))
  }, [uid])

  function openPlay(character: Character) {
    setError('')
    setPlayCharacter(character)
  }

  async function confirmPlay(campaignId: string) {
    if (!playCharacter || startingId) return
    setStartingId(playCharacter.id)
    setError('')
    try {
      const { sessionId } = await startSession({
        characterId: playCharacter.id,
        campaignId
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
          <p className="page-list-subtitle muted">Fichas, perícias e a porta de entrada para a sessão.</p>
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

          const characterGames = activeGames.filter((g) => g.characterId === character.id)
          const singleGame = characterGames.length === 1 ? characterGames[0] : null
          const singleCampaign = singleGame ? campaigns.find((c) => c.id === singleGame.campaignId) : null

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

                {characterGames.length > 0 && (
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      padding: '6px 10px',
                      borderRadius: 'var(--radius-sm)',
                      background: 'rgba(34, 197, 94, 0.12)',
                      border: '1px solid rgba(34, 197, 94, 0.3)',
                      color: '#4ade80',
                      fontSize: '0.8rem',
                      fontWeight: 600
                    }}
                  >
                    <span className="pulse-dot" />
                    <span>
                      {characterGames.length === 1
                        ? `Jogo iniciado: ${singleCampaign?.name || 'Campanha'}`
                        : `${characterGames.length} jogos em andamento`}
                    </span>
                  </div>
                )}

                <p className="char-subtitle muted">
                  {[character.profession, character.race]
                    .filter(Boolean)
                    .join(' • ') || 'Sem profissão'}
                </p>

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
                  characterGames.length === 1 ? (
                    <div style={{ display: 'flex', gap: 8, width: '100%' }}>
                      <button
                        className="btn-play"
                        type="button"
                        style={{ flex: 1 }}
                        onClick={(e) => {
                          e.stopPropagation()
                          navigate(`/game/${characterGames[0].sessionId}`)
                        }}
                      >
                        ▶ Continuar Jogo
                      </button>
                      <button
                        className="button-secondary"
                        type="button"
                        title="Jogar em outra campanha"
                        style={{ padding: '0 10px', fontSize: '0.82rem' }}
                        onClick={(e) => {
                          e.stopPropagation()
                          openPlay(character)
                        }}
                      >
                        + Nova
                      </button>
                    </div>
                  ) : (
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
                      ) : characterGames.length > 1 ? (
                        <>▶ Continuar Jogo ({characterGames.length})</>
                      ) : (
                        <>▶ Iniciar Jogo</>
                      )}
                    </button>
                  )
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
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <p className="muted" style={{ margin: 0 }}>
                    Nenhuma campanha disponível neste universo. Crie uma campanha para jogar.
                  </p>
                  <button
                    type="button"
                    className="button-primary"
                    onClick={() => {
                      setPlayCharacter(null)
                      if (playWorldId) {
                        navigate(`/worlds/${playWorldId}/campaigns/new`)
                      } else {
                        navigate('/campaigns')
                      }
                    }}
                  >
                    + Criar campanha
                  </button>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {playCampaigns.map((c) => {
                    const hasActiveInCamp = activeGames.some(
                      (g) => g.characterId === playCharacter.id && g.campaignId === c.id
                    )
                    return (
                      <button
                        key={c.id}
                        type="button"
                        className={hasActiveInCamp ? 'button-primary' : 'button-secondary'}
                        disabled={Boolean(startingId)}
                        onClick={() => confirmPlay(c.id)}
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          padding: '10px 14px'
                        }}
                      >
                        <span style={{ fontWeight: 600 }}>
                          {startingId === playCharacter.id ? 'Abrindo…' : (c.name || 'Campanha sem nome')}
                        </span>
                        <span style={{ fontSize: '0.78rem', opacity: 0.85 }}>
                          {hasActiveInCamp ? '▶ Retomar jogo' : '+ Iniciar nova partida'}
                        </span>
                      </button>
                    )
                  })}
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
