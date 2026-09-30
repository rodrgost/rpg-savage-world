import type { GameState } from '../domain/types/gameState.js'
import { SessionSnapshotRepo } from '../repositories/sessionSnapshot.repo.js'
import { FieldValue, firestore } from '../infrastructure/firebase.js'

export class SnapshotService {
  constructor(private readonly snapshots = new SessionSnapshotRepo()) {}

  async saveTurnState(state: GameState): Promise<void> {
    await this.snapshots.createSnapshot({
      sessionId: state.meta.sessionId,
      turn: state.meta.turn,
      state
    })

    try {
      await firestore.collection('sessions').doc(state.meta.sessionId).set({
        turn: state.meta.turn,
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true })
    } catch {
      // Falha secundária não bloqueia o snapshot
    }
  }

  async getLatestState(sessionId: string): Promise<GameState | null> {
    const latest = await this.snapshots.getLatestSnapshot(sessionId)
    return latest?.state ?? null
  }

  async getLatestSnapshot(sessionId: string): Promise<{ turn: number; state: GameState } | null> {
    return await this.snapshots.getLatestSnapshot(sessionId)
  }
}
