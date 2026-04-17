import { FieldValue, firestore } from '../infrastructure/firebase.js'
import type { Visibility } from './worlds.repo.js'

export type CharacterDoc = {
  campaignId: string
  worldId?: string
  ownerId?: string
  userId?: string
  visibility?: Visibility
  name: string
  gender?: string
  race?: string
  characterClass?: string
  profession?: string
  description?: string
  image?: {
    mimeType: string
    base64: string
  }
  attributes: Record<string, number>
  skills: Record<string, number>
  edges: string[]
  hindrances: Array<{ name: string; severity: string }>
  hindranceAllocation?: { extraEdges: number; extraAttributePoints: number; extraSkillPoints: number }
  armor?: number
  sheetValues?: Record<string, unknown>
  createdAt: unknown
  updatedAt?: unknown
}

export class CharactersRepo {
  private toMillis(value: unknown): number {
    if (!value) return 0
    if (typeof value === 'object' && value !== null) {
      if ('toMillis' in value && typeof (value as { toMillis?: unknown }).toMillis === 'function') {
        return ((value as { toMillis: () => number }).toMillis() ?? 0)
      }

      if ('seconds' in value && typeof (value as { seconds?: unknown }).seconds === 'number') {
        const seconds = Number((value as { seconds: number }).seconds)
        const nanoseconds = Number((value as { nanoseconds?: number }).nanoseconds ?? 0)
        return seconds * 1000 + Math.floor(nanoseconds / 1_000_000)
      }
    }

    return 0
  }

  async create(params: {
    characterId: string
    campaignId: string
    worldId?: string
    ownerId: string
    visibility: Visibility
    name: string
    gender: string
    race: string
    characterClass: string
    profession: string
    description: string
    attributes: Record<string, number>
    skills: Record<string, number>
    edges: string[]
    hindrances: Array<{ name: string; severity: string }>
    hindranceAllocation?: { extraEdges: number; extraAttributePoints: number; extraSkillPoints: number }
    sheetValues: Record<string, unknown>
    image?: { mimeType: string; base64: string }
  }): Promise<void> {
    const image = params.image
    await firestore
      .collection('characters')
      .doc(params.characterId)
      .set({
        campaignId: params.campaignId,
        ...(params.worldId ? { worldId: params.worldId } : {}),
        ownerId: params.ownerId,
        userId: params.ownerId,
        visibility: params.visibility,
        name: params.name,
        gender: params.gender,
        race: params.race,
        characterClass: params.characterClass,
        profession: params.profession,
        description: params.description,
        ...(image ? { image } : {}),
        attributes: params.attributes,
        skills: params.skills,
        edges: params.edges,
        hindrances: params.hindrances,
        ...(params.hindranceAllocation ? { hindranceAllocation: params.hindranceAllocation } : {}),
        sheetValues: params.sheetValues,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      })
  }

  async get(characterId: string): Promise<(CharacterDoc & { id: string }) | null> {
    const doc = await firestore.collection('characters').doc(characterId).get()
    if (!doc.exists) return null
    return { id: doc.id, ...(doc.data() as CharacterDoc) }
  }

  async listByUser(params: { userId: string; campaignId?: string; worldId?: string }): Promise<Array<CharacterDoc & { id: string }>> {
    let characterQuery: FirebaseFirestore.Query<FirebaseFirestore.DocumentData> = firestore
      .collection('characters')
      .where('userId', '==', params.userId)

    if (params.campaignId) {
      characterQuery = characterQuery.where('campaignId', '==', params.campaignId)
    } else if (params.worldId) {
      characterQuery = characterQuery.where('worldId', '==', params.worldId)
    }

    const qs = await characterQuery.get()
    const rows = qs.docs.map((doc) => ({ id: doc.id, ...(doc.data() as CharacterDoc) }))

    rows.sort((a, b) => this.toMillis(b.createdAt) - this.toMillis(a.createdAt))
    return rows
  }

  async listAccessible(params: { userId: string; campaignId?: string; worldId?: string }): Promise<Array<CharacterDoc & { id: string }>> {
    const [ownedSnapshot, publicSnapshot] = await Promise.all([
      firestore.collection('characters').where('userId', '==', params.userId).get(),
      firestore.collection('characters').where('visibility', '==', 'public').get()
    ])

    const merged = new Map<string, CharacterDoc & { id: string }>()
    for (const snapshot of [ownedSnapshot, publicSnapshot]) {
      for (const doc of snapshot.docs) {
        const character = { id: doc.id, ...(doc.data() as CharacterDoc) }
        if (params.campaignId && character.campaignId !== params.campaignId) continue
        if (!params.campaignId && params.worldId && character.worldId !== params.worldId) continue
        merged.set(character.id, character)
      }
    }

    const rows = Array.from(merged.values())
    rows.sort((a, b) => this.toMillis(b.createdAt) - this.toMillis(a.createdAt))
    return rows
  }

  async listByCampaign(campaignId: string): Promise<Array<CharacterDoc & { id: string }>> {
    const snapshot = await firestore.collection('characters').where('campaignId', '==', campaignId).get()
    const rows = snapshot.docs.map((doc) => ({ id: doc.id, ...(doc.data() as CharacterDoc) }))
    rows.sort((a, b) => this.toMillis(b.createdAt) - this.toMillis(a.createdAt))
    return rows
  }

  async update(params: {
    characterId: string
    name: string
    gender: string
    race: string
    characterClass: string
    profession: string
    description: string
    visibility?: Visibility
    attributes: Record<string, number>
    skills: Record<string, number>
    edges: string[]
    hindrances: Array<{ name: string; severity: string }>
    hindranceAllocation?: { extraEdges: number; extraAttributePoints: number; extraSkillPoints: number }
    sheetValues: Record<string, unknown>
    image?: { mimeType: string; base64: string }
  }): Promise<void> {
    const image = params.image
    await firestore.collection('characters').doc(params.characterId).set(
      {
        name: params.name,
        gender: params.gender,
        race: params.race,
        characterClass: params.characterClass,
        profession: params.profession,
        description: params.description,
        ...(params.visibility !== undefined ? { visibility: params.visibility } : {}),
        attributes: params.attributes,
        skills: params.skills,
        edges: params.edges,
        hindrances: params.hindrances,
        ...(params.hindranceAllocation ? { hindranceAllocation: params.hindranceAllocation } : {}),
        sheetValues: params.sheetValues,
        updatedAt: FieldValue.serverTimestamp(),
        ...(image ? { image } : {})
      },
      { merge: true }
    )
  }

  async delete(characterId: string): Promise<void> {
    await firestore.collection('characters').doc(characterId).delete()
  }
}