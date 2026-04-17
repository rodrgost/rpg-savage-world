import type { GameState } from '../domain/types/gameState.js'
import { SessionSnapshotRepo } from '../repositories/sessionSnapshot.repo.js'

export class SnapshotService {
  constructor(private readonly snapshots = new SessionSnapshotRepo()) {}

  async saveTurnState(state: GameState): Promise<void> {
    await this.snapshots.createSnapshot({
      sessionId: state.meta.sessionId,
      turn: state.meta.turn,
      state
    })
  }

  async getLatestState(sessionId: string): Promise<GameState | null> {
    const latest = await this.snapshots.getLatestSnapshot(sessionId)
    return latest?.state ?? null
  }
}
