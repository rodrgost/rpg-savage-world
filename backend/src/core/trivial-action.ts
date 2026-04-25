// ─── Classificador de Ações Triviais ───
//
// Detecta ações *inequivocamente* triviais independente de contexto de cena.
// Quando uma ação se encaixa aqui, nenhum teste de dados é necessário e a
// chamada à LLM para validateAction pode ser ignorada.
//
// CRITÉRIO DE INCLUSÃO — a ação deve ser trivial em QUALQUER cenário razoável:
//   - Atender um telefone/chamada
//   - Sentar, deitar, levantar-se
//   - Acenar, cumprimentar com gesto
//   - Pressionar um botão óbvio/ligar um aparelho simples
//   - Verificar a hora/relógio/inventário
//
// EXCLUÍDOS deliberadamente (contexto importa):
//   - "Abrir a porta" → pode estar trancada (Ladinagem)
//   - "Pular" → pode ser um abismo (Atletismo)
//   - "Conversar" → pode exigir Persuasão dependendo do NPC

type TrivialResult =
  | { trivial: true; reason: string }
  | { trivial: false }

/** Normaliza o input para matching case-insensitive sem acentos. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
}

type TrivialPattern = {
  /** Regex testada contra o input normalizado */
  pattern: RegExp
  /** Motivo narrativo curto para preencher diceCheck.reason */
  reason: string
}

const TRIVIAL_PATTERNS: TrivialPattern[] = [
  // Telefone / chamada
  {
    pattern: /\b(atender|pegar|responder|receber)\b.{0,30}\b(telefone|celular|chamada|ligacao|ligação|fone)\b/,
    reason: 'Atender uma chamada é uma ação automática'
  },
  {
    pattern: /\b(ligar|fazer|dar)\b.{0,30}\b(uma ligacao|uma ligação|um telefonema|para alguem|para alguém)\b/,
    reason: 'Fazer uma ligação é uma ação automática'
  },

  // Sentar / deitar / levantar-se / ficar de pé
  {
    pattern: /\b(sentar|sentar-se|me sentar|se sentar)\b/,
    reason: 'Sentar é uma ação automática'
  },
  {
    pattern: /\b(deitar|deitar-se|me deitar|se deitar|deitar no chao|deitar no chão)\b/,
    reason: 'Deitar é uma ação automática'
  },
  {
    pattern: /\b(levantar-se|levantar me|me levantar|se levantar|ficar de pe|ficar de pé)\b/,
    reason: 'Levantar-se é uma ação automática'
  },

  // Cumprimentos e gestos
  {
    pattern: /^(acenar|dar tchau|acenar de despedida|cumprimentar com gesto|acenar com a mao|acenar com a mão)$/,
    reason: 'Gesto simples de cumprimento'
  },
  {
    pattern: /\b(dar (um )?(oi|ola|olá|bom dia|boa tarde|boa noite|ate logo|até logo|tchau))\b/,
    reason: 'Cumprimento simples e automático'
  },

  // Verificar hora / relógio / data
  {
    pattern: /\b(verificar|ver|checar|olhar)\b.{0,20}\b(as horas|a hora|o relogio|o relógio|o horario|o horário|a data)\b/,
    reason: 'Verificar a hora é automático'
  },
  {
    pattern: /\b(que horas sao|que horas são|ver horas)\b/,
    reason: 'Verificar a hora é automático'
  },

  // Verificar inventário / bolsos / mochila (sem busca furtiva)
  {
    pattern: /\b(verificar|checar|olhar|examinar)\b.{0,25}\b(meu inventario|meu inventário|minha mochila|meus bolsos|meus itens|meu equipamento)\b/,
    reason: 'Verificar o próprio inventário é automático'
  },

  // Ligar / desligar aparelho simples
  {
    pattern: /\b(ligar|desligar|acender|apagar)\b.{0,20}\b(a luz|as luzes|o computador|o laptop|o notebook|a lanterna|a televisao|a televisão|a tv)\b/,
    reason: 'Operar um aparelho simples é automático'
  },
  {
    pattern: /\b(apertar|pressionar|clicar)\b.{0,20}\b(o botao|o botão|o interruptor|a chave)\b/,
    reason: 'Pressionar um botão simples é automático'
  },

  // Beber / comer item já em mãos (sem busca)
  {
    pattern: /\b(beber|tomar|ingerir)\b.{0,20}\b(a agua|a água|o remedio|o remédio|a pocao|a poção|o veneno)\b/,
    reason: 'Consumir um item que já está em mãos é automático'
  },
  {
    pattern: /\b(comer|devorar|mastigar)\b.{0,20}\b(a comida|o alimento|a racao|a ração|o biscoito|o pao|o pão)\b/,
    reason: 'Comer algo que já está em mãos é automático'
  },

  // Respirar / descansar (explícito)
  {
    pattern: /\b(respirar fundo|tomar folego|tomar fôlego|descansar um momento|sentar para descansar)\b/,
    reason: 'Descanso breve não requer teste'
  }
]

/**
 * Classifica se uma ação do jogador é trivialmente óbvia e não requer
 * nenhum teste de dados, independente do contexto de cena.
 *
 * @returns `{ trivial: true, reason }` se for trivial, `{ trivial: false }` caso contrário.
 */
export function classifyTrivialAction(input: string): TrivialResult {
  const normalized = normalize(input)

  for (const { pattern, reason } of TRIVIAL_PATTERNS) {
    if (pattern.test(normalized)) {
      return { trivial: true, reason }
    }
  }

  return { trivial: false }
}
