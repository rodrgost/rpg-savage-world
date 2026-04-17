import type { DieType } from '../types'

/* ── Tipos de dado ──────────────────────────────────────── */

export const DIE_OPTIONS: { value: DieType; label: string }[] = [
  { value: 4, label: 'd4' },
  { value: 6, label: 'd6' },
  { value: 8, label: 'd8' },
  { value: 10, label: 'd10' },
  { value: 12, label: 'd12' },
]

/* ── Atributos ──────────────────────────────────────────── */

export type AttributeDef = {
  key: string
  label: string
  description: string
}

export const ATTRIBUTES: AttributeDef[] = [
  {
    key: 'agility',
    label: 'Agilidade',
    description: 'Representa velocidade, reflexos e equilíbrio. Governa perícias como Furtividade, Atirar e Cavalgar.',
  },
  {
    key: 'smarts',
    label: 'Astúcia',
    description: 'Inteligência, sagacidade e raciocínio rápido. Governa perícias como Notar, Investigar e Conhecimento.',
  },
  {
    key: 'spirit',
    label: 'Espírito',
    description: 'Força de vontade, determinação interior e carisma. Governa Intimidar, Provocar e Persuadir.',
  },
  {
    key: 'strength',
    label: 'Força',
    description: 'Potência física bruta e capacidade de carga. Afeta dano corpo-a-corpo e Escalar.',
  },
  {
    key: 'vigor',
    label: 'Vigor',
    description: 'Resistência, saúde e constitução. Determina Resistência (Toughness) e ajuda a absorver dano.',
  },
]

export const ATTRIBUTE_KEYS = ATTRIBUTES.map((a) => a.key)

/** Map attribute keys to PT-BR labels used in requirements */
const ATTR_LABEL_TO_KEY: Record<string, string> = {
  Agilidade: 'agility',
  Astúcia: 'smarts',
  Espírito: 'spirit',
  Força: 'strength',
  Vigor: 'vigor',
}

/* ── Perícias ───────────────────────────────────────────── */

export type SkillDef = {
  key: string
  label: string
  linkedAttribute: string
  description: string
}

