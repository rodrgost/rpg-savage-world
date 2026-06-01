import admin from 'firebase-admin'
import { assertFirebaseEnv, env } from '../config/env.js'
import { existsSync, readFileSync } from 'node:fs'

assertFirebaseEnv()

type ServiceAccountWithProjectId = admin.ServiceAccount & { project_id?: string }

function parseServiceAccount(raw: string): ServiceAccountWithProjectId {
  return JSON.parse(raw) as ServiceAccountWithProjectId
}

function resolveProjectId(serviceAccount: ServiceAccountWithProjectId): string | undefined {
  return env.firebaseProjectId || serviceAccount.project_id || undefined
}

function init(): admin.app.App {
  if (admin.apps.length > 0) return admin.app()

  if (env.firebaseServiceAccountJson) {
    const serviceAccount = parseServiceAccount(env.firebaseServiceAccountJson)
    return admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      projectId: resolveProjectId(serviceAccount)
    })
  }

  if (env.firebaseServiceAccountPath && existsSync(env.firebaseServiceAccountPath)) {
    const raw = readFileSync(env.firebaseServiceAccountPath, 'utf-8')
    const serviceAccount = parseServiceAccount(raw)
    return admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      projectId: resolveProjectId(serviceAccount)
    })
  }

  if (env.firebaseServiceAccountPath) {
    console.warn(
      `[firebase] FIREBASE_SERVICE_ACCOUNT_PATH configurado mas arquivo nao encontrado: ${env.firebaseServiceAccountPath}. ` +
      'Tentando applicationDefault().'
    )
  }

  return admin.initializeApp({
    credential: admin.credential.applicationDefault(),
    projectId: env.firebaseProjectId || undefined
  })
}

export const firebaseApp = init()
export const firebaseAuth = admin.auth(firebaseApp)
export const firestore = admin.firestore(firebaseApp)
export const FieldValue = admin.firestore.FieldValue
