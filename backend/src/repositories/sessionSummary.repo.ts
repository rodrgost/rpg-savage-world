import { FieldValue, firestore } from '../infrastructure/firebase.js'

export type SessionSummaryRow = {
  sessionId: string
  lastTurnIncluded: number
  summaryText: string
  historySummaryText?: string
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
    historySummaryText?: string
    keyEvents?: unknown
  }): Promise<void> {
    const data: Record<string, unknown> = {
      sessionId: params.sessionId,
      lastTurnIncluded: params.lastTurnIncluded,
      summaryText: params.summaryText,
      keyEvents: params.keyEvents ?? null,
      updatedAt: FieldValue.serverTimestamp()
    }

    if (params.historySummaryText !== undefined) {
      data.historySummaryText = params.historySummaryText
    }

    await this.summaryDoc(params.sessionId).set(
      data,
      { merge: true }
    )
  }

  async upsertHistorySummary(params: { sessionId: string; historySummaryText: string }): Promise<void> {
    await this.summaryDoc(params.sessionId).set(
      {
        sessionId: params.sessionId,
        historySummaryText: params.historySummaryText,
        updatedAt: FieldValue.serverTimestamp()
      },
      { merge: true }
    )
  }

  async getSummary(sessionId: string): Promise<SessionSummaryRow | null> {
    const doc = await this.summaryDoc(sessionId).get()
    if (!doc.exists) return null
    const data = doc.data() as SessionSummaryRow
    return {
      sessionId,
      lastTurnIncluded: data.lastTurnIncluded ?? 0,
      summaryText: data.summaryText ?? '',
      historySummaryText: data.historySummaryText ?? '',
      keyEvents: data.keyEvents ?? undefined
    }
  }
}