export const SKILLS: SkillDef[] = [
  { key: 'Atletismo', label: 'Atletismo', linkedAttribute: 'agility', description: 'Correr, escalar, saltar e nadar' },
  { key: 'Atirar', label: 'Atirar', linkedAttribute: 'agility', description: 'Armas de projétil e distância' },
  { key: 'Cavalgar', label: 'Cavalgar', linkedAttribute: 'agility', description: 'Cavalgar montarias' },
  { key: 'Furtividade', label: 'Furtividade', linkedAttribute: 'agility', description: 'Mover-se sem ser detectado' },
  { key: 'Ladinagem', label: 'Ladinagem', linkedAttribute: 'agility', description: 'Abrir fechaduras e furtos' },
  { key: 'Lutar', label: 'Lutar', linkedAttribute: 'agility', description: 'Combate corpo a corpo' },
  { key: 'Pilotar', label: 'Pilotar', linkedAttribute: 'agility', description: 'Pilotar veículos terrestres' },
  { key: 'Apostar', label: 'Apostar', linkedAttribute: 'smarts', description: 'Jogos de azar e apostas' },
  { key: 'Ciências', label: 'Ciências', linkedAttribute: 'smarts', description: 'Conhecimentos científicos avançados' },
  { key: 'Conhecimento Geral', label: 'Conhecimento Geral', linkedAttribute: 'smarts', description: 'Cultura geral e senso comum' },
  { key: 'Curar', label: 'Curar', linkedAttribute: 'smarts', description: 'Tratar ferimentos e doenças' },
  { key: 'Eletrônica', label: 'Eletrônica', linkedAttribute: 'smarts', description: 'Operar e reparar eletrônicos' },
  { key: 'Investigar', label: 'Investigar', linkedAttribute: 'smarts', description: 'Investigar e coletar informações' },
  { key: 'Notar', label: 'Notar', linkedAttribute: 'smarts', description: 'Detectar detalhes e ameaças' },
  { key: 'Ocultismo', label: 'Ocultismo', linkedAttribute: 'smarts', description: 'Conhecimento sobrenatural e místico' },
  { key: 'Reparar', label: 'Reparar', linkedAttribute: 'smarts', description: 'Consertar máquinas e dispositivos' },
  { key: 'Sobrevivência', label: 'Sobrevivência', linkedAttribute: 'smarts', description: 'Rastrear, caçar e sobreviver na natureza' },
  { key: 'Tática', label: 'Tática', linkedAttribute: 'smarts', description: 'Estratégia e comando em combate' },
  { key: 'Intimidar', label: 'Intimidar', linkedAttribute: 'spirit', description: 'Amedrontar e coagir oponentes' },
  { key: 'Persuadir', label: 'Persuadir', linkedAttribute: 'spirit', description: 'Convencer e negociar com outros' },
  { key: 'Provocar', label: 'Provocar', linkedAttribute: 'spirit', description: 'Distrair e irritar oponentes em combate' },
  { key: 'Fé', label: 'Fé', linkedAttribute: 'spirit', description: 'Canalizar poder divino' },
  { key: 'Conjurar', label: 'Conjurar', linkedAttribute: 'smarts', description: 'Lançar feitiços e rituais arcanos' },
  { key: 'Psionismo', label: 'Psionismo', linkedAttribute: 'smarts', description: 'Canalizar poder psíquico ou interior' },
  { key: 'Desempenho', label: 'Desempenho', linkedAttribute: 'spirit', description: 'Cantar, dançar, atuar e entreter' },
  { key: 'Dirigir', label: 'Dirigir', linkedAttribute: 'agility', description: 'Pilotar veículos terrestres' },
  { key: 'Navegar', label: 'Navegar', linkedAttribute: 'smarts', description: 'Pilotar embarcações' },
  { key: 'Roubar', label: 'Roubar', linkedAttribute: 'agility', description: 'Abrir fechaduras e furtos' },
  { key: 'Escalar', label: 'Escalar', linkedAttribute: 'strength', description: 'Escalar superfícies íngremes e paredes' },
]

/* ── Vantagens (Edges) ──────────────────────────────────── */

/** Requisito estruturado para uma Edge */
export type EdgeRequirement =
  | { type: 'attribute'; attribute: string; minDie: DieType }
  | { type: 'skill'; skill: string; minDie: DieType }
  | { type: 'edge'; edge: string }

export type EdgeDef = {
  key: string
  label: string
  category: string
  description: string
  requirements: EdgeRequirement[]
  /** Texto puro para exibição (PT-BR) */
  requirementLabel?: string
}

