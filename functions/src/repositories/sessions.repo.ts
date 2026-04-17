import { FieldValue, firestore } from '../infrastructure/firestore.js'

export type SessionDoc = {
  campaignId: string
  ownerId: string
  characterId: string
  worldId?: string
  status: 'active' | 'paused' | 'ended'
  activeConflict: string | null
  currentTurn: number
  createdAt: unknown
}

export class SessionsRepo {
  async create(params: { sessionId: string; campaignId: string; ownerId: string; characterId: string; worldId?: string }): Promise<void> {
    await firestore
      .collection('sessions')
      .doc(params.sessionId)
      .set({
        campaignId: params.campaignId,
        ownerId: params.ownerId,
        characterId: params.characterId,
        worldId: params.worldId ?? null,
        status: 'active',
        activeConflict: null,
        currentTurn: 0,
        createdAt: FieldValue.serverTimestamp()
      })
  }

  async get(sessionId: string): Promise<(SessionDoc & { id: string }) | null> {
    const doc = await firestore.collection('sessions').doc(sessionId).get()
    if (!doc.exists) return null
    return { id: doc.id, ...(doc.data() as SessionDoc) }
  }

  async updateTurn(params: { sessionId: string; currentTurn: number }): Promise<void> {
    await firestore.collection('sessions').doc(params.sessionId).set({ currentTurn: params.currentTurn }, { merge: true })
  }

  async pause(params: { sessionId: string }): Promise<void> {
    await firestore.collection('sessions').doc(params.sessionId).set({ status: 'paused' }, { merge: true })
  }

  async resume(params: { sessionId: string }): Promise<void> {
    await firestore.collection('sessions').doc(params.sessionId).set({ status: 'active' }, { merge: true })
  }
}
