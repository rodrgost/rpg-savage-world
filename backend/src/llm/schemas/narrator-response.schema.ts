/**
 * Schema de saída estruturada para o turno do Narrador (Gemini responseSchema).
 *
 * Formato: subconjunto OpenAPI aceito pela API Gemini (REST v1beta,
 * generationConfig.responseSchema). Os nomes de `type` seguem a convenção do
 * proto Schema do Gemini (UPPERCASE: "OBJECT", "ARRAY", "STRING", ...).
 *
 * IMPORTANTE (a verificar na doc atual do modelo em uso):
 *  - Nem todo keyword do JSON Schema é honrado. Aqui usamos apenas:
 *    type, properties, items, required, enum, nullable, propertyOrdering.
 *  - Evitamos `additionalProperties`, `minItems`/`maxItems`, `anyOf` e
 *    condicionais — suporte irregular entre versões. A regra "exatamente 4
 *    opções" continua no prompt e é garantida na sanitização.
 *  - `actionPayload` é um objeto de chaves variáveis; como o Gemini exige
 *    `properties` em OBJECT, enumeramos todas as chaves conhecidas (todas
 *    opcionais). Aliases e campos extras são tratados na sanitização.
 *
 * O sanitizeNarratorResponse permanece a fonte de verdade do contrato: este
 * schema só reduz a probabilidade de JSON malformado, não substitui a validação.
 */
export const NARRATOR_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: 'OBJECT',
  properties: {
    narrative: {
      type: 'STRING',
      description: 'Texto narrativo completo deste passo da história (PT-BR, 2ª pessoa do singular).'
    },
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
      description: 'Exatamente 4 opções de ação para o jogador.',
      items: {
        type: 'OBJECT',
        properties: {
          id: { type: 'STRING' },
          text: { type: 'STRING' },
          actionType: { type: 'STRING', enum: ['custom', 'trait_test', 'attack', 'travel', 'flag', 'heal'] },
          actionPayload: {
            type: 'OBJECT',
            description: 'Campos parciais para montar a ação mecânica (todos opcionais). Dano/AP NÃO são informados aqui — o app os resolve pela arma equipada.',
            properties: {
              skill: { type: 'STRING', nullable: true },
              attribute: { type: 'STRING', nullable: true },
              targetId: { type: 'STRING', nullable: true },
              to: { type: 'STRING', nullable: true },
              input: { type: 'STRING', nullable: true }
            },
            propertyOrdering: ['skill', 'attribute', 'targetId', 'to', 'input']
          },
          requiredItems: { type: 'ARRAY', items: { type: 'STRING' } },
          feasible: { type: 'BOOLEAN' },
          feasibilityReason: { type: 'STRING', nullable: true },
          diceCheck: {
            type: 'OBJECT',
            properties: {
              required: { type: 'BOOLEAN' },
              skill: { type: 'STRING', nullable: true },
              attribute: { type: 'STRING', nullable: true },
              difficulty: { type: 'STRING', enum: ['normal', 'dificil', 'extremo'], nullable: true },
              reason: { type: 'STRING' }
            },
            required: ['required', 'reason'],
            propertyOrdering: ['required', 'skill', 'attribute', 'difficulty', 'reason']
          }
        },
        required: ['text', 'actionType', 'feasible', 'diceCheck'],
        propertyOrdering: ['id', 'text', 'actionType', 'actionPayload', 'requiredItems', 'feasible', 'feasibilityReason', 'diceCheck']
      }
    },
    npcs: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          // `id` é opcional: para NPCs já presentes, copie o id (hash) listado em
          // PRESENT NPCS; para novos NPCs, o sistema gera o id a partir do displayName.
          id: { type: 'STRING', nullable: true },
          displayName: { type: 'STRING' },
          disposition: { type: 'STRING', enum: ['hostile', 'neutral', 'friendly'] },
          newlyIntroduced: { type: 'BOOLEAN' },
          status: { type: 'STRING', enum: ['active', 'incapacitated', 'defeated', 'dead'], nullable: true }
        },
        required: ['displayName', 'disposition', 'newlyIntroduced'],
        propertyOrdering: ['id', 'displayName', 'disposition', 'newlyIntroduced', 'status']
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
          category: {
            type: 'STRING',
            enum: ['weapon', 'armor', 'consumable', 'ammunition', 'money', 'vehicle', 'property', 'quest', 'misc']
          }
        },
        required: ['name', 'quantity', 'changeType', 'category'],
        propertyOrdering: ['itemId', 'name', 'quantity', 'changeType', 'category']
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
  required: ['narrative', 'options'],
  propertyOrdering: ['narrative', 'segments', 'options', 'npcs', 'itemChanges', 'statusChanges', 'npcAttacks', 'outcomeOverride']
}