export const EDGES: EdgeDef[] = [
  // Combate
  { key: 'Bloqueio', label: 'Bloqueio', category: 'Combate', description: '+1 em Aparar', requirements: [{ type: 'skill', skill: 'Lutar', minDie: 8 }], requirementLabel: 'Lutar d8+' },
  { key: 'Esquiva', label: 'Esquiva', category: 'Combate', description: '-2 para ser atingido por ataques à distância', requirements: [{ type: 'attribute', attribute: 'agility', minDie: 8 }], requirementLabel: 'Agilidade d8+' },
  { key: 'Primeiro Ataque', label: 'Primeiro Ataque', category: 'Combate', description: 'Ataque gratuito contra inimigo que entra no seu alcance', requirements: [{ type: 'attribute', attribute: 'agility', minDie: 8 }], requirementLabel: 'Agilidade d8+' },
  { key: 'Frenesi', label: 'Frenesi', category: 'Combate', description: 'Pode fazer um ataque corpo a corpo adicional com -2', requirements: [{ type: 'skill', skill: 'Lutar', minDie: 8 }], requirementLabel: 'Lutar d8+' },
  { key: 'Ambidestria', label: 'Ambidestria', category: 'Combate', description: 'Ignora penalidade de mão inábil', requirements: [{ type: 'attribute', attribute: 'agility', minDie: 8 }], requirementLabel: 'Agilidade d8+' },
  { key: 'Golpe Poderoso', label: 'Golpe Poderoso', category: 'Combate', description: 'Dobra o dado de dano de Força em um ataque corpo a corpo (1×/turno)', requirements: [] },
  { key: 'Mira Firme', label: 'Mira Firme', category: 'Combate', description: '+1 em Tiro ou Arremesso se não se mover', requirements: [{ type: 'skill', skill: 'Atirar', minDie: 8 }], requirementLabel: 'Atirar d8+' },
  { key: 'Contra-Ataque', label: 'Contra-Ataque', category: 'Combate', description: 'Ataque gratuito contra oponente que falhar em atingi-lo corpo a corpo', requirements: [{ type: 'skill', skill: 'Lutar', minDie: 8 }], requirementLabel: 'Lutar d8+' },
  // Liderança
  { key: 'Comando', label: 'Comando', category: 'Liderança', description: 'Aliados em alcance recebem +1 para recuperar de Atordoamento', requirements: [{ type: 'attribute', attribute: 'smarts', minDie: 6 }], requirementLabel: 'Astúcia d6+' },
  { key: 'Inspirar', label: 'Inspirar', category: 'Liderança', description: 'Uma vez por turno, aliados recebem +1 em um teste', requirements: [{ type: 'edge', edge: 'Comando' }], requirementLabel: 'Comando' },
  { key: 'Fervor', label: 'Fervor', category: 'Liderança', description: 'Aliados em alcance recebem +1 em dano corpo a corpo', requirements: [{ type: 'attribute', attribute: 'spirit', minDie: 8 }, { type: 'edge', edge: 'Comando' }], requirementLabel: 'Espírito d8+, Comando' },
  { key: 'Líder Nato', label: 'Líder Nato', category: 'Liderança', description: 'Líder pode compartilhar Bennies com aliados em alcance', requirements: [{ type: 'attribute', attribute: 'spirit', minDie: 8 }], requirementLabel: 'Espírito d8+' },
  // Background
  { key: 'Arcano', label: 'Arcano (Background)', category: 'Background', description: 'Acesso a poderes mágicos, divinos ou psíquicos e pontos de poder (10 PP)', requirements: [], requirementLabel: 'Variável' },
  { key: 'Atraente', label: 'Atraente', category: 'Background', description: '+1 em Persuasão e Atuação para quem se importa com aparência', requirements: [{ type: 'attribute', attribute: 'vigor', minDie: 6 }], requirementLabel: 'Vigor d6+' },
  { key: 'Muito Atraente', label: 'Muito Atraente', category: 'Background', description: '+2 em Persuasão e Atuação para quem se importa com aparência', requirements: [{ type: 'edge', edge: 'Atraente' }], requirementLabel: 'Atraente' },
  { key: 'Sorte', label: 'Sorte', category: 'Background', description: '+1 Benny por sessão', requirements: [] },
  { key: 'Grande Sorte', label: 'Grande Sorte', category: 'Background', description: '+2 Bennies por sessão', requirements: [{ type: 'edge', edge: 'Sorte' }], requirementLabel: 'Sorte' },
  { key: 'Rico', label: 'Rico', category: 'Background', description: '3× os fundos iniciais', requirements: [] },
  { key: 'Muito Rico', label: 'Muito Rico', category: 'Background', description: '5× os fundos iniciais', requirements: [{ type: 'edge', edge: 'Rico' }], requirementLabel: 'Rico' },
  { key: 'Nobre', label: 'Nobre', category: 'Background', description: 'Status social elevado; +2 em Persuasão com pessoas que respeitam nobreza', requirements: [] },
  { key: 'Corajoso', label: 'Corajoso', category: 'Background', description: '+2 para resistir testes de medo e Intimidação', requirements: [{ type: 'attribute', attribute: 'spirit', minDie: 6 }], requirementLabel: 'Espírito d6+' },
  { key: 'Linguista', label: 'Linguista', category: 'Background', description: 'Conhece idiomas adicionais equivalentes a Astúcia/2', requirements: [{ type: 'attribute', attribute: 'smarts', minDie: 6 }], requirementLabel: 'Astúcia d6+' },
  // Poder
  { key: 'Pontos de Poder', label: 'Pontos de Poder', category: 'Poder', description: '+5 Pontos de Poder', requirements: [{ type: 'edge', edge: 'Arcano' }], requirementLabel: 'Arcano' },
  { key: 'Recuperação Rápida', label: 'Recuperação Rápida', category: 'Poder', description: 'Recupera 1 PP a cada 30 minutos (em vez de 1 hora)', requirements: [{ type: 'edge', edge: 'Arcano' }], requirementLabel: 'Arcano' },
  { key: 'Alma Guerreira', label: 'Alma Guerreira', category: 'Poder', description: '+2 de dano com poderes ofensivos', requirements: [{ type: 'edge', edge: 'Arcano' }], requirementLabel: 'Arcano' },
  // Profissional
  { key: 'Assassino', label: 'Assassino', category: 'Profissional', description: '+2 de dano contra alvos Vulneráveis ou Desprevenidos', requirements: [{ type: 'attribute', attribute: 'agility', minDie: 8 }, { type: 'skill', skill: 'Lutar', minDie: 6 }, { type: 'skill', skill: 'Furtividade', minDie: 8 }], requirementLabel: 'Agilidade d8+, Lutar d6+, Furtividade d8+' },
  { key: 'Investigador', label: 'Investigador', category: 'Profissional', description: '+2 em Pesquisa e Percepção para investigações', requirements: [{ type: 'skill', skill: 'Investigar', minDie: 8 }, { type: 'skill', skill: 'Notar', minDie: 8 }], requirementLabel: 'Investigar d8+, Notar d8+' },
  { key: 'Estudioso', label: 'Estudioso', category: 'Profissional', description: '+2 em dois rankings de Conhecimento à sua escolha', requirements: [{ type: 'attribute', attribute: 'smarts', minDie: 8 }], requirementLabel: 'Astúcia d8+' },
  { key: 'Curandeiro', label: 'Curandeiro', category: 'Profissional', description: '+2 em todos os testes de Medicina', requirements: [{ type: 'skill', skill: 'Curar', minDie: 8 }], requirementLabel: 'Curar d8+' },
  { key: 'Mentalista', label: 'Mentalista', category: 'Profissional', description: '+2 em Intimidação e Provocação por poderes psíquicos', requirements: [{ type: 'attribute', attribute: 'smarts', minDie: 8 }], requirementLabel: 'Astúcia d8+' },
  // Social
  { key: 'Carismático', label: 'Carismático', category: 'Social', description: 'Re-rola falha em Persuasão uma vez por interação', requirements: [{ type: 'attribute', attribute: 'spirit', minDie: 8 }], requirementLabel: 'Espírito d8+' },
  { key: 'Contatos', label: 'Contatos', category: 'Social', description: 'Pode requisitar favores de uma organização ou facção', requirements: [] },
  { key: 'Conexões', label: 'Conexões', category: 'Social', description: 'Acesso a uma rede de informantes e aliados influentes', requirements: [] },
]

