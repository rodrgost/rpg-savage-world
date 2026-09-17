import { FieldValue, firestore } from '../infrastructure/firebase.js'

export type SystemPromptRecord = {
  userId: string
  promptKey: string
  prompt: string
  createdAt?: unknown
  updatedAt?: unknown
}

export class SystemPromptsRepo {
  private collection() {
    return firestore.collection('system_prompts')
  }

  private docId(userId: string, promptKey: string): string {
    return `${userId}_${promptKey}`
  }

  async get(userId: string, promptKey: string): Promise<string | null> {
    if (!userId || !promptKey) return null
    const snap = await this.collection().doc(this.docId(userId, promptKey)).get()
    if (!snap.exists) return null
    const data = snap.data() as SystemPromptRecord | undefined
    return typeof data?.prompt === 'string' ? data.prompt : null
  }

  async set(userId: string, promptKey: string, prompt: string): Promise<void> {
    const docRef = this.collection().doc(this.docId(userId, promptKey))
    const snap = await docRef.get()
    if (snap.exists) {
      await docRef.set(
        {
          userId,
          promptKey,
          prompt,
          updatedAt: FieldValue.serverTimestamp()
        },
        { merge: true }
      )
    } else {
      await docRef.set({
        userId,
        promptKey,
        prompt,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      })
    }
  }

  async delete(userId: string, promptKey: string): Promise<void> {
    await this.collection().doc(this.docId(userId, promptKey)).delete()
  }
}
