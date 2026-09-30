import { config as loadDotenv } from 'dotenv'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'

const currentDir = dirname(fileURLToPath(import.meta.url))
const backendRoot = resolve(currentDir, '..', '..')
const workspaceRoot = resolve(backendRoot, '..')

loadDotenv({ path: resolve(workspaceRoot, '.env') })
loadDotenv({ path: resolve(backendRoot, '.env'), override: false })

function resolveFilePath(filePath: string): string {
  if (!filePath) return ''
  if (existsSync(filePath)) return filePath
  const fromWorkspace = resolve(workspaceRoot, filePath)
  if (existsSync(fromWorkspace)) return fromWorkspace
  const fromBackend = resolve(backendRoot, filePath)
  if (existsSync(fromBackend)) return fromBackend
  return filePath
}

export const env = {
  port: Number(process.env.PORT ?? '3100'),
  nodeEnv: process.env.NODE_ENV ?? 'development',

  firebaseProjectId: process.env.FIREBASE_PROJECT_ID ?? '',
  firebaseServiceAccountPath: resolveFilePath(process.env.FIREBASE_SERVICE_ACCOUNT_PATH ?? ''),
  firebaseServiceAccountJson: process.env.FIREBASE_SERVICE_ACCOUNT_JSON ?? '',

  /** Orçamento de tokens (estimativa ~4 chars/token) para a janela de histórico recente
   *  mantida fora do resumo — substitui um teto fixo de N mensagens, robusto a turnos
   *  com mensagens muito curtas ou muito longas. Default: 3000 tokens. */
  recentTokenBudget: Number(process.env.RECENT_TOKEN_BUDGET ?? '3000'),

  /** Nº mínimo de tokens excedentes (além da janela recente) para justificar uma chamada
   *  LLM de compactação. Abaixo deste limiar, o excedente acumula até o próximo turno.
   *  Default: 2250 (~75% do orçamento da janela recente). */
  compactBatchMinTokens: Number(process.env.COMPACT_BATCH_MIN_TOKENS ?? '2250'),

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
