import { DISPOSITION_TO_RELATION, type GameState, type RelationalStatus } from '../domain/types/gameState.js'
import type { NarratorTurnResponse } from '../domain/types/narrative.js'
import { KnownNpcsRepo, type KnownNpcDoc, type KnownNpcUpsert } from '../repositories/knownNpcs.repo.js'
import { warn } from '../utils/file-logger.js'

/**
 * Mantém o registro durável de NPCs conhecidos pelo personagem
 * (characters/{id}/knownNpcs), atualizado a partir das menções do narrador
 * a cada turno. Edições manuais do jogador têm precedência sobre o automático.
 */
export class NpcRelationsService {
  private readonly knownNpcs = new KnownNpcsRepo()

  /**
   * Registra/atualiza no personagem os NPCs mencionados neste turno.
   * Só grava quando algo mudou (evita 1 write por turno para NPC estático).
   * Nunca lança: falha aqui não pode quebrar o turno.
   */
  async syncFromTurn(params: {
    characterId: string
    sessionId: string
    state: GameState
    mentions: NarratorTurnResponse['npcs']
  }): Promise<void> {
    const { characterId, sessionId, state, mentions } = params
    if (!characterId || !mentions.length) return

    try {
      const npcById = new Map(state.npcs.map((npc) => [npc.id, npc]))
      const existingById = await this.knownNpcs.getMany(
        characterId,
        mentions.map((m) => m.id)
      )

      const upserts: KnownNpcUpsert[] = []
      for (const mention of mentions) {
        const npc = npcById.get(mention.id)
        const existing = existingById.get(mention.id)

        const disposition = npc?.disposition ?? mention.disposition
        // NPC derrotado narrativamente já saiu de state.npcs — a menção é a fonte da condição
        const conditionStatus = mention.status ?? npc?.status
        const followsPlayer = npc?.followsPlayer ?? mention.followsPlayer ?? existing?.followsPlayer
        const lastKnownLocation = npc?.location ?? state.worldState.activeLocation
        const name = mention.displayName ?? mention.name
        const isCatalogNpc = npc?.tags?.includes('catalog') ?? existing?.isCatalogNpc

        const relationalStatus: RelationalStatus =
          existing?.relationSource === 'manual'
            ? existing.relationalStatus
            : mention.relation ??
              existing?.relationalStatus ??
              (disposition ? DISPOSITION_TO_RELATION[disposition] : 'conhecido')

        const desired: KnownNpcUpsert = {
          npcId: mention.id,
          name,
          relationalStatus,
          relationSource: existing?.relationSource ?? 'auto',
          ...(disposition !== undefined ? { disposition } : {}),
          ...(conditionStatus !== undefined ? { conditionStatus } : {}),
          ...(followsPlayer !== undefined ? { followsPlayer } : {}),
          ...(lastKnownLocation !== undefined ? { lastKnownLocation } : {}),
          ...(isCatalogNpc !== undefined ? { isCatalogNpc } : {}),
          lastSessionId: sessionId
        }

        if (!existing) {
          upserts.push({ ...desired, isNew: true })
          continue
        }

        if (this.hasChanges(existing, desired)) {
          upserts.push(desired)
        }
      }

      await this.knownNpcs.upsertBatch(characterId, upserts)
    } catch (error) {
      warn('npcRelations', `Falha ao sincronizar NPCs conhecidos do personagem ${characterId}: ${String(error)}`)
    }
  }

  async deleteAllKnownNpcs(characterId: string): Promise<void> {
    await this.knownNpcs.deleteAllByCharacter(characterId)
  }

  private hasChanges(existing: KnownNpcDoc, desired: KnownNpcUpsert): boolean {
    const fields = [
      'name',
      'relationalStatus',
      'disposition',
      'conditionStatus',
      'followsPlayer',
      'lastKnownLocation',
      'isCatalogNpc',
      'lastSessionId'
    ] as const

    return fields.some((field) => desired[field] !== undefined && desired[field] !== existing[field])
  }
}
