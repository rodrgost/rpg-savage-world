import type { GameState } from '../domain/types/gameState.js'
import { FieldValue, firestore } from '../infrastructure/firebase.js'

/** Remove recursivamente propriedades com valor undefined de um objeto (Firestore não aceita undefined) */
function stripUndefined<T>(obj: T): T {
  if (obj === null || obj === undefined || typeof obj !== 'object') return obj
  if (Array.isArray(obj)) return obj.map(stripUndefined) as unknown as T
  const clean: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (v !== undefined) clean[k] = stripUndefined(v)
  }
  return clean as T
}

export class SessionSnapshotRepo {
  private sessionDoc(sessionId: string) {
    return firestore.collection('sessions').doc(sessionId)
  }

  async createSnapshot(params: { sessionId: string; turn: number; state: GameState }): Promise<void> {
    const snapRef = this.sessionDoc(params.sessionId).collection('snapshots').doc(String(params.turn))
    await snapRef.set({
      turn: params.turn,
      stateJson: stripUndefined(params.state),
      createdAt: FieldValue.serverTimestamp()
    })
  }

  async getLatestSnapshot(sessionId: string): Promise<{ turn: number; state: GameState } | null> {
    const qs = await this.sessionDoc(sessionId)
      .collection('snapshots')
      .orderBy('turn', 'desc')
      .limit(1)
      .get()

    const doc = qs.docs[0]
    if (!doc) return null

    const data = doc.data() as { turn: number; stateJson: GameState }
    return { turn: data.turn, state: data.stateJson }
  }

  async getSnapshot(sessionId: string, turn: number): Promise<GameState | null> {
    const doc = await this.sessionDoc(sessionId).collection('snapshots').doc(String(turn)).get()
    if (!doc.exists) return null
    const data = doc.data() as { stateJson: GameState }
    return data.stateJson
  }
}
