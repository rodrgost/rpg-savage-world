import { FormEvent, useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'

import {
  createCharacter,
  deleteCharacter,
  generateCharacterFromWorldStory,
  generateCharacterImagePreview,
  getCharacter,
  listCampaigns,
  listWorlds,
  updateCharacter
} from '../lib/api'
import type { Campaign, DieType, Hindrance, Visibility, World } from '../types'
import {
  ATTRIBUTES,
  ATTRIBUTE_KEYS,
  CHARACTER_CREATION,
  DIE_OPTIONS,
  EDGES,
  HINDRANCES,
  SKILLS,
  calcHindrancePoints,
  calcHindrancePointsSpent,
  calcParry,
  calcToughness,
  checkEdgeRequirements,
  validateHindranceLimits,
} from '../data/savage-worlds'
import type { HindrancePointsAllocation } from '../data/savage-worlds'

type StoredImage = { mimeType: string; base64: string }
type Props = { uid: string }

const ATTR_ICONS: Record<string, string> = {
  agility: '⚡', smarts: '🧠', spirit: '🔥', strength: '💪', vigor: '🛡️',
}

function defaultAttributes(): Record<string, DieType> {
  return Object.fromEntries(ATTRIBUTE_KEYS.map((k) => [k, 4 as DieType]))
}

function countAttributeSteps(attrs: Record<string, number>): number {
  return ATTRIBUTE_KEYS.reduce((sum, k) => sum + ((attrs[k] ?? 4) - 4) / 2, 0)
}

function countSkillSteps(skills: Record<string, number>): number {
  let cost = 0
  for (const [, die] of Object.entries(skills)) {
    if (die >= 4) cost += 1 + (die - 4) / 2
  }
  return cost
}

/* ── Die Selector Component ─── */
function DieSelector({ value, onChange }: { value: DieType; onChange: (v: DieType) => void }) {
  return (
    <div className="die-selector">
      {DIE_OPTIONS.map((d) => (
        <button
          key={d.value}
          type="button"
          className={`die-btn ${value === d.value ? 'active' : ''}`}
          onClick={() => onChange(d.value)}
        >
          {d.label}
        </button>
      ))}
    </div>
  )
}

/* ── Skills grouped by linked attribute ─── */
function groupSkillsByAttribute() {
  const groups: Record<string, typeof SKILLS> = {}
  for (const sk of SKILLS) {
    const attr = sk.linkedAttribute
    if (!groups[attr]) groups[attr] = []
    groups[attr].push(sk)
  }
  return groups
}

const SKILL_GROUPS = groupSkillsByAttribute()

/* ── Edge groups by category ─── */
function groupEdgesByCategory() {
  const groups: Record<string, typeof EDGES> = {}
  for (const edge of EDGES) {
    if (!groups[edge.category]) groups[edge.category] = []
    groups[edge.category].push(edge)
  }
  return groups
}

const EDGE_GROUPS = groupEdgesByCategory()

export function CreateCharacterPage({ uid }: Props) {
  const navigate = useNavigate()
  const { characterId } = useParams<{ characterId: string }>()
  const isEditMode = Boolean(characterId)

  /* ---------- State ---------- */
  const [worlds, setWorlds] = useState<World[]>([])
  const [selectedWorldId, setSelectedWorldId] = useState('')
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [selectedCampaignId, setSelectedCampaignId] = useState('')
  const [ownerId, setOwnerId] = useState('')
  const [visibility, setVisibility] = useState<Visibility>('private')
  const [name, setName] = useState('')
  const [gender, setGender] = useState('')
  const [race, setRace] = useState('')
  const [characterClass, setCharacterClass] = useState('')
  const [profession, setProfession] = useState('')
  const [description, setDescription] = useState('')
  const [attributes, setAttributes] = useState<Record<string, DieType>>(defaultAttributes)
  const [skills, setSkills] = useState<Record<string, DieType>>({})
  const [selectedEdges, setSelectedEdges] = useState<string[]>([])
  const [selectedHindrances, setSelectedHindrances] = useState<Hindrance[]>([])
  const [image, setImage] = useState<StoredImage | undefined>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [suggestLoading, setSuggestLoading] = useState(false)
  const [imageLoading, setImageLoading] = useState(false)
  const [hindranceAllocation, setHindranceAllocation] = useState<HindrancePointsAllocation>({
    extraEdges: 0, extraAttributePoints: 0, extraSkillPoints: 0,
  })

  /* ---------- Derived ---------- */
  const attrPointsTotal = CHARACTER_CREATION.attributePoints + hindranceAllocation.extraAttributePoints
  const attrPointsUsed = useMemo(() => countAttributeSteps(attributes), [attributes])
  const attrPointsLeft = attrPointsTotal - attrPointsUsed

  const skillPointsTotal = CHARACTER_CREATION.skillPoints + hindranceAllocation.extraSkillPoints
  const skillPointsUsed = useMemo(() => countSkillSteps(skills), [skills])
  const skillPointsLeft = skillPointsTotal - skillPointsUsed
  const selectedCampaign = campaigns.find((campaign) => campaign.id === selectedCampaignId)
  const isOwner = !isEditMode || !ownerId || ownerId === uid
  const isReadOnly = isEditMode && !isOwner

  const fightingDie = skills['Lutar'] ?? 0
  const vigorDie = attributes['vigor'] ?? 4
  const derivedParry = calcParry(fightingDie || 0)
  const derivedToughness = calcToughness(vigorDie)

  /* Hindrance budget */
  const hindrancePointsEarned = useMemo(
    () => calcHindrancePoints(selectedHindrances),
    [selectedHindrances],
  )
  const hindrancePointsSpent = useMemo(
    () => calcHindrancePointsSpent(hindranceAllocation),
    [hindranceAllocation],
  )
  const hindrancePointsLeft = hindrancePointsEarned - hindrancePointsSpent
  const hindranceLimits = useMemo(
    () => validateHindranceLimits(selectedHindrances),
    [selectedHindrances],
  )

  /* Max number of free edges from hindrance points */
  const freeEdgesAllowed = hindranceAllocation.extraEdges

  /* Edge eligibility cache */
  const edgeEligibility = useMemo(() => {
    const map: Record<string, { eligible: boolean; unmetRequirements: string[] }> = {}
    for (const edge of EDGES) {
      map[edge.key] = checkEdgeRequirements(edge, attributes, skills, selectedEdges)
    }
    return map
  }, [attributes, skills, selectedEdges])

  /* ---------- Load data ---------- */
  useEffect(() => {
    if (!uid) return
    listWorlds().then(setWorlds).catch(() => {})
  }, [uid])

  useEffect(() => {
    if (!uid) return
    listCampaigns(selectedWorldId || undefined).then(setCampaigns).catch(() => {})
    // Reset campaign selection when world changes
    if (!isEditMode) setSelectedCampaignId('')
  }, [uid, selectedWorldId])

  useEffect(() => {
    if (!isEditMode || !characterId || !uid) return
    getCharacter(characterId)
      .then((c) => {
        setOwnerId(c.ownerId)
        setVisibility(c.visibility)
        if (c.worldId) {
          setSelectedWorldId(c.worldId)
        } else {
          listCampaigns().then((allCampaigns) => {
            const camp = allCampaigns.find((ca) => ca.id === c.campaignId)
            if (camp?.worldId) setSelectedWorldId(camp.worldId)
          }).catch(() => {})
        }
        setSelectedCampaignId(c.campaignId)
        setName(c.name)
        setGender(c.gender ?? '')
        setRace(c.race ?? '')
        setCharacterClass(c.characterClass ?? '')
        setProfession(c.profession ?? '')
        setDescription(c.description ?? '')
        if (c.attributes) setAttributes(c.attributes as Record<string, DieType>)
        if (c.skills) setSkills(c.skills as Record<string, DieType>)
        if (c.edges) setSelectedEdges(c.edges)
        if (c.hindrances) setSelectedHindrances(c.hindrances)
        if (c.hindranceAllocation) setHindranceAllocation(c.hindranceAllocation)
        if (c.image) setImage(c.image)
      })
      .catch((loadError) => {
        setError(loadError instanceof Error ? loadError.message : 'Falha ao carregar personagem')
      })
  }, [isEditMode, characterId, uid])

  /* ---------- Handlers ---------- */
  function setAttr(key: string, value: DieType) {
    setAttributes((prev) => ({ ...prev, [key]: value }))
  }

  function toggleSkill(key: string) {
    setSkills((prev) => {
      const copy = { ...prev }
      if (copy[key]) { delete copy[key] } else { copy[key] = 4 }
      return copy
    })
  }

  function setSkillDie(key: string, value: DieType) {
    setSkills((prev) => ({ ...prev, [key]: value }))
  }

  function toggleEdge(key: string) {
    setSelectedEdges((prev) => {
      if (prev.includes(key)) return prev.filter((e) => e !== key)
      // Check eligibility
      const elig = edgeEligibility[key]
      if (elig && !elig.eligible) return prev
      // Max edges = freeEdgesAllowed (from hindrance points)
      if (prev.length >= freeEdgesAllowed) return prev
      return [...prev, key]
    })
  }

  function toggleHindrance(h: { key: string; severity: 'minor' | 'major' }) {
    setSelectedHindrances((prev) => {
      const exists = prev.find((x) => x.name === h.key)
      if (exists) return prev.filter((x) => x.name !== h.key)
      // Enforce limits
      const majorCount = prev.filter((x) => x.severity === 'major').length
      const minorCount = prev.filter((x) => x.severity === 'minor').length
      if (h.severity === 'major' && majorCount >= CHARACTER_CREATION.maxMajorHindrances) return prev
      if (h.severity === 'minor' && minorCount >= CHARACTER_CREATION.maxMinorHindrances) return prev
      return [...prev, { name: h.key, severity: h.severity }]
    })
  }

  function adjustAllocation(field: keyof HindrancePointsAllocation, delta: number) {
    setHindranceAllocation((prev) => {
      const next = { ...prev, [field]: Math.max(0, prev[field] + delta) }
      // Don't let spending exceed earned points
      if (calcHindrancePointsSpent(next) > hindrancePointsEarned) return prev
      return next
    })
  }

  async function handleSuggest() {
    if (!selectedCampaignId) return
    setSuggestLoading(true)
    setError('')
    try {
      // Pass only fields the user already edited so the AI respects them
      const existing: Record<string, string> = {}
      if (name.trim()) existing.name = name.trim()
      if (gender.trim()) existing.gender = gender.trim()
      if (race.trim()) existing.race = race.trim()
      if (characterClass.trim()) existing.characterClass = characterClass.trim()
      if (profession.trim()) existing.profession = profession.trim()
      //if (description.trim()) existing.description = description.trim()

      const suggestion = await generateCharacterFromWorldStory({
        campaignId: selectedCampaignId,
        existingFields: Object.keys(existing).length > 0 ? existing : undefined
      })

      // Only overwrite fields that the user had left empty
      if (!name.trim()) setName(suggestion.name)
      if (!gender.trim()) setGender(suggestion.gender)
      if (!race.trim()) setRace(suggestion.race)
      if (!characterClass.trim()) setCharacterClass(suggestion.characterClass)
      if (!profession.trim()) setProfession(suggestion.profession)
      if (!description.trim()) setDescription(suggestion.description)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao gerar sugestão por IA para este personagem')
    } finally {
      setSuggestLoading(false)
    }
  }

  async function handleImagePreview() {
    if (!selectedCampaignId || !profession || !characterClass) return
    setImageLoading(true)
    setError('')
    try {
      // Consolida o que o jogador já definiu para o backend melhorar a descrição visual do retrato.
      const parts: string[] = []
      if (name.trim()) parts.push(`Nome do personagem: ${name.trim()}`)
      if (description.trim()) parts.push(`Descrição base: ${description.trim()}`)
      if (selectedCampaign?.thematic?.trim()) parts.push(`Tom da campanha: ${selectedCampaign.thematic.trim()}`)
      if (selectedEdges.length > 0) {
        const labels = selectedEdges.map(k => EDGES.find(e => e.key === k)?.label ?? k)
        parts.push(`Traços marcantes: ${labels.join(', ')}`)
      }
      if (selectedHindrances.length > 0) {
        const labels = selectedHindrances.map(h => HINDRANCES.find(d => d.key === h.name)?.label ?? h.name)
        parts.push(`Complicações visíveis: ${labels.join(', ')}`)
      }

      const img = await generateCharacterImagePreview({
        campaignId: selectedCampaignId,
        gender,
        race,
        profession,
        characterClass,
        additionalDescription: parts.join('. ') || undefined
      })
      setImage(img)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao gerar imagem')
    } finally {
      setImageLoading(false)
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (isReadOnly) {
      setError('Somente o dono pode alterar este personagem.')
      return
    }
    setError('')
    if (!selectedCampaignId) { setError('Selecione uma campanha'); return }
    if (attrPointsLeft < 0) { setError('Pontos de atributo excedidos'); return }
    if (skillPointsLeft < 0) { setError('Pontos de perícia excedidos'); return }
    if (!hindranceLimits.valid) { setError(hindranceLimits.errors.join('. ')); return }
    if (hindrancePointsLeft < 0) { setError('Pontos de Complicações gastos em excesso'); return }
    // Validate edge requirements
    for (const edgeKey of selectedEdges) {
      const elig = edgeEligibility[edgeKey]
      if (elig && !elig.eligible) {
        const edgeDef = EDGES.find((ed) => ed.key === edgeKey)
        setError(`Vantagem "${edgeDef?.label ?? edgeKey}" não atende requisitos: ${elig.unmetRequirements.join(', ')}`)
        return
      }
    }

    setLoading(true)
    try {
      if (isEditMode && characterId) {
        await updateCharacter(characterId, {
          name, gender, race, characterClass, profession, description,
          visibility,
          attributes, skills, edges: selectedEdges, hindrances: selectedHindrances,
          hindranceAllocation, image
        })
      } else {
        await createCharacter({
          campaignId: selectedCampaignId,
          name, gender, race, characterClass, profession, description,
          visibility,
          attributes, skills, edges: selectedEdges, hindrances: selectedHindrances,
          hindranceAllocation, image
        })
      }
      navigate('/characters')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao salvar personagem')
    } finally {
      setLoading(false)
    }
  }

  /* ---------- Render ---------- */
  return (
    <section className="panel page-char-form">
      <h2 className="page-title">{isEditMode ? 'Editar Personagem' : 'Criar Personagem'}</h2>
      {isReadOnly && <p className="muted readonly-note">Este personagem está disponível somente para leitura para você.</p>}

      <form onSubmit={handleSubmit}>
        <fieldset className="form-fieldset-reset" disabled={isReadOnly}>
        {/* ═══════ DADOS BÁSICOS ═══════ */}
        <div className="section-card">
          <div className="section-card-header">
            <h3>📋 Informações Básicas</h3>
          </div>
          <div className="section-card-body form-stack">
            <label>
              Universo
              <select
                disabled={isEditMode}
                onChange={(e) => setSelectedWorldId(e.target.value)}
                value={selectedWorldId}
              >
                <option value="">Todos os universos</option>
                {worlds.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            </label>

            <label>
              Visibilidade
              <select value={visibility} onChange={(e) => setVisibility(e.target.value as Visibility)}>
                <option value="private">Privado</option>
                <option value="public">Público</option>
              </select>
            </label>

            {visibility === 'public' && selectedCampaign && selectedCampaign.visibility !== 'public' && (
              <p className="error" style={{ margin: 0 }}>
                Personagens públicos exigem uma campanha pública.
              </p>
            )}

            <label>
              Campanha
              <select
                disabled={isEditMode}
                onChange={(e) => setSelectedCampaignId(e.target.value)}
                value={selectedCampaignId}
              >
                <option value="">Selecione uma campanha</option>
                {campaigns.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.thematic}
                  </option>
                ))}
              </select>
            </label>

            {selectedCampaignId && (
              <div className="form-row-2">
                <button
                  className="button-secondary"
                  disabled={suggestLoading}
                  onClick={handleSuggest}
                  type="button"
                >
                  {suggestLoading ? 'Gerando sugestão...' : '✨ Sugerir pela IA'}
                </button>
                {(name || gender || race || characterClass || profession || description) && (
                  <button
                    className="button-danger-outline"
                    type="button"
                    onClick={() => {
                      setName(''); setGender(''); setRace('')
                      setCharacterClass(''); setProfession(''); setDescription('')
                      setImage(undefined)
                    }}
                  >
                    🗑️ Limpar campos
                  </button>
                )}
              </div>
            )}

            <label>
              Nome
              <input onChange={(e) => setName(e.target.value)} required type="text" value={name} placeholder="Nome do personagem" />
            </label>
            <div className="form-row-2">
              <label>
                Sexo
                <select value={gender} onChange={(e) => setGender(e.target.value)}>
                  <option value="">Não informado</option>
                  <option value="Masculino">Masculino</option>
                  <option value="Feminino">Feminino</option>
                  <option value="Outro">Outro</option>
                </select>
              </label>
              <label>
                Raça
                <input onChange={(e) => setRace(e.target.value)} type="text" value={race} placeholder="Ex: Humano, Elfo, Anão..." />
              </label>
            </div>
            <label>
              Classe / Conceito
              <input onChange={(e) => setCharacterClass(e.target.value)} required type="text" value={characterClass} placeholder="Ex: Guerreiro, Mago, Explorador..." />
            </label>
            <label>
              Profissão
              <input onChange={(e) => setProfession(e.target.value)} required type="text" value={profession} placeholder="Ex: Mercenário, Curandeiro..." />
            </label>
            <label>
              Descrição
              <textarea onChange={(e) => setDescription(e.target.value)} rows={3} value={description} placeholder="Aparência, personalidade, história..." />
            </label>
          </div>
        </div>

        {/* ═══════ IMAGEM ═══════ */}
        <div className="section-card">
          <div className="section-card-header">
            <h3>🖼️ Retrato</h3>
          </div>
          <div className="section-card-body">
            {image && (
              <div className="hero-image">
                <img
                  alt="Prévia do personagem"
                  src={`data:${image.mimeType};base64,${image.base64}`}
                />
              </div>
            )}
            <button
              className="button-secondary button-full"
              disabled={imageLoading || !selectedCampaignId || !profession || !characterClass}
              onClick={handleImagePreview}
              type="button"
              style={{ marginTop: image ? 'var(--space-3)' : 0 }}
            >
              {imageLoading ? 'Gerando imagem...' : '🖼️ Gerar imagem com IA'}
            </button>
          </div>
        </div>

        {/* ═══════ ATRIBUTOS ═══════ */}
        <div className="section-card">
          <div className="section-card-header">
            <h3>🎲 Atributos</h3>
            <span className={`badge ${attrPointsLeft < 0 ? 'badge--error' : attrPointsLeft === 0 ? 'badge--success' : 'badge--accent'}`}>
              {attrPointsLeft} / {attrPointsTotal} pts
            </span>
          </div>
          <div className="section-card-body">
            <div className="attr-list">
              {ATTRIBUTES.map((attr) => (
                <div key={attr.key} className="attr-row">
                  <div className="attr-icon">{ATTR_ICONS[attr.key] ?? '⬡'}</div>
                  <div className="attr-info">
                    <strong>{attr.label}</strong>
                    <small>{attr.description}</small>
                  </div>
                  <DieSelector
                    value={(attributes[attr.key] ?? 4) as DieType}
                    onChange={(v) => setAttr(attr.key, v)}
                  />
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* ═══════ PERÍCIAS ═══════ */}
        <div className="section-card">
          <div className="section-card-header">
            <h3>📖 Perícias</h3>
            <span className={`badge ${skillPointsLeft < 0 ? 'badge--error' : skillPointsLeft === 0 ? 'badge--success' : 'badge--accent'}`}>
              {skillPointsLeft} / {skillPointsTotal} pts
            </span>
          </div>
          <div className="section-card-body">
            <p className="section-card-hint" style={{ marginBottom: 'var(--space-3)' }}>
              Marque as perícias desejadas. Cada d4 = 1 pt, cada aumento = +1 pt.
            </p>

            {ATTRIBUTES.map((attr) => {
              const groupSkills = SKILL_GROUPS[attr.key]
              if (!groupSkills?.length) return null
              return (
                <div key={attr.key} className="skill-group">
                  <div className="skill-group-title">{ATTR_ICONS[attr.key]} {attr.label}</div>
                  <div className="skill-grid">
                    {groupSkills.map((sk) => {
                      const active = sk.key in skills
                      return (
                        <div key={sk.key} className={`skill-row ${active ? 'active' : ''}`}>
                          <label className="skill-check">
                            <input
                              checked={active}
                              onChange={() => toggleSkill(sk.key)}
                              type="checkbox"
                            />
                            <span>{sk.label}</span>
                          </label>
                          {active && (
                            <DieSelector
                              value={skills[sk.key]}
                              onChange={(v) => setSkillDie(sk.key, v)}
                            />
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        {/* ═══════ COMPLICAÇÕES ═══════ */}
        <div className="section-card">
          <div className="section-card-header">
            <h3>⚠️ Complicações</h3>
            <span className={`badge ${!hindranceLimits.valid ? 'badge--error' : hindrancePointsEarned > 0 ? 'badge--warn' : 'badge--accent'}`}>
              {hindranceLimits.majorCount}M / {hindranceLimits.minorCount}m &nbsp;→&nbsp; {hindrancePointsEarned} pts
            </span>
          </div>
          <div className="section-card-body">
            <p className="section-card-hint" style={{ marginBottom: 'var(--space-3)' }}>
              Máx. {CHARACTER_CREATION.maxMajorHindrances} Maior e {CHARACTER_CREATION.maxMinorHindrances} Menores. Concedem pontos extras para gastar.
            </p>

            {!hindranceLimits.valid && (
              <p className="error" style={{ margin: '0 0 var(--space-3)' }}>
                {hindranceLimits.errors.join('. ')}
              </p>
            )}

            <div className="chips-wrap">
              {HINDRANCES.map((h) => {
                const isActive = selectedHindrances.some((x) => x.name === h.key)
                const majorCount = selectedHindrances.filter((x) => x.severity === 'major').length
                const minorCount = selectedHindrances.filter((x) => x.severity === 'minor').length
                const atLimit =
                  !isActive &&
                  ((h.severity === 'major' && majorCount >= CHARACTER_CREATION.maxMajorHindrances) ||
                   (h.severity === 'minor' && minorCount >= CHARACTER_CREATION.maxMinorHindrances))

                return (
                  <label
                    key={h.key}
                    className={`chip chip--${h.severity} ${isActive ? 'active' : ''} ${atLimit ? 'disabled' : ''}`}
                  >
                    <input type="checkbox" checked={isActive} onChange={() => toggleHindrance(h)} disabled={atLimit && !isActive} />
                    <span>{h.label}</span>
                    <span className="chip-sub">{h.severity === 'major' ? 'Maior · 2pts' : 'Menor · 1pt'}</span>
                  </label>
                )
              })}
            </div>

            {/* Hindrance Points Budget */}
            {hindrancePointsEarned > 0 && (
              <div className="hindrance-budget" style={{ marginTop: 'var(--space-4)' }}>
                <div className="section-card-hint" style={{ marginBottom: 'var(--space-2)', fontWeight: 600 }}>
                  💰 Gastar Pontos de Complicação ({hindrancePointsLeft} restantes de {hindrancePointsEarned})
                </div>

                <div className="budget-controls">
                  <div className="budget-row">
                    <span className="budget-label">+1 Vantagem extra <small>(2 pts)</small></span>
                    <div className="budget-stepper">
                      <button type="button" className="stepper-btn" onClick={() => adjustAllocation('extraEdges', -1)}>−</button>
                      <span className="stepper-value">{hindranceAllocation.extraEdges}</span>
                      <button type="button" className="stepper-btn" onClick={() => adjustAllocation('extraEdges', 1)}>+</button>
                    </div>
                  </div>

                  <div className="budget-row">
                    <span className="budget-label">+1 Ponto de Atributo <small>(2 pts)</small></span>
                    <div className="budget-stepper">
                      <button type="button" className="stepper-btn" onClick={() => adjustAllocation('extraAttributePoints', -1)}>−</button>
                      <span className="stepper-value">{hindranceAllocation.extraAttributePoints}</span>
                      <button type="button" className="stepper-btn" onClick={() => adjustAllocation('extraAttributePoints', 1)}>+</button>
                    </div>
                  </div>

                  <div className="budget-row">
                    <span className="budget-label">+1 Ponto de Perícia <small>(1 pt)</small></span>
                    <div className="budget-stepper">
                      <button type="button" className="stepper-btn" onClick={() => adjustAllocation('extraSkillPoints', -1)}>−</button>
                      <span className="stepper-value">{hindranceAllocation.extraSkillPoints}</span>
                      <button type="button" className="stepper-btn" onClick={() => adjustAllocation('extraSkillPoints', 1)}>+</button>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* ═══════ VANTAGENS ═══════ */}
        <div className="section-card">
          <div className="section-card-header">
            <h3>⭐ Vantagens</h3>
            <span className={`badge ${selectedEdges.length > freeEdgesAllowed ? 'badge--error' : selectedEdges.length === freeEdgesAllowed ? 'badge--success' : 'badge--accent'}`}>
              {selectedEdges.length} / {freeEdgesAllowed}
            </span>
          </div>
          <div className="section-card-body">
            {freeEdgesAllowed === 0 && (
              <p className="section-card-hint" style={{ marginBottom: 'var(--space-3)' }}>
                Selecione Complicações e aloque pontos em "Vantagem extra" para desbloquear.
              </p>
            )}
            <div className="chips-wrap">
              {Object.entries(EDGE_GROUPS).map(([category, edges]) => (
                <div key={category} style={{ width: '100%' }}>
                  <div className="chip-group-title">{category}</div>
                  <div className="chips-wrap">
                    {edges.map((edge) => {
                      const isActive = selectedEdges.includes(edge.key)
                      const elig = edgeEligibility[edge.key]
                      const isDisabled = !isActive && (!elig?.eligible || selectedEdges.length >= freeEdgesAllowed)
                      return (
                        <label
                          key={edge.key}
                          className={`chip ${isActive ? 'active' : ''} ${isDisabled ? 'disabled' : ''}`}
                          title={elig && !elig.eligible ? `Requer: ${elig.unmetRequirements.join(', ')}` : ''}
                        >
                          <input type="checkbox" checked={isActive} onChange={() => toggleEdge(edge.key)} disabled={isDisabled} />
                          <span>{edge.label}</span>
                          {edge.requirementLabel && (
                            <span className={`chip-sub ${elig?.eligible ? '' : 'unmet'}`}>
                              {elig?.eligible ? '✓' : '✗'} {edge.requirementLabel}
                            </span>
                          )}
                        </label>
                      )
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* ═══════ DERIVADOS ═══════ */}
        <div className="section-card">
          <div className="section-card-header">
            <h3>📊 Estatísticas</h3>
          </div>
          <div className="section-card-body">
            <div className="derived-bar">
              <div className="derived-stat">
                <span className="derived-stat-value">6</span>
                <span className="derived-stat-label">Movimentação</span>
              </div>
              <div className="derived-stat">
                <span className="derived-stat-value">{derivedParry}</span>
                <span className="derived-stat-label">Aparar</span>
              </div>
              <div className="derived-stat">
                <span className="derived-stat-value">{derivedToughness}</span>
                <span className="derived-stat-label">Resistência</span>
              </div>
              <div className="derived-stat">
                <span className="derived-stat-value">3</span>
                <span className="derived-stat-label">Ferimentos máx.</span>
              </div>
              <div className="derived-stat">
                <span className="derived-stat-value">3</span>
                <span className="derived-stat-label">Bennies</span>
              </div>
            </div>
          </div>
        </div>
        </fieldset>

        {/* ═══════ ERROS ═══════ */}
        {error && (
          <div className="section-card" style={{ borderColor: 'var(--feedback-error)' }}>
            <div className="section-card-body">
              <p className="error" style={{ margin: 0 }}>{error}</p>
            </div>
          </div>
        )}

        {!campaigns.length && (
          <div className="section-card">
            <div className="section-card-body">
              <p className="muted" style={{ margin: 0 }}>Crie uma campanha antes de criar personagem.</p>
            </div>
          </div>
        )}

        {/* ═══════ AÇÕES ═══════ */}
        <div className="form-actions">
          {!isReadOnly && (
            <button
              className="button-primary-lg"
              disabled={loading || !campaigns.length || attrPointsLeft < 0 || skillPointsLeft < 0}
              type="submit"
            >
              {loading
                ? (isEditMode ? 'Salvando...' : 'Criando...')
                : (isEditMode ? 'Salvar Personagem' : 'Criar Personagem')}
            </button>
          )}

          <button className="button-secondary" onClick={() => navigate('/characters')} type="button">
            ← Voltar para lista
          </button>

          {isReadOnly && <span className="badge badge--muted">Somente leitura</span>}

          {isEditMode && characterId && isOwner && (
            <button
              className="button-danger"
              disabled={loading}
              onClick={async () => {
                if (!window.confirm('Tem certeza que deseja excluir este personagem?')) return
                setLoading(true)
                try {
                  await deleteCharacter(characterId)
                  navigate('/characters')
                } catch (err) {
                  setError(err instanceof Error ? err.message : 'Falha ao excluir')
                } finally {
                  setLoading(false)
                }
              }}
              type="button"
            >
              Excluir personagem
            </button>
          )}
        </div>
      </form>
    </section>
  )
}
