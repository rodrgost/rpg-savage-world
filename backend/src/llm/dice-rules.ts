/**
 * Princípio único de "quando exigir rolagem de dados", compartilhado entre o
 * system prompt do narrador (narrateTurn/narrateStart) e o de validateAction.
 * Antes vivia duplicado (com redação ligeiramente diferente) nos dois prompts —
 * uma mudança de regra em um lugar e esquecida no outro já causou divergência.
 * Agora há uma única fonte de verdade.
 */
export const DICE_ROLL_PRINCIPLE_PT = [
  'Só exija rolagem quando AMBAS as condições forem verdadeiras: (1) o resultado é genuinamente incerto neste contexto, E (2) o fracasso teria consequências narrativas interessantes.',
  'Se qualquer uma das duas for falsa → required: false.',
  'NA DÚVIDA: required: false. A rolagem é a EXCEÇÃO, não a regra.'
].join('\n')
