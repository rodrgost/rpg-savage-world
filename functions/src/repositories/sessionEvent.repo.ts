import { FieldValue, firestore } from '../infrastructure/firestore.js'

export class SessionEventRepo {
  private eventsCollection(sessionId: string) {
    return firestore.collection('sessions').doc(sessionId).collection('events')
  }

  async append(params: { sessionId: string; turn: number; type: string; payload: Record<string, unknown> }): Promise<void> {
    await this.eventsCollection(params.sessionId).add({
      turn: params.turn,
      type: params.type,
      payload: params.payload,
      createdAt: FieldValue.serverTimestamp()
    })
  }

  async listSince(params: { sessionId: string; afterTurn: number }): Promise<Array<{ turn: number; type: string; payload: unknown }>> {
    const qs = await this.eventsCollection(params.sessionId)
      .where('turn', '>', params.afterTurn)
      .orderBy('turn', 'asc')
      .get()

    return qs.docs.map((d) => {
      const data = d.data() as { turn: number; type: string; payload: unknown }
      return { turn: data.turn, type: data.type, payload: data.payload }
    })
  }
}
