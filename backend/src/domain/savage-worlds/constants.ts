import type { AttributeName, DieType, Hindrance, SWAttributes } from '../types/gameState.js'

// ─── Atributos ───

export type AttributeDefinition = {
  key: AttributeName
  label: string
  description: string
}

export const ATTRIBUTES: readonly AttributeDefinition[] = [
  { key: 'agility', label: 'Agilidade', description: 'Reflexos, equilíbrio e rapidez de movimentos' },
  { key: 'smarts', label: 'Astúcia', description: 'Intelecto, percepção e raciocínio rápido' },
  { key: 'spirit', label: 'Espírito', description: 'Força de vontade, carisma e determinação' },
  { key: 'strength', label: 'Força', description: 'Poder físico bruto e capacidade de carga' },
  { key: 'vigor', label: 'Vigor', description: 'Resistência física, saúde e capacidade de absorver dano' }
] as const

export const ATTRIBUTE_KEYS: readonly AttributeName[] = ATTRIBUTES.map((a) => a.key)

// ─── Skills ───

export type SkillDefinition = {
  key: string
  label: string
  linkedAttribute: AttributeName
  description: string
}

export const SKILLS: readonly SkillDefinition[] = [
  { key: 'athletics', label: 'Atletismo', linkedAttribute: 'agility', description: 'Correr, escalar, saltar e nadar' },
  { key: 'boating', label: 'Navegação', linkedAttribute: 'agility', description: 'Pilotar embarcações' },
  { key: 'driving', label: 'Condução', linkedAttribute: 'agility', description: 'Pilotar veículos terrestres' },
  { key: 'fighting', label: 'Luta', linkedAttribute: 'agility', description: 'Combate corpo a corpo' },
  { key: 'riding', label: 'Montaria', linkedAttribute: 'agility', description: 'Cavalgar montarias' },
  { key: 'shooting', label: 'Tiro', linkedAttribute: 'agility', description: 'Armas de projétil e distância' },
  { key: 'stealth', label: 'Furtividade', linkedAttribute: 'agility', description: 'Mover-se sem ser detectado' },
  { key: 'thievery', label: 'Ladinagem', linkedAttribute: 'agility', description: 'Abrir fechaduras e furtos' },
  { key: 'academics', label: 'Acadêmico', linkedAttribute: 'smarts', description: 'Conhecimento formal e erudição' },
  { key: 'commonKnowledge', label: 'Conhecimento Geral', linkedAttribute: 'smarts', description: 'Cultura geral e senso comum' },
  { key: 'electronics', label: 'Eletrônica', linkedAttribute: 'smarts', description: 'Operar e reparar eletrônicos' },
  { key: 'hacking', label: 'Hacking', linkedAttribute: 'smarts', description: 'Invadir sistemas computacionais' },
  { key: 'healing', label: 'Medicina', linkedAttribute: 'smarts', description: 'Tratar ferimentos e doenças' },
  { key: 'language', label: 'Idiomas', linkedAttribute: 'smarts', description: 'Comunicar-se em outras línguas' },
  { key: 'notice', label: 'Percepção', linkedAttribute: 'smarts', description: 'Detectar detalhes e ameaças' },
  { key: 'occult', label: 'Ocultismo', linkedAttribute: 'smarts', description: 'Conhecimento sobrenatural e místico' },
  { key: 'repair', label: 'Reparos', linkedAttribute: 'smarts', description: 'Consertar máquinas e dispositivos' },
  { key: 'research', label: 'Pesquisa', linkedAttribute: 'smarts', description: 'Investigar e coletar informações' },
  { key: 'science', label: 'Ciência', linkedAttribute: 'smarts', description: 'Conhecimentos científicos avançados' },
  { key: 'battle', label: 'Tática', linkedAttribute: 'smarts', description: 'Estratégia e comando em combate' },
  { key: 'gambling', label: 'Jogatina', linkedAttribute: 'smarts', description: 'Jogos de azar e apostas' },
  { key: 'intimidation', label: 'Intimidação', linkedAttribute: 'spirit', description: 'Amedrontar e coagir oponentes' },
  { key: 'performance', label: 'Atuação', linkedAttribute: 'spirit', description: 'Cantar, dançar, atuar e entreter' },
  { key: 'persuasion', label: 'Persuasão', linkedAttribute: 'spirit', description: 'Convencer e negociar com outros' },
  { key: 'taunt', label: 'Provocar', linkedAttribute: 'smarts', description: 'Distrair e irritar oponentes em combate' },
  { key: 'faith', label: 'Fé', linkedAttribute: 'spirit', description: 'Canalizar poder divino' },
  { key: 'focus', label: 'Foco', linkedAttribute: 'spirit', description: 'Canalizar poder psíquico ou interior' },
  { key: 'spellcasting', label: 'Magias', linkedAttribute: 'smarts', description: 'Lançar feitiços e rituais arcanos' },
  { key: 'survival', label: 'Sobrevivência', linkedAttribute: 'smarts', description: 'Rastrear, caçar e sobreviver na natureza' }
] as const

