/**
 * Migration: Legacy skill labels → Canonical PT-BR labels
 *
 * Updates all characters in Firestore whose `skills` map contains legacy
 * keys (e.g. "Lutar", "Atirar", "Dirigir") to the canonical backend labels
 * (e.g. "Luta", "Tiro", "Condução").
 *
 * The script is idempotent: documents that already use canonical labels are
 * skipped without modification.
 *
 * HOW TO RUN:
 *   npx tsx scripts/migrate-skill-labels.ts
 *
 * DRY-RUN mode (no writes):
 *   $env:DRY_RUN='1' ; npx tsx scripts/migrate-skill-labels.ts
 *
 * Uses the same Firebase credentials as the backend (.env at workspace root).
 */

import '../backend/src/config/env.js'
import { firestore } from '../backend/src/infrastructure/firebase.js'

const DRY_RUN = process.env.DRY_RUN === '1'

// Mapeamento completo: label legado → label canônico
const LEGACY_TO_CANONICAL: Record<string, string> = {
  // Agilidade
  Atirar: 'Tiro',
  Cavalgar: 'Montaria',
  Lutar: 'Luta',
  Pilotar: 'Pilotagem',
  Dirigir: 'Condução',
  Navegar: 'Navegação',
  Roubar: 'Ladinagem',   // duplicata — consolida em Ladinagem
  // Astúcia
  Apostar: 'Jogatina',
  'Ciências': 'Ciência',
  Curar: 'Medicina',
  Investigar: 'Pesquisa',
  Notar: 'Percepção',
  Reparar: 'Reparos',
  // Espírito
  Intimidar: 'Intimidação',
  Persuadir: 'Persuasão',
  Conjurar: 'Magias',
  Psionismo: 'Foco',
  Desempenho: 'Atuação',
}

function migrateSkills(skills: Record<string, unknown>): { updated: Record<string, unknown>; changed: boolean } {
  const result: Record<string, unknown> = {}
  let changed = false

  for (const [key, value] of Object.entries(skills)) {
    const canonical = LEGACY_TO_CANONICAL[key]
    if (canonical) {
      // Se o canonical já existe no mesmo documento, mantém o maior valor (não sobrescreve progresso)
      if (canonical in skills) {
        const existing = skills[canonical]
        const legacy = value
        const winner = typeof existing === 'number' && typeof legacy === 'number'
          ? Math.max(existing, legacy)
          : existing
        result[canonical] = winner
      } else {
        result[canonical] = value
      }
      changed = true
    } else {
      // Já está no formato canônico ou é chave desconhecida — mantém
      if (!(key in result)) {
        result[key] = value
      }
    }
  }

  return { updated: result, changed }
}

async function migrate() {
  console.log(`=== Migration: legacy skill labels → canonical PT-BR labels ===`)
  if (DRY_RUN) console.log('*** DRY-RUN mode — no writes will be performed ***\n')

  const snap = await firestore.collection('characters').get()
  console.log(`Found ${snap.size} character(s) to check.\n`)

  let skipped = 0
  let updated = 0
  let errors = 0

  for (const doc of snap.docs) {
    const data = doc.data()
    const skills = data.skills as Record<string, unknown> | undefined

    if (!skills || typeof skills !== 'object') {
      skipped++
      continue
    }

    const { updated: newSkills, changed } = migrateSkills(skills)

    if (!changed) {
      skipped++
      continue
    }

    const changedKeys = Object.keys(skills).filter((k) => LEGACY_TO_CANONICAL[k])
    console.log(`  [${DRY_RUN ? 'DRY' : 'UPDATE'}] Character ${doc.id} (${data.name ?? '?'}): ${changedKeys.map((k) => `${k} → ${LEGACY_TO_CANONICAL[k]}`).join(', ')}`)

    if (!DRY_RUN) {
      try {
        await doc.ref.update({ skills: newSkills })
        updated++
      } catch (err) {
        console.error(`  [ERROR] Failed to update ${doc.id}:`, err)
        errors++
      }
    } else {
      updated++
    }  }

  console.log(`\n=== Done ===`)
  console.log(`  Skipped (already canonical): ${skipped}`)
  console.log(`  Updated: ${updated}`)
  if (errors > 0) console.log(`  Errors: ${errors}`)
}

migrate().catch((err) => {
  console.error('Migration failed:', err)
  process.exit(1)
})
