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
 * Explicação compartilhada do campo diceCheck.traco — substitui os antigos
 * required/skill/attribute por um único campo, evitando o estado ambíguo
 * "quer testar mas não sabe o quê" (que antes exigia um fallback genérico
 * ou descarte da opção). required é sempre derivado no código: required =
 * traco !== null. Usado tanto no prompt do narrador quanto no de validateAction.
 */
export const DICE_TRACO_FIELD_EXPLANATION_PT = [
  '"traco": nome da PERÍCIA (ex.: "Percepção", "Furtividade", "Reparos") OU do ATRIBUTO (ex.: "Vigor", "Espírito") que esta ação testa — em português, exatamente como usado na ficha do jogador.',
  'Preencha "traco" com um nome SEMPRE que a ação corresponder a uma perícia ou atributo reconhecível, mesmo que a opção pareça mista ou tenha um objetivo narrativo maior (ex.: "consertar o motor para sobreviver à viagem" → traco: "Reparos" — o objetivo futuro é só o motivo do teste, não uma segunda ação).',
  'Use "traco": null APENAS quando a ação for puramente narrativa/social sem risco mecânico real (ex.: "observar a paisagem", "seguir andando").',
  'Não existe campo separado "required" — ele é decidido automaticamente pela presença de "traco".'
].join('\n')
