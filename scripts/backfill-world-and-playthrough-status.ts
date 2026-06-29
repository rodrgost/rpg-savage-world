/**
 * Backfill: desacoplamento Personagem↔Campanha (modelo N:M via Playthrough)
 *
 * Faz duas coisas, ambas idempotentes:
 *
 *  1) CHARACTERS — garante `worldId`.
 *     Personagens legados foram criados presos a uma campanha (`campaignId`).
 *     Aqui derivamos `worldId` a partir de `campaigns/{campaignId}.worldId`.
 *     Personagens que já têm `worldId` são pulados.
 *
 *  2) SESSIONS (Playthroughs) — garante `status: 'ativo'`.
 *     Sessões antigas não têm `status`; sem ele não aparecem na aba
 *     "jogos ativos". Default = 'ativo'. NÃO mexemos em `updatedAt`
 *     (a listagem cai para `createdAt`), para não forjar recência.
 *
 * HOW TO RUN:
 *   npx tsx scripts/backfill-world-and-playthrough-status.ts
 *
 * DRY-RUN (sem escrita):
 *   $env:DRY_RUN='1' ; npx tsx scripts/backfill-world-and-playthrough-status.ts
 *
 * Usa as mesmas credenciais do backend (.env na raiz do workspace).
 */

import '../backend/src/config/env.js'
import { firestore, FieldValue } from '../backend/src/infrastructure/firebase.js'

const DRY_RUN = process.env.DRY_RUN === '1'

/** Cache campaignId → worldId para evitar leituras repetidas. */
const campaignWorldCache = new Map<string, string | null>()

async function resolveWorldIdFromCampaign(campaignId: string): Promise<string | null> {
  if (campaignWorldCache.has(campaignId)) return campaignWorldCache.get(campaignId) ?? null
  const doc = await firestore.collection('campaigns').doc(campaignId).get()
  const worldId = doc.exists ? ((doc.data()?.worldId as string | undefined) ?? null) : null
  campaignWorldCache.set(campaignId, worldId)
  return worldId
}

async function backfillCharacters() {
  console.log('\n--- 1) characters: garantir worldId ---')
  const snap = await firestore.collection('characters').get()
  console.log(`Encontrados ${snap.size} personagem(ns).`)

  let skipped = 0
  let updated = 0
  let orphan = 0
  let errors = 0

  for (const doc of snap.docs) {
    const data = doc.data()
    const worldId = data.worldId as string | undefined
    const campaignId = data.campaignId as string | undefined

    if (worldId && worldId.trim()) {
      skipped++
      continue
    }

    if (!campaignId || !campaignId.trim()) {
      console.warn(`  [ÓRFÃO] ${doc.id} (${data.name ?? '?'}) sem worldId e sem campaignId — backfill manual`)
      orphan++
      continue
    }

    const resolvedWorldId = await resolveWorldIdFromCampaign(campaignId)
    if (!resolvedWorldId) {
      console.warn(`  [ÓRFÃO] ${doc.id} (${data.name ?? '?'}) campanha ${campaignId} sem worldId/inexistente — backfill manual`)
      orphan++
      continue
    }

    console.log(`  [${DRY_RUN ? 'DRY' : 'UPDATE'}] ${doc.id} (${data.name ?? '?'}): worldId ← ${resolvedWorldId} (via campanha ${campaignId})`)
    if (!DRY_RUN) {
      try {
        await doc.ref.set({ worldId: resolvedWorldId, updatedAt: FieldValue.serverTimestamp() }, { merge: true })
        updated++
      } catch (err) {
        console.error(`  [ERRO] Falha ao atualizar ${doc.id}:`, err)
        errors++
      }
    } else {
      updated++
    }
  }

  console.log(`  → pulados (já tinham worldId): ${skipped}`)
  console.log(`  → atualizados: ${updated}`)
  console.log(`  → órfãos (precisam de backfill manual): ${orphan}`)
  if (errors > 0) console.log(`  → erros: ${errors}`)
}

async function backfillSessionStatus() {
  console.log('\n--- 2) sessions (Playthroughs): garantir status ---')
  const snap = await firestore.collection('sessions').get()
  console.log(`Encontradas ${snap.size} sessão(ões).`)

  let skipped = 0
  let updated = 0
  let errors = 0

  for (const doc of snap.docs) {
    const data = doc.data()
    const status = data.status as string | undefined

    if (status && status.trim()) {
      skipped++
      continue
    }

    console.log(`  [${DRY_RUN ? 'DRY' : 'UPDATE'}] sessão ${doc.id}: status ← 'ativo'`)
    if (!DRY_RUN) {
      try {
        await doc.ref.set({ status: 'ativo' }, { merge: true })
        updated++
      } catch (err) {
        console.error(`  [ERRO] Falha ao atualizar ${doc.id}:`, err)
        errors++
      }
    } else {
      updated++
    }
  }

  console.log(`  → pulados (já tinham status): ${skipped}`)
  console.log(`  → atualizados: ${updated}`)
  if (errors > 0) console.log(`  → erros: ${errors}`)
}

async function main() {
  console.log('=== Backfill: worldId em characters + status em sessions ===')
  if (DRY_RUN) console.log('*** DRY-RUN — nenhuma escrita será feita ***')

  await backfillCharacters()
  await backfillSessionStatus()

  console.log('\n=== Concluído ===')
}

main().catch((err) => {
  console.error('Backfill falhou:', err)
  process.exit(1)
})
