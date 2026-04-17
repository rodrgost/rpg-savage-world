import { BadRequestException, Injectable } from '@nestjs/common'
import { firebaseAuth, firestore } from '../infrastructure/firebase.js'

type OwnershipCounts = {
  worlds: number
  campaigns: number
  characters: number
  sessions: number
}

@Injectable()
export class AuthService {
  private async transferOwnership(params: {
    collectionName: string
    fieldName: string
    fromUserId: string
    toUserId: string
  }): Promise<number> {
    const snapshot = await firestore
      .collection(params.collectionName)
      .where(params.fieldName, '==', params.fromUserId)
      .get()

    if (snapshot.empty) return 0

    for (let index = 0; index < snapshot.docs.length; index += 400) {
      const batch = firestore.batch()
      for (const doc of snapshot.docs.slice(index, index + 400)) {
        batch.set(
          doc.ref,
          {
            [params.fieldName]: params.toUserId
          },
          { merge: true }
        )
      }
      await batch.commit()
    }

    return snapshot.size
  }

  private async transferCharacterOwnership(params: {
    fromUserId: string
    toUserId: string
  }): Promise<number> {
    const snapshot = await firestore
      .collection('characters')
      .where('userId', '==', params.fromUserId)
      .get()

    if (snapshot.empty) return 0

    for (let index = 0; index < snapshot.docs.length; index += 400) {
      const batch = firestore.batch()
      for (const doc of snapshot.docs.slice(index, index + 400)) {
        batch.set(
          doc.ref,
          {
            userId: params.toUserId,
            ownerId: params.toUserId
          },
          { merge: true }
        )
      }
      await batch.commit()
    }

    return snapshot.size
  }

  async mergeAnonymousOwnership(params: { currentUserId: string; anonymousIdToken: string }) {
    const anonymousIdToken = params.anonymousIdToken.trim()
    if (!anonymousIdToken) {
      throw new BadRequestException('O token do usuário anônimo é obrigatório.')
    }

    let decodedAnonymousToken
    try {
      decodedAnonymousToken = await firebaseAuth.verifyIdToken(anonymousIdToken)
    } catch {
      throw new BadRequestException('O token do usuário anônimo está inválido ou expirou.')
    }

    const sourceUserId = decodedAnonymousToken.uid
    const provider = decodedAnonymousToken.firebase?.sign_in_provider ?? ''

    if (provider !== 'anonymous') {
      throw new BadRequestException('O token informado não pertence a um usuário anônimo válido.')
    }

    if (sourceUserId === params.currentUserId) {
      const emptyCounts: OwnershipCounts = {
        worlds: 0,
        campaigns: 0,
        characters: 0,
        sessions: 0
      }

      return {
        ok: true,
        merged: false,
        sourceUserId,
        targetUserId: params.currentUserId,
        counts: emptyCounts
      }
    }

    const [worlds, campaigns, characters, sessions] = await Promise.all([
      this.transferOwnership({
        collectionName: 'worlds',
        fieldName: 'ownerId',
        fromUserId: sourceUserId,
        toUserId: params.currentUserId
      }),
      this.transferOwnership({
        collectionName: 'campaigns',
        fieldName: 'ownerId',
        fromUserId: sourceUserId,
        toUserId: params.currentUserId
      }),
      this.transferCharacterOwnership({
        fromUserId: sourceUserId,
        toUserId: params.currentUserId
      }),
      this.transferOwnership({
        collectionName: 'sessions',
        fieldName: 'ownerId',
        fromUserId: sourceUserId,
        toUserId: params.currentUserId
      })
    ])

    const counts: OwnershipCounts = { worlds, campaigns, characters, sessions }

    return {
      ok: true,
      merged: Object.values(counts).some((count) => count > 0),
      sourceUserId,
      targetUserId: params.currentUserId,
      counts
    }
  }
}