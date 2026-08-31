// ─── Game Chat / Narrative Types ───
// Tipos para o sistema de chat narrativo do jogo.
// Cada resposta da LLM segue o formato NarratorTurnResponse.

import type { NarrativeStyle, PlayerAction } from './gameState.js'
import type { WorldGuide } from './world-guide.js'

// ─── Inventário ───

export type ItemCategory =
  | 'weapon'
  | 'armor'
  | 'consumable'
  | 'ammunition'
  | 'money'
  | 'vehicle'
  | 'property'
  | 'quest'
  | 'misc'

export type InventoryItem = {
  id: string
  name: string
  description: string
  quantity: number
  /** Categoria estruturada do item */
  category?: ItemCategory
  /** Tags opcionais para categorização adicional */
  tags?: string[]
  /** Bônus de Resistência (Toughness) quando equipado como armadura corporal — definido pela narrativa na criação do item */
  armorValue?: number
  /** Bônus de Aparar (Parry) quando equipado como escudo — definido pela narrativa na criação do item */
  parryBonus?: number
}

export type EquippedItemsBrief = {
  attack?: { itemId: string; name: string; isCatalogWeapon: boolean; damageFormula: string; ap: number }
  armor?: { itemId: string; name: string; armorValue: number }
  shield?: { itemId: string; name: string; parryBonus: number }
}

export type ItemChange = {
  itemId: string
  name: string
  quantity: number
  changeType: 'gained' | 'lost' | 'used'
  /** Descrição do que o item é / o que contém / para que serve — preenchida pela narrativa para itens não óbvios, para orientar o LLM em turnos futuros */
  description?: string
  /** Categoria do item — obrigatória para veículos e propriedades */
  category?: ItemCategory
  /** Bônus de Resistência concedido quando este item (categoria "armor") é equipado como armadura corporal */
  armorValue?: number
  /** Bônus de Aparar concedido quando este item (categoria "armor") é equipado como escudo */
  parryBonus?: number
}

// ─── Status Effects ───

export type StatusChange = {
  effectId: string
  name: string
  changeType: 'applied' | 'removed'
  turnsRemaining?: number | null
  description: string
  targetType?: 'player' | 'npc'
  targetId?: string | null
}

// ─── NPCs mencionados ───

export type NPCMention = {
  /** Identificador estável (hash determinístico do displayName), gerado pelo sistema. */
  id: string
  /** Alias de `displayName` mantido por retrocompatibilidade. */
  name: string
  /** Nome amigável exibido ao jogador. */
  displayName: string
  disposition: 'hostile' | 'neutral' | 'friendly'
  newlyIntroduced: boolean
  /** Status do NPC se houver mudança narrativa (ex: incapacitado, derrotado) */
  status?: 'active' | 'incapacitated' | 'defeated' | 'dead' | 'left'
  /** Indica se o NPC deve acompanhar o jogador em viagens. */
  followsPlayer?: boolean
  /** Mudança na relação do NPC com o personagem do jogador (omitir se inalterada) */
  relation?: 'conhecido' | 'aliado' | 'amigavel' | 'neutro' | 'desconfiado' | 'hostil' | 'inimigo'
}

export type NarrativeSegment =
  | {
      type: 'narrator'
      text: string
    }
  | {
      type: 'npc'
      npcId?: string | null
      /** Alias de `npcDisplayName` mantido por retrocompatibilidade. */
      npcName: string
      /** Nome amigável exibido ao jogador. */
      npcDisplayName?: string
      disposition: NPCMention['disposition']
      text: string
    }

// ─── Chance Check (avaliação percentual de sucesso estimada pelo LLM) ───

export type ChanceCheck = {
  /** Se esta opção exige resolução por chance (true) ou é automática/trivial (false) */
  required: boolean
  /**
   * Estimativa percentual (0–100) de sucesso para a ação no contexto atual.
   * Populado pelo LLM apenas quando required=true.
   * Guia de referência:
   *   80–95 → ação rotineira com pequena chance de falha
   *   50–70 → desafio moderado
   *   25–45 → ação difícil
   *   5–20  → muito improvável, mas possível
   */
  successChance?: number | null
  /** Justificativa narrativa para a estimativa (ou para a ausência de rolagem) */
  reason: string
}

