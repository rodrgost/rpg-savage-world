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
import type { Visibility } from '../types'

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
  const [thematic, setThematic] = useState('')
  const [storyDescription, setStoryDescription] = useState('')
  const [imagePreview, setImagePreview] = useState<StoredImage | null>(null)
  const [youtubeUrl, setYoutubeUrl] = useState('')
  const [lastGeneratedContextKey, setLastGeneratedContextKey] = useState('')
  const [loading, setLoading] = useState(false)
  const [llmLoading, setLlmLoading] = useState(false)
  const [imageLoading, setImageLoading] = useState(false)
  const [storyTab, setStoryTab] = useState<'preview' | 'edit'>('preview')
  const [error, setError] = useState('')
  const isOwner = !isEditMode || !ownerId || ownerId === uid

  function buildContextKey(wName: string, theme: string): string {
    return `${wName.trim().toLowerCase()}::${theme.trim().toLowerCase()}`
  }

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

  // Load existing campaign in edit mode
  useEffect(() => {
    async function loadData() {
      try {
        if (isEditMode && campaignId) {
          const campaign = await getCampaign(campaignId)
          setOwnerId(campaign.ownerId)
          setVisibility(campaign.visibility)
          setResolvedWorldId(campaign.worldId)
          setThematic(campaign.thematic)
          setStoryDescription(campaign.storyDescription ?? '')
          setImagePreview(campaign.image ?? null)
          setYoutubeUrl(campaign.youtubeUrl ?? '')
        }
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : 'Falha ao carregar dados')
      }
    }
    loadData()
  }, [isEditMode, campaignId])

  async function handleGenerateImage() {
    if (isEditMode && !isOwner) return

    if (!thematic.trim()) {
      setError('Informe a temática antes de gerar imagem.')
      return
    }

    setError('')
    setImageLoading(true)

    try {
      const image = await generateCampaignImagePreview(
        isEditMode && campaignId
          ? { campaignId, thematic }
          : { worldName, thematic }
      )
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
          thematic,
          storyDescription,
          visibility,
          image: imagePreview ?? undefined,
          youtubeUrl: youtubeUrl.trim() || undefined
        })
        navigate(`/worlds/${resolvedWorldId}/campaigns`)
      } else {
        await createCampaign({
          worldId: resolvedWorldId,
          thematic,
          storyDescription,
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

  async function handleIncrementWithLlm() {
    if (!worldName.trim() || !thematic.trim()) {
      setError('Informe a temática antes de incrementar com LLM.')
      return
    }

    setError('')
    setLlmLoading(true)
    try {
      const contextKey = buildContextKey(worldName, thematic)
      const shouldContinuePreviousContext = contextKey === lastGeneratedContextKey

      const nextDescription = await incrementCampaignStoryPreview({
        worldName,
        thematic,
        currentDescription: shouldContinuePreviousContext ? storyDescription : undefined
      })
      setStoryDescription(nextDescription)
      setLastGeneratedContextKey(contextKey)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Falha ao incrementar campanha com LLM')
    } finally {
      setLlmLoading(false)
    }
  }

  const currentContextKey = buildContextKey(worldName, thematic)
  const hasPendingContextChange = !!lastGeneratedContextKey && currentContextKey !== lastGeneratedContextKey
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
        <label>
          Temática / era da campanha
          <input
            value={thematic}
            onChange={(event) => setThematic(event.target.value)}
            placeholder="Ex: Reinos Fragmentados e magia decadente"
            readOnly={isEditMode}
            disabled={isEditMode}
            required
          />
        </label>

        {(!isEditMode || isOwner) && (
          <button
            disabled={imageLoading || llmLoading || loading || !thematic.trim()}
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
            <span className="lore-section-title">História / descrição da campanha</span>
            {!isEditMode && (
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

          {!isEditMode && storyTab === 'edit' ? (
            <textarea
              className="lore-textarea"
              value={storyDescription}
              onChange={(event) => setStoryDescription(event.target.value)}
              placeholder="Clique no botão para incrementar com LLM"
              rows={20}
            />
          ) : (
            <div className="lore-preview markdown-view">
              {storyDescription.trim() ? (
                <Markdown remarkPlugins={[remarkGfm]}>{storyDescription}</Markdown>
              ) : (
                <p className="muted">Nenhuma história ainda. {isEditMode ? '' : 'Gere com LLM ou edite manualmente.'}</p>
              )}
            </div>
          )}

          {!isEditMode && hasPendingContextChange && (
            <p className="muted">Parâmetros alterados. O próximo incremento vai gerar um novo contexto.</p>
          )}

          {!isEditMode && (
            <button disabled={llmLoading || loading || !thematic.trim()} onClick={handleIncrementWithLlm} type="button">
              {llmLoading ? 'Incrementando com LLM...' : 'Incrementar história com LLM'}
            </button>
          )}
        </div>

        <label>
          Música ambiente (YouTube)
          <input
            type="url"
            value={youtubeUrl}
            onChange={(event) => setYoutubeUrl(event.target.value)}
            placeholder="https://www.youtube.com/watch?v=... ou https://youtu.be/..."
            disabled={isEditMode && !isOwner}
          />
        </label>

        <label>
          Visibilidade
          <select value={visibility} onChange={(event) => setVisibility(event.target.value as Visibility)} disabled={isEditMode && !isOwner}>
            <option value="private">Privada</option>
            <option value="public">Pública</option>
          </select>
        </label>

        {(!isEditMode || isOwner) && (
          <button disabled={loading || llmLoading || !uid || !thematic.trim()} type="submit">
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
