# Nova hierarquia: Mundo → (Campanha, Personagem) → Playthrough

Rascunho de tipos e plano de migração para o modelo N:M entre **Personagem** e
**Campanha**, com o **Playthrough** (a atual coleção `sessions`) como junção que
guarda o estado da partida.

> Decisões já tomadas:
> 1. **Progressão fica no Playthrough.** O Personagem é o "molde" (ficha-base);
>    cada partida instancia/snapshota essa ficha e evolui de forma isolada.
> 2. **Personagem é preso ao Mundo.** `worldId` passa a ser obrigatório no
>    Personagem, e a invariante de partida é `character.worldId === campaign.worldId`.

---

## 1. O que já existe hoje (descoberta no código)

A boa notícia: a arquitetura **já está quase lá**.

- Coleções no Firestore: `worlds`, `campaigns`, `characters` e `sessions`.
- A coleção **`sessions` já é, de fato, o Playthrough**: cada doc liga
  `ownerId` + `campaignId` + `characterId` + `worldId` e carrega o estado vivo
  (`GameState`: wounds, fatigue, inventário, statusEffects, combate) via
  snapshots/subcoleções. A chave de retomada é
  `resumeKey = ownerId:campaignId:characterId` (`session.service.ts`).

O único acoplamento que trava o N:M:

- `CharacterDoc.campaignId` é **obrigatório** (`characters.repo.ts`) e a criação
  de sessão valida `character.campaignId !== campaignId`
  (`session.service.ts:788`). Ou seja, hoje **um personagem pertence a exatamente
  uma campanha**. É exatamente esse vínculo 1:1 que causa o desconforto.

Conclusão: não é preciso reescrever a hierarquia — basta **desacoplar Personagem
de Campanha** e tratar `sessions` explicitamente como Playthrough.

---

## 2. Tipos propostos

### World — praticamente inalterado

```ts
export type WorldDoc = {
  ownerId: string
  visibility?: Visibility
  ruleSetId: string
  name: string
  description: string
  lore: string
  npcCatalog?: NpcDefinition[]
  status: 'active'
  createdAt: unknown
  updatedAt: unknown
}
```

### Campaign — inalterado (já pertence ao Mundo, sem dono-personagem)

```ts
export type CampaignDoc = {
  worldId: string          // pertence ao mundo
  ownerId: string
  visibility?: Visibility
  name?: string
  storyDescription: string
  storyCharacters?: StoryCharacter[]
  status: 'active'
  createdAt: unknown
  updatedAt: unknown
}
```

> A Campanha continua sendo um **cenário reutilizável, sem dono-personagem**.
> É legítimo ela ser "genérica": a personalização acontece no Playthrough.

### Character — DESACOPLADO da Campanha

```ts
export type CharacterDoc = {
  // REMOVIDO: campaignId
  worldId: string          // agora OBRIGATÓRIO (personagem preso ao mundo)
  ownerId: string
  userId?: string
  visibility?: Visibility

  // Identidade + ficha-BASE (o "molde"; não é o estado de jogo)
  name: string
  gender?: string
  race?: string
  profession?: string
  description?: string
  attributes: Record<string, number>   // valores iniciais
  skills: Record<string, number>
  edges: string[]
  hindrances: Array<{ name: string; severity: string }>
  sheetValues?: Record<string, unknown>

  createdAt: unknown
  updatedAt?: unknown
}
```

Mudanças: remover `campaignId`; tornar `worldId` obrigatório. O Personagem deixa
de carregar qualquer noção de "campanha" — ele é só identidade + ficha inicial,
válida dentro de um Mundo.

### Playthrough — a junção (a atual coleção `sessions`, formalizada)

