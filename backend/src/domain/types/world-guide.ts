export type WorldGuideGlossaryTerm = {
  term: string
  definition: string
  preferredUsage?: string
  avoidTerms?: string[]
}

export type WorldGuideFaction = {
  name: string
  role: string
  publicFace: string
  powerBase: string
  relationships: string[]
}

export type WorldGuide = {
  llmPersona: {
    role: string
    perspective: string
    knowledgeLimits: string
  }
  universeRules: {
    magicAndPowers: string[]
    technology: string[]
    impossibilities: string[]
    costsAndLimits: string[]
  }
  glossary: {
    terms: WorldGuideGlossaryTerm[]
    forbiddenGenericTerms: string[]
  }
  factionsAndPower: {
    groups: WorldGuideFaction[]
    socialTensions: string[]
    speciesAndCultures: string[]
  }
  knowledgeHorizon: {
    currentMoment: string
    knownFacts: string[]
    unknownOrSpoilerFacts: string[]
  }
  geography: {
    immediateSetting: string
    keyLocations: string[]
    sensoryTexture: string
  }
  mood: {
    tone: string
    emotionalPalette: string
    languageStyle: string
    avoidStyle: string
  }
}

function renderList(items: string[] | undefined, empty = 'Não definido.'): string {
  const lines = (items ?? []).map((item) => item.trim()).filter(Boolean)
  if (!lines.length) return empty
  return lines.map((item) => `- ${item}`).join('\n')
}

export function renderWorldGuideMarkdown(worldGuide: WorldGuide | undefined): string {
  if (!worldGuide) return ''

  const glossaryTerms = worldGuide.glossary.terms.length
    ? worldGuide.glossary.terms
      .map((entry) => {
        const avoidTerms = entry.avoidTerms?.length ? ` Evitar: ${entry.avoidTerms.join(', ')}.` : ''
        const usage = entry.preferredUsage ? ` Uso preferido: ${entry.preferredUsage}.` : ''
        return `- ${entry.term}: ${entry.definition}.${usage}${avoidTerms}`
      })
      .join('\n')
    : 'Não definido.'

  const factions = worldGuide.factionsAndPower.groups.length
    ? worldGuide.factionsAndPower.groups
      .map((group) => `- ${group.name}: ${group.role}. Face pública: ${group.publicFace}. Base de poder: ${group.powerBase}. Relações: ${group.relationships.join('; ') || 'não definidas'}.`)
      .join('\n')
    : 'Não definido.'

  return [
    '## Guia Canônico do Universo',
    '',
    '### Persona e Perspectiva do Narrador',
    `- Papel: ${worldGuide.llmPersona.role}`,
    `- Perspectiva: ${worldGuide.llmPersona.perspective}`,
    `- Limites de conhecimento: ${worldGuide.llmPersona.knowledgeLimits}`,
    '',
    '### Regras do Universo',
    'Magia e poderes:',
    renderList(worldGuide.universeRules.magicAndPowers),
    'Tecnologia:',
    renderList(worldGuide.universeRules.technology),
    'Impossibilidades:',
    renderList(worldGuide.universeRules.impossibilities),
    'Custos e limites:',
    renderList(worldGuide.universeRules.costsAndLimits),
    '',
    '### Glossário e Jargões',
    glossaryTerms,
    'Termos genéricos proibidos:',
    renderList(worldGuide.glossary.forbiddenGenericTerms),
    '',
    '### Facções, Raças e Dinâmicas de Poder',
    factions,
    'Tensões sociais:',
    renderList(worldGuide.factionsAndPower.socialTensions),
    'Espécies e culturas:',
    renderList(worldGuide.factionsAndPower.speciesAndCultures),
    '',
    '### Linha do Tempo e Horizonte de Conhecimento',
    `- Momento atual: ${worldGuide.knowledgeHorizon.currentMoment}`,
    'Fatos conhecidos:',
    renderList(worldGuide.knowledgeHorizon.knownFacts),
    'Fatos desconhecidos ou spoilers proibidos:',
    renderList(worldGuide.knowledgeHorizon.unknownOrSpoilerFacts),
    '',
    '### Geografia e Cenário Imediato',
    `- Cenário imediato: ${worldGuide.geography.immediateSetting}`,
    'Locais-chave:',
    renderList(worldGuide.geography.keyLocations),
    `- Textura sensorial: ${worldGuide.geography.sensoryTexture}`,
    '',
    '### Tom e Atmosfera',
    `- Tom: ${worldGuide.mood.tone}`,
    `- Paleta emocional: ${worldGuide.mood.emotionalPalette}`,
    `- Estilo de linguagem: ${worldGuide.mood.languageStyle}`,
    `- Evitar: ${worldGuide.mood.avoidStyle}`
  ].join('\n')
}
