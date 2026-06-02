# Fluxo do LLM na Narração

Documentação do pipeline de narração gerado pelo modelo de linguagem (LLM — *Large Language Model*) no backend do RPG Adaptável.

---

## Arquivos responsáveis

| Arquivo | Papel |
|---|---|
| [`backend/src/llm/narrator.ts`](../backend/src/llm/narrator.ts) | Interface `Narrator` e todos os tipos de requisição/resposta do narrador |
| [`backend/src/llm/gemini.adapter.ts`](../backend/src/llm/gemini.adapter.ts) | Implementação concreta `GeminiAdapter` — suporta Gemini e DeepSeek |
| [`backend/src/domain/types/narrative.ts`](../backend/src/domain/types/narrative.ts) | Tipos de saída: `NarratorTurnResponse`, `DiceCheck`, `ItemChange`, `StatusChange`, `NPCMention` |
| [`backend/src/services/contextBuilder.ts`](../backend/src/services/contextBuilder.ts) | Constrói `rulesDigest`, mapa de perícias e contexto dinâmico do turno |
| [`backend/src/core/trivial-action.ts`](../backend/src/core/trivial-action.ts) | Classifica ações triviais sem chamar o LLM |
| [`backend/src/utils/file-logger.ts`](../backend/src/utils/file-logger.ts) | Log de todas as requisições/respostas do LLM em disco |

---

## Providers suportados

Selecionado via variável de ambiente `LLM_PROVIDER`:

| Provider | Variáveis relevantes | Endpoint |
|---|---|---|
| **Gemini** (padrão) | `GEMINI_API_KEY`, `GEMINI_MODEL`, `GEMINI_BASE_URL` | `POST /v1beta/models/{model}:generateContent?key=…` |
| **DeepSeek** | `DEEPSEEK_API_KEY`, `DEEPSEEK_MODEL`, `DEEPSEEK_BASE_URL` | `POST /chat/completions` (compatível com OpenAI) |

---

## Operações disponíveis na interface `Narrator`

```ts
interface Narrator {
  narrateStart(req)          // Abertura de sessão — cena inicial + itens + opções
  narrateTurn(req)           // Turno normal — narra resultado da ação do jogador
  validateAction(req)        // Valida ação livre digitada pelo jogador
  summarize(req)             // Gera/atualiza resumo canônico de continuidade
  summarizeHistory(req)      // Compacta histórico de mensagens em resumo
  expandWorld(req)           // Expande história de campanha com worldbuilding
  expandAdventureStory(req)  // Alias de expandWorld
  expandWorldLore(req)       // Cria/expande lore profundo do universo
  generateImageDescription(req) // Descrição visual para geração de imagem
  suggestCharacterFromWorld(req) // Sugere ficha de personagem baseada no mundo
}
```

---

## Fluxo principal de narração

```
Jogador escolhe opção (ou digita ação livre)
        │
        ▼
[session.service.ts]  ──► validateAction()  ◄── só se ação livre (custom)
        │                  (classifyTrivialAction primeiro — sem LLM)
        │
        ▼
[rule-engine.ts / dice-engine.ts]
 Resolve dados, combate, efeitos, eventos
        │
        ▼
[contextBuilder.ts]
 Monta NarrateTurnRequest com:
  - Estado atual (local, ferimentos, inventário, NPCs)
  - Histórico recente: últimas 20 mensagens (multi-turn contents[])
  - rulesDigest (regras Savage Worlds)
  - summaryText (resumo canônico)
  - playerSkills (mapa de perícias)
        │
        ▼
[GeminiAdapter.narrateTurn()]
 1. Sanitiza histórico → ContentEntry[] (alternância user/model)
 2. Monta currentTurnPrompt (estado + ação + resultado mecânico)
 3. Chama generateNarratorResponse()
        │
        ▼
[generateNarratorResponse()]
 1. buildNarratorSystemPrompt() → systemInstruction
 2. Chama LLM (até 2 tentativas)
 3. parseJsonObjectDetailed() → tenta direct → fragment → repaired → regex
 4. sanitizeNarratorResponse() → valida e limpa campos
 5. isNarratorResponseStructurallyValid() → rejeita se inválido
        │
        ▼
NarratorTurnResponse → session.service.ts
  │
  ▼
[summary.service.ts]
 Após salvar a mensagem do narrador, compacta o excedente do histórico:
  - mantém as últimas 20 mensagens na sessão
  - junta resumo anterior + mensagens antigas em ordem cronológica
  - gera novo summaryText incremental via summarizeHistory()
  - remove apenas as mensagens já incorporadas ao resumo
  │
  ▼
session.service.ts → frontend
```

