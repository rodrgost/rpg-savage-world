import { FieldValue, firestore } from '../infrastructure/firebase.js'
import type { RelationalStatus } from '../domain/types/gameState.js'

/**
 * Registro durável de um NPC conhecido pelo personagem.
 * Subcoleção characters/{characterId}/knownNpcs/{npcId} — sobrevive a reset de sessão.
 */
export type KnownNpcDoc = {
  npcId: string
  /** displayName do NPC no último avistamento */
  name: string
  relationalStatus: RelationalStatus
  /** Edição manual vence sobre atualizações do narrador */
  relationSource: 'auto' | 'manual'
  notes?: string
  disposition?: 'hostile' | 'neutral' | 'friendly'
  conditionStatus?: 'active' | 'incapacitated' | 'defeated' | 'dead'
  lastKnownLocation?: string
  isCatalogNpc?: boolean
  lastSessionId?: string
  firstMetAt: unknown
  lastSeenAt: unknown
  updatedAt?: unknown
}

export type KnownNpcUpsert = Partial<Omit<KnownNpcDoc, 'npcId' | 'firstMetAt' | 'lastSeenAt' | 'updatedAt'>> & {
  npcId: string
  /** Marca o doc como recém-criado: grava firstMetAt */
  isNew?: boolean
}

function toMillis(value: unknown): number {
  if (!value || typeof value !== 'object') return 0
  if ('toMillis' in value && typeof (value as { toMillis?: unknown }).toMillis === 'function') {
    return (value as { toMillis: () => number }).toMillis() ?? 0
  }
  if ('seconds' in value && typeof (value as { seconds?: unknown }).seconds === 'number') {
    const seconds = Number((value as { seconds: number }).seconds)
    const nanoseconds = Number((value as { nanoseconds?: number }).nanoseconds ?? 0)
    return seconds * 1000 + Math.floor(nanoseconds / 1_000_000)
  }
  return 0
}

export class KnownNpcsRepo {
  private collection(characterId: string) {
    return firestore.collection('characters').doc(characterId).collection('knownNpcs')
  }

  async listByCharacter(characterId: string): Promise<Array<KnownNpcDoc & { id: string }>> {
    const snapshot = await this.collection(characterId).get()
    const rows = snapshot.docs.map((doc) => ({ id: doc.id, ...(doc.data() as KnownNpcDoc) }))
    rows.sort((a, b) => toMillis(b.lastSeenAt) - toMillis(a.lastSeenAt))
    return rows
  }

  async getMany(characterId: string, npcIds: string[]): Promise<Map<string, KnownNpcDoc>> {
    const result = new Map<string, KnownNpcDoc>()
    if (!npcIds.length) return result

    const refs = npcIds.map((npcId) => this.collection(characterId).doc(npcId))
    const docs = await firestore.getAll(...refs)
    for (const doc of docs) {
      if (doc.exists) result.set(doc.id, doc.data() as KnownNpcDoc)
    }
    return result
  }

  async upsertBatch(characterId: string, docs: KnownNpcUpsert[]): Promise<void> {
    if (!docs.length) return

    const batch = firestore.batch()
    for (const { npcId, isNew, ...fields } of docs) {
      const payload: Record<string, unknown> = { npcId }
      if (fields.name !== undefined) payload.name = fields.name
      if (fields.relationalStatus !== undefined) payload.relationalStatus = fields.relationalStatus
      if (fields.relationSource !== undefined) payload.relationSource = fields.relationSource
      if (fields.notes !== undefined) payload.notes = fields.notes
      if (fields.disposition !== undefined) payload.disposition = fields.disposition
      if (fields.conditionStatus !== undefined) payload.conditionStatus = fields.conditionStatus
      if (fields.lastKnownLocation !== undefined) payload.lastKnownLocation = fields.lastKnownLocation
      if (fields.isCatalogNpc !== undefined) payload.isCatalogNpc = fields.isCatalogNpc
      if (fields.lastSessionId !== undefined) payload.lastSessionId = fields.lastSessionId
      if (isNew) payload.firstMetAt = FieldValue.serverTimestamp()
      payload.lastSeenAt = FieldValue.serverTimestamp()
      payload.updatedAt = FieldValue.serverTimestamp()

      batch.set(this.collection(characterId).doc(npcId), payload, { merge: true })
    }
    await batch.commit()
  }

  /**
   * Edição manual pelo jogador. relationalStatus/notes marcam relationSource='manual';
   * resetToAuto devolve o controle ao narrador.
   */
  async updateManual(
    characterId: string,
    npcId: string,
    patch: { relationalStatus?: RelationalStatus; notes?: string; resetToAuto?: boolean }
  ): Promise<(KnownNpcDoc & { id: string }) | null> {
    const ref = this.collection(characterId).doc(npcId)
    const existing = await ref.get()
    if (!existing.exists) return null

    const payload: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() }
    if (patch.relationalStatus !== undefined) payload.relationalStatus = patch.relationalStatus
    if (patch.notes !== undefined) payload.notes = patch.notes
    if (patch.resetToAuto) {
      payload.relationSource = 'auto'
    } else if (patch.relationalStatus !== undefined || patch.notes !== undefined) {
      payload.relationSource = 'manual'
    }

    await ref.set(payload, { merge: true })
    const updated = await ref.get()
    return { id: updated.id, ...(updated.data() as KnownNpcDoc) }
  }
}