/** @deprecated Use ChanceCheck. Mantido apenas para compatibilidade durante migração. */
export type DiceCheck = ChanceCheck

// ─── Validação de ação custom ───

export type ValidateActionResponse = {
  /** Se a ação é viável dado o contexto atual */
  feasible: boolean
  /** Motivo caso não seja viável */
  feasibilityReason?: string
  /** Avaliação de chance da ação */
  diceCheck?: ChanceCheck | null
  /** Tipo de ação inferida — inclui chance_check (narrador-only, resolvido para 'custom' pelo adapter) */
  actionType: PlayerAction['type'] | 'chance_check'
  /** Payload parcial para montar o PlayerAction */
  actionPayload: Record<string, unknown>
  /** Breve descrição narrativa da interpretação da ação */
  interpretation: string
}

export type ValidateActionRequest = {
  /** Texto livre digitado pelo jogador */
  input: string
  /** Contexto atual da cena */
  context: {
    summaryText: string
    location: string
    wounds: number
    fatigue: number
    isShaken: boolean
    bennies: number
    npcsPresent: Array<{
      id: string
      name: string
      displayName?: string
      isWildCard: boolean
      disposition?: 'hostile' | 'neutral' | 'friendly'
      wounds: number
      maxWounds: number
      toughness: number
      parry: number
      statusEffects?: Array<{ id: string; name: string; turnsRemaining?: number }>
    }>
    /** IDs de NPCs já derrotados nesta sessão */
    defeatedNpcIds?: string[]
    /** Objetos/estruturas fixas detectados no local atual (terminal, escotilha, painel, etc.) */
    sceneObjectsCurrent?: string[]
    inventory: InventoryItem[]
    equippedItems?: EquippedItemsBrief
    activeStatusEffects: Array<{ id: string; name: string; turnsRemaining?: number }>
    playerSkills?: Record<string, string>
    rulesDigest?: string
  }
  recentMessages: Array<{ role: string; segments?: NarrativeSegment[]; playerInput?: string; engineEvents?: Array<{ type: string; payload: Record<string, unknown> }> }>
}

// ─── Opções de ação ───

export type ActionOption = {
  id: string
  /** Texto narrativo descritivo da opção */
  text: string
  /** Fala direta do personagem do jogador ao escolher esta opção (apenas opções de diálogo/confronto/social) */
  playerSpeech?: string | null
  /** Tipo da ação — inclui tipos do motor + 'chance_check' (narrador-only, resolvido para 'custom' pelo adapter) */
  actionType: PlayerAction['type'] | 'chance_check'
  /** Payload parcial para montar o PlayerAction */
  actionPayload: Record<string, unknown>
  /**
   * Avaliação percentual de chance para esta opção.
   * required=false → ação automática, sem resolução.
   * required=true  → app resolve com Math.random() * 100 < successChance.
   */
  diceCheck?: ChanceCheck | null
}

// ─── Resposta completa de um turno narrativo ───

export type NpcAttackEntry = {
  /** ID do NPC que ataca */
  npcId: string
  /** Dado de ataque (lados, ex: 6 = d6) */
  skillDie: number
  /** Fórmula de dano (ex: "str+d6", "2d6") */
  damageFormula: string
  /** Penetração de armadura (default 0) */
  ap?: number
  /** Se o ataque é à distância (disparo, arremesso) — afeta a Vantagem Esquivar */
  isRanged?: boolean
}

// ─── Inversão justificada de desfecho ───

export type OutcomeOverride = {
  /** Resultado mecânico produzido pelo rule-engine */
  mechanicalResult: 'success' | 'failure'
  /** Desfecho efetivamente narrado neste turno (difere de mechanicalResult quando há inversão) */
  narratedOutcome: 'success' | 'failure'
  /** Causa explícita na ficção que justifica a divergência (ex: interferência de terceiros, imprevisto ambiental) */
  justification: string
}