export const CORE_SKILL_KEYS = SKILLS.map((s) => s.key)

// ─── Edges ───

export type EdgeRequirement = {
  rank?: 'novato' | 'experiente' | 'veterano' | 'heroico' | 'lendario'
  attribute?: { name: AttributeName; min: DieType }
  skill?: { name: string; min: DieType }
  edge?: string
}

export type EdgeDefinition = {
  key: string
  label: string
  category: 'background' | 'combat' | 'leadership' | 'power' | 'professional' | 'social' | 'weird' | 'legendary'
  description: string
  requirements: EdgeRequirement[]
}

export const EDGES: readonly EdgeDefinition[] = [
  // Background
  { key: 'alertness', label: 'Alerta', category: 'background', description: '+2 em testes de Percepção', requirements: [] },
  { key: 'ambidextrous', label: 'Ambidestro', category: 'background', description: 'Ignora penalidade de mão inábil', requirements: [{ attribute: { name: 'agility', min: 8 } }] },
  { key: 'attractive', label: 'Atraente', category: 'background', description: '+1 em Persuasão e Atuação para quem se importa com aparência', requirements: [{ attribute: { name: 'vigor', min: 6 } }] },
  { key: 'brawny', label: 'Corpulento', category: 'background', description: '+1 de Resistência e +1 de limite de carga', requirements: [{ attribute: { name: 'strength', min: 6 }, skill: { name: 'vigor', min: 6 } }] },
  { key: 'luck', label: 'Sortudo', category: 'background', description: '+1 Benny por sessão', requirements: [] },
  { key: 'quickDraw', label: 'Saque Rápido', category: 'background', description: 'Pode sacar uma arma como ação livre', requirements: [{ attribute: { name: 'agility', min: 8 } }] },
  { key: 'rich', label: 'Rico', category: 'background', description: '3× os fundos iniciais', requirements: [] },

  // Combat
  { key: 'block', label: 'Bloqueio', category: 'combat', description: '+1 em Aparar', requirements: [{ rank: 'experiente' }, { skill: { name: 'fighting', min: 8 } }] },
  { key: 'berserk', label: 'Berserk', category: 'combat', description: 'Entra em fúria ao ser ferido: +1 em Luta e dano, +2 em Resistência, ignora 1 nível de ferimento', requirements: [] },
  { key: 'combatReflexes', label: 'Reflexos de Combate', category: 'combat', description: '+2 para recuperar-se de Atordoamento', requirements: [{ rank: 'experiente' }] },
  { key: 'dodge', label: 'Esquivar', category: 'combat', description: '-2 para ser atingido por ataques à distância', requirements: [{ rank: 'experiente' }, { attribute: { name: 'agility', min: 8 } }] },
  { key: 'firstStrike', label: 'Primeiro Golpe', category: 'combat', description: 'Ataque gratuito contra inimigo que entra no seu alcance', requirements: [{ attribute: { name: 'agility', min: 8 } }] },
  { key: 'frenzy', label: 'Frenesi', category: 'combat', description: 'Pode fazer um ataque corpo a corpo adicional com -2', requirements: [{ rank: 'experiente' }, { skill: { name: 'fighting', min: 8 } }] },
  { key: 'levelHeaded', label: 'Cabeça Fria', category: 'combat', description: 'Compra uma carta de Ação adicional e escolhe a melhor', requirements: [{ rank: 'experiente' }, { attribute: { name: 'smarts', min: 8 } }] },
  { key: 'marksman', label: 'Atirador', category: 'combat', description: '+1 em Tiro ou Arremesso se não se mover', requirements: [{ rank: 'experiente' }, { skill: { name: 'shooting', min: 8 } }] },
  { key: 'nerveOfSteel', label: 'Nervos de Aço', category: 'combat', description: 'Ignora 1 ponto de penalidade por ferimento', requirements: [{ rank: 'novato' }, { attribute: { name: 'vigor', min: 8 } }] },
  { key: 'sweep', label: 'Varredura', category: 'combat', description: 'Ataca todos os oponentes adjacentes com -2', requirements: [{ attribute: { name: 'strength', min: 8 }, skill: { name: 'fighting', min: 8 } }] },
  { key: 'twoFisted', label: 'Duas Armas', category: 'combat', description: 'Pode atacar com ambas as mãos sem penalidade de ação múltipla', requirements: [{ attribute: { name: 'agility', min: 8 } }] },

  // Professional
  { key: 'acrobat', label: 'Acrobata', category: 'professional', description: '+2 em Atletismo para acrobacias e +1 em Aparar se desarmado', requirements: [{ attribute: { name: 'agility', min: 8 }, skill: { name: 'athletics', min: 8 } }] },
  { key: 'assassin', label: 'Assassino', category: 'professional', description: '+2 de dano contra alvos Vulneráveis ou Desprevenidos', requirements: [{ rank: 'experiente' }, { skill: { name: 'fighting', min: 6 } }, { skill: { name: 'stealth', min: 8 } }] },
  { key: 'champion', label: 'Campeão', category: 'professional', description: '+2 de dano e Resistência contra criaturas sobrenaturais malignas', requirements: [{ attribute: { name: 'spirit', min: 8 }, skill: { name: 'fighting', min: 6 } }] },
  { key: 'healer', label: 'Curandeiro', category: 'professional', description: '+2 em todos os testes de Medicina', requirements: [{ skill: { name: 'healing', min: 8 } }] },
  { key: 'investigator', label: 'Investigador', category: 'professional', description: '+2 em Pesquisa e Percepção para investigações', requirements: [{ skill: { name: 'research', min: 8 } }] },
  { key: 'scholar', label: 'Erudito', category: 'professional', description: '+2 em dois rankings de Conhecimento à sua escolha', requirements: [{ skill: { name: 'research', min: 8 } }] },
  { key: 'woodsman', label: 'Mateiro', category: 'professional', description: '+2 em Sobrevivência e Furtividade em ambientes naturais', requirements: [{ attribute: { name: 'spirit', min: 6 }, skill: { name: 'survival', min: 8 } }] },

  // Leadership
  { key: 'command', label: 'Comando', category: 'leadership', description: 'Aliados em alcance recebem +1 para recuperar de Atordoamento', requirements: [{ attribute: { name: 'smarts', min: 6 } }] },
  { key: 'inspire', label: 'Inspirar', category: 'leadership', description: 'Uma vez por turno, aliados recebem +1 em um teste', requirements: [{ rank: 'experiente' }, { edge: 'command' }] },
  { key: 'naturalLeader', label: 'Líder Nato', category: 'leadership', description: 'Líder pode compartilhar Bennies com aliados em alcance', requirements: [{ rank: 'experiente' }, { attribute: { name: 'spirit', min: 8 }, edge: 'command' }] },

  // Social
  { key: 'charismatic', label: 'Carismático', category: 'social', description: 'Re-rola falha em Persuasão uma vez por interação', requirements: [{ attribute: { name: 'spirit', min: 8 } }] },
  { key: 'connections', label: 'Conexões', category: 'social', description: 'Pode requisitar favores de uma organização ou facção', requirements: [] },
  { key: 'strongWilled', label: 'Determinado', category: 'social', description: '+2 para resistir Intimidação e Provocação, e faz testes de Astúcia com +2', requirements: [{ attribute: { name: 'spirit', min: 8 } }] },

  // Power
  { key: 'arcaneBackground_magic', label: 'Antecedente Arcano (Magia)', category: 'power', description: 'Acesso a poderes mágicos e pontos de poder (10 PP)', requirements: [{ skill: { name: 'spellcasting', min: 4 } }] },
  { key: 'arcaneBackground_miracles', label: 'Antecedente Arcano (Milagres)', category: 'power', description: 'Acesso a poderes divinos e pontos de poder (10 PP)', requirements: [{ skill: { name: 'faith', min: 4 } }] },
  { key: 'arcaneBackground_psionics', label: 'Antecedente Arcano (Psionismo)', category: 'power', description: 'Acesso a poderes psíquicos e pontos de poder (10 PP)', requirements: [{ skill: { name: 'focus', min: 4 } }] },
  { key: 'newPower', label: 'Novo Poder', category: 'power', description: 'Aprende um novo poder arcano', requirements: [{ edge: 'arcaneBackground_magic' }] },
  { key: 'powerPoints', label: 'Pontos de Poder', category: 'power', description: '+5 Pontos de Poder', requirements: [{ edge: 'arcaneBackground_magic' }] }
] as const

