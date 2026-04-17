import type { GameState } from '../domain/types/gameState.js'
import type { InventoryItem, ItemChange } from '../domain/types/narrative.js'

/**
 * Serviço para gerenciar o inventário (mochila) do jogador.
 * Atualmente é uma lista simples sem limite de capacidade.
 * Extensível futuramente para peso, slots, etc.
 */
export class InventoryService {
  /**
   * Aplica mudanças de itens no inventário do jogador.
   * - gained: adiciona ou incrementa quantidade
   * - lost/used: decrementa quantidade, remove se chegar a 0
   */
  applyItemChanges(state: GameState, changes: ItemChange[]): GameState {
    if (!changes.length) return state

    const inventory = [...(state.player.inventory ?? [])].map((item) => ({ ...item }))

    for (const change of changes) {
      const existing = inventory.find((i) => i.id === change.itemId || i.name === change.name)

      if (change.changeType === 'gained') {
        if (existing) {
          existing.quantity += change.quantity
        } else {
          inventory.push({
            id: change.itemId,
            name: change.name,
            description: '',
            quantity: change.quantity,
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
    return inv.some(
      (i) => (i.id === itemIdOrName || i.name === itemIdOrName) && i.quantity > 0
    )
  }

  /** Retorna a lista de itens do inventário */
  getInventory(state: GameState): InventoryItem[] {
    return state.player.inventory ?? []
  }
}
