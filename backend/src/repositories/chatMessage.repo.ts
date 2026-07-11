import { FieldValue, firestore } from '../infrastructure/firebase.js'
import type { ActionOption, NPCMention, ItemChange, StatusChange, NarrativeSegment } from '../domain/types/narrative.js'
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
  segments?: NarrativeSegment[]
  playerInput?: string
  /**
   * Gancho fora de cena gerado pela LLM neste turno. NÃO é exibido na UI (fica
   * fora de segments); é realimentado no histórico enviado à LLM para que o
   * gancho possa ser concretizado em cena nos turnos seguintes.
   */
  storyHook?: string | null
  options?: ActionOption[]
  npcs?: NPCMention[]
  itemChanges?: ItemChange[]
  statusChanges?: StatusChange[]
  /** Engine events attached to system messages (e.g. trait_test results) */
  engineEvents?: Array<{ type: string; payload: Record<string, unknown> }>
  /** Localização ativa no momento em que a mensagem foi gerada (usado para filtrar NPCs por cena) */
  location?: string
  createdAt?: unknown
}

export class ChatMessageRepo {
  private messagesCollection(sessionId: string) {
    return firestore.collection('sessions').doc(sessionId).collection('messages')
  }

  /** Mensagens já incorporadas ao resumo canônico — mantidas só para auditoria/reconstrução, fora da janela ativa do narrador. */
  private archivedMessagesCollection(sessionId: string) {
    return firestore.collection('sessions').doc(sessionId).collection('archivedMessages')
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

    return qs.docs.map((d, i) => ({ seq: i + 1, ...d.data() }) as ChatMessageRow)
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

    // Inverte para ordem cronológica ascendente antes de mapear, para que o índice
    // posicional reflita a ordem real (i=0 → mensagem mais antiga da janela).
    return [...qs.docs].reverse().map((d, i) => ({ seq: i + 1, ...d.data() }) as ChatMessageRow)
  }

  async countBySession(sessionId: string): Promise<number> {
    const snapshot = await this.messagesCollection(sessionId).count().get()
    return snapshot.data().count
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

    return qs.docs.map((d, i) => ({ seq: i + 1, ...d.data() }) as ChatMessageRow)
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

  /**
   * Move mensagens da coleção ativa para a coleção de arquivo (escreve no arquivo +
   * remove da ativa). Usada na compactação: o texto bruto sobrevive para auditoria/
   * reconstrução em vez de ser perdido quando o resumo as incorpora.
   * Cada mensagem custa 2 operações (set + delete); o Firestore limita batches a 500
   * operações, daí o chunk de 250 mensagens.
   */
  async archiveBatch(sessionId: string, messages: ChatMessageRow[]): Promise<void> {
    if (!messages.length) return
    const activeCol = this.messagesCollection(sessionId)
    const archiveCol = this.archivedMessagesCollection(sessionId)
    const chunkSize = 250
    for (let i = 0; i < messages.length; i += chunkSize) {
      const batch = firestore.batch()
      const chunk = messages.slice(i, i + chunkSize)
      for (const message of chunk) {
        batch.set(archiveCol.doc(message.messageId), stripUndefined({ ...message, archivedAt: FieldValue.serverTimestamp() }))
        batch.delete(activeCol.doc(message.messageId))
      }
      await batch.commit()
    }
  }

  /** Mensagens já arquivadas (compactadas em algum resumo anterior), em ordem cronológica. Usado para reconstrução completa do resumo. */
  async listArchivedBySession(sessionId: string): Promise<ChatMessageRow[]> {
    let qs = await this.archivedMessagesCollection(sessionId).orderBy('seq', 'asc').get()
    if (qs.empty) {
      qs = await this.archivedMessagesCollection(sessionId).orderBy('createdAt', 'asc').get()
    }
    return qs.docs.map((d) => d.data() as ChatMessageRow)
  }
}
