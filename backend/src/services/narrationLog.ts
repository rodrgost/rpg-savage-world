import { randomUUID } from 'node:crypto'

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
    feasible: boolean
    diceCheck?: { skill?: string; attribute?: string; tn?: number; required?: boolean } | null
  }>
  npcs: Array<{ id: string; name: string; action: string }>
  itemChanges: Array<{ name: string; changeType: string; quantity?: number }>
  statusChanges: Array<{ name: string; changeType: string; effectId?: string }>
  npcAttackEvents: Array<{ type: string; payload: Record<string, unknown> }>
  isFallback: boolean
}

const MAX_PER_SESSION = 60
const _store = new Map<string, NarrationLogEntry[]>()

export function pushNarrationLog(entry: Omit<NarrationLogEntry, 'id'>): void {
  const list = _store.get(entry.sessionId) ?? []
  list.push({ id: randomUUID(), ...entry })
  if (list.length > MAX_PER_SESSION) list.shift()
  _store.set(entry.sessionId, list)
}

export function getNarrationLog(sessionId: string): NarrationLogEntry[] {
  return [...(_store.get(sessionId) ?? [])].reverse()
}
