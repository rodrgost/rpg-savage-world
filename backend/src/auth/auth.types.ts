import type admin from 'firebase-admin'
import type { Request } from 'express'

export type AuthenticatedUser = {
  uid: string
  email?: string
  isAnonymous: boolean
  token: admin.auth.DecodedIdToken
}

export type AuthenticatedRequest = Request & {
  user: AuthenticatedUser
}