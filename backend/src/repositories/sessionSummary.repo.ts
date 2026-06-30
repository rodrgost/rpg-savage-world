import { FieldValue, firestore } from '../infrastructure/firebase.js'
import type { StructuredSummary } from '../llm/summary-format.js'

export type SessionSummaryRow = {
  sessionId: string
  lastTurnIncluded: number
  /** Texto renderizado a partir de summaryStructured — é o que entra no prompt do narrador. */
  summaryText: string
  /** Resumo estruturado (fonte de verdade); ausente em sessões antigas pré-migração JSON. */
  summaryStructured?: StructuredSummary
  keyEvents?: unknown
}

type StoredSessionSummaryDoc = {
  sessionId?: string
  lastTurnIncluded?: number
  summaryText?: string
  historySummaryText?: string
  summaryStructured?: StructuredSummary
  keyEvents?: unknown
}

export class SessionSummaryRepo {
  private summaryDoc(sessionId: string) {
    return firestore.collection('sessions').doc(sessionId).collection('_meta').doc('summary')
  }

  async upsertSummary(params: {
    sessionId: string
    lastTurnIncluded: number
    summaryText: string
    summaryStructured?: StructuredSummary
    keyEvents?: unknown
  }): Promise<void> {
    const data: Record<string, unknown> = {
      sessionId: params.sessionId,
      lastTurnIncluded: params.lastTurnIncluded,
      summaryText: params.summaryText,
      historySummaryText: FieldValue.delete(),
      updatedAt: FieldValue.serverTimestamp()
    }

    if (params.summaryStructured !== undefined) {
      data.summaryStructured = params.summaryStructured
    }

    if (params.keyEvents !== undefined) {
      data.keyEvents = params.keyEvents
    }

    await this.summaryDoc(params.sessionId).set(
      data,
      { merge: true }
    )
  }

  async getSummary(sessionId: string): Promise<SessionSummaryRow | null> {
    const doc = await this.summaryDoc(sessionId).get()
    if (!doc.exists) return null
    const data = doc.data() as StoredSessionSummaryDoc
    return {
      sessionId,
      lastTurnIncluded: data.lastTurnIncluded ?? 0,
      summaryText: data.summaryText ?? data.historySummaryText ?? '',
      summaryStructured: data.summaryStructured,
      keyEvents: data.keyEvents ?? undefined
    }
  }
}
