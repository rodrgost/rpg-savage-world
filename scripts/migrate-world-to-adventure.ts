/**
 * Migration: World → Universe + Adventure
 *
 * This script reads all existing documents in the `worlds` collection (old schema)
 * and migrates them to the new two-tier model:
 *
 *   worlds  (universe / setting)  — name, description, lore, ruleSetId, image
 *   adventures (era / story)      — thematic, storyDescription, image, youtubeUrl
 *
 * It also updates characters and sessions that referenced `worldId` to reference
 * the new `adventureId` field.
 *
 * HOW TO RUN:
 *   npx tsx scripts/migrate-world-to-adventure.ts
 *
 * Prerequisites:
 *   - GOOGLE_APPLICATION_CREDENTIALS env var pointing to a service account key JSON
 *   - Or run from a GCP environment with default credentials
 */

import { initializeApp, cert, type ServiceAccount } from 'firebase-admin/app'
import { getFirestore, FieldValue } from 'firebase-admin/firestore'
import { randomUUID } from 'node:crypto'

// Initialize Firebase Admin
const app = initializeApp()
const db = getFirestore(app)

interface OldWorldDoc {
  campaignId?: string
  ownerId?: string
  ruleSetId?: string
  thematic?: string
  name?: string
  storyDescription?: string
  image?: { mimeType: string; base64: string }
  youtubeUrl?: string
  status?: string
  createdAt?: unknown
  updatedAt?: unknown
}

async function migrate() {
  console.log('=== Starting migration: World → Universe + Adventure ===\n')

  const worldsSnap = await db.collection('worlds').get()
  console.log(`Found ${worldsSnap.size} existing world documents.\n`)

  if (worldsSnap.empty) {
    console.log('Nothing to migrate.')
    return
  }

  // We'll collect campaign IDs to look up names
  const campaignIds = new Set<string>()
  for (const doc of worldsSnap.docs) {
    const data = doc.data() as OldWorldDoc
    if (data.campaignId) campaignIds.add(data.campaignId)
  }

  // Load campaign names
  const campaignNames: Record<string, string> = {}
  for (const cid of campaignIds) {
    const cDoc = await db.collection('campaigns').doc(cid).get()
    if (cDoc.exists) {
      campaignNames[cid] = (cDoc.data() as Record<string, unknown>)?.name as string ?? ''
    }
  }

  const batch = db.batch()
  const worldIdToAdventureId: Record<string, string> = {}
  let count = 0

  for (const doc of worldsSnap.docs) {
    const oldWorldId = doc.id
    const data = doc.data() as OldWorldDoc

    // Determine universe name from campaign or thematic
    const campaignName = data.campaignId ? (campaignNames[data.campaignId] ?? '') : ''
    const universeName = campaignName || data.name || data.thematic || 'Universo sem nome'

    // Check if this doc already has new fields (idempotency — skip if already migrated)
    if ((data as Record<string, unknown>).description !== undefined && !(data as Record<string, unknown>).thematic) {
      console.log(`  [SKIP] World ${oldWorldId} appears already migrated.`)
      continue
    }

    // 1. Rewrite the world doc as a universe
    const worldRef = db.collection('worlds').doc(oldWorldId)
    batch.set(worldRef, {
      campaignId: data.campaignId ?? '',
      ownerId: data.ownerId ?? '',
      ruleSetId: data.ruleSetId ?? 'savage-worlds',
      name: universeName,
      description: data.thematic ? `Cenário com temática: ${data.thematic}` : '',
      lore: '',
      status: data.status ?? 'active',
      image: data.image ?? null,
      createdAt: data.createdAt ?? FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    })

    // 2. Create an adventure document from the old world data
    const adventureId = randomUUID()
    worldIdToAdventureId[oldWorldId] = adventureId

    const adventureRef = db.collection('adventures').doc(adventureId)
    batch.set(adventureRef, {
      worldId: oldWorldId,
      ownerId: data.ownerId ?? '',
      thematic: data.thematic ?? data.name ?? '',
      name: data.thematic ?? data.name ?? '',
      storyDescription: data.storyDescription ?? '',
      image: data.image ?? null,
      youtubeUrl: data.youtubeUrl ?? '',
      status: 'active',
      createdAt: data.createdAt ?? FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    })

    console.log(`  [MIGRATE] World "${oldWorldId}" → Universe "${universeName}" + Adventure "${adventureId}"`)
    count++
  }

  if (count === 0) {
    console.log('\nNo documents needed migration.')
    return
  }

  // Commit world + adventure changes first
  await batch.commit()
  console.log(`\n✅ Migrated ${count} world(s) into universe + adventure pairs.\n`)

  // 3. Update characters: add adventureId based on their worldId
  console.log('--- Updating characters ---')
  const charsSnap = await db.collection('characters').get()
  let charCount = 0

  for (const doc of charsSnap.docs) {
    const charData = doc.data() as Record<string, unknown>
    const oldWorldId = charData.worldId as string | undefined
    if (!oldWorldId) continue

    const adventureId = worldIdToAdventureId[oldWorldId]
    if (!adventureId) {
      console.log(`  [WARN] Character ${doc.id} has worldId "${oldWorldId}" with no matching adventure. Skipping.`)
      continue
    }

    // Only update if adventureId not already set
    if (!charData.adventureId) {
      await db.collection('characters').doc(doc.id).update({
        adventureId,
        updatedAt: FieldValue.serverTimestamp()
      })
      charCount++
    }
  }
  console.log(`✅ Updated ${charCount} character(s).\n`)

  // 4. Update sessions: add adventureId based on their worldId
  console.log('--- Updating sessions ---')
  const sessionsSnap = await db.collection('sessions').get()
  let sessionCount = 0

  for (const doc of sessionsSnap.docs) {
    const sessData = doc.data() as Record<string, unknown>
    const oldWorldId = sessData.worldId as string | undefined
    if (!oldWorldId) continue

    const adventureId = worldIdToAdventureId[oldWorldId]
    if (!adventureId) {
      console.log(`  [WARN] Session ${doc.id} has worldId "${oldWorldId}" with no matching adventure. Skipping.`)
      continue
    }

    if (!sessData.adventureId) {
      await db.collection('sessions').doc(doc.id).update({
        adventureId,
        updatedAt: FieldValue.serverTimestamp()
      })
      sessionCount++
    }
  }
  console.log(`✅ Updated ${sessionCount} session(s).\n`)

  console.log('=== Migration complete ===')
  console.log('Mapping (old worldId → new adventureId):')
  for (const [wid, aid] of Object.entries(worldIdToAdventureId)) {
    console.log(`  ${wid} → ${aid}`)
  }
}

migrate().catch((err) => {
  console.error('Migration failed:', err)
  process.exit(1)
})
