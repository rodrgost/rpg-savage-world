import { config as loadDotenv } from 'dotenv'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'

const currentDir = dirname(fileURLToPath(import.meta.url))
const backendRoot = resolve(currentDir, '..', '..')
const workspaceRoot = resolve(backendRoot, '..')

loadDotenv({ path: resolve(workspaceRoot, '.env') })
loadDotenv({ path: resolve(backendRoot, '.env'), override: false })

export const env = {
  port: Number(process.env.PORT ?? '3100'),
  nodeEnv: process.env.NODE_ENV ?? 'development',

  firebaseProjectId: process.env.FIREBASE_PROJECT_ID ?? '',
  firebaseServiceAccountPath: process.env.FIREBASE_SERVICE_ACCOUNT_PATH ?? '',
  firebaseServiceAccountJson: process.env.FIREBASE_SERVICE_ACCOUNT_JSON ?? '',

  summaryIntervalTurns: Number(process.env.SUMMARY_INTERVAL_TURNS ?? '10'),

  // Origens adicionais permitidas no CORS (ex.: domínio customizado no Railway)
  allowedOrigins: (process.env.ALLOWED_ORIGIN ?? '').split(',').map(o => o.trim()).filter(Boolean)
}

// Garante que pelo menos um caminho de credenciais exista.
// - Local dev: GOOGLE_APPLICATION_CREDENTIALS aponta para o JSON
// - Alternativa: FIREBASE_SERVICE_ACCOUNT_JSON (string JSON)
export function assertFirebaseEnv(): void {
  if (env.firebaseServiceAccountJson) return
  if (env.firebaseServiceAccountPath && existsSync(env.firebaseServiceAccountPath)) return
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) return

  throw new Error(
    'Firebase credenciais ausentes. Defina GOOGLE_APPLICATION_CREDENTIALS, FIREBASE_SERVICE_ACCOUNT_JSON ou FIREBASE_SERVICE_ACCOUNT_PATH com um arquivo valido.'
  )
}
