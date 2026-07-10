# Plano — Mover as regras de Savage Worlds do LLM para o app

> Status: **planejamento** (nenhuma alteração de código foi feita). Objetivo: o LLM
> passa a **classificar a intenção** e **narrar**; o app passa a **decidir e calcular
> toda a mecânica** (perícia, TN, modificadores, dano, AP, viabilidade).

## 1. Diagnóstico — o que hoje é regra no LLM vs. no app

O motor de regras já existe e já faz a resolução real das rolagens:

- `core/dice-engine.ts` — rolagem de traço (com Wild Die), dano, contagem de aumentos.
- `core/rule-engine.ts` — `applyAction` / `applyNpcAttack`: TN base 4, penalidade de
  ferimento, bônus de Edges/Hindrances, dano vs. Resistência, Atordoado/Ferimentos,
  Soak, Wild Card × Extra, etc.
- `domain/savage-worlds/constants.ts` — tabelas fixas já presentes: `SKILLS`, `EDGES`,
  `HINDRANCES`, `WEAPONS`, `ARMORS`, `calcParry`, `calcToughness`, `calcPace`.
- `core/trivial-action.ts` — classificador de ações triviais (dispensa teste).

Ou seja: **a parte "rolar os dados" já está no app.** O que ainda está delegado ao
LLM é a parte de **decidir a mecânica de cada opção**, embutida no campo `diceCheck` e
em `actionPayload` de cada uma das 4 opções, mais um bloco grande de regras no prompt.

O que o LLM ainda decide hoje (e que este plano quer remover dele):

| Campo decidido pelo LLM hoje | Onde | Natureza |
|---|---|---|
| `diceCheck.required` (precisa rolar?) | options[] | Regra (parcialmente fixa) |
| `diceCheck.skill` / `diceCheck.attribute` | options[] | Mapeamento ação→traço (fixo) |
| `diceCheck.modifier` (-2 / -4 / +2) | options[] | Misto: fixo + julgamento |
| `diceCheck.tn` (4 / 6 / 8) | options[] | Misto: base fixa + julgamento |
| `actionPayload.damageFormula` | options[] | Fixo (vem da arma/`WEAPONS`) |
| `actionPayload.ap` | options[] | Fixo (vem da arma) |
| `actionPayload.targetId` | options[] | Identificação de alvo (fica no LLM) |
| ~~`feasible` / `requiredItems`~~ | options[] | Removido — ver nota abaixo |
| `npcAttacks[].skillDie` / `damageFormula` / `ap` | resposta | Fixo (vem do NPC/arma) |
| Bloco de regras SW no prompt | `gemini.adapter.ts` (~1947–2011 e outros) | Fixo |

A consequência prática do estado atual: o LLM pode produzir um `damageFormula`, um `tn`
ou um `modifier` divergente das regras, e esse valor é repassado ao `rule-engine` por
`buildActionFromOption` (`session.service.ts` ~1520). Há sanitização, mas a **fonte da
verdade mecânica ainda é, em parte, o texto do modelo.**

## 2. Princípio de design alvo

- **LLM**: ficção + intenção. Diz *o que o jogador quer fazer* e *contra quem/o quê*,
  num vocabulário pequeno e estável. Narra o desfecho **a partir** dos eventos que o
  motor já calculou (isso já acontece via `engineEvents` em `narrateTurn`).
- **App**: toda a mecânica. Dado a intenção + o estado (personagem, NPC, cena, itens),
  o app resolve perícia, atributo, TN, modificadores, fórmula de dano, AP, viabilidade
  e penalidades — usando as tabelas fixas que já existem.

## 3. Nova fronteira de contrato (o que o LLM passa a devolver)

Reduzir `diceCheck` + `actionPayload` a um **descritor de intenção** enxuto. Proposta de
campos por opção (nomes a confirmar na implementação):

- `actionType`: `custom | trait_test | attack | travel | heal | flag` (mantém).
- `intent`: enum estável de *propósito* da ação, ex.: `perceive`, `sneak`, `persuade`,
  `intimidate`, `climb_or_jump`, `pick_lock`, `investigate`, `occult_knowledge`,
  `resist_fear`, `resist_poison`, `melee_attack`, `ranged_attack`, `heal`, `talk`,
  `move`. O app mapeia `intent → perícia/atributo` (substitui `diceCheck.skill`).
