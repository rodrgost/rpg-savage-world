/**
 * Schema de saída estruturada para o turno do Narrador (Gemini responseSchema).
 *
 * Formato: subconjunto OpenAPI aceito pela API Gemini (REST v1beta,
 * generationConfig.responseSchema). Os nomes de `type` seguem a convenção do
 * proto Schema do Gemini (UPPERCASE: "OBJECT", "ARRAY", "STRING", ...).
 *
 * O LLM narra livremente e decide por si mesmo o resultado das ações — sem
 * rolagem de dados, sem diceCheck, sem npcAttacks mecânicos.
 *
 * O sanitizeNarratorResponse permanece a fonte de verdade do contrato: este
 * schema só reduz a probabilidade de JSON malformado, não substitui a validação.
 */

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
          actionType: { type: 'STRING', enum: ['custom', 'travel', 'flag'] },
          actionPayload: {
            type: 'OBJECT',
            description: 'Campos parciais para montar a ação (todos opcionais).',
            properties: {
              to: { type: 'STRING', nullable: true },
              input: { type: 'STRING', nullable: true },
              key: { type: 'STRING', nullable: true }
            },
            propertyOrdering: ['to', 'input', 'key']
          }
        },
        required: ['text', 'actionType'],
        propertyOrdering: ['text', 'actionType', 'actionPayload']
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
            description: 'APENAS para category="armor" quando o item é vestido como armadura corporal: bônus de proteção concedido (tipicamente 1 a 4). Omitir para itens que não são armadura corporal.'
          },
          parryBonus: {
            type: 'INTEGER',
            nullable: true,
            description: 'APENAS para category="armor" quando o item é um escudo/anteparo empunhado: bônus de defesa concedido (tipicamente 1 a 2). Omitir para armadura corporal.'
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
    }
  },
  required: ['segments', 'options'],
  propertyOrdering: ['segments', 'options', 'npcs', 'itemChanges', 'statusChanges']
}

/**
 * Schema de saída estruturada para validateAction (classificação de ação livre
 * digitada pelo jogador). O LLM classifica a ação como custom, travel ou flag
 * sem inferência de perícia nem rolagem de dados.
 */
export const VALIDATE_ACTION_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: 'OBJECT',
  properties: {
    feasible: { type: 'BOOLEAN' },
    feasibilityReason: { type: 'STRING', nullable: true },
    actionType: { type: 'STRING', enum: ['custom', 'travel', 'flag'] },
    actionPayload: {
      type: 'OBJECT',
      description: 'Campos parciais para montar a ação (todos opcionais).',
      properties: {
        to: { type: 'STRING', nullable: true },
        input: { type: 'STRING', nullable: true },
        key: { type: 'STRING', nullable: true }
      },
      propertyOrdering: ['to', 'input', 'key']
    },
    interpretation: { type: 'STRING' }
  },
  required: ['feasible', 'actionType', 'actionPayload', 'interpretation'],
  propertyOrdering: ['feasible', 'feasibilityReason', 'actionType', 'actionPayload', 'interpretation']
}
