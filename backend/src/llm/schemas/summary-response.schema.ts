/**
 * Schema de saída estruturada para o resumo de continuidade (Gemini responseSchema).
 *
 * Substitui o antigo formato de prosa livre por blocos estruturados, validáveis
 * e mescláveis sem depender do LLM "lembrar" o formato textual a cada
 * recompactação. Ver StructuredSummary em ../narrator.ts para os tipos
 * correspondentes no lado do app.
 */
export const SUMMARY_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: 'OBJECT',
  properties: {
    locations: {
      type: 'ARRAY',
      description: 'Um bloco por local distinto já visitado (exceto o local atual), em ordem cronológica.',
      items: {
        type: 'OBJECT',
        properties: {
          name: { type: 'STRING' },
          turnStart: { type: 'INTEGER' },
          turnEnd: { type: 'INTEGER' },
          situation: { type: 'STRING', description: 'O que aconteceu aqui — máx 2 frases.' },
          npcs: { type: 'STRING', nullable: true, description: 'Ex: "Nome (traço, disposição); Nome2 (...)". Omitir se nenhum NPC relevante.' },
          tensions: { type: 'STRING', nullable: true, description: 'Fios narrativos abertos, mistérios, promessas não cumpridas.' }
        },
        required: ['name', 'turnStart', 'turnEnd', 'situation'],
        propertyOrdering: ['name', 'turnStart', 'turnEnd', 'situation', 'npcs', 'tensions']
      }
    },
    current: {
      type: 'OBJECT',
      description: 'Bloco do local atual — sempre presente.',
      properties: {
        name: { type: 'STRING' },
        turn: { type: 'INTEGER' },
        situation: { type: 'STRING', description: 'Cena atual e ameaças imediatas.' },
        npcs: { type: 'STRING', nullable: true },
        goals: { type: 'STRING', nullable: true, description: 'Metas ainda pendentes do personagem.' },
        tensions: { type: 'STRING', nullable: true }
      },
      required: ['name', 'turn', 'situation'],
      propertyOrdering: ['name', 'turn', 'situation', 'npcs', 'goals', 'tensions']
    }
  },
  required: ['locations', 'current'],
  propertyOrdering: ['locations', 'current']
}
