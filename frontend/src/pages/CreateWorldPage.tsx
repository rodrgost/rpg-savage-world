import { FormEvent, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import {
  createWorld,
  deleteWorld,
  generateWorldImagePreview,
  generateWorldGuide,
  getWorld,
  updateWorld
} from '../lib/api'
import type { Visibility, WorldGuide } from '../types'
import { renderWorldGuideMarkdown } from '../types'

type StoredImage = {
  mimeType: string
  base64: string
}

type Props = {
  uid: string
}

export function CreateWorldPage({ uid }: Props) {
  const navigate = useNavigate()
  const { worldId } = useParams<{ worldId: string }>()
  const isEditMode = !!worldId

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [worldGuide, setWorldGuide] = useState<WorldGuide | undefined>()
  const [loreUserInstruction, setLoreUserInstruction] = useState('')
  const [ownerId, setOwnerId] = useState('')
  const [visibility, setVisibility] = useState<Visibility>('private')
  const [imagePreview, setImagePreview] = useState<StoredImage | null>(null)
  const [loading, setLoading] = useState(false)
  const [loreLoading, setLoreLoading] = useState(false)
  const [imageLoading, setImageLoading] = useState(false)
  const [error, setError] = useState('')
  const isOwner = !isEditMode || !ownerId || ownerId === uid
  const worldGuideMarkdown = renderWorldGuideMarkdown(worldGuide)

  useEffect(() => {
    window.scrollTo(0, 0)
  }, [worldId])

  useEffect(() => {
    async function loadData() {
      try {
        if (isEditMode && worldId) {
          const world = await getWorld(worldId)
          setOwnerId(world.ownerId)
          setVisibility(world.visibility)
          setName(world.name)
          setDescription(world.description ?? '')
          setWorldGuide(world.worldGuide)
          setImagePreview(world.image ?? null)
        }
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : 'Falha ao carregar dados')
      }
    }
    loadData()
  }, [isEditMode, worldId])

  async function handleGenerateImage() {
    if (isEditMode && !isOwner) return

    if (!name.trim()) {
      setError('Informe o nome do universo antes de gerar imagem.')
      return
    }

    setError('')
    setImageLoading(true)

    try {
      const image = await generateWorldImagePreview({ name })
      setImagePreview(image)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Falha ao gerar imagem do universo')
    } finally {
      setImageLoading(false)
    }
  }

  async function handleGenerateLore() {
    if (!isOwner) return

    if (isEditMode && worldId) {
      // For existing worlds, use the server-side generation that saves automatically
      setError('')
      setLoreLoading(true)
      try {
        const generated = await generateWorldGuide(worldId, {
          userInstruction: loreUserInstruction
        })
        setWorldGuide(generated.worldGuide)
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : 'Falha ao gerar guia do universo')
      } finally {
        setLoreLoading(false)
      }
    } else {
      // No modo de criação, salva o universo primeiro e redireciona para edição
      if (!name.trim()) {
        setError('Informe o nome do universo antes de gerar guia.')
        return
      }
      setError('')
      setLoading(true)
      try {
        const newWorldId = await createWorld({
          name,
          description,
          worldGuide,
          visibility,
          image: imagePreview ?? undefined
        })
        await generateWorldGuide(newWorldId, {
          userInstruction: loreUserInstruction
        })
        navigate(`/worlds/${newWorldId}/edit`)
      } catch (saveError) {
        setError(saveError instanceof Error ? saveError.message : 'Falha ao salvar universo')
      } finally {
        setLoading(false)
      }
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!uid || (isEditMode && !isOwner)) return

    setError('')
    setLoading(true)

    try {
      if (isEditMode && worldId) {
        await updateWorld(worldId, { name, description, worldGuide, visibility, image: imagePreview ?? undefined })
      } else {
        await createWorld({ name, description, worldGuide, visibility, image: imagePreview ?? undefined })
      }
      navigate('/worlds')
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : isEditMode ? 'Falha ao atualizar universo' : 'Falha ao criar universo')
    } finally {
      setLoading(false)
    }
  }

  async function handleDeleteWorld() {
    if (!isEditMode || !worldId) return
    if (loading || loreLoading || imageLoading) return

    const confirmed = window.confirm('Excluir este universo? Todas as campanhas e personagens dentro dele serão perdidos. Esta ação não pode ser desfeita.')
    if (!confirmed) return

    setError('')
    setLoading(true)
    try {
      await deleteWorld(worldId)
      navigate('/worlds')
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Falha ao excluir universo')
    } finally {
      setLoading(false)
    }
  }

  return (
    <section className="panel page-world-create">
      <h2>{isEditMode ? 'Edição de Universo' : 'Criação de Universo'}</h2>
      <p className="muted">{isEditMode ? 'Edite os dados do universo selecionado.' : 'Crie um novo universo que servirá como cenário para suas campanhas.'}</p>
      {isEditMode && !isOwner && <p className="muted readonly-note">Este universo está disponível somente para leitura para você.</p>}

      <form className="form-grid" onSubmit={handleSubmit}>
        <label>
          Nome do universo
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Ex: Terras de Aethermoor"
            disabled={isEditMode && !isOwner}
            required
          />
        </label>

        <label>
          Descrição do universo
          <textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="Ex: Uma cidade-estado suspensa onde magia industrial é regulada por guildas rivais."
            rows={3}
            disabled={isEditMode && !isOwner}
          />
        </label>

        {(!isEditMode || isOwner) && (
          <button
            className="btn-ai-gen"
            disabled={imageLoading || loreLoading || loading || !name.trim()}
            onClick={handleGenerateImage}
            type="button"
          >
            {imageLoading ? <><span className="btn-ai-spinner" /> Gerando imagem…</> : '🎨 Gerar imagem do universo'}
          </button>
        )}

        {imagePreview && (
          <div className="image-preview" role="region" aria-label="Prévia da imagem do universo">
            <img
              alt="Prévia da imagem do universo"
              className="image-preview-img image-preview-img--world"
              src={`data:${imagePreview.mimeType};base64,${imagePreview.base64}`}
            />
          </div>
        )}

        <label>
          Instrução do usuário para criar o guia
          <textarea
            value={loreUserInstruction}
            onChange={(event) => setLoreUserInstruction(event.target.value)}
            placeholder="Ex: Quero um mundo com foco em intriga política, tecnologia rara e magia perigosa."
            rows={4}
            disabled={!isOwner || loreLoading || imageLoading || loading}
          />
          <span className="muted">Este campo não é salvo. Ele serve apenas para orientar a próxima geração do guia de universo com IA.</span>
        </label>

        {isOwner && (
          <button className="btn-ai-gen" disabled={loreLoading || imageLoading || loading} onClick={handleGenerateLore} type="button">
            {loreLoading ? <><span className="btn-ai-spinner" /> Gerando guia…</> : '✨ Gerar guia com IA'}
          </button>
        )}

        <div className="lore-section">
          <div className="lore-section-header">
            <span className="lore-section-title">Guia do universo</span>
          </div>

          <div className="lore-preview markdown-view">
            {worldGuideMarkdown.trim() ? (
              <Markdown remarkPlugins={[remarkGfm]}>{worldGuideMarkdown}</Markdown>
            ) : (
              <p className="muted">Nenhum guia ainda. Gere com IA para preencher os campos canônicos do universo.</p>
            )}
          </div>
        </div>

        <p className="muted">As regras do jogo são baseadas em Savage Worlds.</p>

        <label>
          Visibilidade
          <select value={visibility} onChange={(event) => setVisibility(event.target.value as Visibility)} disabled={isEditMode && !isOwner}>
            <option value="private">Privado</option>
            <option value="public">Público</option>
          </select>
        </label>

        {(!isEditMode || isOwner) && (
          <button disabled={loading || loreLoading || imageLoading || !uid || !name.trim()} type="submit">
            {loading ? (isEditMode ? 'Salvando...' : 'Criando...') : isEditMode ? 'Salvar universo' : 'Criar universo'}
          </button>
        )}

        {isEditMode && (
          <>
            <button
              className="button-secondary"
              onClick={() => navigate(`/worlds/${worldId}/campaigns`)}
              type="button"
            >
              Ver campanhas deste universo
            </button>

            {isOwner && (
              <button
                className="button-danger"
                disabled={loading || loreLoading || imageLoading}
                onClick={handleDeleteWorld}
                type="button"
              >
                Excluir universo
              </button>
            )}
          </>
        )}

        <button className="button-secondary" onClick={() => navigate('/worlds')} type="button">
          Voltar para lista
        </button>

        {!uid && <p className="muted">Aguardando autenticação anônima...</p>}
        {error && <p className="error">{error}</p>}
      </form>
    </section>
  )
}
