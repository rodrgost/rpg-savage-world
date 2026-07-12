import { Controller, Get } from '@nestjs/common'
import { Public } from './auth/public.decorator.js'
import { getSkillInferenceMetrics } from './llm/skill-inference-metrics.js'

@Public()
@Controller('/health')
export class HealthController {
  @Get()
  health(): { ok: true } {
    return { ok: true }
  }

  /**
   * Observabilidade leve (Fase 5 do plano de ajuste do diceCheck.traco): quantas
   * vezes, desde o último restart do processo, sanitizeNarratorResponse precisou
   * inferir a skill a partir do texto/justificativa da opção (LLM não devolveu um
   * traco válido do enum), e quantas vezes nem isso funcionou e a rolagem foi
   * descartada. Não é uma métrica histórica/persistida — só o estado do processo
   * atual. Ver src/llm/skill-inference-metrics.ts.
   */
  @Get('/llm-metrics')
  llmMetrics(): ReturnType<typeof getSkillInferenceMetrics> {
    return getSkillInferenceMetrics()
  }
}
