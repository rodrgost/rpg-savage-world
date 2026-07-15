/**
 * Script utilitário para chamar o LLM (narração) usando um prompt de texto livre
 * lido de um arquivo fixo (scripts/prompt.txt), imprimindo a resposta no console.
 *
 * NÃO faz parte do build nem do fluxo normal do app — é pra uso manual, chamado
 * a partir de um .bat (ver narrate.bat na raiz do repositório).
 *
 * Provider escolhido pela env LLM_PROVIDER (openai | gemini | deepseek), igual ao
 * backend (ver backend/src/config/env.ts e backend/src/llm/gemini.adapter.ts).
 * Credenciais e parâmetros (API key, modelo, temperatura, base URL, tokens, timeout)
 * vêm das mesmas envs genéricas já usadas em produção — nenhuma env nova foi criada.
 *
 * O conteúdo de scripts/prompt.txt é enviado como está, em uma única mensagem
 * (role: user) — quem decide o formato da resposta (texto livre, JSON etc.) é o
 * próprio texto do prompt, não este script.
 *
 * Uso:
 *   cd backend
 *   npx tsx scripts/narrate-from-file.ts
 * Ou clicando duas vezes em narrate.bat na raiz do repositório.
 */

import { config as loadDotenv } from 'dotenv'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'

const currentDir = dirname(fileURLToPath(import.meta.url))
const backendRoot = resolve(currentDir, '..')
const workspaceRoot = resolve(backendRoot, '..')

// Mesma ordem de carregamento do backend (ver backend/src/config/env.ts):
// .env da raiz do workspace primeiro, depois backend/.env sem sobrescrever.
loadDotenv({ path: resolve(workspaceRoot, '.env') })
loadDotenv({ path: resolve(backendRoot, '.env'), override: false })

const PROMPT_FILE_PATH = resolve(currentDir, 'prompt.txt')

type SupportedLlmProvider = 'gemini' | 'deepseek' | 'openai'

function readEnv(name: string, fallback = ''): string {
  const value = process.env[name]
  if (typeof value !== 'string') return fallback
  return value.trim().replace(/^"(.*)"$/, '$1')
}

