import type { GameState } from '../domain/types/gameState.js'
import type { InventoryItem, ItemChange } from '../domain/types/narrative.js'

const ITEM_REFERENCE_STOPWORDS = new Set([
  'a',
  'as',
  'com',
  'da',
  'das',
  'de',
  'do',
  'dos',
  'e',
  'em',
  'na',
  'nas',
  'no',
  'nos',
  'o',
  'os',
  'para',
  'por',
  'um',
  'uma'
])

function normalizeInventoryLookup(value: string | null | undefined): string {
  return (value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\d]+/gu, ' ')
    .trim()
}

function tokenizeInventoryReference(value: string | null | undefined): string[] {
  return normalizeInventoryLookup(value)
    .split(' ')
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !ITEM_REFERENCE_STOPWORDS.has(token))
}

function buildItemAliases(item: InventoryItem): string[] {
  return [item.id, item.name, ...(item.tags ?? [])]
    .map((value) => normalizeInventoryLookup(value))
    .filter(Boolean)
}

function aliasMatchesReference(alias: string, reference: string, referenceTokens: string[]): boolean {
  if (!alias || !reference) return false
  if (alias === reference) return true

  if (referenceTokens.length === 0) {
    return alias.includes(reference) || reference.includes(alias)
  }

  const aliasTokens = tokenizeInventoryReference(alias)
  if (!aliasTokens.length) return false
  const aliasTokenSet = new Set(aliasTokens)

  return referenceTokens.every((token) => aliasTokenSet.has(token))
}

/**
 * Serviço para gerenciar o inventário (mochila) do jogador.
 * Atualmente é uma lista simples sem limite de capacidade.
 * Extensível futuramente para peso, slots, etc.
 */
export class InventoryService {
  private findMatchingItemInList(items: InventoryItem[], references: Array<string | null | undefined>): InventoryItem | undefined {
    const cleanedReferences = references
      .map((reference) => ({
        raw: reference ?? '',
        normalized: normalizeInventoryLookup(reference),
        tokens: tokenizeInventoryReference(reference)
      }))
      .filter((reference) => reference.normalized)

    if (!cleanedReferences.length) return undefined

    for (const reference of cleanedReferences) {
      const exact = items.find((item) => {
        if (item.quantity <= 0) return false
        return buildItemAliases(item).some((alias) => alias === reference.normalized)
      })
      if (exact) return exact
    }

    for (const reference of cleanedReferences) {
      const fuzzy = items.find((item) => {
        if (item.quantity <= 0) return false
        return buildItemAliases(item).some((alias) => aliasMatchesReference(alias, reference.normalized, reference.tokens))
      })
      if (fuzzy) return fuzzy
    }

    return undefined
  }

  /**
   * Aplica mudanças de itens no inventário do jogador.
   * - gained: adiciona ou incrementa quantidade
   * - lost/used: decrementa quantidade, remove se chegar a 0
   */
  applyItemChanges(state: GameState, changes: ItemChange[]): GameState {
    if (!changes.length) return state

    const inventory = [...(state.player.inventory ?? [])].map((item) => ({ ...item }))

    for (const change of changes) {
      const existing = this.findMatchingItemInList(inventory, [change.itemId, change.name])

      if (change.changeType === 'gained') {
        if (existing) {
          existing.quantity += change.quantity
        } else {
          inventory.push({
            id: change.itemId,
            name: change.name,
            description: '',
            quantity: change.quantity,
            ...(change.category ? { category: change.category } : {}),
            tags: []
          })
        }
      } else {
        // lost or used
        if (existing) {
          existing.quantity -= change.quantity
          if (existing.quantity <= 0) {
            const idx = inventory.indexOf(existing)
            if (idx >= 0) inventory.splice(idx, 1)
          }
        }
      }
    }

    return {
      ...state,
      player: {
        ...state.player,
        inventory
      }
    }
  }

  /** Verifica se o jogador possui um item pelo id ou nome */
  hasItem(state: GameState, itemIdOrName: string): boolean {
    const inv = state.player.inventory ?? []
    return Boolean(this.findMatchingItemInList(inv, [itemIdOrName]))
  }

  /** Retorna a lista de itens do inventário */
  getInventory(state: GameState): InventoryItem[] {
    return state.player.inventory ?? []
  }
}