/* ── Complicações (Hindrances) ──────────────────────────── */

export type HindranceDef = {
  key: string
  label: string
  severity: 'minor' | 'major'
  description: string
}

export const HINDRANCES: HindranceDef[] = [
  { key: 'Arrogante', label: 'Arrogante', severity: 'major', description: 'Sempre desafia o líder inimigo; subestima oponentes' },
  { key: 'Caolho', label: 'Caolho', severity: 'major', description: '-2 em testes que dependem de visão de profundidade' },
  { key: 'Cego', label: 'Cego', severity: 'major', description: '-6 em tarefas visuais; ganha +1 Edge como compensação' },
  { key: 'Código de Honra', label: 'Código de Honra', severity: 'major', description: 'Segue um código rígido mesmo quando perigoso' },
  { key: 'Covarde', label: 'Covarde', severity: 'major', description: '-2 em testes de resistir medo e Intimidação' },
  { key: 'Desejo de Morte', label: 'Desejo de Morte', severity: 'minor', description: 'Assume riscos desnecessários e se coloca em perigo' },
  { key: 'Delusão (Menor)', label: 'Delusão (Menor)', severity: 'minor', description: 'Acredita em algo que não é verdade (efeito leve)' },
  { key: 'Delusão (Maior)', label: 'Delusão (Maior)', severity: 'major', description: 'Acredita firmemente em algo falso; afeta decisões constantemente' },
  { key: 'Feio', label: 'Feio', severity: 'minor', description: '-1 em Persuasão devido à aparência desagradável' },
  { key: 'Hábito (Menor)', label: 'Hábito (Menor)', severity: 'minor', description: 'Vício social irritante que incomoda os outros' },
  { key: 'Hábito (Maior)', label: 'Hábito (Maior)', severity: 'major', description: 'Vício debilitante que afeta saúde ou julgamento' },
  { key: 'Herói', label: 'Herói', severity: 'major', description: 'Nunca recusa ajudar quem está em perigo' },
  { key: 'Idoso', label: 'Idoso', severity: 'major', description: '-1 em Agilidade, Força e Vigor; +5 pontos de perícia' },
  { key: 'Inimigo (Menor)', label: 'Inimigo (Menor)', severity: 'minor', description: 'Alguém moderadamente poderoso quer prejudicá-lo' },
  { key: 'Inimigo (Maior)', label: 'Inimigo (Maior)', severity: 'major', description: 'Alguém muito poderoso quer destruí-lo' },
  { key: 'Jovem', label: 'Jovem', severity: 'major', description: 'Apenas 3 pontos de atributo e 10 pontos de perícia; +1 Benny' },
  { key: 'Leal', label: 'Leal', severity: 'minor', description: 'Nunca trai aliados, mesmo sob pressão extrema' },
  { key: 'Lento (Menor)', label: 'Lento (Menor)', severity: 'minor', description: 'Pace 5, d4 como dado de corrida' },
  { key: 'Lento (Maior)', label: 'Lento (Maior)', severity: 'major', description: 'Pace 4, d4 como dado de corrida; -2 em Atletismo para corrida' },
  { key: 'Manco', label: 'Manco', severity: 'major', description: 'Pace 4, d4 como dado de corrida' },
  { key: 'Maneta', label: 'Maneta', severity: 'major', description: 'Falta um braço; não pode usar armas de duas mãos' },
  { key: 'Mau Hábito', label: 'Mau Hábito', severity: 'minor', description: 'Comportamento socialmente inaceitável que causa problemas' },
  { key: 'Obeso', label: 'Obeso', severity: 'minor', description: '+1 Resistência, -1 Pace, d4 como dado de corrida' },
  { key: 'Pacifista (Menor)', label: 'Pacifista (Menor)', severity: 'minor', description: 'Luta apenas em autodefesa' },
  { key: 'Pacifista (Maior)', label: 'Pacifista (Maior)', severity: 'major', description: 'Nunca usa violência, mesmo em autodefesa' },
  { key: 'Pequeno', label: 'Pequeno', severity: 'major', description: '-1 em Resistência por tamanho reduzido' },
  { key: 'Procurado (Menor)', label: 'Procurado (Menor)', severity: 'minor', description: 'Procurado por uma facção local ou crime menor' },
  { key: 'Procurado (Maior)', label: 'Procurado (Maior)', severity: 'major', description: 'Procurado por forças poderosas ou crime grave' },
  { key: 'Sanguinário', label: 'Sanguinário', severity: 'minor', description: 'Nunca faz prisioneiros; -4 em Carisma com NPCs pacíficos' },
  { key: 'Temerário', label: 'Temerário', severity: 'minor', description: 'Assume riscos desnecessários e age impulsivamente' },
  { key: 'Tímido', label: 'Tímido', severity: 'minor', description: '-2 em Persuasão com desconhecidos' },
  { key: 'Vingativo', label: 'Vingativo', severity: 'minor', description: 'Busca a qualquer custo retribuir ofensas ou danos' },
]