---

## Fluxo de início de sessão (`narrateStart`)

Chamado uma única vez ao criar/retomar sessão:

1. Monta `userPrompt` com dados do personagem (nome, raça, profissão, vantagens, complicações)
2. Instrui o LLM a criar cena de abertura + NPC inicial + **3 a 6 itens iniciais** (`changeType: "gained"`)
3. Usa `mode: 'start'` no system prompt — relaxa restrições de itens (`weapon` e `armor` são permitidos)
4. Delega para `generateNarratorResponse()` com `narrateStartMaxTokens`

---

## System Prompt do Narrador (`buildNarratorSystemPrompt`)

Composto dinamicamente pela função `buildNarratorSystemPrompt()`. Seções injetadas:

| Seção | Conteúdo | Quando |
|---|---|---|
| Regras fixas | Persona, formato JSON obrigatório, regras de `diceCheck` | Sempre |
| `=== UNIVERSO ===` | Nome, descrição e lore do mundo | Se o mundo tiver descrição/lore |
| `=== CAMPANHA ===` | Nome, temática e história da campanha | Se a campanha tiver texto |
| `=== REGRAS SAVAGE WORLDS ===` | Digest de mecânicas, vantagens, complicações | Via `rulesDigest` |
| `=== PERÍCIAS DO JOGADOR ===` | Mapa `{ Luta: "d8", Percepção: "d6", … }` | Via `playerSkills` |
| `=== RESUMO DA AVENTURA ===` | Resumo canônico gerado por `summarize()` | Via `summaryText` |
| Regras de modo | `REGRAS DE INÍCIO DE SESSÃO` ou `REGRAS DE TURNO CANÔNICO` | Depende de `mode` |
| `=== INSTRUÇÕES DE NARRAÇÃO ===` | Diretrizes de narrativa, âncoras canônicas | Sempre |

---

## Segmentos de narração e fala de NPC

Além de `narrative`, a resposta de narração pode incluir `segments` para apresentação visual no frontend:

```json
{
  "narrative": "Texto completo do turno em ordem.",
  "segments": [
    { "type": "narrator", "text": "Descrição da cena ou consequência." },
    { "type": "npc", "npcId": "npc-1", "npcName": "Iara", "disposition": "friendly", "text": "Fala direta do NPC." }
  ]
}
```

Regras:

- `narrative` continua obrigatório e é o texto completo usado para histórico, resumo e compatibilidade com mensagens antigas.
- `segments` é opcional e serve para renderização: narração fica como `type: "narrator"`; fala direta de NPC fica como `type: "npc"`.
- Segmentos de NPC devem usar um `npcId` presente na cena ou introduzido no mesmo retorno em `npcs`.
- O backend valida o NPC canônico antes de salvar. Se a fala apontar para NPC inexistente ou ambíguo, o bloco é convertido para narrador.
- Mensagens antigas sem `segments` continuam sendo exibidas a partir de `narrative`.

---

## Prompt do turno (user message final — `narrateTurn`)