// ─── Hindrances ───

export type HindranceDefinition = {
  key: string
  label: string
  severity: 'minor' | 'major' | 'minor_or_major'
  description: string
}

export const HINDRANCES: readonly HindranceDefinition[] = [
  { key: 'allThumbs', label: 'Desastrado', severity: 'minor', description: '-2 ao usar dispositivos mecânicos e eletrônicos' },
  { key: 'arrogant', label: 'Arrogante', severity: 'major', description: 'Sempre desafia o líder inimigo; subestima oponentes' },
  { key: 'badEyes', label: 'Má Visão', severity: 'minor_or_major', description: '-1 (menor) ou -2 (maior) em testes que dependem de visão à distância' },
  { key: 'badLuck', label: 'Azarado', severity: 'major', description: '-1 Benny por sessão' },
  { key: 'blind', label: 'Cego', severity: 'major', description: '-6 em tarefas visuais; ganha +1 Edge como compensação' },
  { key: 'cautious', label: 'Cauteloso', severity: 'minor', description: 'Hesita e planeja demais antes de agir' },
  { key: 'clueless', label: 'Desinformado', severity: 'major', description: '-1 em Conhecimento Geral e Percepção' },
  { key: 'clumsy', label: 'Desajeitado', severity: 'major', description: '-2 em Atletismo e Furtividade' },
  { key: 'code_of_honor', label: 'Código de Honra', severity: 'major', description: 'Segue um código rígido mesmo quando perigoso' },
  { key: 'curious', label: 'Curioso', severity: 'major', description: 'Não resiste a investigar mistérios e locais perigosos' },
  { key: 'delusional', label: 'Delirante', severity: 'minor_or_major', description: 'Acredita em algo que não é verdade' },
  { key: 'elderly', label: 'Idoso', severity: 'major', description: '-1 em Agilidade, Força e Vigor; +5 pontos de perícia' },
  { key: 'enemy', label: 'Inimigo', severity: 'minor_or_major', description: 'Alguém poderoso quer prejudicá-lo' },
  { key: 'greedy', label: 'Ganancioso', severity: 'minor_or_major', description: 'Dificuldade em resistir a riquezas e negócios vantajosos' },
  { key: 'habit', label: 'Hábito', severity: 'minor_or_major', description: 'Vício social irritante (menor) ou debilitante (maior)' },
  { key: 'heroic', label: 'Heroico', severity: 'major', description: 'Nunca recusa ajudar quem está em perigo' },
  { key: 'illiterate', label: 'Iletrado', severity: 'minor', description: 'Não sabe ler nem escrever' },
  { key: 'loyal', label: 'Leal', severity: 'minor', description: 'Nunca trai aliados, mesmo sob pressão extrema' },
  { key: 'mean', label: 'Rude', severity: 'minor', description: '-1 em Persuasão devido a atitude ríspida' },
  { key: 'obese', label: 'Obeso', severity: 'minor', description: '+1 Resistência, -1 Pace, d4 como dado de corrida' },
  { key: 'onArm', label: 'Maneta', severity: 'major', description: 'Falta um braço; não pode usar armas de duas mãos' },
  { key: 'oneLeg', label: 'Perneta', severity: 'major', description: 'Pace 4, d4 como dado de corrida' },
  { key: 'outsider', label: 'Forasteiro', severity: 'minor_or_major', description: '-2 em Persuasão com grupo dominante' },
  { key: 'overconfident', label: 'Confiante Demais', severity: 'major', description: 'Acredita que pode resolver qualquer situação' },
  { key: 'pacifist', label: 'Pacifista', severity: 'minor_or_major', description: 'Luta apenas em autodefesa (menor) ou nunca (maior)' },
  { key: 'phobia', label: 'Fobia', severity: 'minor_or_major', description: '-1 (menor) ou -2 (maior) perto do objeto de medo' },
  { key: 'poverty', label: 'Pobreza', severity: 'minor', description: 'Metade dos fundos iniciais; perde metade da renda' },
  { key: 'slowPoke', label: 'Lento', severity: 'minor', description: 'Pace 5, d4 como dado de corrida' },
  { key: 'stubborn', label: 'Teimoso', severity: 'minor', description: 'Sempre defende seu ponto mesmo quando errado' },
  { key: 'vengeful', label: 'Vingativo', severity: 'minor_or_major', description: 'Busca a qualquer custo retribuir ofensas ou danos' },
  { key: 'wanted', label: 'Procurado', severity: 'minor_or_major', description: 'A lei ou uma facção está atrás de você' },
  { key: 'young', label: 'Jovem', severity: 'major', description: 'Apenas 3 pontos de atributo e 10 pontos de perícia; +1 Benny' }
] as const