/* ── Character Creation Config ──────────────────────────── */

export const CHARACTER_CREATION = {
  attributePoints: 5,
  skillPoints: 12,
  startingDie: 4 as DieType,
  /** Limites de complicações */
  maxMajorHindrances: 1,
  maxMinorHindrances: 2,
  /** Custo de cada Edge em pontos de hindrance */
  edgeCostInHindrancePoints: 2,
}

/* ── Hindrance Points Budget ────────────────────────────── */

export type HindrancePointsAllocation = {
  extraEdges: number        // cada 1 = 2 hindrance pts
  extraAttributePoints: number // cada 1 = 2 hindrance pts
  extraSkillPoints: number  // cada 1 = 1 hindrance pt
}

export function calcHindrancePoints(hindrances: { severity: 'minor' | 'major' }[]): number {
  let pts = 0
  for (const h of hindrances) {
    pts += h.severity === 'major' ? 2 : 1
  }
  return Math.min(pts, 4) // SW cap: max 4 pts from hindrances
}

export function validateHindranceLimits(
  hindrances: { severity: 'minor' | 'major' }[]
): { valid: boolean; majorCount: number; minorCount: number; errors: string[] } {
  const majorCount = hindrances.filter((h) => h.severity === 'major').length
  const minorCount = hindrances.filter((h) => h.severity === 'minor').length
  const errors: string[] = []
  if (majorCount > CHARACTER_CREATION.maxMajorHindrances) {
    errors.push(`Máximo ${CHARACTER_CREATION.maxMajorHindrances} Complicação Maior (selecionou ${majorCount})`)
  }
  if (minorCount > CHARACTER_CREATION.maxMinorHindrances) {
    errors.push(`Máximo ${CHARACTER_CREATION.maxMinorHindrances} Complicações Menores (selecionou ${minorCount})`)
  }
  return { valid: errors.length === 0, majorCount, minorCount, errors }
}