```
TURNO DO JOGO — Narre a consequência da ação do jogador.

── ESTADO ATUAL ──
Local: <localização>
Ferimentos: N | Fadiga: N | Abalado: Sim/Não | Bennies: N

── INVENTÁRIO ──
- <item> (xQTD): <desc>
…

── EFEITOS ATIVOS ──
- <efeito> (<N> turnos)
…

── NPCs PRESENTES ──
- <nome> (<id>) [Wild Card|Extra, hostile|neutral|friendly, Res N, Aparar N | ferido N/N]
…

── NPCs DERROTADOS (não referenciar como ameaças) ──
<id1>, <id2>

── AÇÃO DO JOGADOR ──
Tipo: <trait_test|attack|travel|custom|flag>
Descrição: <texto>

── RESULTADO MECÂNICO ──
[DICE_ROLL] { ... }
[DAMAGE] { ... }
…
```

---

## Prompt de início de sessão (user message — `narrateStart`)

```
INÍCIO DE SESSÃO — Narre a abertura desta aventura de RPG.

PERSONAGEM: <nome>
Raça: <raça>
Gênero: <gênero>
Profissão: <profissão>
Descrição: <desc>
Vantagens: <edge1>, <edge2>
Complicações: <hindrance1 (maior)>, <hindrance2 (menor)>

Crie uma abertura imersiva e envolvente que introduza o personagem neste mundo.
Descreva a cena inicial, o ambiente, e apresente um gancho narrativo que motive a ação.
Inclua pelo menos 1 NPC na cena (pode ser um mercador, guarda, viajante, etc.).
Ofereça 4 opções variadas de ação para o jogador começar sua aventura.
Para CADA opção, avalie se ela exige um teste de dados (diceCheck) conforme as regras de Savage Worlds.

ITENS INICIAIS (OBRIGATÓRIO):
Retorne em "itemChanges" de 3 a 6 itens iniciais com changeType "gained" …
```

---

## Prompt de validação de ação (`validateAction`)

```
AÇÃO DO JOGADOR: "<texto livre>"

── CONTEXTO DA CENA ──
Local: <local>
Ferimentos: N | Fadiga: N | Abalado: sim/não | Bennies: N
NPCs presentes: <nome> (<id>) [Wild Card, hostile, Res N, Aparar N]
NPCs derrotados: …
Inventário: <item> (xN), …
Efeitos ativos: <efeito>
Perícias do jogador: Luta: d8, Percepção: d6, …

REGRAS: <rulesDigest>
RESUMO: <summaryText>

── ÚLTIMAS MENSAGENS ──
Narrador: …
Jogador: …

Valide a ação e retorne o JSON.
```

---

## Prompt de resumo (`summarize`)

**System prompt:**
```
Você mantém o resumo canônico de continuidade de uma sessão de RPG Savage Worlds.
Objetivo: gerar um resumo curto, útil para contexto do próximo turno e também para exibição ao jogador.
Regras:
- Escreva em parágrafos corridos, sem títulos, rótulos ou seções.
- Use 1 a 3 parágrafos curtos — apenas as informações que ainda importam para a continuação da história.
- Preserve apenas fatos que mudam a continuação imediata da história.
- Não reconte a cena passo a passo, não descreva golpes, quedas, explosões ou mortes antigas a menos que continuem relevantes agora.
- Itens ganhos, inimigos mortos e feitos do personagem só entram se ainda alterarem risco, recursos, posição ou objetivo imediato.
- Preserve nomes próprios e contagens relevantes quando elas afetarem a próxima decisão.
- Não use markdown, bullets, prefácio, saudação ou comentários metalinguísticos.
```

**User prompt (estrutura):**
```
Turno atual: N.
Resumo anterior canônico: <texto>.
Local atual: <local>.
<combatText> | Ferimentos: N/N. Fadiga: N. Abalado: sim/não. Bennies: N.
Ameaças visíveis: <npcs hostis>
Recursos carregados: <inventário resumido>
Forças/NPCs relevantes no local: <npcs>
Efeitos ativos: <efeitos>
Flags de mundo ativas: <flags>
Eventos novos (JSON): [...]
Narrativa recente (preserve detalhes específicos):
  [narrador T5] …
  [jogador T5] …
Atualize o resumo canônico sem repetir fatos antigos que já estejam cobertos.
```

