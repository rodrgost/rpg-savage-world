// ─── Game Chat / Narrative Types ───
// Tipos para o sistema de chat narrativo do jogo.
// Cada resposta da LLM segue o formato NarratorTurnResponse.

import type { NarrativeStyle, PlayerAction } from './gameState.js'

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
}

export type ItemChange = {
  itemId: string
  name: string
  quantity: number
  changeType: 'gained' | 'lost' | 'used'
  /** Categoria do item — obrigatória para veículos e propriedades */
  category?: ItemCategory
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
  status?: 'active' | 'incapacitated' | 'defeated' | 'dead'
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

// ─── Dice Check (avaliação de teste de dados) ───

export type DiceCheck = {
  /** Se esta opção exige um teste de dados */
  required: boolean
  /** Nome da perícia Savage Worlds (ex: "Percepção", "Furtividade") */
  skill?: string | null
  /** Nome do atributo se não for perícia (ex: "vigor", "spirit") */
  attribute?: string | null
  /**
   * Dificuldade situacional declarada pelo LLM (sinal limitado de ficção).
   * O app converte para modificador fixo via DIFFICULTY_MODIFIER
   * (facil: +2, normal: 0, dificil: -2, extremo: -4). Não confundir com os modificadores
   * mecânicos (ferimento/Edge/Hindrance), que o rule-engine aplica sozinho.
   */
  difficulty?: 'facil' | 'normal' | 'dificil' | 'extremo' | null
  /**
   * Modificador situacional — APP-COMPUTED a partir de `difficulty`.
   * Não é mais decidido pelo LLM; mantido para exibição/persistência.
   */
  modifier?: number
  /** Target Number — APP-COMPUTED (sempre 4 em Savage Worlds). */
  tn?: number
  /** Justificativa narrativa para o teste (ex: "A escuridão dificulta a visão") */
  reason: string
}

// ─── Validação de ação custom ───

export type ValidateActionResponse = {
  /** Se a ação é viável dado o contexto atual */
  feasible: boolean
  /** Motivo caso não seja viável */
  feasibilityReason?: string
  /** Se a ação exige um teste de dados antes de ser executada */
  diceCheck?: DiceCheck | null
  /** Tipo de ação mecânica inferida (custom, trait_test, attack, travel) */
  actionType: PlayerAction['type']
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
    inventory: InventoryItem[]
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
  /** Tipo da ação mecânica correspondente no rule-engine */
  actionType: PlayerAction['type']
  /** Payload parcial para montar o PlayerAction */
  actionPayload: Record<string, unknown>
  /**
   * Avaliação de necessidade de teste de dados para esta opção.
   * Não existe mais feasible/feasibilityReason/requiredItems aqui: pela regra de
   * prompt "AGÊNCIA REAL", o narrador só deve oferecer opções já executáveis —
   * uma opção inviável (sem alvo, sem item) deve ser substituída na origem, nunca
   * oferecida e marcada como inviável.
   */
  diceCheck?: DiceCheck | null
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
  /**
   * Gancho de história: evento ou indício ocorrido fora de cena que cria tensão ou
   * curiosidade para o próximo turno. 1 frase curta. Omitir quando não houver nada
   * relevante acontecendo além da consequência direta da ação.
   */
  storyHook?: string | null
  /** true quando o conteúdo é um fallback estático por falha do LLM */
  isFallback?: boolean
}

// ─── Requests para o Narrator ───

export type NarrateStartRequest = {
  world?: {
    name?: string
    description?: string
    lore?: string
    narrativeStyleGuide?: string
  }
  campaign: {
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
    lore?: string
    narrativeStyleGuide?: string
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
    inventory: InventoryItem[]
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