// ─── Derived Stats ───

export function calcPace(edges: string[], hindrances: Hindrance[]): number {
  let pace = 6
  if (hindrances.some((h) => h.name === 'slowPoke')) pace = 5
  if (hindrances.some((h) => h.name === 'obese')) pace -= 1
  if (hindrances.some((h) => h.name === 'oneLeg')) pace = 4
  if (edges.includes('fleet')) pace += 2
  return Math.max(1, pace)
}

export function calcParry(fightingDie: DieType | 0, edges: string[]): number {
  let parry = 2 + Math.floor((fightingDie || 0) / 2)
  if (edges.includes('block')) parry += 1
  return parry
}

export function calcToughness(vigorDie: DieType, armor: number, edges: string[], hindrances: Hindrance[]): number {
  let toughness = 2 + Math.floor(vigorDie / 2)
  if (edges.includes('brawny')) toughness += 1
  if (hindrances.some((h) => h.name === 'obese')) toughness += 1
  return toughness + armor
}

// ─── Criação de Personagem ───

export const CHARACTER_CREATION = {
  /** Pontos de atributo para distribuir (cada step d4→d6 custa 1) */
  attributePoints: 5,
  /** Pontos de skill para distribuir */
  skillPoints: 12,
  /** Custo de subir skill acima do atributo linkado */
  skillAboveAttributeCost: 2,
  /** Custo normal de step de skill */
  skillNormalCost: 1,
  /** Máximo de pontos que Hindrances podem gerar */
  maxHindrancePoints: 4,
  /** Máximo de Complicações Maiores */
  maxMajorHindrances: 1,
  /** Máximo de Complicações Menores */
  maxMinorHindrances: 2,
  /** Bennies iniciais por sessão */
  startingBennies: 3,
  /** Wild Cards aguentam 3 Wounds */
  maxWounds: 3,
  /** Fadiga máxima */
  maxFatigue: 3,
  /** Dano base desarmado */
  unarmedDamage: 'str'
} as const

