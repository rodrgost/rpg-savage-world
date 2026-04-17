type DiceSpec = { count: number; sides: number; modifier: number }

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