export function calcHindrancePointsSpent(allocation: HindrancePointsAllocation): number {
  return allocation.extraEdges * 2 + allocation.extraAttributePoints * 2 + allocation.extraSkillPoints * 1
}

/* ── Edge Requirement Validation ────────────────────────── */

export type EdgeEligibility = {
  eligible: boolean
  unmetRequirements: string[]
}

export function checkEdgeRequirements(
  edge: EdgeDef,
  attributes: Record<string, number>,
  skills: Record<string, number>,
  selectedEdges: string[],
): EdgeEligibility {
  const unmet: string[] = []
  for (const req of edge.requirements) {
    switch (req.type) {
      case 'attribute': {
        const current = attributes[req.attribute] ?? 4
        if (current < req.minDie) {
          const attrDef = ATTRIBUTES.find((a) => a.key === req.attribute)
          unmet.push(`${attrDef?.label ?? req.attribute} d${req.minDie}+`)
        }
        break
      }
      case 'skill': {
        const current = skills[req.skill] ?? 0
        if (current < req.minDie) {
          unmet.push(`${req.skill} d${req.minDie}+`)
        }
        break
      }
      case 'edge': {
        if (!selectedEdges.includes(req.edge)) {
          unmet.push(`Vantagem: ${req.edge}`)
        }
        break
      }
    }
  }
  return { eligible: unmet.length === 0, unmetRequirements: unmet }
}

/* ── Helpers ────────────────────────────────────────────── */

export function dieLabel(die: number): string {
  return `d${die}`
}

export function calcPace(): number {
  return 6
}

export function calcParry(fightingDie: number): number {
  return 2 + Math.floor(fightingDie / 2)
}

