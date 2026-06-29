import type { Narrator, SummarizeHistoryRequest } from './narrator.js'

// Stub: aqui entra integração real com Gemini.
export class GeminiAdapter implements Narrator {
  async summarizeHistory(req: SummarizeHistoryRequest): Promise<string> {
    return `[LOCAL: ${req.currentState.worldState.activeLocation} | T${req.currentState.meta.turn}]\nSituação: Stub — resumo não disponível.`
  }
}
