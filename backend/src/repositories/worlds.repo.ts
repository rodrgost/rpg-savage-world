import { FieldValue, firestore } from '../infrastructure/firebase.js'

export type Visibility = 'private' | 'public'

export type WorldDoc = {
  ownerId: string
  visibility?: Visibility
  ruleSetId: string
  name: string
  description: string
  lore: string
  image?: {
    mimeType: string
    base64: string
  }
  status: 'active'
  createdAt: unknown
  updatedAt: unknown
}

export class WorldsRepo {
  private sortByCreatedAt<T extends { createdAt: unknown }>(items: T[]): T[] {
    return items.sort((left, right) => {
      const leftSeconds =
        typeof left.createdAt === 'object' && left.createdAt && '_seconds' in left.createdAt
          ? Number((left.createdAt as { _seconds: number })._seconds)
          : 0
      const rightSeconds =
        typeof right.createdAt === 'object' && right.createdAt && '_seconds' in right.createdAt
          ? Number((right.createdAt as { _seconds: number })._seconds)
          : 0
      return rightSeconds - leftSeconds
    })
  }

  private toActiveRows(snapshot: FirebaseFirestore.QuerySnapshot<FirebaseFirestore.DocumentData>) {
    return snapshot.docs
      .map((doc) => ({ id: doc.id, ...(doc.data() as WorldDoc) }))
      .filter((world) => world.status === 'active')
  }

  async create(params: {
    worldId: string
    ownerId: string
    visibility: Visibility
    ruleSetId: string
    name: string
    description: string
    lore?: string
    image?: { mimeType: string; base64: string }
  }): Promise<void> {
    const image = params.image
    await firestore
      .collection('worlds')
      .doc(params.worldId)
      .set({
        ownerId: params.ownerId,
        visibility: params.visibility,
        ruleSetId: params.ruleSetId,
        name: params.name,
        description: params.description,
        lore: params.lore ?? '',
        ...(image ? { image } : {}),
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
    const qs = await firestore.collection('worlds').where('ownerId', '==', params.ownerId).get()

    return this.sortByCreatedAt(this.toActiveRows(qs))
  }

  async listAccessible(params: { userId: string }): Promise<Array<WorldDoc & { id: string }>> {
    const [ownedSnapshot, publicSnapshot] = await Promise.all([
      firestore.collection('worlds').where('ownerId', '==', params.userId).get(),
      firestore.collection('worlds').where('visibility', '==', 'public').get()
    ])

    const merged = new Map<string, WorldDoc & { id: string }>()
    for (const world of [...this.toActiveRows(ownedSnapshot), ...this.toActiveRows(publicSnapshot)]) {
      merged.set(world.id, world)
    }

    return this.sortByCreatedAt(Array.from(merged.values()))
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

  async updateWorld(params: {
    worldId: string
    name?: string
    description?: string
    lore?: string
    ruleSetId?: string
    visibility?: Visibility
    image?: { mimeType: string; base64: string }
  }): Promise<void> {
    const image = params.image
    const data: Record<string, unknown> = {
      updatedAt: FieldValue.serverTimestamp()
    }
    if (params.name !== undefined) data.name = params.name
    if (params.description !== undefined) data.description = params.description
    if (params.lore !== undefined) data.lore = params.lore
    if (params.ruleSetId !== undefined) data.ruleSetId = params.ruleSetId
    if (params.visibility !== undefined) data.visibility = params.visibility
    if (image) data.image = image

    await firestore.collection('worlds').doc(params.worldId).set(data, { merge: true })
  }
}