export function calcToughness(vigorDie: number, armor = 0): number {
  return 2 + Math.floor(vigorDie / 2) + armor
}

export function attributeStepCost(currentDie: DieType, targetDie: DieType): number {
  return (targetDie - currentDie) / 2
}

/* ── Armas ──────────────────────────────────────────────── */

export type WeaponDef = {
  key: string
  label: string
  damage: string
  range?: string
  ap?: number
  minStrength?: number
  notes?: string
  isRanged: boolean
}

export const WEAPONS: WeaponDef[] = [
  // Corpo a corpo
  { key: 'unarmed', label: 'Desarmado', damage: 'For', isRanged: false, notes: 'Dano de Força' },
  { key: 'dagger', label: 'Adaga', damage: 'For+d4', isRanged: false, minStrength: 4 },
  { key: 'short_sword', label: 'Espada Curta', damage: 'For+d6', isRanged: false, minStrength: 6 },
  { key: 'long_sword', label: 'Espada Longa', damage: 'For+d8', isRanged: false, minStrength: 8 },
  { key: 'great_sword', label: 'Espada Grande', damage: 'For+d10', isRanged: false, minStrength: 10, notes: 'Duas mãos, Aparar -1' },
  { key: 'axe', label: 'Machado', damage: 'For+d6', isRanged: false, minStrength: 6 },
  { key: 'great_axe', label: 'Machado Grande', damage: 'For+d10', isRanged: false, minStrength: 10, notes: 'Duas mãos, Aparar -1' },
  { key: 'mace', label: 'Maça', damage: 'For+d6', isRanged: false, minStrength: 6 },
  { key: 'flail', label: 'Mangual', damage: 'For+d6', isRanged: false, minStrength: 6, notes: 'Ignora bônus de Escudo' },
  { key: 'spear', label: 'Lança', damage: 'For+d6', isRanged: false, minStrength: 6, notes: 'Alcance 1, pode arremessar' },
  { key: 'halberd', label: 'Alabarda', damage: 'For+d8', isRanged: false, minStrength: 8, notes: 'Alcance 1, duas mãos' },
  { key: 'staff', label: 'Bordão', damage: 'For+d4', isRanged: false, minStrength: 4, notes: 'Alcance 1, Aparar +1, duas mãos' },
  // Distância
  { key: 'bow', label: 'Arco', damage: '2d6', range: '12/24/48', isRanged: true, minStrength: 6 },
  { key: 'crossbow', label: 'Besta', damage: '2d6', range: '15/30/60', ap: 2, isRanged: true, minStrength: 6, notes: 'AP 2, 1 ação para recarregar' },
  { key: 'sling', label: 'Funda', damage: 'For+d4', range: '4/8/16', isRanged: true, minStrength: 4 },
  { key: 'throwing_knife', label: 'Faca de Arremesso', damage: 'For+d4', range: '3/6/12', isRanged: true, minStrength: 4 },
  { key: 'javelin', label: 'Dardo/Azagaia', damage: 'For+d6', range: '3/6/12', isRanged: true, minStrength: 6 },
  // Armas de fogo (cenários modernos)
  { key: 'pistol', label: 'Pistola', damage: '2d6', range: '12/24/48', ap: 1, isRanged: true, minStrength: 4 },
  { key: 'revolver', label: 'Revólver', damage: '2d6+1', range: '12/24/48', ap: 1, isRanged: true, minStrength: 4 },
  { key: 'rifle', label: 'Rifle', damage: '2d8', range: '24/48/96', ap: 2, isRanged: true, minStrength: 6 },
  { key: 'shotgun', label: 'Escopeta', damage: '1d6+1d8', range: '12/24/48', isRanged: true, minStrength: 6, notes: '+2 para acertar a curta distância' },
  { key: 'smg', label: 'Submetralhadora', damage: '2d6', range: '12/24/48', ap: 1, isRanged: true, minStrength: 4, notes: 'Tiro rápido' },
]

/* ── Armaduras ──────────────────────────────────────────── */