- `targetRef`: referência do alvo (id de NPC presente) — permanece no LLM, pois é
  identificação narrativa, não cálculo.
- `difficulty` (opcional): enum **limitado** `trivial | normal | hard | extreme`, em vez
  de o LLM cuspir `tn`/`modifier` numéricos. O app converte para o modificador fixo
  (ex.: `hard → −2`, `extreme → −4`) sobre o TN base 4. Ver ressalva na seção 8.

O que **sai** do contrato do LLM: `tn`, `modifier` numérico, `damageFormula`, `ap`,
`skillDie` de NPC. Tudo isso passa a ser derivado pelo app.

## 4. O que o app passa a calcular

Camada nova (sugestão: `core/action-resolver.ts`) entre a opção escolhida e o
`rule-engine`, responsável por, a partir de `intent` + estado:

1. **Precisa de teste?** combinar `trivial-action.ts` + a tabela de intents (algumas
   intents são sempre narrativas, ex.: `talk`, `move`).
2. **Perícia/atributo**: `intent → traço` via tabela fixa, resolvendo o dado real com
   `resolveSkillDie` (já existe).
3. **TN e modificador**: TN base 4 (regra fixa). `difficulty` → modificador fixo. As
   penalidades de ferimento, Edges e Hindrances **já** são aplicadas dentro do
   `rule-engine` (`woundPenalty`, `traitEdgeHindranceBonus`) — não duplicar.
4. **Fórmula de dano / AP** (ataques): derivar da arma equipada via catálogo `WEAPONS`
   em vez de aceitar string do LLM. Hoje a arma do jogador não está totalmente ligada à
   fórmula — **lacuna a fechar** (ver seção 6).
5. **Ataques de NPC**: `skillDie`, `damageFormula`, `ap` vêm de `NpcDefinition` /
   `NPCCombatant` (já têm `attackSkillDie`, `damageFormula`, `ap`) e do catálogo, não do
   LLM.
6. **Viabilidade**: `feasible`/`feasibilityReason`/`requiredItems` foram **removidos** de
   `ActionOption` (mantidos só em `ValidateActionResponse`, usado pela ação livre em texto
   via `validateAction`). Para as 4 opções do narrador, a regra passou a ser preventiva no
   prompt ("AGÊNCIA REAL"): o LLM não deve oferecer uma opção que sabe de antemão ser
   inexecutável (sem alvo, sem item) — deve substituí-la por uma alternativa executável.
   `validateNarratorOption` (`session.service.ts`) ainda descarta no app opções de ataque
   sem alvo válido em cena e `trait_test` sem perícia/atributo reconhecível, como rede de
   segurança determinística.

## 5. Dados/tabelas necessárias — em grande parte já existem

- Mapa `intent → perícia/atributo`: **novo**, pequeno, fixo (uma tabela em `constants.ts`
  ou no novo resolver). É essencialmente o que hoje está em prosa no prompt
  (`gemini.adapter.ts` ~1989–2002).
- Mapa `difficulty → modificador`: **novo**, trivial (4 entradas).
- `WEAPONS` / `ARMORS`: **já existem**; falta garantir o vínculo arma-equipada →
  fórmula de dano/AP do jogador.
- Penalidades de ferimento, Edges, Hindrances, Parry, Toughness: **já no motor**.

## 6. Mudanças por arquivo (esboço)

- `domain/savage-worlds/constants.ts`: adicionar `INTENT_TO_TRAIT` e
  `DIFFICULTY_MODIFIER`. (Não tenho certeza ainda se a melhor casa é aqui ou no resolver;
  decidir na implementação.)
- `core/action-resolver.ts` (**novo**): `resolveActionFromIntent(state, intent, opts)`
  → devolve um `PlayerAction` mecânico completo (perícia, modificador, damageFormula, ap).
