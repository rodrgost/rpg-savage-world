import { FieldValue, firestore } from '../infrastructure/firestore.js'

export type SessionSummaryRow = {
  sessionId: string
  lastTurnIncluded: number
  summaryText: string
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
    keyEvents?: unknown
  }): Promise<void> {
    await this.summaryDoc(params.sessionId).set(
      {
        sessionId: params.sessionId,
        lastTurnIncluded: params.lastTurnIncluded,
        summaryText: params.summaryText,
        keyEvents: params.keyEvents ?? null,
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
      keyEvents: data.keyEvents ?? undefined
    }
  }
}
