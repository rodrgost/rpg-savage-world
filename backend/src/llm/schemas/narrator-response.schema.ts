

export const NARRATOR_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: 'OBJECT',
  properties: {
    segments: {
      type: 'ARRAY',
      description: 'Narração e falas divididas em segmentos.',
      items: {
        type: 'OBJECT',
        properties: {
          type: { type: 'STRING', enum: ['narrator', 'npc'] },
          text: { type: 'STRING' },
          npcId: { type: 'STRING', nullable: true },
          npcName: { type: 'STRING', nullable: true },
          npcDisplayName: { type: 'STRING', nullable: true },
          disposition: { type: 'STRING', enum: ['hostile', 'neutral', 'friendly'], nullable: true }
        },
        required: ['type', 'text'],
        propertyOrdering: ['type', 'npcId', 'npcName', 'npcDisplayName', 'disposition', 'text']
      }
    },
    options: {
      type: 'ARRAY',
      description: 'Exatamente 4 opções de ação para o jogador — todas devem ser realmente executáveis agora.',
      items: {
        type: 'OBJECT',
        properties: {
          text: { type: 'STRING' },
          actionType: { type: 'STRING', enum: ['custom', 'trait_test', 'attack', 'travel', 'flag', 'heal'] },
          actionPayload: {
            type: 'OBJECT',
            description: 'Campos parciais para montar a ação mecânica (todos opcionais). Dano/AP NÃO são informados aqui — o app os resolve pela arma equipada. Perícia/atributo NÃO vão aqui — use diceCheck.traco.',
            properties: {
              targetId: { type: 'STRING', nullable: true },
              to: { type: 'STRING', nullable: true },
              input: { type: 'STRING', nullable: true }
            },
            propertyOrdering: ['targetId', 'to', 'input']
          },
          diceCheck: {
            type: 'OBJECT',
            properties: {
              traco: {
                type: 'STRING',
                nullable: true,
                description: 'Nome da perícia ou habilidade — null se não houver.'
              },
              difficulty: { type: 'STRING', enum: ['facil', 'normal', 'dificil', 'extremo'], nullable: true },
              reason: { type: 'STRING' }
            },
            required: ['reason'],
            propertyOrdering: ['traco', 'difficulty', 'reason']
          }
        },
        required: ['text', 'actionType', 'diceCheck'],
        propertyOrdering: ['text', 'actionType', 'actionPayload', 'diceCheck']
      }
    },
    npcs: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          // `id` é opcional: para NPCs já presentes, copie o id (hash) listado em
          // NPCS PRESENTES; para novos NPCs, o sistema gera o id a partir do displayName.
          id: { type: 'STRING', nullable: true },
          displayName: { type: 'STRING' },
          disposition: { type: 'STRING', enum: ['hostile', 'neutral', 'friendly'] },
          newlyIntroduced: { type: 'BOOLEAN' },
          status: { type: 'STRING', enum: ['active', 'incapacitated', 'defeated', 'dead', 'left'], nullable: true },
          followsPlayer: { type: 'BOOLEAN', nullable: true },
          relation: {
            type: 'STRING',
            enum: ['conhecido', 'aliado', 'amigavel', 'neutro', 'desconfiado', 'hostil', 'inimigo'],
            nullable: true,
            description: 'Relação do NPC com o personagem do jogador — preencher SOMENTE quando ela muda de forma significativa neste turno (traição, aliança, confiança/desconfiança conquistada). Caso contrário, omitir.'
          }
        },
        required: ['displayName', 'disposition', 'newlyIntroduced'],
        propertyOrdering: ['id', 'displayName', 'disposition', 'newlyIntroduced', 'status', 'followsPlayer', 'relation']
      }
    },
    itemChanges: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          itemId: { type: 'STRING' },
          name: { type: 'STRING' },
          quantity: { type: 'INTEGER' },
          changeType: { type: 'STRING', enum: ['gained', 'lost', 'used'] },
          description: {
            type: 'STRING',
            nullable: true,
            description: 'Descrição curta do que o item é / o que contém / para que serve. OBRIGATÓRIA para itens NÃO ÓBVIOS (artefatos, itens de missão, itens mágicos/tecnológicos, recipientes com conteúdo, itens com efeito ou uso especial). Omitir ou null para itens triviais e autoexplicativos (ex.: "Espada", "Maçã", "Moedas de Ouro").'
          },
          category: {
            type: 'STRING',
            enum: ['weapon', 'armor', 'consumable', 'ammunition', 'money', 'vehicle', 'property', 'quest', 'misc']
          },
          armorValue: {
            type: 'INTEGER',
            nullable: true,
            description: 'APENAS para category="armor" quando o item é vestido como armadura corporal: bônus de Resistência concedido (tipicamente 1 a 4). Omitir para itens que não são armadura corporal.'
          },
          parryBonus: {
            type: 'INTEGER',
            nullable: true,
            description: 'APENAS para category="armor" quando o item é um escudo/anteparo empunhado: bônus de Aparar concedido (tipicamente 1 a 2). Omitir para armadura corporal (sem parryBonus).'
          }
        },
        required: ['name', 'quantity', 'changeType', 'category'],
        propertyOrdering: ['itemId', 'name', 'quantity', 'changeType', 'description', 'category', 'armorValue', 'parryBonus']
      }
    },
    statusChanges: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          effectId: { type: 'STRING' },
          name: { type: 'STRING' },
          changeType: { type: 'STRING', enum: ['applied', 'removed'] },
          turnsRemaining: { type: 'INTEGER', nullable: true },
          description: { type: 'STRING' },
          targetType: { type: 'STRING', enum: ['player', 'npc'], nullable: true },
          targetId: { type: 'STRING', nullable: true }
        },
        required: ['name', 'changeType', 'description'],
        propertyOrdering: ['effectId', 'name', 'changeType', 'turnsRemaining', 'description', 'targetType', 'targetId']
      }
    },
    npcAttacks: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          npcId: { type: 'STRING' },
          // O responseSchema do Gemini só aceita `enum` em campos STRING;
          // enum numérico causa HTTP 400. Valores válidos (6, 8, 10, 12) são
          // garantidos na sanitização (sanitizeNarratorResponse).
          skillDie: { type: 'INTEGER', description: 'Dado de perícia do NPC. Valores válidos: 6, 8, 10 ou 12.' },
          damageFormula: { type: 'STRING' },
          ap: { type: 'INTEGER' }
        },
        required: ['npcId', 'skillDie', 'damageFormula', 'ap'],
        propertyOrdering: ['npcId', 'skillDie', 'damageFormula', 'ap']
      }
    },
    outcomeOverride: {
      type: 'OBJECT',
      nullable: true,
      description: 'Preencha SOMENTE quando o desfecho narrado divergir do resultado mecânico do dado. Caso contrário, omita ou use null.',
      properties: {
        mechanicalResult: { type: 'STRING', enum: ['success', 'failure'], description: 'Resultado mecânico produzido pelo dado.' },
        narratedOutcome: { type: 'STRING', enum: ['success', 'failure'], description: 'Desfecho efetivamente narrado (deve diferir de mechanicalResult).' },
        justification: { type: 'STRING', description: 'Causa explícita na ficção que justifica a inversão (interferência, imprevisto, sorte etc.).' }
      },
      required: ['mechanicalResult', 'narratedOutcome', 'justification'],
      propertyOrdering: ['mechanicalResult', 'narratedOutcome', 'justification']
    }
  },
  required: ['segments', 'options'],
  propertyOrdering: ['segments', 'options', 'npcs', 'itemChanges', 'statusChanges', 'npcAttacks', 'outcomeOverride']
}

