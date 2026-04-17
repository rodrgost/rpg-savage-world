import type { GameState } from '../domain/types/gameState.js'
import { FieldValue, firestore } from '../infrastructure/firestore.js'

export class SessionSnapshotRepo {
  private sessionDoc(sessionId: string) {
    return firestore.collection('sessions').doc(sessionId)
  }

  async createSnapshot(params: { sessionId: string; turn: number; state: GameState }): Promise<void> {
    const snapRef = this.sessionDoc(params.sessionId).collection('snapshots').doc(String(params.turn))
    await snapRef.set({
      turn: params.turn,
      stateJson: params.state,
      createdAt: FieldValue.serverTimestamp()
    })
  }

  async getLatestSnapshot(sessionId: string): Promise<{ turn: number; state: GameState } | null> {
    const qs = await this.sessionDoc(sessionId).collection('snapshots').orderBy('turn', 'desc').limit(1).get()
    const doc = qs.docs[0]
    if (!doc) return null
    const data = doc.data() as { turn: number; stateJson: GameState }
    return { turn: data.turn, state: data.stateJson }
  }
}
