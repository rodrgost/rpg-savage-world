import { FieldValue, firestore } from '../infrastructure/firebase.js'
import type { ActionOption, NPCMention, ItemChange, StatusChange } from '../domain/types/narrative.js'
import { randomUUID } from 'node:crypto'

/** Recursively replace undefined values with null for Firestore compatibility */
function stripUndefined<T>(obj: T): T {
  if (obj === undefined) return null as unknown as T
  if (obj === null || typeof obj !== 'object') return obj
  if (Array.isArray(obj)) return obj.map(stripUndefined) as unknown as T
  const clean: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    clean[key] = stripUndefined(value)
  }
  return clean as T
}

export type ChatMessageRow = {
  messageId: string
  sessionId: string
  turn: number
  /** Sequência incremental por sessão — garante ordem determinística */
  seq: number
  role: 'narrator' | 'player' | 'system'
  narrative?: string
  playerInput?: string
  options?: ActionOption[]
  npcs?: NPCMention[]
  itemChanges?: ItemChange[]
  statusChanges?: StatusChange[]
  /** Engine events attached to system messages (e.g. trait_test results) */
  engineEvents?: Array<{ type: string; payload: Record<string, unknown> }>
  createdAt?: unknown
}

export class ChatMessageRepo {
  private messagesCollection(sessionId: string) {
    return firestore.collection('sessions').doc(sessionId).collection('messages')
  }

  /** Contador atômico por sessão para garantir ordenação determinística */
  private async nextSeq(sessionId: string): Promise<number> {
    const metaRef = firestore.collection('sessions').doc(sessionId).collection('_meta').doc('counter')
    const result = await firestore.runTransaction(async (tx) => {
      const snap = await tx.get(metaRef)
      const current = (snap.exists ? (snap.data()?.messageSeq as number) : 0) ?? 0
      const next = current + 1
      tx.set(metaRef, { messageSeq: next }, { merge: true })
      return next
    })
    return result
  }

  private async appendInternal(
    params: Omit<ChatMessageRow, 'messageId' | 'createdAt' | 'seq'>,
    opts?: { overrideSeq?: number }
  ): Promise<ChatMessageRow> {
    const messageId = randomUUID()
    const seq = opts?.overrideSeq ?? await this.nextSeq(params.sessionId)
    const row = stripUndefined({
      messageId,
      ...params,
      seq
    })
    await this.messagesCollection(params.sessionId).doc(messageId).set({
      ...row,
      createdAt: FieldValue.serverTimestamp()
    })
    return row
  }

  async append(
    params: Omit<ChatMessageRow, 'messageId' | 'createdAt' | 'seq'>,
    opts?: { overrideSeq?: number }
  ): Promise<string> {
    const row = await this.appendInternal(params, opts)
    return row.messageId
  }

  async appendAndGet(
    params: Omit<ChatMessageRow, 'messageId' | 'createdAt' | 'seq'>,
    opts?: { overrideSeq?: number }
  ): Promise<ChatMessageRow> {
    const row = await this.appendInternal(params, opts)
    return row
  }

  async listBySession(
    sessionId: string,
    opts?: { afterTurn?: number; limit?: number }
  ): Promise<ChatMessageRow[]> {
    // Tenta ordenar por seq; se não houver resultados (mensagens antigas sem seq), faz fallback para createdAt
    let query = this.messagesCollection(sessionId).orderBy('seq', 'asc') as FirebaseFirestore.Query

    if (opts?.afterTurn !== undefined) {
      query = query.where('turn', '>', opts.afterTurn)
    }
    if (opts?.limit) {
      query = query.limit(opts.limit)
    }

    let qs = await query.get()

    if (qs.empty) {
      // Fallback: mensagens legadas sem campo seq
      let fallback = this.messagesCollection(sessionId).orderBy('createdAt', 'asc') as FirebaseFirestore.Query
      if (opts?.afterTurn !== undefined) {
        fallback = fallback.where('turn', '>', opts.afterTurn)
      }
      if (opts?.limit) {
        fallback = fallback.limit(opts.limit)
      }
      qs = await fallback.get()
    }

    return qs.docs.map((d) => ({ seq: 0, ...d.data() }) as ChatMessageRow)
  }

  async getRecent(sessionId: string, count = 10): Promise<ChatMessageRow[]> {
    // Tenta por seq; fallback para createdAt (sessões antigas)
    let qs = await this.messagesCollection(sessionId)
      .orderBy('seq', 'desc')
      .limit(count)
      .get()

    if (qs.empty) {
      qs = await this.messagesCollection(sessionId)
        .orderBy('createdAt', 'desc')
        .limit(count)
        .get()
    }

    return qs.docs.map((d) => ({ seq: 0, ...d.data() }) as ChatMessageRow).reverse()
  }

  async countBySession(sessionId: string): Promise<number> {
    const qs = await this.messagesCollection(sessionId).select().get()
    return qs.size
  }

  async getOldest(sessionId: string, limit: number): Promise<ChatMessageRow[]> {
    let qs = await this.messagesCollection(sessionId)
      .orderBy('seq', 'asc')
      .limit(limit)
      .get()

    if (qs.empty) {
      qs = await this.messagesCollection(sessionId)
        .orderBy('createdAt', 'asc')
        .limit(limit)
        .get()
    }

    return qs.docs.map((d) => ({ seq: 0, ...d.data() }) as ChatMessageRow)
  }

  async deleteBatch(sessionId: string, messageIds: string[]): Promise<void> {
    if (!messageIds.length) return
    const col = this.messagesCollection(sessionId)
    const batchSize = 500
    for (let i = 0; i < messageIds.length; i += batchSize) {
      const batch = firestore.batch()
      const chunk = messageIds.slice(i, i + batchSize)
      for (const id of chunk) {
        batch.delete(col.doc(id))
      }
      await batch.commit()
    }
  }
}
