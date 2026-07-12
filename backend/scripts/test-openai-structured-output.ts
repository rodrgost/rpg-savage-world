/**
 * Script manual de verificação da Fase 2 (Structured Outputs no path OpenAI).
 *
 * NÃO faz parte do build nem do `npm test` — é pra rodar à mão, uma vez, com uma
 * chave real, ANTES de confiar em response_format=json_schema/strict em produção.
 * Faz 1-2 chamadas reais e pagas à API (poucos tokens, mas reais).
 *
 * Uso:
 *   cd backend
 *   OPENAI_API_KEY=sk-... npx tsx scripts/test-openai-structured-output.ts
 *
 * Ou com um .env na pasta backend/ contendo OPENAI_API_KEY (e opcionalmente
 * OPENAI_MODEL / OPENAI_BASE_URL — usa os mesmos defaults do adapter em produção
 * se não forem definidos).
 *
 * O que o script verifica, na ordem:
 *   1. A API aceita o campo response_format:{type:'json_schema', json_schema:{strict:true,...}}
 *      sem devolver HTTP 400 (alguns endpoints OpenAI-compatíveis não suportam strict).
 *   2. A resposta é um JSON válido e tem a forma esperada (chaves obrigatórias presentes).
 *   3. TODO diceCheck.traco retornado é null ou um dos 35 nomes válidos (SKILLS+ATTRIBUTES)
 *      — o problema original que motivou a Fase 1/2 (o LLM inventando nomes como
 *      "Liderança", que não existe no sistema).
 *   4. A regra "traco preenchido + actionType=custom nunca coexistem" (do prompt) é
 *      respeitada.
 *
 * Se o passo 1 falhar (HTTP 400 mencionando response_format/json_schema/strict), a
 * conclusão é que o endpoint/modelo configurado não suporta Structured Outputs
 * strict — nesse caso é preciso ajustar generateOpenAiCompatibleTextDetailed em
 * gemini.adapter.ts para cair de volta em response_format:{type:'json_object'}
 * (o comportamento anterior à Fase 2) e depender só do reforço de prompt (Fase 4)
 * + do fallback de sanitização (Fase 3) pra esse provider.
 */

import { config as loadDotenv } from 'dotenv'
import { NARRATOR_RESPONSE_SCHEMA } from '../src/llm/schemas/narrator-response.schema.js'
import { buildOpenAiJsonSchemaResponseFormat, assertStrictJsonSchemaInvariants, toOpenAiStrictSchema } from '../src/llm/schemas/openai-strict-schema.js'
import { SKILLS, ATTRIBUTES } from '../src/domain/savage-worlds/constants.js'

loadDotenv()

const API_KEY = process.env.OPENAI_API_KEY?.trim()
const MODEL = process.env.OPENAI_MODEL?.trim() || 'gpt-4.1-mini'
const BASE_URL = (process.env.OPENAI_BASE_URL?.trim() || 'https://api.openai.com/v1').replace(/\/+$/, '')

const VALID_TRACO_LABELS = new Set<string>([
  ...SKILLS.map((s) => s.label),
  ...ATTRIBUTES.map((a) => a.label)
])

type TestCase = {
  name: string
  systemPrompt: string
  userPrompt: string
}

const TEST_CASES: TestCase[] = [
  {
    name: 'controle (ação claramente ligada a uma perícia)',
    systemPrompt:
      'Você é o Narrador de um RPG (Savage Worlds, cenário pós-apocalíptico). Responda em português do Brasil, segunda pessoa. Retorne APENAS o JSON pedido pelo schema, sem markdown.',
    userPrompt:
      'O jogador está diante de uma porta trancada com ferrugem, tentando arrombá-la. Narre a cena e ofereça 4 opções de ação (options[]), cada uma com diceCheck.traco preenchido corretamente quando a ação exigir teste.'
  },
  {
    name: 'reprodução do caso de log (pressão social ambígua)',
    systemPrompt:
      'Você é o Narrador de um RPG (Savage Worlds, cenário pós-apocalíptico). Responda em português do Brasil, segunda pessoa. Retorne APENAS o JSON pedido pelo schema, sem markdown.',
    userPrompt:
      'O jogador está tentando inspecionar uma bomba, mas um homem hostil de máscara de metal bloqueia o caminho. Uma das opções deveria ser "Exigir que ele libere espaço para você trabalhar". Narre a cena e ofereça 4 opções de ação (options[]), cada uma com diceCheck.traco preenchido corretamente quando a ação exigir teste.'
  }
]

