import type { NpcDefinition, NPCCombatant } from '../domain/types/gameState.js'
import type { NPCMention } from '../domain/types/narrative.js'

function normalizeNpcLookup(value: string | null | undefined): string {
  return (value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\d]+/gu, ' ')
    .trim()
}

/**
 * Serviço para gerenciar NPCs a partir do catálogo do mundo.
 * Análogo ao InventoryService para itens: o LLM menciona um NPC por id/nome,
 * a aplicação carrega os stats canônicos do catálogo em vez de criar stubs genéricos.
 */
export class NpcService {
  /**
   * Tenta resolver um NPC a partir do catálogo do mundo.
   * Prioridade: match exato de id → match normalizado de nome.
   * Se não encontrar no catálogo, retorna null (caller deve criar stub).
   */
  resolveNpcFromCatalog(
    catalog: NpcDefinition[],
    mention: Pick<NPCMention, 'id' | 'name' | 'disposition'>,
    location: string
  ): NPCCombatant | null {
    if (!catalog.length) return null

    const byId = catalog.find((def) => def.id === mention.id)
    if (byId) return this.buildNpcFromDefinition(byId, mention.disposition, location)

    const mentionNorm = normalizeNpcLookup(mention.name)
    const byName = catalog.find((def) => normalizeNpcLookup(def.name) === mentionNorm)
    if (byName) return this.buildNpcFromDefinition(byName, mention.disposition, location)

    return null
  }

  /**
   * Constrói um NPCCombatant a partir de uma definição do catálogo.
   * A disposição da menção sobrescreve o default do catálogo.
   */
  buildNpcFromDefinition(
    def: NpcDefinition,
    disposition: NPCCombatant['disposition'],
    location: string
  ): NPCCombatant {
    return {
      id: def.id,
      name: def.name,
      isWildCard: def.isWildCard,
      attributes: def.attributes ?? {},
      skills: def.skills ?? {},
      wounds: 0,
      maxWounds: def.maxWounds ?? (def.isWildCard ? 3 : 1),
      fatigue: 0,
      isShaken: false,
      toughness: def.toughness,
      parry: def.parry,
      armor: def.armor ?? 0,
      pace: def.pace ?? 6,
      bennies: def.bennies ?? (def.isWildCard ? 2 : 0),
      tags: [...(def.tags ?? []), 'catalog'],
      disposition: disposition ?? def.dispositionDefault,
      location,
      status: 'active',
      ...(def.personality ? { personality: def.personality } : {}),
      ...(def.motivation ? { motivation: def.motivation } : {}),
      ...(def.speechPattern ? { speechPattern: def.speechPattern } : {})
    }
  }

  /**
   * Cria um stub genérico para NPCs não catalogados (comportamento legado).
   */
  buildNpcStub(
    mention: Pick<NPCMention, 'id' | 'name' | 'disposition'>,
    location: string
  ): NPCCombatant {
    return {
      id: mention.id,
      name: mention.name,
      isWildCard: false,
      attributes: {},
      skills: {},
      wounds: 0,
      maxWounds: 1,
      fatigue: 0,
      isShaken: false,
      toughness: 4,
      parry: 4,
      armor: 0,
      pace: 6,
      bennies: 0,
      tags: ['narrative'],
      disposition: mention.disposition,
      location,
      status: 'active'
    }
  }
}
