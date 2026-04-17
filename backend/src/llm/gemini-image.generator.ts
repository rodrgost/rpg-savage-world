import { z } from 'zod'
import { log, warn } from '../utils/file-logger.js'

function readEnv(name: string, fallback = ''): string {
  const value = process.env[name]
  if (typeof value !== 'string') return fallback
  return value.trim().replace(/^"(.*)"$/, '$1')
}

function toNumber(value: string, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function withMin(value: number, min: number): number {
  return value < min ? min : value
}

type GeminiGenerateContentResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string
        inlineData?: { mimeType?: string; data?: string }
        inline_data?: { mime_type?: string; data?: string }
      }>
    }
    finishReason?: string
    safetyRatings?: Array<{ category?: string; probability?: string; blocked?: boolean }>
  }>
  promptFeedback?: {
    blockReason?: string
    safetyRatings?: Array<{ category?: string; probability?: string; blocked?: boolean }>
  }
}

export const imageGenerationParamsSchema = z
  .object({
    prompt: z.string().trim().min(1),
    negativePrompt: z.string().trim().min(1).optional(),
    width: z.number().int().positive().max(4096).optional(),
    height: z.number().int().positive().max(4096).optional(),
    aspectRatio: z
      .enum(['1:1', '16:9', '9:16', '4:3', '3:4'])
      .optional(),
    mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']).optional(),
    seed: z.number().int().nonnegative().max(2 ** 31 - 1).optional(),
    timeoutMs: z.number().int().positive().max(120_000).optional()
  })
  .strict()

export type ImageGenerationParams = z.infer<typeof imageGenerationParamsSchema>

export type GeneratedImage = {
  mimeType: string
  base64: string
  text?: string
}

function buildPrompt(params: ImageGenerationParams): string {
  const lines: string[] = [params.prompt.trim()]

  if (params.negativePrompt) {
    lines.push('', `Evite: ${params.negativePrompt.trim()}`)
  }

  return lines.join('\n')
}

function describeBlockReason(response: GeminiGenerateContentResponse): string | null {
  if (response.promptFeedback?.blockReason) {
    return `Prompt bloqueado: ${response.promptFeedback.blockReason}`
  }
  const candidate = response.candidates?.[0]
  if (candidate && !candidate.content) {
    const finish = candidate.finishReason ?? 'desconhecido'
    const blocked = candidate.safetyRatings?.filter((r) => r.blocked)
    const categories = blocked?.map((r) => r.category).join(', ') || ''
    return `Resposta bloqueada (finishReason: ${finish}${categories ? `, categorias: ${categories}` : ''})`
  }
  return null
}

function extractFirstImage(response: GeminiGenerateContentResponse): GeneratedImage {
  const parts = response.candidates?.[0]?.content?.parts ?? []

  const text = parts
    .map((part) => part.text?.trim() ?? '')
    .filter(Boolean)
    .join('\n')

  for (const part of parts) {
    const inlineData = part.inlineData
    if (inlineData?.data) {
      return {
        base64: inlineData.data,
        mimeType: inlineData.mimeType ?? 'application/octet-stream',
        text: text || undefined
      }
    }
    const inline_data = part.inline_data
    if (inline_data?.data) {
      return {
        base64: inline_data.data,
        mimeType: inline_data.mime_type ?? 'application/octet-stream',
        text: text || undefined
      }
    }
  }

  throw new Error('Gemini não retornou imagem (inlineData)')
}

export class GeminiImageGenerator {
  private readonly apiKey = readEnv('GEMINI_API_KEY')
  private readonly model = readEnv('GEMINI_IMAGE_MODEL', 'gemini-2.5-flash-image')
  private readonly baseUrl = readEnv('GEMINI_BASE_URL', 'https://generativelanguage.googleapis.com')
  private readonly temperature = toNumber(readEnv('GEMINI_IMAGE_TEMPERATURE', '0.8'), 0.8)
  private readonly timeoutMs = withMin(toNumber(readEnv('GEMINI_TIMEOUT_MS', '45000'), 45000), 15000)

  async generateImage(params: ImageGenerationParams): Promise<GeneratedImage> {
    if (!this.apiKey) {
      throw new Error('GEMINI_API_KEY não configurada')
    }

    const parsedParams = imageGenerationParamsSchema.parse(params)
    const maxAttempts = 3

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const url = `${this.baseUrl}/v1beta/models/${encodeURIComponent(this.model)}:generateContent?key=${encodeURIComponent(this.apiKey)}`
      const controller = new AbortController()
      const timeout = setTimeout(
        () => controller.abort(),
        parsedParams.timeoutMs ?? this.timeoutMs
      )

      const promptText = buildPrompt(parsedParams)
      if (attempt === 1) {
        log('GeminiImage', `Prompt: ${promptText.slice(0, 300)}`)
        log('GeminiImage', `Model: ${this.model} Temperature: ${this.temperature}`)
      } else {
        log('GeminiImage', `Tentativa ${attempt}/${maxAttempts}`)
      }

      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: promptText }] }],
            generationConfig: {
              temperature: this.temperature,
              responseModalities: ['IMAGE', 'TEXT']
            },
            safetySettings: [
              { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
              { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' },
              { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
              { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' },
            ]
          }),
          signal: controller.signal
        })

        const raw = await response.text()
        if (!response.ok) {
          warn('GeminiImage', `Tentativa ${attempt}/${maxAttempts} HTTP ${response.status}: ${raw.slice(0, 300)}`)
          if (attempt < maxAttempts) {
            await new Promise((r) => setTimeout(r, 1500 * attempt))
            continue
          }
          throw new Error(`Gemini HTTP ${response.status}: ${raw.slice(0, 200)}`)
        }

        const parsed = raw ? (JSON.parse(raw) as GeminiGenerateContentResponse) : {}

        try {
          return extractFirstImage(parsed)
        } catch (extractError) {
          const blockReason = describeBlockReason(parsed)
          warn(
            'GeminiImage',
            `Tentativa ${attempt}/${maxAttempts} falha.`,
            blockReason ?? 'Sem imagem na resposta.',
            'Raw (primeiros 500 chars):', raw.slice(0, 500)
          )
          if (attempt < maxAttempts) {
            await new Promise((r) => setTimeout(r, 1500 * attempt))
            continue
          }
          throw new Error(blockReason ?? 'Gemini não retornou imagem (inlineData)')
        }
      } finally {
        clearTimeout(timeout)
      }
    }

    throw new Error('Gemini não retornou imagem após múltiplas tentativas')
  }
}