```ts
export type PlaythroughStatus = 'ativo' | 'pausado' | 'concluido'

export type PlaythroughDoc = {
  ownerId: string
  worldId: string
  campaignId: string       // qual cenário
  characterId: string      // qual personagem
  resumeKey: string        // `${ownerId}:${campaignId}:${characterId}`

  status: PlaythroughStatus // NOVO — alimenta a aba "jogos ativos"
  createdAt: unknown
  updatedAt: unknown

  // Estado vivo permanece nos snapshots/subcoleções já existentes:
  // GameState (wounds, fatigue, inventário, statusEffects, combate),
  // segments/mensagens, eventos, resumos.
}
```

Isto é a materialização do N:M: a mesma Campanha pode ter vários Playthroughs
(personagens diferentes) e o mesmo Personagem pode ter vários Playthroughs
(campanhas diferentes), cada um com progressão própria.

---

## 3. Invariantes

1. **Mesmo mundo:** ao criar Playthrough, validar
   `character.worldId === campaign.worldId`.
   Substitui a checagem atual `character.campaignId !== campaignId`
   (`session.service.ts:788`).
2. **Snapshot no início:** começar um Playthrough copia a ficha-base do
   Personagem para o `GameState` inicial. Editar o Personagem depois **não**
   altera retroativamente partidas em andamento (comportamento desejado).
3. **Unicidade de retomada:** `resumeKey` continua garantindo no máximo um
   Playthrough "vivo" por trinca (owner, campanha, personagem) — ou troque para
   permitir múltiplos saves por trinca, se quiser.

---

## 4. Aba "jogos ativos comigo"

Consulta direta sobre Playthroughs:

```ts
firestore.collection('sessions') // futura coleção 'playthroughs'
  .where('ownerId', '==', userId)
  .where('status', '==', 'ativo')
  .orderBy('updatedAt', 'desc')
```

Cada linha = um Playthrough, exibindo Personagem + Campanha + "continuar de onde
parei". O mesmo Personagem pode aparecer em várias linhas (campanhas diferentes,
níveis diferentes).

---

## 5. Pontos de refatoração (superfície de impacto)

- `characters.repo.ts`: remover `campaignId` de `CharacterDoc`, `create`,
  `update`; tornar `worldId` obrigatório; trocar `listByCampaign(campaignId)` e
  os filtros por `campaignId` por filtros via `worldId` (e, para "personagens de
  uma campanha jogada", derivar dos Playthroughs daquela campanha).
- `session.service.ts:788`: trocar a validação de campanha pela invariante de
  mundo (`character.worldId === campaign.worldId`).
- `game-data.service.ts`: `listByCampaign(characters)` (linhas ~590, ~629) e
  `listAccessible({ campaignId })` (~824) precisam ser reescritos — "quem joga
  esta campanha" agora vem de Playthroughs, não de `character.campaignId`.
  Em ~1026, `campaigns.get(character.campaignId)` deixa de existir.
- Adicionar `status` ao doc de `sessions`/Playthrough e setá-lo em
  criar/pausar/concluir.
- Regras do Firestore (`firestore.rules`): ajustar para o Personagem sem
  `campaignId` e para o filtro por `worldId`.

### Migração de dados (personagens existentes)

1. Backfill: para cada `character` sem `worldId`, derivar de
   `campaigns.get(character.campaignId).worldId`.
2. Parar de exigir/escrever `campaignId` em `characters` (pode manter o campo só
   para leitura legada durante a transição).
3. Garantir que todo Playthrough/`session` antigo tenha `status` (default
   `ativo`).

---

## 6. Resumo da mudança

| Entidade   | Antes                         | Depois                                  |
|------------|-------------------------------|-----------------------------------------|
| World      | dono do conteúdo              | igual                                   |
| Campaign   | pertence ao mundo             | igual (cenário reutilizável)            |
| Character  | **preso a uma campanha**      | **preso só ao mundo** (molde/ficha-base)|
| Session    | junção implícita + estado     | **Playthrough** explícito, com `status` |

O esforço concentra-se em remover `character.campaignId` e formalizar `sessions`
como Playthrough. A hierarquia em si (Mundo no topo, Playthrough na ponta) já
está suportada pelo código atual.