// ─── Armas (Tabela básica) ───

export type WeaponDefinition = {
  key: string
  label: string
  damage: string
  range?: string
  ap?: number
  minStrength?: DieType
  notes?: string
  isRanged: boolean
}

export const WEAPONS: readonly WeaponDefinition[] = [
  // Corpo a corpo
  { key: 'unarmed', label: 'Desarmado', damage: 'str', isRanged: false, notes: 'Dano de Força' },
  { key: 'dagger', label: 'Adaga', damage: 'str+d4', isRanged: false, minStrength: 4 },
  { key: 'short_sword', label: 'Espada Curta', damage: 'str+d6', isRanged: false, minStrength: 6 },
  { key: 'long_sword', label: 'Espada Longa', damage: 'str+d8', isRanged: false, minStrength: 8 },
  { key: 'great_sword', label: 'Espada Grande', damage: 'str+d10', isRanged: false, minStrength: 10, notes: 'Duas mãos, Aparar -1' },
  { key: 'axe', label: 'Machado', damage: 'str+d6', isRanged: false, minStrength: 6 },
  { key: 'great_axe', label: 'Machado Grande', damage: 'str+d10', isRanged: false, minStrength: 10, notes: 'Duas mãos, Aparar -1' },
  { key: 'mace', label: 'Maça', damage: 'str+d6', isRanged: false, minStrength: 6 },
  { key: 'flail', label: 'Mangual', damage: 'str+d6', isRanged: false, minStrength: 6, notes: 'Ignora bônus de Escudo' },
  { key: 'spear', label: 'Lança', damage: 'str+d6', isRanged: false, minStrength: 6, notes: 'Alcance 1, pode arremessar' },
  { key: 'halberd', label: 'Alabarda', damage: 'str+d8', isRanged: false, minStrength: 8, notes: 'Alcance 1, duas mãos' },
  { key: 'staff', label: 'Bordão', damage: 'str+d4', isRanged: false, minStrength: 4, notes: 'Alcance 1, Aparar +1, duas mãos' },

  // Distância
  { key: 'bow', label: 'Arco', damage: '2d6', range: '12/24/48', isRanged: true, minStrength: 6 },
  { key: 'crossbow', label: 'Besta', damage: '2d6', range: '15/30/60', ap: 2, isRanged: true, minStrength: 6, notes: 'AP 2, 1 ação para recarregar' },
  { key: 'sling', label: 'Funda', damage: 'str+d4', range: '4/8/16', isRanged: true, minStrength: 4 },
  { key: 'throwing_knife', label: 'Faca de Arremesso', damage: 'str+d4', range: '3/6/12', isRanged: true, minStrength: 4 },
  { key: 'javelin', label: 'Dardo/Azagaia', damage: 'str+d6', range: '3/6/12', isRanged: true, minStrength: 6 },

  // Armas de fogo (cenários modernos)
  { key: 'pistol', label: 'Pistola', damage: '2d6', range: '12/24/48', ap: 1, isRanged: true, minStrength: 4 },
  { key: 'revolver', label: 'Revólver', damage: '2d6+1', range: '12/24/48', ap: 1, isRanged: true, minStrength: 4 },
  { key: 'rifle', label: 'Rifle', damage: '2d8', range: '24/48/96', ap: 2, isRanged: true, minStrength: 6 },
  { key: 'shotgun', label: 'Escopeta', damage: '1d6+1d8', range: '12/24/48', isRanged: true, minStrength: 6, notes: '+2 para acertar a curta distância' },
  { key: 'smg', label: 'Submetralhadora', damage: '2d6', range: '12/24/48', ap: 1, isRanged: true, minStrength: 4, notes: 'Tiro rápido' }
] as const

