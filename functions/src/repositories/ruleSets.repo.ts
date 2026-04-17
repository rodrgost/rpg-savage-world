import { FieldValue, firestore } from '../infrastructure/firestore.js'

export type RuleSetDoc = {
  name: string
  system: string
  rulesJson: Record<string, unknown>
  createdAt: unknown
  updatedAt: unknown
}

export class RuleSetsRepo {
  async upsert(params: {
    ruleSetId: string
    name: string
    system: string
    rulesJson: Record<string, unknown>
  }): Promise<void> {
    await firestore
      .collection('rule_sets')
      .doc(params.ruleSetId)
      .set(
        {
          name: params.name,
          system: params.system,
          rulesJson: params.rulesJson,
          updatedAt: FieldValue.serverTimestamp(),
          createdAt: FieldValue.serverTimestamp()
        },
        { merge: true }
      )
  }

  async get(ruleSetId: string): Promise<(RuleSetDoc & { id: string }) | null> {
    const doc = await firestore.collection('rule_sets').doc(ruleSetId).get()
    if (!doc.exists) return null
    return { id: doc.id, ...(doc.data() as RuleSetDoc) }
  }

  async listAll(): Promise<Array<RuleSetDoc & { id: string }>> {
    const qs = await firestore.collection('rule_sets').orderBy('updatedAt', 'desc').get()
    return qs.docs.map((doc) => ({ id: doc.id, ...(doc.data() as RuleSetDoc) }))
  }
}