---

## Prompt de sugestão de personagem (`suggestCharacterFromWorld`)

**System prompt:**
```
Você é um designer de personagens para RPG.
Leia o enredo fornecido e crie um personagem cujo papel e profissão emergem naturalmente da história.
Responda SOMENTE em JSON válido, sem markdown e sem comentários.
Formato obrigatório do JSON: todas as 6 chaves devem existir; `gender` e `race` podem ser string vazia quando o contexto não sustentar uma inferência.
{
  "name": "<nome coerente com o contexto>",
  "gender": "<Masculino, Feminino, Outro ou vazio se não houver pista contextual>",
  "race": "<raça/espécie ou vazio se não houver pista contextual>",
  "profession": "<profissão ou ofício derivado do enredo>",
  "description": "<2 ou 3 frases descrevendo aparência, equipamento e motivação>",
  "campaignRole": "<missão ou conexão concreta com a aventura>"
}
```

**User prompt:**
```
[Campos já preenchidos pelo jogador, se houver]
Lore do universo: <lore>.
Temática da aventura: <thematic>.
História da aventura: <storyDescription>.
```

---

## Formato de resposta esperada do narrador (JSON)

```json
{
  "narrative": "Texto narrativo imersivo em 2-3 parágrafos curtos.",
  "options": [
    {
      "id": "<uuid>",
      "text": "Descrição curta da opção",
      "actionType": "custom|trait_test|attack|travel|flag",
      "actionPayload": { "input": "…" },
      "requiredItems": [],
      "feasible": true,
      "feasibilityReason": "",
      "diceCheck": {
        "required": true,
        "skill": "Percepção",
        "attribute": null,
        "modifier": 0,
        "tn": 4,
        "reason": "Justificativa narrativa"
      }
    }
  ],
  "npcs": [
    { "id": "<uuid>", "name": "Nome", "disposition": "hostile|neutral|friendly", "newlyIntroduced": true }
  ],
  "itemChanges": [
    { "itemId": "<uuid>", "name": "Item", "quantity": 1, "changeType": "gained|lost|used", "category": "weapon|armor|consumable|ammunition|vehicle|property|quest|misc" }
  ],
  "statusChanges": [
    { "effectId": "<uuid>", "name": "Efeito", "changeType": "applied|removed", "turnsRemaining": 3, "description": "…" }
  ],
  "locationChange": "Nova localização ou null",
  "chapterTitle": "Título do capítulo ou null"
}
```

> **Regra:** `options` deve ter **exatamente 4** itens. Toda opção deve ter `diceCheck` preenchido.

---

## Retry e fallback

| Situação | Comportamento |
|---|---|
| `finishReason === MAX_TOKENS` | Tenta novamente (tentativa 2 com temperatura reduzida e system prompt de correção) |
| JSON inválido / sem `direct` ou `fragment` | Tenta novamente |
| Validação estrutural falha (`isNarratorResponseStructurallyValid`) | Tenta novamente |
| 2 tentativas falharam (`narrateTurn`) | Retorna `isFallback: true` com resposta genérica sem LLM |
| 2 tentativas falharam (`narrateStart`) | Retorna `isFallback: true` com abertura genérica baseada na temática |
| `validateAction` falha no parse | Permite ação como `custom` sem bloqueio |

### System prompt de correção (tentativa 2)

```
=== CORREÇÃO OBRIGATÓRIA ===
- A resposta anterior foi rejeitada por estar incompleta, truncada ou não canônica.
- Retorne JSON completo e autoconsistente.
- Não use entidades fora do contexto estruturado.
- Não omita options, diceCheck ou actionPayload obrigatórios.
- Se tiver dúvida sobre mutações de estado, deixe npcs, itemChanges, statusChanges e locationChange vazios/null.
```

