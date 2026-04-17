import admin from 'firebase-admin'
import { assertFirebaseEnv, env } from '../config/env.js'
import { readFileSync } from 'node:fs'

assertFirebaseEnv()

function init(): admin.app.App {
  if (admin.apps.length > 0) return admin.app()

  if (env.firebaseServiceAccountPath) {
    const raw = readFileSync(env.firebaseServiceAccountPath, 'utf-8')
    const serviceAccount = JSON.parse(raw) as admin.ServiceAccount
    return admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      projectId: env.firebaseProjectId || (serviceAccount as any).project_id
    })
  }

  if (env.firebaseServiceAccountJson) {
    const serviceAccount = JSON.parse(env.firebaseServiceAccountJson) as admin.ServiceAccount
    return admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      projectId: env.firebaseProjectId || (serviceAccount as any).project_id
    })
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
