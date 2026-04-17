import { rollDice } from './dice-engine.js'

type Token =
  | { type: 'number'; value: number }
  | { type: 'ident'; value: string }
  | { type: 'op'; value: '+' | '-' | '*' | '/' }
  | { type: 'lparen' }
  | { type: 'rparen' }
  | { type: 'dice'; value: string }

function isAlpha(ch: string): boolean {
  return /[a-zA-Z_]/.test(ch)
}

function isAlnum(ch: string): boolean {
  return /[a-zA-Z0-9_]/.test(ch)
}

function tokenize(input: string): Token[] {
  const s = input.trim()
  const tokens: Token[] = []
  let i = 0

  while (i < s.length) {
    const ch = s[i]
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++
      continue
    }

    if (ch === '(') {
      tokens.push({ type: 'lparen' })
      i++
      continue
    }
    if (ch === ')') {
      tokens.push({ type: 'rparen' })
      i++
      continue
    }
    if (ch === '+' || ch === '-' || ch === '*' || ch === '/') {
      tokens.push({ type: 'op', value: ch })
      i++
      continue
    }

    if (/[0-9]/.test(ch) || ch.toLowerCase() === 'd') {
      let j = i
      while (j < s.length && /[0-9]/.test(s[j])) j++

      if (j < s.length && s[j].toLowerCase() === 'd') {
        j++
        while (j < s.length && /[0-9]/.test(s[j])) j++
        if (j < s.length && (s[j] === '+' || s[j] === '-')) {
          j++
          while (j < s.length && /[0-9]/.test(s[j])) j++
        }
        tokens.push({ type: 'dice', value: s.slice(i, j) })
        i = j
        continue
      }

      const numStr = s.slice(i, j)
      tokens.push({ type: 'number', value: Number(numStr) })
      i = j
      continue
    }

    if (isAlpha(ch)) {
      let j = i + 1
      while (j < s.length && isAlnum(s[j])) j++
      tokens.push({ type: 'ident', value: s.slice(i, j) })
      i = j
      continue
    }

    throw new Error(`Caractere inválido na fórmula: '${ch}'`)
  }

  return tokens
}

type AstNode =
  | { kind: 'num'; value: number }
  | { kind: 'var'; name: string }
  | { kind: 'dice'; spec: string }
  | { kind: 'bin'; op: '+' | '-' | '*' | '/'; left: AstNode; right: AstNode }
  | { kind: 'unary'; op: '+' | '-'; expr: AstNode }

class Parser {
  private pos = 0
  constructor(private readonly tokens: Token[]) {}

  parse(): AstNode {
    const expr = this.parseExpr()
    if (this.pos !== this.tokens.length) throw new Error('Tokens sobrando após parse')
    return expr
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos]
  }

  private eat(): Token {
    const t = this.tokens[this.pos]
    if (!t) throw new Error('Fim inesperado')
    this.pos++
    return t
  }

  private parseExpr(): AstNode {
    let node = this.parseTerm()
    while (true) {
      const t = this.peek()
      if (t?.type === 'op' && (t.value === '+' || t.value === '-')) {
        this.eat()
        const right = this.parseTerm()
        node = { kind: 'bin', op: t.value, left: node, right }
        continue
      }
      break
    }
    return node
  }

  private parseTerm(): AstNode {
    let node = this.parseFactor()
    while (true) {
      const t = this.peek()
      if (t?.type === 'op' && (t.value === '*' || t.value === '/')) {
        this.eat()
        const right = this.parseFactor()
        node = { kind: 'bin', op: t.value, left: node, right }
        continue
      }
      break
    }
    return node
  }

  private parseFactor(): AstNode {
    const t = this.peek()
    if (t?.type === 'op' && (t.value === '+' || t.value === '-')) {
      this.eat()
      const expr = this.parseFactor()
      return { kind: 'unary', op: t.value, expr }
    }
    return this.parsePrimary()
  }

  private parsePrimary(): AstNode {
    const t = this.eat()
    if (t.type === 'number') return { kind: 'num', value: t.value }
    if (t.type === 'ident') return { kind: 'var', name: t.value }
    if (t.type === 'dice') return { kind: 'dice', spec: t.value }
    if (t.type === 'lparen') {
      const inner = this.parseExpr()
      const close = this.eat()
      if (close.type !== 'rparen') throw new Error('Parênteses não fechado')
      return inner
    }
    throw new Error('Token inesperado')
  }
}

export type FormulaScope = Record<string, number>
export type EvalResult = {
  value: number
  rolls: Array<{ dice: string; total: number; rolls: number[] }>
}

export function evalFormula(formula: string, scope: FormulaScope, rng: () => number = Math.random): EvalResult {
  const tokens = tokenize(formula)
  const ast = new Parser(tokens).parse()
  const rolls: EvalResult['rolls'] = []

  function evalNode(node: AstNode): number {
    switch (node.kind) {
      case 'num':
        return node.value
      case 'var': {
        const v = scope[node.name]
        if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`Variável indefinida: ${node.name}`)
        return v
      }
      case 'dice': {
        const r = rollDice(node.spec, rng)
        rolls.push({ dice: node.spec, total: r.total, rolls: r.rolls })
        return r.total
      }
      case 'unary': {
        const v = evalNode(node.expr)
        return node.op === '-' ? -v : v
      }
      case 'bin': {
        const a = evalNode(node.left)
        const b = evalNode(node.right)
        switch (node.op) {
          case '+':
            return a + b
          case '-':
            return a - b
          case '*':
            return a * b
          case '/':
            return a / b
        }
      }
    }
  }

  return { value: evalNode(ast), rolls }
}