// ─── Armaduras (Tabela básica) ───

export type ArmorDefinition = {
  key: string
  label: string
  armorValue: number
  minStrength?: DieType
  notes?: string
}

export const ARMORS: readonly ArmorDefinition[] = [
  { key: 'leather', label: 'Couro', armorValue: 1, minStrength: 4 },
  { key: 'chain_mail', label: 'Cota de Malha', armorValue: 2, minStrength: 6 },
  { key: 'plate_mail', label: 'Armadura de Placas', armorValue: 3, minStrength: 8, notes: '-2 Furtividade' },
  { key: 'small_shield', label: 'Escudo Pequeno', armorValue: 1, notes: '+1 Aparar' },
  { key: 'medium_shield', label: 'Escudo Médio', armorValue: 2, notes: '+2 Aparar, -2 para ser atingido à distância' },
  { key: 'large_shield', label: 'Escudo Grande', armorValue: 3, notes: '+2 Aparar, -4 para ser atingido à distância' },
  { key: 'kevlar_vest', label: 'Colete Kevlar', armorValue: 2, notes: 'Cobre apenas torso' },
  { key: 'tactical_vest', label: 'Colete Tático', armorValue: 4, minStrength: 6, notes: 'Cobre apenas torso' }
] as const

// ─── Ranks de Progressão ───

export type RankName = 'novato' | 'experiente' | 'veterano' | 'heroico' | 'lendario'

export const RANKS: readonly { key: RankName; label: string; advancesNeeded: number }[] = [
  { key: 'novato', label: 'Novato', advancesNeeded: 0 },
  { key: 'experiente', label: 'Experiente', advancesNeeded: 4 },
  { key: 'veterano', label: 'Veterano', advancesNeeded: 8 },
  { key: 'heroico', label: 'Heroico', advancesNeeded: 12 },
  { key: 'lendario', label: 'Lendário', advancesNeeded: 16 }
] as const

// ─── Helpers ───

export function defaultAttributes(): SWAttributes {
  return { agility: 4, smarts: 4, spirit: 4, strength: 4, vigor: 4 }
}

export function isDieType(value: number): value is DieType {
  return value === 4 || value === 6 || value === 8 || value === 10 || value === 12
}

const DIE_STEPS: readonly DieType[] = [4, 6, 8, 10, 12] as const

export function dieSteps(from: DieType): number {
  return DIE_STEPS.indexOf(from)
}

export function dieLabel(die: DieType): string {
  return `d${die}`
}