---

## Parâmetros de temperatura por operação

| Operação | Gemini (padrão) | DeepSeek |
|---|---|---|
| `narrateStart` | 0.25 | 0.25 |
| `narrateTurn` | 0.20 | 0.20 |
| `summarize` | 0.20 | 0.15 |
| `summarizeHistory` | 0.15 | 0.10 |
| `suggestCharacterFromWorld` | 1.0 | 1.0 |
| `validateAction` | 0.20 | 0.20 |
| `generateImageDescription` | 0.55 | 0.55 |
| `expandWorld` / `expandWorldLore` | valor padrão | valor padrão |

> **Nota de mudança (junho 2026)**: Temperaturas de narração foram reduzidas (narrateStart: 0.50→0.25, narrateTurn: 0.45→0.20) para aumentar determinismo e reduzir variabilidade em `itemChanges` especulativos. Temperatura de retry foi ajustada para mínimo 0.10 (antes: 0.05) para evitar respostas robóticas demais na segunda tentativa.

---

## Regras de `itemChanges` — Enfoque em Evidência Mecânica

**🔴 Regra crítica**: O narrador (LLM) SÓ deve incluir `itemChanges` quando o **RESULTADO MECÂNICO** contém evidência **EXPLÍCITA** da mudança.

### Evidências válidas que justificam `itemChanges`:

- `[item_gained]` — Jogador recebeu item (encontrado, comprado, saqueado, entregue)
- `[item_lost]` — Jogador perdeu item (morreu NPC que dava item, ação falhou e perdeu item comprometido)
- `[item_used]` — Jogador usou consumível (poção, munição especial, item único)
- `[ammunition_consumed]` — Munição foi consumida em ataque bem-sucedido
- `[damage_dealt]` — Dano foi registrado (pode afetar armas com durabilidade)

### Evidências **inválidas** (sem itemChanges):

❌ Jogador apenas **menciona** que vai usar um item ("Vou oferecer 20 dólares") — sem evento mecânico  
❌ Jogador fala de descartar algo — sem evento `[item_lost]` do engine  
❌ Narrador especula sobre mudança de inventário — sem evidência no RESULTADO MECÂNICO  
❌ NPC suggere transação — sem confirmação mecânica de sucesso

### Consequência:

Quando há dúvida, o narrador deixa `itemChanges` vazio `[]`. O engine mecânico é responsável por rastrear mudanças reais de inventário. O narrador apenas **relata** mudanças que já foram confirmadas mecanicamente.

---

## Variáveis de ambiente relevantes

```dotenv
LLM_PROVIDER="gemini"               # ou "deepseek"

# Gemini
GEMINI_API_KEY="…"
GEMINI_MODEL="gemini-2.5-flash"
GEMINI_BASE_URL="https://generativelanguage.googleapis.com"
GEMINI_TEMPERATURE="0.3"
GEMINI_MAX_OUTPUT_TOKENS="8192"
GEMINI_NARRATE_START_MAX_TOKENS="16384"
GEMINI_NARRATE_TURN_MAX_TOKENS="16384"
GEMINI_TIMEOUT_MS="90000"
GEMINI_NARRATOR_TIMEOUT_MS="120000"

# DeepSeek
DEEPSEEK_API_KEY="…"
DEEPSEEK_MODEL="deepseek-chat"
DEEPSEEK_BASE_URL="https://api.deepseek.com"
DEEPSEEK_TEMPERATURE="0.3"
DEEPSEEK_MAX_OUTPUT_TOKENS="8192"   # limitado a 8192 pelo provider
DEEPSEEK_NARRATE_START_MAX_TOKENS="16384"
DEEPSEEK_NARRATE_TURN_MAX_TOKENS="16384"
DEEPSEEK_TIMEOUT_MS="90000"
DEEPSEEK_NARRATOR_TIMEOUT_MS="120000"
```
