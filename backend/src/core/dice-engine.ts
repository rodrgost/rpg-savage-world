import type { DieType } from '../domain/types/gameState.js'

// ─── Savage Worlds Dice Engine ───
// Acing Dice: se tirar o máximo, rola de novo e soma (exploding)
// Wild Die: Wild Cards rolam um d6 extra e ficam com o maior
// Trait Roll: dado da habilidade + wild die → maior resultado

const MAX_EXPLOSIONS = 20

type DiceSpec = { count: number; sides: number; modifier: number }

export type RollDetail = {
  sides: number
  rolls: number[]
  total: number
  aced: boolean
}

export type TraitRollResult = {
  traitRoll: RollDetail
  wildRoll: RollDetail | null
  finalTotal: number
  isSuccess: boolean
  raises: number
  modifier: number
}

export type DamageRollResult = {
  dice: RollDetail[]
  modifier: number
  total: number
}

function parseDice(dice: string): DiceSpec {
  const trimmed = dice.trim().toLowerCase()
  const m = /^([0-9]*)d([0-9]+)([+-][0-9]+)?$/.exec(trimmed)
  if (!m) throw new Error(`Dice inválido: ${dice}`)

  const count = m[1] ? Number(m[1]) : 1
  const sides = Number(m[2])
  const modifier = m[3] ? Number(m[3]) : 0

  if (!Number.isFinite(count) || count <= 0) throw new Error(`Dice count inválido: ${dice}`)
  if (!Number.isFinite(sides) || sides <= 1) throw new Error(`Dice sides inválido: ${dice}`)
  if (!Number.isFinite(modifier)) throw new Error(`Dice modifier inválido: ${dice}`)

  return { count, sides, modifier }
}

/** Rola um dado com Acing (Exploding Dice) */
export function rollExploding(sides: number, rng: () => number = Math.random): RollDetail {
  const rolls: number[] = []
  let total = 0
  let aced = false

  for (let i = 0; i < MAX_EXPLOSIONS; i++) {
    const r = Math.floor(rng() * sides) + 1
    rolls.push(r)
    total += r
    if (r === sides) {
      aced = true
    } else {
      break
    }
  }

  return { sides, rolls, total, aced }
}

/** Rola um Trait Roll (Savage Worlds core mechanic) */
export function rollTrait(
  dieSides: DieType,
  isWildCard: boolean,
  modifier: number = 0,
  rng: () => number = Math.random
): TraitRollResult {
  const traitRoll = rollExploding(dieSides, rng)
  let wildRoll: RollDetail | null = null

  if (isWildCard) {
    wildRoll = rollExploding(6, rng)
  }

  const bestRoll = wildRoll ? Math.max(traitRoll.total, wildRoll.total) : traitRoll.total
  const finalTotal = bestRoll + modifier

  return {
    traitRoll,
    wildRoll,
    finalTotal,
    isSuccess: finalTotal >= 4,
    raises: countRaises(finalTotal),
    modifier
  }
}

/** Rola dano no formato Savage Worlds (ex: 'str+d6', '2d6+1', 'd8') */
export function rollDamage(
  damageFormula: string,
  strengthDie: DieType = 4,
  rng: () => number = Math.random
): DamageRollResult {
  const dice: RollDetail[] = []
  let modifier = 0

  // Normaliza a formula
  const normalized = damageFormula.trim().toLowerCase().replace(/\s+/g, '')

  // Separa tokens por + ou - preservando sinal
  const tokens = normalized.match(/[+-]?[^+-]+/g) ?? [normalized]

  for (const token of tokens) {
    const clean = token.trim()

    if (clean === 'str' || clean === '+str') {
      // Dado de Força: cada dado explode individualmente
      dice.push(rollExploding(strengthDie, rng))
    } else if (clean === '-str') {
      const roll = rollExploding(strengthDie, rng)
      dice.push({ ...roll, total: -roll.total })
    } else if (/^[+-]?\d*d\d+/.test(clean)) {
      // Notação de dados: 2d6, d8, +1d6, etc.
      const sign = clean.startsWith('-') ? -1 : 1
      const spec = parseDice(clean.replace(/^[+-]/, ''))
      for (let i = 0; i < spec.count; i++) {
        const roll = rollExploding(spec.sides, rng)
        dice.push(sign < 0 ? { ...roll, total: -roll.total } : roll)
      }
      modifier += spec.modifier * sign
    } else {
      // Modificador numérico
      const num = Number(clean)
      if (Number.isFinite(num)) modifier += num
    }
  }

  const total = dice.reduce((sum, d) => sum + d.total, 0) + modifier
  return { dice, modifier, total }
}

/** Verifica se total >= 4 (Target Number padrão do SW) */
export function isSuccess(total: number, tn: number = 4): boolean {
  return total >= tn
}

/** Conta quantos Raises (cada +4 acima do TN) */
export function countRaises(total: number, tn: number = 4): number {
  if (total < tn) return 0
  return Math.floor((total - tn) / 4)
}

/** Rola dados simples (compatibilidade) */
export function rollDice(dice: string, rng: () => number = Math.random): { total: number; rolls: number[] } {
  const spec = parseDice(dice)
  const rolls: number[] = []

  for (let i = 0; i < spec.count; i++) {
    const r = Math.floor(rng() * spec.sides) + 1
    rolls.push(r)
  }

  const total = rolls.reduce((a, b) => a + b, 0) + spec.modifier
  return { total, rolls }
}
