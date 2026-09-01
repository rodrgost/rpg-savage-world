import { FormEvent, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import {
  createCampaign,
  deleteCampaign,
  generateCampaignImagePreview,
  getCampaign,
  getWorld,
  incrementCampaignStoryPreview,
  updateCampaign
} from '../lib/api'
import type { StoryCharacter, Visibility, CampaignMission } from '../types'

type StoredImage = {
  mimeType: string
  base64: string
}

type Props = {
  uid: string
}

export function CreateCampaignPage({ uid }: Props) {
  const navigate = useNavigate()
  const { worldId, campaignId } = useParams<{ worldId?: string; campaignId?: string }>()
  const isEditMode = !!campaignId

  const [resolvedWorldId, setResolvedWorldId] = useState(worldId ?? '')
  const [worldName, setWorldName] = useState('')
  const [ownerId, setOwnerId] = useState('')
  const [visibility, setVisibility] = useState<Visibility>('private')
  const [name, setName] = useState('')
  const [storyDescription, setStoryDescription] = useState('')
  const [storyDescriptionEn, setStoryDescriptionEn] = useState('')
  const [storyDetails, setStoryDetails] = useState('')
  const [storyDetailsEn, setStoryDetailsEn] = useState('')
  const [storyMissions, setStoryMissions] = useState<CampaignMission[]>([])
  const [storyCharacters, setStoryCharacters] = useState<StoryCharacter[]>([])
  const [imagePreview, setImagePreview] = useState<StoredImage | null>(null)
  const [youtubeUrl, setYoutubeUrl] = useState('')
  const [loading, setLoading] = useState(false)
  const [llmLoading, setLlmLoading] = useState(false)
  const [imageLoading, setImageLoading] = useState(false)
  const [storyTab, setStoryTab] = useState<'preview' | 'edit'>('preview')
  const [detailsTab, setDetailsTab] = useState<'preview' | 'edit'>('preview')
  const [error, setError] = useState('')
  const isOwner = !isEditMode || !ownerId || ownerId === uid

  useEffect(() => {
    window.scrollTo(0, 0)
  }, [campaignId, worldId])

  // Load world name
  useEffect(() => {
    async function loadWorld() {
      const wId = resolvedWorldId
      if (!wId) return
      try {
        const world = await getWorld(wId)
        setWorldName(world.name)
      } catch { /* ignore */ }
    }
    loadWorld()
  }, [resolvedWorldId])

  // Load campaign data
  useEffect(() => {
    async function loadData() {
      if (!campaignId) return
      try {
        const campaign = await getCampaign(campaignId)
        setOwnerId(campaign.ownerId)
        setVisibility(campaign.visibility)
        setResolvedWorldId(campaign.worldId)
        setName(campaign.name ?? '')
        setStoryDescription(campaign.storyDescription ?? '')
        setStoryDescriptionEn(campaign.storyDescriptionEn ?? '')
        setStoryDetails(campaign.storyDetails ?? '')
        setStoryDetailsEn(campaign.storyDetailsEn ?? '')
        setStoryMissions(campaign.storyMissions ?? [])
        setStoryCharacters(campaign.storyCharacters ?? [])
        setImagePreview(campaign.image ?? null)
        setYoutubeUrl(campaign.youtubeUrl ?? '')
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : 'Falha ao carregar dados')
      }
    }
    loadData()
  }, [campaignId])

  async function handleGenerateImage() {
    if (!isOwner) return

    setError('')
    setImageLoading(true)

    try {
      const image = await generateCampaignImagePreview({ name: name.trim() || undefined, storyDescription: (storyDescriptionEn.trim() || storyDescription.trim()) || undefined, worldId: resolvedWorldId || undefined })
      setImagePreview(image)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Falha ao gerar imagem da campanha')
    } finally {
      setImageLoading(false)
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!uid || (isEditMode && !isOwner)) return

    setError('')
    setLoading(true)

    try {
      if (isEditMode && campaignId) {
        await updateCampaign(campaignId, {
          name: name.trim() || undefined,
          storyDescription,
          storyDescriptionEn: storyDescriptionEn.trim() || undefined,
          storyDetails: storyDetails.trim() || undefined,
          storyDetailsEn: storyDetailsEn.trim() || undefined,
          storyMissions: storyMissions.length > 0 ? storyMissions : undefined,
          storyCharacters: storyCharacters.length > 0 ? storyCharacters : undefined,
          visibility,
          image: imagePreview ?? undefined,
          youtubeUrl: youtubeUrl.trim() || undefined
        })
        navigate(`/worlds/${resolvedWorldId}/campaigns`)
      } else {
        await createCampaign({
          worldId: resolvedWorldId,
          name: name.trim() || undefined,
          storyDescription,
          storyDescriptionEn: storyDescriptionEn.trim() || undefined,
          storyDetails: storyDetails.trim() || undefined,
          storyDetailsEn: storyDetailsEn.trim() || undefined,
          storyMissions: storyMissions.length > 0 ? storyMissions : undefined,
          visibility,
          image: imagePreview ?? undefined,
          youtubeUrl: youtubeUrl.trim() || undefined
        })
        navigate(`/worlds/${resolvedWorldId}/campaigns`)
      }
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : isEditMode ? 'Falha ao atualizar campanha' : 'Falha ao criar campanha')
    } finally {
      setLoading(false)
    }
  }

  async function handleDeleteCampaign() {
    if (!isEditMode || !campaignId) return
    if (loading || llmLoading || imageLoading) return

    const confirmed = window.confirm('Excluir esta campanha? Os personagens e sessões vinculados serão perdidos. Esta ação não pode ser desfeita.')
    if (!confirmed) return

    setError('')
    setLoading(true)
    try {
      await deleteCampaign(campaignId)
      navigate(`/worlds/${resolvedWorldId}/campaigns`)
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Falha ao excluir campanha')
    } finally {
      setLoading(false)
    }
  }

  async function handleGenerateWithLlm() {
    setError('')
    setLlmLoading(true)
    try {
      const result = await incrementCampaignStoryPreview({ worldName, worldId: resolvedWorldId || undefined })
      setStoryDescription(result.storyDescription)
      setStoryDescriptionEn(result.storyDescriptionEn ?? '')
      setStoryDetails(result.storyDetails ?? '')
      setStoryDetailsEn(result.storyDetailsEn ?? '')
      setStoryMissions(result.storyMissions)
      setStoryCharacters(result.storyCharacters)
      setName(result.name ?? '')
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Falha ao gerar campanha com LLM')
    } finally {
      setLlmLoading(false)
    }
  }

  const backPath = resolvedWorldId ? `/worlds/${resolvedWorldId}/campaigns` : '/worlds'

  return (
    <section className="panel page-world-create">
      <h2>{isEditMode ? 'Edição de Campanha' : 'Nova Campanha'}</h2>
      <p className="muted">
        {worldName ? `Universo: ${worldName}` : 'Carregando universo...'}
        {isEditMode ? ' — Edite os dados da campanha.' : ' — Configure a temática e história desta campanha.'}
      </p>
      {isEditMode && !isOwner && <p className="muted readonly-note">Esta campanha está disponível somente para leitura para você.</p>}

      <form className="form-grid" onSubmit={handleSubmit}>
        {isOwner && (
          <div className="llm-actions-top">
            <button disabled={llmLoading || loading} onClick={handleGenerateWithLlm} type="button">
              {llmLoading ? 'Gerando com LLM...' : 'Gerar campanha com LLM'}
            </button>
          </div>
        )}

        <label>
          Nome da campanha
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Ex: A Queda dos Reis"
            disabled={!isOwner}
          />
        </label>

        {isOwner && (
          <button
            disabled={imageLoading || llmLoading || loading}
            onClick={handleGenerateImage}
            type="button"
          >
            {imageLoading ? 'Gerando imagem...' : 'Gerar imagem da campanha'}
          </button>
        )}

        {imagePreview && (
          <div className="image-preview" role="region" aria-label="Prévia da imagem da campanha">
            <img
              alt="Prévia da imagem da campanha"
              className="image-preview-img image-preview-img--world"
              src={`data:${imagePreview.mimeType};base64,${imagePreview.base64}`}
            />
          </div>
        )}

        <div className="lore-section">
          <div className="lore-section-header">
            <span className="lore-section-title">Introdução da campanha (o jogador vê)</span>
            {isOwner && (
              <div className="lore-tabs">
                <button
                  type="button"
                  className={`lore-tab${storyTab === 'preview' ? ' active' : ''}`}
                  onClick={() => setStoryTab('preview')}
                >
                  📖 Visualizar
                </button>
                <button
                  type="button"
                  className={`lore-tab${storyTab === 'edit' ? ' active' : ''}`}
                  onClick={() => setStoryTab('edit')}
                >
                  ✏️ Editar
                </button>
              </div>
            )}
          </div>
          <p className="muted">Texto curto (1-2 parágrafos), sem revelar tramas ou reviravoltas — é a única parte da história exibida ao jogador.</p>

          {storyTab === 'edit' && isOwner ? (
            <textarea
              className="lore-textarea"
              value={storyDescription}
              onChange={(event) => setStoryDescription(event.target.value)}
              placeholder="Clique no botão para gerar com LLM"
              rows={6}
            />
          ) : (
            <div className="lore-preview markdown-view">
              {storyDescription.trim() ? (
                <Markdown remarkPlugins={[remarkGfm]}>{storyDescription}</Markdown>
              ) : (
                <p className="muted">Nenhuma introdução ainda. {isOwner ? 'Gere com LLM ou edite manualmente.' : ''}</p>
              )}
            </div>
          )}
        </div>

        <div className="lore-section">
          <div className="lore-section-header">
            <span className="lore-section-title">Detalhes estratégicos (uso do narrador — o jogador NÃO vê)</span>
            {isOwner && (
              <div className="lore-tabs">
                <button
                  type="button"
                  className={`lore-tab${detailsTab === 'preview' ? ' active' : ''}`}
                  onClick={() => setDetailsTab('preview')}
                >
                  📖 Visualizar
                </button>
                <button
                  type="button"
                  className={`lore-tab${detailsTab === 'edit' ? ' active' : ''}`}
                  onClick={() => setDetailsTab('edit')}
                >
                  ✏️ Editar
                </button>
              </div>
            )}
          </div>

          {detailsTab === 'edit' && isOwner ? (
            <textarea
              className="lore-textarea"
              value={storyDetails}
              onChange={(event) => setStoryDetails(event.target.value)}
              placeholder="Clique no botão para gerar com LLM"
              rows={16}
            />
          ) : (
            <div className="lore-preview markdown-view">
              {storyDetails.trim() ? (
                <Markdown remarkPlugins={[remarkGfm]}>{storyDetails}</Markdown>
              ) : (
                <p className="muted">Nenhum detalhe ainda. {isOwner ? 'Gere com LLM ou edite manualmente.' : ''}</p>
              )}
            </div>
          )}
        </div>

        {storyMissions.length > 0 && (
          <div className="lore-section">
            <div className="lore-section-header">
              <span className="lore-section-title">Missões da campanha</span>
            </div>
            <div className="story-characters-grid">
              {storyMissions.map((mission, index) => (
                <div key={index} className="story-character-card">
                  <div className="story-character-header">
                    <strong className="story-character-name">{mission.title}</strong>
                    <span className="story-character-role">{mission.optional ? 'Opcional' : 'Principal'}</span>
                  </div>
                  {mission.description && <p className="story-character-description">{mission.description}</p>}
                </div>
              ))}
            </div>
          </div>
        )}

        {storyCharacters.length > 0 && (
          <div className="lore-section">
            <div className="lore-section-header">
              <span className="lore-section-title">Personagens relevantes da história</span>
            </div>
            <div className="story-characters-grid">
              {storyCharacters.map((char, index) => (
                <div key={index} className="story-character-card">
                  <div className="story-character-header">
                    <strong className="story-character-name">{char.name}</strong>
                    <span className="story-character-role">{char.role}</span>
                  </div>
                  {char.description && <p className="story-character-description">{char.description}</p>}
                  <span className="story-character-status">{char.status}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        <label>
          Música ambiente (YouTube)
          <input
            type="url"
            value={youtubeUrl}
            onChange={(event) => setYoutubeUrl(event.target.value)}
            placeholder="https://www.youtube.com/watch?v=... ou https://youtu.be/..."
            disabled={!isOwner}
          />
        </label>

        <label>
          Visibilidade
          <select value={visibility} onChange={(event) => setVisibility(event.target.value as Visibility)} disabled={!isOwner}>
            <option value="private">Privada</option>
            <option value="public">Pública</option>
          </select>
        </label>

        {isOwner && (
          <button disabled={loading || llmLoading || !uid} type="submit">
            {loading ? (isEditMode ? 'Salvando...' : 'Criando...') : isEditMode ? 'Salvar campanha' : 'Criar campanha'}
          </button>
        )}

        {isEditMode && isOwner && (
          <button
            className="button-danger"
            disabled={loading || llmLoading || imageLoading}
            onClick={handleDeleteCampaign}
            type="button"
          >
            Excluir campanha
          </button>
        )}

        <button className="button-secondary" onClick={() => navigate(backPath)} type="button">
          Voltar para lista
        </button>

        {!uid && <p className="muted">Aguardando autenticação anônima...</p>}
        {error && <p className="error">{error}</p>}
      </form>
    </section>
  )
}
