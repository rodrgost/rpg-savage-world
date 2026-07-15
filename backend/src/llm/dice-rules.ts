import { SKILLS } from '../domain/savage-worlds/constants.js'

/**
 * Princípio único de "quando exigir rolagem de dados", compartilhado entre o
 * system prompt do narrador (narrateTurn/narrateStart) e o de validateAction.
 * Antes vivia duplicado (com redação ligeiramente diferente) nos dois prompts —
 * uma mudança de regra em um lugar e esquecida no outro já causou divergência.
 * Agora há uma única fonte de verdade.
 */
export const DICE_ROLL_PRINCIPLE_PT = [
  'Só exija rolagem quando AMBAS as condições forem verdadeiras: (1) o resultado é genuinamente incerto neste contexto, E (2) o fracasso teria consequências narrativas interessantes.',
  'Se qualquer uma das duas for falsa → "traco": null.',
  'NA DÚVIDA: "traco": null. A rolagem é a EXCEÇÃO, não a regra.'
].join('\n')

/**
 * Lista fechada dos únicos nomes válidos para "traco" — os mesmos rótulos usados
 * no enum do schema estruturado (narrator-response.schema.ts e
 * VALIDATE_ACTION_RESPONSE_SCHEMA) e na resolução determinística
 * (findSkillDefinition em gemini.adapter.ts). Gerada dinamicamente de
 * constants.ts para nunca dessincronizar. Só perícias — atributos não fazem
 * mais parte do traço; testes de atributo puro (soak_roll, recover_shaken)
 * são resolvidos direto pelo rule-engine, sem passar pela LLM.
 */
const VALID_TRACO_NAMES_PT = SKILLS.map((s) => s.label).join(', ')

/**
 * Explicação compartilhada do campo diceCheck.traco — um único campo fechado,
 * sem fallback nem inferência no código: se a LLM não devolver um nome exato
 * desta lista, não há perícia e a ação segue sem teste de dados. required é
 * sempre derivado no código: required = traco !== null. Usado tanto no prompt
 * do narrador quanto no de validateAction.
 */
export const DICE_TRACO_FIELD_EXPLANATION_PT = [
  '"traco": nome da PERÍCIA que esta ação testa — em português, exatamente como usado na ficha do jogador.',
  `LISTA FECHADA — "traco" só pode ser null ou EXATAMENTE um destes ${SKILLS.length} nomes (nenhum outro é válido, mesmo que pareça razoável na ficção — ex.: "Liderança" NÃO existe neste sistema): ${VALID_TRACO_NAMES_PT}.`,
  'Preencha "traco" com um nome da lista SEMPRE que a ação corresponder a uma perícia reconhecível, mesmo que a opção pareça mista ou tenha um objetivo narrativo maior (ex.: "consertar o motor para sobreviver à viagem" → traco: "Reparos" — o objetivo futuro é só o motivo do teste, não uma segunda ação).',
  'AÇÕES SOCIAIS (conversar, perguntar, se aproximar de alguém): só use uma perícia de influência (Persuasão, Intimidação, Provocar, Atuação) quando a ficção JÁ estabeleceu resistência real do NPC nesta cena (ele é hostil, desconfiado, hesitante, ou tem um motivo já mostrado para esconder algo). Se o NPC ainda não demonstrou nenhuma resistência, "traco": null — deixe o diálogo acontecer livre; a perícia só entra quando ele de fato recusar, hesitar ou exigir ser convencido. Não teste a perícia do resultado que você espera obter (ex.: a informação sensível) antes de a cena mostrar que alguém está relutante em dar essa informação.',
  'OPÇÕES COMPOSTAS (uma etapa concreta em risco agora + um payoff social que só acontece DEPOIS dela): teste apenas a perícia da etapa que está de fato em risco neste turno. Ex.: "procurar alguém discretamente e confirmar o que ele sabe" → traco: "Furtividade" (buscar sem ser visto é o risco agora); NÃO teste ao mesmo tempo a perícia de convencer/confirmar informação — essa segunda etapa só existe depois que a primeira for resolvida, e vira uma opção separada no turno seguinte, quando a ficção já mostra se o NPC encontrado coopera ou resiste.',
  'Se a ação não corresponder claramente a nenhum nome da lista, use "traco": null — não invente um nome parecido nem force o mais próximo. O app NÃO tenta mais adivinhar ou corrigir isso depois: "traco" inválido ou ausente vira sempre "sem teste", nunca uma perícia escolhida pelo código.',
  'Use "traco": null quando a ação for puramente narrativa/social sem risco mecânico real (ex.: "observar a paisagem", "seguir andando"), ou quando exigir apenas um atributo bruto sem perícia associada — esse caso também vira "traco": null.',
  'Não existe campo separado "required" — ele é decidido automaticamente pela presença de "traco".'
].join('\n')
