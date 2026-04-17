import { FieldValue, firestore } from '../infrastructure/firebase.js'
import type { Visibility } from './worlds.repo.js'

export type CampaignDoc = {
  worldId: string
  ownerId: string
  visibility?: Visibility
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
      .map((doc) => ({ id: doc.id, ...(doc.data() as CampaignDoc) }))
      .filter((campaign) => campaign.status === 'active')
  }

  async create(params: {
    campaignId: string
    worldId: string
    ownerId: string
    visibility: Visibility
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
        visibility: params.visibility,
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
    const qs = await firestore.collection('campaigns').where('ownerId', '==', params.ownerId).get()

    const filtered = this.toActiveRows(qs).filter((campaign) => {
      if (campaign.status !== 'active') return false
      if (params.worldId && campaign.worldId !== params.worldId) return false
      return true
    })

    return this.sortByCreatedAt(filtered)
  }

  async listAccessible(params: { userId: string; worldId?: string }): Promise<Array<CampaignDoc & { id: string }>> {
    const [ownedSnapshot, publicSnapshot] = await Promise.all([
      firestore.collection('campaigns').where('ownerId', '==', params.userId).get(),
      firestore.collection('campaigns').where('visibility', '==', 'public').get()
    ])

    const merged = new Map<string, CampaignDoc & { id: string }>()
    for (const campaign of [...this.toActiveRows(ownedSnapshot), ...this.toActiveRows(publicSnapshot)]) {
      if (params.worldId && campaign.worldId !== params.worldId) continue
      merged.set(campaign.id, campaign)
    }

    return this.sortByCreatedAt(Array.from(merged.values()))
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

  async updateStoryDescription(campaignId: string, storyDescription: string): Promise<void> {
    await firestore.collection('campaigns').doc(campaignId).set(
      {
        storyDescription,
        updatedAt: FieldValue.serverTimestamp()
      },
      { merge: true }
    )
  }

  async updateCampaign(params: {
    campaignId: string
    thematic: string
    storyDescription: string
    visibility?: Visibility
    image?: { mimeType: string; base64: string }
    youtubeUrl?: string
  }): Promise<void> {
    const image = params.image
    await firestore.collection('campaigns').doc(params.campaignId).set(
      {
        thematic: params.thematic,
        name: params.thematic,
        storyDescription: params.storyDescription,
        ...(params.visibility !== undefined ? { visibility: params.visibility } : {}),
        ...(image ? { image } : {}),
        ...(params.youtubeUrl !== undefined ? { youtubeUrl: params.youtubeUrl || '' } : {}),
        updatedAt: FieldValue.serverTimestamp()
      },
      { merge: true }
    )
  }
}