import { SKILLS, ATTRIBUTES } from '../domain/savage-worlds/constants.js'

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
 * no enum do schema estruturado (narrator-response.schema.ts) e na validação
 * determinística (findSkillDefinition/sanitizeAttributeName em gemini.adapter.ts).
 * Gerada dinamicamente de constants.ts para nunca dessincronizar. Reforça no texto
 * do prompt o que o schema já impõe estruturalmente — importante para chamadas
 * onde o schema não é aplicado (ex.: validateAction, que não usa responseSchema)
 * e como defesa redundante mesmo quando é aplicado.
 */
const VALID_TRACO_NAMES_PT = [...SKILLS.map((s) => s.label), ...ATTRIBUTES.map((a) => a.label)].join(', ')

/**
 * Explicação compartilhada do campo diceCheck.traco — substitui os antigos
 * required/skill/attribute por um único campo, evitando o estado ambíguo
 * "quer testar mas não sabe o quê" (que antes exigia um fallback genérico
 * ou descarte da opção). required é sempre derivado no código: required =
 * traco !== null. Usado tanto no prompt do narrador quanto no de validateAction.
 */
export const DICE_TRACO_FIELD_EXPLANATION_PT = [
  '"traco": nome da PERÍCIA OU do ATRIBUTO que esta ação testa — em português, exatamente como usado na ficha do jogador.',
  `LISTA FECHADA — "traco" só pode ser null ou EXATAMENTE um destes ${SKILLS.length + ATTRIBUTES.length} nomes (nenhum outro é válido, mesmo que pareça razoável na ficção — ex.: "Liderança" NÃO existe neste sistema): ${VALID_TRACO_NAMES_PT}.`,
  'Preencha "traco" com um nome da lista SEMPRE que a ação corresponder a uma perícia ou atributo reconhecível, mesmo que a opção pareça mista ou tenha um objetivo narrativo maior (ex.: "consertar o motor para sobreviver à viagem" → traco: "Reparos" — o objetivo futuro é só o motivo do teste, não uma segunda ação).',
  'Se a ação não corresponder claramente a nenhum nome da lista, use "traco": null — não invente um nome parecido nem force o mais próximo.',
  'Use "traco": null APENAS quando a ação for puramente narrativa/social sem risco mecânico real (ex.: "observar a paisagem", "seguir andando").',
  'Não existe campo separado "required" — ele é decidido automaticamente pela presença de "traco".'
].join('\n')