function fail(message: string): never {
  console.error(`\n✖ FALHA: ${message}\n`)
  process.exitCode = 1
  throw new Error(message)
}

function checkTraco(value: unknown, path: string): string[] {
  const problems: string[] = []
  if (value !== null && typeof value !== 'string') {
    problems.push(`${path}: traco não é string nem null (${JSON.stringify(value)})`)
  } else if (typeof value === 'string' && !VALID_TRACO_LABELS.has(value)) {
    problems.push(`${path}: traco="${value}" NÃO está na lista de ${VALID_TRACO_LABELS.size} nomes válidos`)
  }
  return problems
}

type ShapeCheckResult = {
  /** Problemas críticos: se acontecerem, o LLM violou a própria lista fechada do
   *  schema (traco fora do enum) — o motivo de existir a Fase 1/2. Isso faz o
   *  script reportar FALHA. */
  critical: string[]
  /** Problemas conhecidos que a resposta CRUA da API pode ter mas que o app já
   *  corrige depois, em sanitizeNarratorResponse (gemini.adapter.ts) — ex.: o
   *  LLM preenche um traco válido mas deixa actionType="custom" (regra só de
   *  prompt, sem enforcement no JSON Schema — não dá pra expressar "se traco
   *  então actionType" em enum/type puro sem if/then/else, que evitamos por
   *  suporte irregular entre providers). Reportado, mas NÃO derruba o script,
   *  porque quem consome essa resposta é sempre sanitizeNarratorResponse, nunca
   *  o JSON cru direto. */
  knownAndHandled: string[]
}

function validateNarratorResponseShape(parsed: unknown): ShapeCheckResult {
  const critical: string[] = []
  const knownAndHandled: string[] = []
  if (typeof parsed !== 'object' || parsed === null) {
    return { critical: ['resposta não é um objeto JSON'], knownAndHandled }
  }
  const obj = parsed as Record<string, unknown>

  if (!Array.isArray(obj.segments) || obj.segments.length === 0) {
    critical.push('segments ausente ou vazio')
  }
  if (!Array.isArray(obj.options) || obj.options.length === 0) {
    critical.push('options ausente ou vazio')
  } else {
    obj.options.forEach((rawOption, index) => {
      if (typeof rawOption !== 'object' || rawOption === null) {
        critical.push(`options[${index}]: não é objeto`)
        return
      }
      const option = rawOption as Record<string, unknown>
      const diceCheck = option.diceCheck as Record<string, unknown> | undefined
      if (!diceCheck) {
        critical.push(`options[${index}]: diceCheck ausente`)
        return
      }
      critical.push(...checkTraco(diceCheck.traco, `options[${index}].diceCheck`))

      const hasTraco = diceCheck.traco !== null && diceCheck.traco !== undefined
      if (hasTraco && option.actionType === 'custom') {
        knownAndHandled.push(
          `options[${index}]: traco preenchido ("${diceCheck.traco}") mas actionType="custom" na resposta CRUA — sanitizeNarratorResponse corrige isso pra "trait_test" antes de chegar ao jogador`
        )
      }
    })
  }

  return { critical, knownAndHandled }
}

