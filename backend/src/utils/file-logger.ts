import { appendFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const LOG_DIR = join(process.cwd(), 'logs')
if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true })

// ─── Console Logger ───

export function log(tag: string, ...args: unknown[]): void {
  console.log(`[${tag}]`, ...args)
}

export function warn(tag: string, ...args: unknown[]): void {
  console.warn(`[${tag}]`, ...args)
  writeLine(`[WARN] [${tag}] ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`)
}

export function error(tag: string, ...args: unknown[]): void {
  console.error(`[${tag}]`, ...args)
}

// ─── File Logger ───

function logFilePath(): string {
  const date = new Date().toISOString().slice(0, 10) // YYYY-MM-DD
  return join(LOG_DIR, `llm-${date}.log`)
}

function writeLine(line: string): void {
  try {
    appendFileSync(logFilePath(), `${line}\n`, 'utf-8')
  } catch {
    // silently ignore write errors
  }
}

export function logLlmRequest(tag: string, opts: {
  systemPrompt?: string
  userPrompt: string | Array<{ role: string; text: string }>
  model?: string
  maxOutputTokens?: number
  temperature?: number
}): void {
  const sep = '═'.repeat(80)
  writeLine(sep)
  writeLine(`▶ LLM REQUEST  [${tag}]  model=${opts.model ?? '?'}  maxTokens=${opts.maxOutputTokens ?? '?'}  temp=${opts.temperature ?? '?'}`)
  if (opts.systemPrompt) {
    writeLine('── SYSTEM PROMPT ──')
    for (const line of opts.systemPrompt.split('\n')) {
      writeLine(`  ${line}`)
    }
  }
  writeLine(Array.isArray(opts.userPrompt) ? `── USER PROMPT (${opts.userPrompt.length} turns) ──` : '── USER PROMPT ──')
  if (Array.isArray(opts.userPrompt)) {
    opts.userPrompt.forEach((entry, index) => {
      writeLine(`  [${index + 1}] ${entry.role}`)
      for (const line of entry.text.split('\n')) {
        writeLine(`    ${line}`)
      }
    })
  } else {
    for (const line of opts.userPrompt.split('\n')) {
      writeLine(`  ${line}`)
    }
  }
  writeLine(sep)
}

export function logLlmResponse(tag: string, opts: {
  rawLength: number
  responseText: string
  durationMs: number
  finishReason?: string
  promptTokens?: number
  outputTokens?: number
}): void {
  const sep = '─'.repeat(80)
  writeLine(sep)
  writeLine(`◀ LLM RESPONSE [${tag}]  len=${opts.rawLength}  duration=${opts.durationMs}ms  finish=${opts.finishReason ?? '?'}  promptTk=${opts.promptTokens ?? '?'}  outputTk=${opts.outputTokens ?? '?'}`)
  writeLine('── RESPONSE TEXT ──')
  for (const line of opts.responseText.split('\n')) {
    writeLine(`  ${line}`)
  }
  writeLine(sep)
}

export function logLlmError(tag: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`[LLM ERROR] [${tag}]`, message)
  writeLine(`✖ LLM ERROR [${tag}]  ${message}`)
}
