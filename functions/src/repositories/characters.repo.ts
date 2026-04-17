import { FieldValue, firestore } from '../infrastructure/firestore.js'

export type CharacterDoc = {
  campaignId: string
  worldId?: string
  userId: string
  name: string
  attributes: Record<string, number>
  skills: Record<string, number>
  resources: Record<string, number>
  conditions: unknown[]
  createdAt: unknown
}

export class CharactersRepo {
  async create(params: {
    characterId: string
    campaignId: string
    worldId?: string
    userId: string
    name: string
    attributes: Record<string, number>
  }): Promise<void> {
    await firestore
      .collection('characters')
      .doc(params.characterId)
      .set({
        campaignId: params.campaignId,
        worldId: params.worldId ?? null,
        userId: params.userId,
        name: params.name,
        attributes: params.attributes,
        skills: {},
        resources: {},
        conditions: [],
        createdAt: FieldValue.serverTimestamp()
      })
  }

  async get(characterId: string): Promise<(CharacterDoc & { id: string }) | null> {
    const doc = await firestore.collection('characters').doc(characterId).get()
    if (!doc.exists) return null
    return { id: doc.id, ...(doc.data() as CharacterDoc) }
  }
}
