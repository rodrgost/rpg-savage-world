import { randomUUID } from 'node:crypto'
import { FieldValue, firestore } from '../infrastructure/firebase.js'

export type NarrationLogEntry = {
  id: string
  sessionId: string
  timestamp: number
  turn: number
  durationMs: number
  playerAction: { type: string; description: string }
  engineEvents: Array<{ type: string; payload: Record<string, unknown> }>
  narrative: string
  options: Array<{
    id: string
    text: string
    playerSpeech?: string | null
    actionType: string
    diceCheck?: { successChance?: number; required?: boolean } | null
  }>
  npcs: Array<{ id: string; name: string; action: string }>
  itemChanges: Array<{ name: string; changeType: string; quantity?: number }>
  statusChanges: Array<{ name: string; changeType: string; effectId?: string }>
  npcAttackEvents: Array<{ type: string; payload: Record<string, unknown> }>
  isFallback: boolean
}

const MAX_PER_SESSION = 60

function logCollection(sessionId: string) {
  return firestore.collection('sessions').doc(sessionId).collection('narrationLog')
}

export async function pushNarrationLog(entry: Omit<NarrationLogEntry, 'id'>): Promise<void> {
  const id = randomUUID()
  await logCollection(entry.sessionId).doc(id).set({
    ...entry,
    id,
    createdAt: FieldValue.serverTimestamp()
  })
}

export async function getNarrationLog(sessionId: string): Promise<NarrationLogEntry[]> {
  const qs = await logCollection(sessionId)
    .orderBy('timestamp', 'desc')
    .limit(MAX_PER_SESSION)
    .get()

  return qs.docs.map((d) => {
    const data = d.data() as NarrationLogEntry
    return { ...data, id: d.id }
  })
}
