/**
 * Migration: Adventure → Campaign
 *
 * This script copies all documents from the `adventures` collection to the
 * `campaigns` collection (new schema), then updates references in:
 *   - characters: adventureId → campaignId (pointing to the new campaign doc)
 *   - sessions: adventureId → campaignId (pointing to the new campaign doc)
 *
 * HOW TO RUN:
 *   npx tsx scripts/migrate-adventure-to-campaign.ts
 *
 * Prerequisites:
 *   - GOOGLE_APPLICATION_CREDENTIALS env var pointing to a service account key JSON
 *   - Or run from a GCP environment with default credentials
 */

import { initializeApp } from 'firebase-admin/app'
import { getFirestore, FieldValue } from 'firebase-admin/firestore'

const app = initializeApp()
const db = getFirestore(app)

async function migrate() {
  console.log('=== Migration: adventures → campaigns ===\n')

  // 1. Copy all adventure docs to campaigns collection
  const adventuresSnap = await db.collection('adventures').get()
  console.log(`Found ${adventuresSnap.size} adventure(s) to migrate.\n`)

  const adventureIdToCampaignId = new Map<string, string>()

  for (const doc of adventuresSnap.docs) {
    const data = doc.data()
    const campaignId = doc.id // Keep the same ID for simplicity

    adventureIdToCampaignId.set(doc.id, campaignId)

    // Check if campaign doc already exists (idempotent)
    const existing = await db.collection('campaigns').doc(campaignId).get()
    if (existing.exists) {
      console.log(`  [SKIP] Campaign ${campaignId} already exists`)
      continue
    }

    await db.collection('campaigns').doc(campaignId).set({
      worldId: data.worldId ?? '',
      ownerId: data.ownerId ?? '',
      thematic: data.thematic ?? '',
      storyDescription: data.storyDescription ?? '',
      ...(data.image ? { image: data.image } : {}),
      ...(data.youtubeUrl ? { youtubeUrl: data.youtubeUrl } : {}),
      name: data.name ?? data.thematic ?? '',
      status: data.status ?? 'active',
      createdAt: data.createdAt ?? FieldValue.serverTimestamp(),
      updatedAt: data.updatedAt ?? FieldValue.serverTimestamp()
    })

    console.log(`  [OK] Adventure ${doc.id} → Campaign ${campaignId} (${data.thematic ?? 'no thematic'})`)
  }

  // 2. Update characters: set campaignId = adventureId value (same ID), remove adventureId
  const charsSnap = await db.collection('characters').get()
  console.log(`\nChecking ${charsSnap.size} character(s)...`)

  let charsUpdated = 0
  for (const doc of charsSnap.docs) {
    const data = doc.data()
    const adventureId = data.adventureId

    if (!adventureId) continue

    const campaignId = adventureIdToCampaignId.get(adventureId) ?? adventureId

    // Only update if campaignId differs or adventureId still exists
    if (data.campaignId === campaignId && !data.adventureId) continue

    await doc.ref.update({
      campaignId,
      adventureId: FieldValue.delete()
    })

    charsUpdated++
    console.log(`  [OK] Character ${doc.id}: adventureId=${adventureId} → campaignId=${campaignId}`)
  }
  console.log(`  Updated ${charsUpdated} character(s).`)

  // 3. Update sessions: set campaignId from adventureId if needed, remove adventureId field
  const sessionsSnap = await db.collection('sessions').get()
  console.log(`\nChecking ${sessionsSnap.size} session(s)...`)

  let sessionsUpdated = 0
  for (const doc of sessionsSnap.docs) {
    const data = doc.data()
    const adventureId = data.adventureId

    if (!adventureId) continue

    const campaignId = adventureIdToCampaignId.get(adventureId) ?? adventureId

    await doc.ref.update({
      campaignId,
      adventureId: FieldValue.delete()
    })

    sessionsUpdated++
    console.log(`  [OK] Session ${doc.id}: adventureId=${adventureId} → campaignId=${campaignId}`)
  }
  console.log(`  Updated ${sessionsUpdated} session(s).`)

  // 4. Update snapshots meta inside sessions
  console.log(`\nChecking session snapshots...`)
  let snapshotsUpdated = 0
  for (const sessionDoc of sessionsSnap.docs) {
    const snapshotsSnap = await sessionDoc.ref.collection('snapshots').get()
    for (const snapDoc of snapshotsSnap.docs) {
      const snapData = snapDoc.data()
      const meta = snapData.meta
      if (meta?.adventureId) {
        const campaignId = adventureIdToCampaignId.get(meta.adventureId) ?? meta.adventureId
        await snapDoc.ref.update({
          'meta.campaignId': campaignId,
          'meta.adventureId': FieldValue.delete()
        })
        snapshotsUpdated++
      }
    }
  }
  console.log(`  Updated ${snapshotsUpdated} snapshot(s).`)

  // 5. Remove campaignId from worlds (old thin campaign reference)
  const worldsSnap = await db.collection('worlds').get()
  console.log(`\nChecking ${worldsSnap.size} world(s) for old campaignId field...`)

  let worldsUpdated = 0
  for (const doc of worldsSnap.docs) {
    const data = doc.data()
    if (data.campaignId) {
      await doc.ref.update({
        campaignId: FieldValue.delete()
      })
      worldsUpdated++
      console.log(`  [OK] World ${doc.id}: removed campaignId=${data.campaignId}`)
    }
  }
  console.log(`  Updated ${worldsUpdated} world(s).`)

  console.log('\n=== Migration complete! ===')
  console.log(`Summary:`)
  console.log(`  Adventures → Campaigns: ${adventuresSnap.size}`)
  console.log(`  Characters updated: ${charsUpdated}`)
  console.log(`  Sessions updated: ${sessionsUpdated}`)
  console.log(`  Snapshots updated: ${snapshotsUpdated}`)
  console.log(`  Worlds cleaned: ${worldsUpdated}`)
}

migrate().catch((err) => {
  console.error('Migration failed:', err)
  process.exit(1)
})
