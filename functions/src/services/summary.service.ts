export class SummaryService {
  // A compactação de histórico acontece no backend (backend/src/services/summary.service.ts).
  // Esta versão é mantida para compatibilidade com o index.ts das Cloud Functions.
  async maybeUpdateSummary(_params: { state: unknown }): Promise<void> {
    // no-op
  }
}