/**
 * Schema de saída estruturada para validateAction (classificação de ação livre
 * digitada pelo jogador). Reaproveita o mesmo TRACO_ENUM fechado do narrador —
 * a LLM já resolve o traço aqui dentro do enum; não há mais sanitização/
 * inferência posterior (sanitizeValidateActionResponse foi removido). Se o
 * traco não vier ou não bater com o enum, a ação segue sem teste de dados.
 */
export const VALIDATE_ACTION_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: 'OBJECT',
  properties: {
    feasible: { type: 'BOOLEAN' },
    feasibilityReason: { type: 'STRING', nullable: true },
    actionType: { type: 'STRING', enum: ['custom', 'trait_test', 'attack', 'travel', 'flag'] },
    actionPayload: {
      type: 'OBJECT',
      description: 'Campos parciais para montar a ação mecânica (todos opcionais). Perícia NÃO vai aqui — use diceCheck.traco.',
      properties: {
        targetId: { type: 'STRING', nullable: true },
        to: { type: 'STRING', nullable: true },
        input: { type: 'STRING', nullable: true },
        key: { type: 'STRING', nullable: true }
      },
      propertyOrdering: ['targetId', 'to', 'input', 'key']
    },
    diceCheck: {
      type: 'OBJECT',
      nullable: true,
      properties: {
        traco: {
          type: 'STRING',
          nullable: true,
          description: 'Nome da perícia ou habilidade — null se não houver.'
        },
        difficulty: { type: 'STRING', enum: ['facil', 'normal', 'dificil', 'extremo'], nullable: true },
        reason: { type: 'STRING' }
      },
      required: ['reason'],
      propertyOrdering: ['traco', 'difficulty', 'reason']
    },
    interpretation: { type: 'STRING' }
  },
  required: ['feasible', 'actionType', 'actionPayload', 'interpretation'],
  propertyOrdering: ['feasible', 'feasibilityReason', 'actionType', 'actionPayload', 'diceCheck', 'interpretation']
}
