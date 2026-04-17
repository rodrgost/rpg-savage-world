import type { Narrator, SummarizeRequest } from './narrator.js'

// Stub: aqui entra integração real com Gemini.
// A LLM nunca aplica regras: só narra/condensa.
export class GeminiAdapter implements Narrator {
  async summarize(req: SummarizeRequest): Promise<string> {
    return [
      `Resumo até o turno ${req.upToTurn} (stub).`,
      `Eventos desde o último resumo: ${req.keyEvents.length}.`,
      `Local atual: ${req.currentState.worldState.activeLocation}.`,
      `HP jogador: ${req.currentState.player.hp}.`
    ].join('\n')
  }
}