async function runTestCase(testCase: TestCase): Promise<boolean> {
  console.log(`\n── Caso: ${testCase.name} ──`)

  const responseFormat = buildOpenAiJsonSchemaResponseFormat('narrator_response_test', NARRATOR_RESPONSE_SCHEMA)

  const startMs = Date.now()
  const response = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${API_KEY}`
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: testCase.systemPrompt },
        { role: 'user', content: testCase.userPrompt }
      ],
      temperature: 0.4,
      max_completion_tokens: 2048,
      stream: false,
      response_format: responseFormat
    })
  })

  const durationMs = Date.now() - startMs
  const raw = await response.text()

  if (!response.ok) {
    console.error(`  ✖ HTTP ${response.status} (${durationMs}ms)`)
    console.error(`  Corpo da resposta:\n${raw.slice(0, 2000)}`)
    if (/response_format|json_schema|strict/i.test(raw)) {
      console.error(
        '  → Indício de que o endpoint/modelo NÃO suporta response_format:json_schema com strict:true. ' +
          'Ver nota no topo deste arquivo sobre como reverter a Fase 2 se for esse o caso.'
      )
    }
    return false
  }

  let parsedEnvelope: unknown
  try {
    parsedEnvelope = JSON.parse(raw)
  } catch {
    console.error(`  ✖ HTTP ${response.status} OK mas corpo não é JSON válido (${durationMs}ms):\n${raw.slice(0, 500)}`)
    return false
  }

  const content = (parsedEnvelope as { choices?: Array<{ message?: { content?: string }; finish_reason?: string }> })
    .choices?.[0]?.message?.content
  const finishReason = (parsedEnvelope as { choices?: Array<{ finish_reason?: string }> }).choices?.[0]?.finish_reason
  const usage = (parsedEnvelope as { usage?: { prompt_tokens?: number; completion_tokens?: number } }).usage

  console.log(`  HTTP ${response.status} OK — ${durationMs}ms — finish=${finishReason ?? '?'} — promptTk=${usage?.prompt_tokens ?? '?'} outputTk=${usage?.completion_tokens ?? '?'}`)

  if (!content) {
    console.error('  ✖ Resposta OK mas sem choices[0].message.content')
    return false
  }

  let parsedNarrator: unknown
  try {
    parsedNarrator = JSON.parse(content)
  } catch (err) {
    console.error(`  ✖ choices[0].message.content não é JSON válido: ${(err as Error).message}`)
    console.error(`  Conteúdo bruto:\n${content.slice(0, 2000)}`)
    return false
  }

  const { critical, knownAndHandled } = validateNarratorResponseShape(parsedNarrator)

  if (knownAndHandled.length > 0) {
    console.log(`  ⚠ ${knownAndHandled.length} observação(ões) — não derruba o teste, é corrigido em produção:`)
    for (const note of knownAndHandled) console.log(`    - ${note}`)
  }

  if (critical.length > 0) {
    console.error(`  ✖ ${critical.length} problema(s) CRÍTICO(S) na resposta:`)
    for (const problem of critical) console.error(`    - ${problem}`)
    console.log('  JSON completo pra inspeção manual:')
    console.log(JSON.stringify(parsedNarrator, null, 2))
    return false
  }

  console.log('  ✔ Todos os diceCheck.traco retornados são válidos (null ou um dos 35 nomes conhecidos)')
  const options = (parsedNarrator as { options: Array<{ text: string; diceCheck?: { traco?: string | null } }> }).options
  for (const option of options) {
    console.log(`    - "${option.text}" → traco=${JSON.stringify(option.diceCheck?.traco ?? null)}`)
  }
  return true
}

async function main(): Promise<void> {
  console.log('=== Teste de Structured Outputs (Fase 2) — provider OpenAI-compatível ===')
  console.log(`Modelo: ${MODEL}`)
  console.log(`Base URL: ${BASE_URL}`)

  // Sanity check estrutural do schema convertido — roda sempre, sem custo de API,
  // mesmo que a chave não esteja configurada (dá sinal rápido de que o schema em si
  // está bem formado antes de gastar uma chamada real).
  try {
    assertStrictJsonSchemaInvariants(toOpenAiStrictSchema(NARRATOR_RESPONSE_SCHEMA))
    console.log('✔ Schema convertido passa nos invariantes do modo strict (checagem local, sem custo de API)')
  } catch (err) {
    fail(`schema convertido não satisfaz os invariantes do modo strict: ${(err as Error).message}`)
  }

  if (!API_KEY) {
    fail('OPENAI_API_KEY não definida (defina no ambiente ou em backend/.env antes de rodar este script) — pulando as chamadas reais à API')
  }

  let allPassed = true
  for (const testCase of TEST_CASES) {
    try {
      const passed = await runTestCase(testCase)
      allPassed = allPassed && passed
    } catch (err) {
      console.error(`  ✖ Erro inesperado no caso "${testCase.name}": ${(err as Error).message}`)
      allPassed = false
    }
  }

  console.log('\n=== Resultado final ===')
  if (allPassed) {
    console.log('✔ Todos os casos passaram. response_format:json_schema/strict parece funcionar como esperado neste endpoint/modelo.')
  } else {
    console.log('✖ Pelo menos um caso falhou — ver detalhes acima antes de confiar na Fase 2 em produção.')
    process.exitCode = 1
  }
}

main().catch((err) => {
  console.error('Erro fatal:', err)
  process.exitCode = 1
})