export type ArmorDef = {
  key: string
  label: string
  armorValue: number
  minStrength?: number
  notes?: string
}

export const ARMORS: ArmorDef[] = [
  { key: 'leather', label: 'Couro', armorValue: 1, minStrength: 4 },
  { key: 'chain_mail', label: 'Cota de Malha', armorValue: 2, minStrength: 6 },
  { key: 'plate_mail', label: 'Armadura de Placas', armorValue: 3, minStrength: 8, notes: '-2 Furtividade' },
  { key: 'small_shield', label: 'Escudo Pequeno', armorValue: 1, notes: '+1 Aparar' },
  { key: 'medium_shield', label: 'Escudo Médio', armorValue: 2, notes: '+2 Aparar, -2 para ser atingido à distância' },
  { key: 'large_shield', label: 'Escudo Grande', armorValue: 3, notes: '+2 Aparar, -4 para ser atingido à distância' },
  { key: 'kevlar_vest', label: 'Colete Kevlar', armorValue: 2, notes: 'Cobre apenas torso' },
  { key: 'tactical_vest', label: 'Colete Tático', armorValue: 4, minStrength: 6, notes: 'Cobre apenas torso' },
]

/* ── Ranks de Progressão ───────────────────────────────── */

export type RankDef = {
  key: string
  label: string
  advancesNeeded: number
}

export const RANKS: RankDef[] = [
  { key: 'novato', label: 'Novato', advancesNeeded: 0 },
  { key: 'experiente', label: 'Experiente', advancesNeeded: 4 },
  { key: 'veterano', label: 'Veterano', advancesNeeded: 8 },
  { key: 'heroico', label: 'Heroico', advancesNeeded: 12 },
  { key: 'lendario', label: 'Lendário', advancesNeeded: 16 },
]

/* ── Regras Básicas (resumo mecânico) ──────────────────── */

export const CORE_RULES = [
  {
    title: 'Testes',
    text: 'Rola-se o dado da perícia/atributo + Wild Die (d6). Usa-se o MAIOR resultado. Se tirar o valor máximo do dado, ele "explode" — re-rola e soma ao total.',
  },
  {
    title: 'Sucesso e Ampliação (Raise)',
    text: 'O número-alvo (TN) padrão é 4. Atingir o TN = sucesso. Cada +4 acima do TN = 1 Raise (sucesso excepcional com efeitos bônus).',
  },
  {
    title: 'Combate',
    text: 'Ataque corpo a corpo: rola Luta vs Aparar do alvo. Ataque à distância: rola Tiro vs TN 4 (com modificadores de distância e cobertura). Um Raise no ataque = +1d6 de dano bônus.',
  },
  {
    title: 'Dano vs Resistência',
    text: 'O dano é comparado à Resistência do alvo. Dano ≥ Resistência → Abalado (Shaken). Cada Raise acima da Resistência = +1 Ferimento. Se já estava Abalado e sofre Abalado novamente = +1 Ferimento.',
  },
  {
    title: 'Ferimentos',
    text: 'Cada ferimento causa -1 em TODOS os testes (acumulativo, máximo -3). Com 4+ ferimentos o personagem fica Incapacitado e deve fazer um teste de Vigor para sobreviver.',
  },
  {
    title: 'Bennies',
    text: 'Cada jogador recebe 3 Bennies por sessão. Podem ser gastos para: re-rolar qualquer teste, absorver ferimento (teste de Vigor — Soak), ou recuperar de Abalado instantaneamente.',
  },
  {
    title: 'Fadiga',
    text: 'Acumulada por esforço, ambiente hostil ou uso de poderes. Cada nível de Fadiga causa -1 em todos os testes. Se exceder o máximo (3 níveis), o personagem fica Incapacitado.',
  },
  {
    title: 'Iniciativa',
    text: 'Usa-se cartas de baralho. Cada personagem recebe uma carta no início do turno — quanto maior a carta, mais cedo age. Coringas dão +2 em todos os testes e dano naquele turno.',
  },
]
