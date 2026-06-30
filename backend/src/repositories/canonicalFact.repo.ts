import { randomUUID } from 'node:crypto'
import { FieldValue, firestore } from '../infrastructure/firebase.js'
import type { CanonicalFact, CanonicalFactCategory } from '../domain/types/canonicalFact.js'

export type NewCanonicalFact = {
  turn: number
  location: string
  category: CanonicalFactCategory
  text: string
}

export class CanonicalFactRepo {
  private collection(sessionId: string) {
    return firestore.collection('sessions').doc(sessionId).collection('facts')
  }

  async appendBatch(sessionId: string, facts: NewCanonicalFact[]): Promise<void> {
    if (!facts.length) return
    const batch = firestore.batch()
    const col = this.collection(sessionId)
    for (const fact of facts) {
      const id = randomUUID()
      batch.set(col.doc(id), {
        id,
        sessionId,
        ...fact,
        createdAt: FieldValue.serverTimestamp()
      })
    }
    await batch.commit()
  }

  async listBySession(sessionId: string): Promise<CanonicalFact[]> {
    const qs = await this.collection(sessionId).orderBy('turn', 'asc').get()
    return qs.docs.map((d) => d.data() as CanonicalFact)
  }
}
