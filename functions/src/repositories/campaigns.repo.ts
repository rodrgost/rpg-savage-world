import { FieldValue, firestore } from '../infrastructure/firestore.js'

export type CampaignDoc = {
  worldId: string
  ownerId: string
  thematic: string
  storyDescription: string
  image?: {
    mimeType: string
    base64: string
  }
  youtubeUrl?: string
  name?: string
  status: 'active'
  createdAt: unknown
  updatedAt: unknown
}

export class CampaignsRepo {
  async create(params: {
    campaignId: string
    worldId: string
    ownerId: string
    thematic: string
    storyDescription: string
    image?: { mimeType: string; base64: string }
    youtubeUrl?: string
  }): Promise<void> {
    const image = params.image
    await firestore
      .collection('campaigns')
      .doc(params.campaignId)
      .set({
        worldId: params.worldId,
        ownerId: params.ownerId,
        thematic: params.thematic,
        storyDescription: params.storyDescription,
        ...(image ? { image } : {}),
        ...(params.youtubeUrl ? { youtubeUrl: params.youtubeUrl } : {}),
        name: params.thematic,
        status: 'active',
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      })
  }

  async get(campaignId: string): Promise<(CampaignDoc & { id: string }) | null> {
    const doc = await firestore.collection('campaigns').doc(campaignId).get()
    if (!doc.exists) return null
    return { id: doc.id, ...(doc.data() as CampaignDoc) }
  }

  async listByOwner(params: { ownerId: string; worldId?: string }): Promise<Array<CampaignDoc & { id: string }>> {
    let query: FirebaseFirestore.Query<FirebaseFirestore.DocumentData> = firestore
      .collection('campaigns')
      .where('ownerId', '==', params.ownerId)
      .where('status', '==', 'active')

    if (params.worldId) {
      query = query.where('worldId', '==', params.worldId)
    }

    const qs = await query.orderBy('createdAt', 'desc').get()
    return qs.docs.map((doc) => ({ id: doc.id, ...(doc.data() as CampaignDoc) }))
  }

  async listByWorld(worldId: string): Promise<Array<CampaignDoc & { id: string }>> {
    const qs = await firestore
      .collection('campaigns')
      .where('worldId', '==', worldId)
      .where('status', '==', 'active')
      .get()

    return qs.docs.map((doc) => ({ id: doc.id, ...(doc.data() as CampaignDoc) }))
  }

  async delete(campaignId: string): Promise<void> {
    await firestore.collection('campaigns').doc(campaignId).delete()
  }
}