export type NarratorTurnResponse = {
  /** Blocos estruturados para renderizar narração e falas diretas de NPCs (fonte única da narração) */
  segments: NarrativeSegment[]
  /** Sempre 4 opções de ação para o jogador */
  options: ActionOption[]
  /** NPCs presentes ou mencionados na cena */
  npcs: NPCMention[]
  /** Itens ganhos, perdidos ou usados neste turno */
  itemChanges: ItemChange[]
  /** Efeitos de status aplicados ou removidos */
  statusChanges: StatusChange[]
  /** Ataques de NPCs hostis contra o jogador neste turno */
  npcAttacks?: NpcAttackEntry[]
  /** Preenchido apenas quando o desfecho narrado diverge do resultado mecânico, com a justificativa na ficção */
  outcomeOverride?: OutcomeOverride | null
  /** true quando o conteúdo é um fallback estático por falha do LLM */
  isFallback?: boolean
}

// ─── Requests para o Narrator ───

export type NarrateStartRequest = {
  world?: {
    name?: string
    description?: string
    worldGuide?: WorldGuide
  }
  campaign?: {
    storyDescription: string
    name?: string
  }
  character: {
    name: string
    profession?: string
    race?: string
    gender?: string
    description?: string
    edges: string[]
    hindrances: Array<{ name: string; severity: string }>
  }
  simpleVocabulary?: boolean
}

export type NarrateTurnRequest = {
  /** Ação escolhida pelo jogador (texto ou opcionId) */
  playerAction: {
    type: string
    description: string
    /** Fala direta do personagem (quando ação começa com "-") */
    playerSpeech?: string
  }
  /** Resultado mecânico do rule-engine */
  engineEvents: Array<{ type: string; payload: Record<string, unknown> }>
  /** Dados do universo (lore macro) — injetados no systemInstruction */
  world?: {
    name?: string
    description?: string
    worldGuide?: WorldGuide
  }
  /** Dados da campanha (história) — injetados no systemInstruction */
  campaign?: {
    name?: string
    storyDescription?: string
  }
  /** Contexto para a LLM (summary, estado, inventário) */
  context: {
    summaryText: string
    location: string
    wounds: number
    fatigue: number
    isShaken: boolean
    bennies: number
    npcsPresent: Array<{
      id: string
      name: string
      displayName?: string
      isWildCard: boolean
      disposition?: 'hostile' | 'neutral' | 'friendly'
      wounds: number
      maxWounds: number
      toughness: number
      parry: number
      statusEffects?: Array<{ id: string; name: string; turnsRemaining?: number }>
      personality?: string
      motivation?: string
      speechPattern?: string
    }>
    /** IDs de NPCs já derrotados nesta sessão */
    defeatedNpcIds?: string[]
    /** Objetos/estruturas fixas detectados no local atual (terminal, escotilha, painel, etc.) */
    sceneObjectsCurrent?: string[]
    inventory: InventoryItem[]
    equippedItems?: EquippedItemsBrief
    activeStatusEffects: Array<{ id: string; name: string; turnsRemaining?: number }>
    /** Perícias do personagem com seus dados atuais (ex: { "Percepção": "d6", "Luta": "d8" }) */
    playerSkills?: Record<string, string>
    /** Digest compacto das regras do jogo + traços do personagem */
    rulesDigest?: string
    /** Situação atual da cena — orienta o tom narrativo */
    situation?: 'exploracao' | 'combat' | 'dialogo'
    /** Catálogo de NPCs nomeados do mundo — permite referenciar NPCs canônicos por ID */
    npcCatalog?: Array<{ id: string; name: string; description?: string; dispositionDefault: string }>
  }
  recentMessages: Array<{ role: string; segments?: NarrativeSegment[]; playerInput?: string; engineEvents?: Array<{ type: string; payload: Record<string, unknown> }> }>
  narrativeStyle?: NarrativeStyle
  simpleVocabulary?: boolean
}