- `domain/types/gameState.ts` / `narrative.ts`: novo tipo de intenção; campos de arma
  equipada se ainda não existirem (verificar `InventoryItem`).
- `llm/schemas/narrator-response.schema.ts`: enxugar `diceCheck`/`actionPayload`,
  introduzir `intent`/`difficulty`.
- `llm/gemini.adapter.ts`: **remover** o bloco de regras numéricas (TN, modificadores,
  fórmulas) do prompt; manter apenas a orientação de *quando* uma ação é incerta e
  *qual a intenção*. Ajustar sanitização (`sanitizeValidateActionResponse` e a montagem
  de opções ~2285–2362).
- `modules/session/session.service.ts`: `buildActionFromOption` passa a chamar o novo
  resolver em vez de copiar `tn`/`modifier`/`damageFormula` do LLM.

## 7. Estratégia de migração (faseada, para reduzir risco)

1. **Fase 0 — instrumentar**: logar, para cada opção, o que o LLM mandou vs. o que o
   resolver *calcularia*. Mede a divergência antes de cortar.
2. **Fase 1 — app assume o numérico**: o app passa a sobrescrever `tn`, `modifier`,
   `damageFormula`, `ap` com valores calculados, **ainda recebendo** os campos do LLM
   (que viram dica, não verdade). Baixo risco, reversível.
3. **Fase 2 — introduzir `intent`/`difficulty`** no schema e fazer o resolver depender
   deles; manter fallback para o mapeamento por perícia.
4. **Fase 3 — limpar o prompt**: remover as regras numéricas de `gemini.adapter.ts` e os
   campos antigos do schema. Validar que o tamanho/latência do prompt caiu.
5. **Fase 4 — NPC**: mover `npcAttacks` numéricos para derivação a partir do catálogo/NPC.

## 8. Riscos e pontos de incerteza (a decidir com você)

- **Dificuldade é, em parte, julgamento de ficção, não regra fixa.** Em Savage Worlds o
  TN base é 4 (fixo), mas modificadores situacionais (−2 difícil, −4 quase impossível)
  dependem do contexto. Há duas escolhas: (a) o LLM informa um `difficulty` **limitado**
  e o app converte para número fixo (mantém alguma decisão de ficção no LLM, mas
  controlada); ou (b) o app define a dificuldade por regras puras (mais determinístico,
  porém pode ficar "burro" em cenas onde o contexto importa). Recomendo (a). **Decisão
  sua.**
- **Vínculo arma→dano do jogador**: preciso confirmar no código se o item equipado já
  carrega a fórmula/AP de `WEAPONS` ou se isso hoje só existe porque o LLM preenchia
  `damageFormula`. Se for o segundo caso, é a maior lacuna de dados a fechar.
- **`feasible` por ficção (decidido)**: removido de `ActionOption` — o LLM agora evita
  oferecer a opção inviável desde a origem (regra "AGÊNCIA REAL" no prompt), em vez de
  oferecê-la marcada como inviável.
- **Compatibilidade de sessões salvas**: opções já persistidas no chat usam o schema
  antigo. `buildActionFromOption` precisa continuar lendo o formato legado durante a
  transição.

## 9. Testes (incluir antes de fechar)

- Testes unitários do `action-resolver` (intent + estado → ação mecânica esperada),
  cobrindo perícia, ferimento, Edge/Hindrance, arma, AP.
- Testes do `rule-engine` permanecem como rede de segurança da resolução.
- Teste de regressão: mesma intenção produz a mesma mecânica independentemente do texto
  do LLM (o objetivo central deste plano).
- Comparar logs da Fase 0 para confirmar que a divergência LLM×app foi a esperada.

---

### Resumo de uma linha

A rolagem já está no app; o que falta tirar do LLM é a **decisão mecânica por opção**
(`tn`, `modifier`, `damageFormula`, `ap`, mapeamento ação→perícia) e o **bloco de regras
no prompt** — substituindo-os por um descritor de **intenção** + um **resolver** no app
que usa as tabelas fixas já existentes (`WEAPONS`, `SKILLS`, `EDGES`, `calcParry/Toughness`).