function toNumber(value: string, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function readLlmProvider(): SupportedLlmProvider {
  const provider = readEnv('LLM_PROVIDER', 'gemini').toLowerCase()
  if (provider === 'deepseek' || provider === 'openai') return provider
  return 'gemini'
}

function readPrompt(): string {
  let raw: string
  try {
    raw = readFileSync(PROMPT_FILE_PATH, 'utf-8')
  } catch (err) {
    throw new Error(`Não foi possível ler o arquivo de prompt em ${PROMPT_FILE_PATH}: ${(err as Error).message}`)
  }
  const text = raw.trim()
  if (!text) {
    throw new Error(`O arquivo de prompt (${PROMPT_FILE_PATH}) está vazio. Escreva o texto do prompt nele antes de rodar o script.`)
  }
  return text
}

type ProviderConfig = {
  provider: SupportedLlmProvider
  apiKey: string
  apiKeyEnvName: string
  model: string
  baseUrl: string
  temperature: number
  maxOutputTokens: number
  timeoutMs: number
}

function resolveProviderConfig(): ProviderConfig {
  const provider = readLlmProvider()

  if (provider === 'gemini') {
    return {
      provider,
      apiKeyEnvName: 'GEMINI_API_KEY',
      apiKey: readEnv('GEMINI_API_KEY'),
      model: readEnv('GEMINI_MODEL', 'gemini-2.5-flash'),
      baseUrl: readEnv('GEMINI_BASE_URL', 'https://generativelanguage.googleapis.com').replace(/\/+$/, ''),
      temperature: toNumber(readEnv('GEMINI_TEMPERATURE', '0.4'), 0.4),
      maxOutputTokens: toNumber(readEnv('GEMINI_MAX_OUTPUT_TOKENS', '8192'), 8192),
      timeoutMs: toNumber(readEnv('GEMINI_TIMEOUT_MS', '90000'), 90000)
    }
  }

  const prefix = provider === 'openai' ? 'OPENAI' : 'DEEPSEEK'
  return {
    provider,
    apiKeyEnvName: `${prefix}_API_KEY`,
    apiKey: readEnv(`${prefix}_API_KEY`),
    model: readEnv(`${prefix}_MODEL`, provider === 'openai' ? 'gpt-4.1-mini' : 'deepseek-chat'),
    baseUrl: readEnv(
      `${prefix}_BASE_URL`,
      provider === 'openai' ? 'https://api.openai.com/v1' : 'https://api.deepseek.com'
    ).replace(/\/+$/, ''),
    temperature: toNumber(readEnv(`${prefix}_TEMPERATURE`, '0.4'), 0.4),
    maxOutputTokens: toNumber(readEnv(`${prefix}_MAX_OUTPUT_TOKENS`, '8192'), 8192),
    timeoutMs: toNumber(readEnv(`${prefix}_TIMEOUT_MS`, '90000'), 90000)
  }
}

async function callGemini(config: ProviderConfig, promptText: string): Promise<string> {
  const url = `${config.baseUrl}/v1beta/models/${encodeURIComponent(config.model)}:generateContent?key=${encodeURIComponent(config.apiKey)}`
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs)

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: promptText }] }],
        generationConfig: {
          temperature: config.temperature,
          maxOutputTokens: config.maxOutputTokens
        }
      }),
      signal: controller.signal
    })

    const raw = await response.text()
    if (!response.ok) {
      throw new Error(`Gemini HTTP ${response.status}: ${raw.slice(0, 500)}`)
    }

    const parsed = raw ? JSON.parse(raw) : {}
    const parts = parsed?.candidates?.[0]?.content?.parts ?? []
    const text = parts
      .filter((part: { thought?: boolean }) => !part.thought)
      .map((part: { text?: string }) => part.text?.trim() ?? '')
      .filter(Boolean)
      .join('\n')

    if (!text) {
      throw new Error(`Gemini retornou conteúdo vazio. Resposta bruta: ${raw.slice(0, 500)}`)
    }
    return text
  } finally {
    clearTimeout(timeout)
  }
}

async function callOpenAiCompatible(config: ProviderConfig, promptText: string): Promise<string> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs)

  try {
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`
      },
      body: JSON.stringify({
        model: config.model,
        messages: [{ role: 'user', content: promptText }],
        temperature: config.temperature,
        ...(config.provider === 'openai'
          ? { max_completion_tokens: config.maxOutputTokens }
          : { max_tokens: Math.min(config.maxOutputTokens, 8192) }),
        stream: false
      }),
      signal: controller.signal
    })

    const raw = await response.text()
    if (!response.ok) {
      throw new Error(`${config.provider} HTTP ${response.status}: ${raw.slice(0, 500)}`)
    }

    const parsed = raw ? JSON.parse(raw) : {}
    const text = parsed?.choices?.[0]?.message?.content
    if (typeof text !== 'string' || !text.trim()) {
      throw new Error(`${config.provider} retornou conteúdo vazio. Resposta bruta: ${raw.slice(0, 500)}`)
    }
    return text.trim()
  } finally {
    clearTimeout(timeout)
  }
}

async function main(): Promise<void> {
  const config = resolveProviderConfig()

  console.log('=== Narração via LLM (script standalone) ===')
  console.log(`Provider: ${config.provider}`)
  console.log(`Modelo: ${config.model}`)
  console.log(`Prompt: ${PROMPT_FILE_PATH}`)

  if (!config.apiKey) {
    throw new Error(`${config.apiKeyEnvName} não configurada (defina no .env da raiz do workspace ou em backend/.env).`)
  }

  const promptText = readPrompt()

  const startMs = Date.now()
  const text = config.provider === 'gemini'
    ? await callGemini(config, promptText)
    : await callOpenAiCompatible(config, promptText)
  const durationMs = Date.now() - startMs

  console.log(`\n--- Resposta (${durationMs}ms) ---\n`)
  console.log(text)
  console.log('\n--- Fim ---')
}

main().catch((err) => {
  console.error('\nErro:', (err as Error).message)
  process.exitCode = 1
})
