import { FieldValue, firestore } from '../infrastructure/firestore.js'

export type WorldDoc = {
  ownerId: string
  ruleSetId: string
  name: string
  description: string
  lore: string
  status: 'active'
  createdAt: unknown
  updatedAt: unknown
}

export class WorldsRepo {
  async create(params: { worldId: string; ownerId: string; ruleSetId: string; name: string; description: string; lore?: string }): Promise<void> {
    await firestore
      .collection('worlds')
      .doc(params.worldId)
      .set({
        ownerId: params.ownerId,
        ruleSetId: params.ruleSetId,
        name: params.name,
        description: params.description,
        lore: params.lore ?? '',
        status: 'active',
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      })
  }

  async get(worldId: string): Promise<(WorldDoc & { id: string }) | null> {
    const doc = await firestore.collection('worlds').doc(worldId).get()
    if (!doc.exists) return null
    return { id: doc.id, ...(doc.data() as WorldDoc) }
  }

  async listByOwner(params: { ownerId: string }): Promise<Array<WorldDoc & { id: string }>> {
    let query: FirebaseFirestore.Query<FirebaseFirestore.DocumentData> = firestore
      .collection('worlds')
      .where('ownerId', '==', params.ownerId)
      .where('status', '==', 'active')

    const qs = await query.orderBy('createdAt', 'desc').get()
    return qs.docs.map((doc) => ({ id: doc.id, ...(doc.data() as WorldDoc) }))
  }

  async delete(worldId: string): Promise<void> {
    await firestore.collection('worlds').doc(worldId).delete()
  }

  async updateLore(worldId: string, lore: string): Promise<void> {
    await firestore.collection('worlds').doc(worldId).set(
      {
        lore,
        updatedAt: FieldValue.serverTimestamp()
      },
      { merge: true }
    )
  }
}