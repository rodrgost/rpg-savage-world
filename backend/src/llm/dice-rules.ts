/**
 * Instruções simplificadas para narração contínua pelo LLM.
 * Regras mecânicas e validações do Savage Worlds foram removidas.
 * O LLM deve focar unicamente na narrativa fluida e coerente da história.
 */
export const DICE_ROLL_PRINCIPLE_PT = [
  'A história é conduzida de forma fluida pelo Narrador com base na ficção, nas intenções do jogador e no estado atual do mundo.',
  'Não há rolagens mecânicas de dados ou validações de sistema. "traco" pode ser null.'
].join('\n')

export const DICE_TRACO_FIELD_EXPLANATION_PT = [
  '"traco": null ou o nome descritivo de alguma perícia/habilidade caso deseje referenciá-la na opção narrativa.',
  'Não há validações mecânicas atreladas a este campo.'
].join('\n')
