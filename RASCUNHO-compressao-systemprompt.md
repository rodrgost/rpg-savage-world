# Rascunho — compressão de redundâncias do system prompt (narrador)

> Status: **proposta para revisão**. Nada aplicado no código ainda.
> Escopo aprovado: 4 clusters de redundância. **Inventário/munição NÃO será tocado** (definido como crítico).
> Arquivos afetados quando aplicar: `backend/src/llm/gemini.adapter.ts` (e nada no `contextBuilder.ts`).

---

## Cluster 1 — "Histórico jogado vence a lore" (3 → 1)

Mantém o bloco forte **CANONICAL HIERARCHY** intacto. Reduz as duas repetições nos headers.

### 1a. Header de CAMPAIGN
**Antes:**
```
=== CAMPAIGN (PLANNED ARC — background only) ===
Use this for thematic coherence and world color. Do NOT treat it as a script to follow — the ADVENTURE SUMMARY is what canonically happened.
```
**Depois:**
```
=== CAMPAIGN (PLANNED ARC — background only) ===
Thematic and world color only — not a script (see CANONICAL HIERARCHY).
```

### 1b. Header de ADVENTURE SUMMARY
**Antes:**
```
=== ADVENTURE SUMMARY (ESTABLISHED CANON) ===
⚠️ This is the authoritative record of what already happened in this game. Facts here are FIXED — they cannot be contradicted by UNIVERSE lore or CAMPAIGN story. Build forward from this; do NOT rewrite, ignore, or contradict any event recorded here.
```
**Depois:**
```
=== ADVENTURE SUMMARY (ESTABLISHED CANON) ===
⚠️ Authoritative canon of what already happened — build forward from this; never contradict it.
```

**Economia estimada:** ~50 tokens. (Risco: baixo — a regra completa segue no bloco HIERARCHY.)

---

## Cluster 2 — "NPCs podem falar/agir mas não resolvem a cena" (3 → 1)

Mantém a versão detalhada em **NPC CHARACTER & PARTICIPATION**. Remove a NOTE duplicada na PRIMARY RULE.

**Antes (na seção PRIMARY RULE FOR THE NARRATOR SEGMENTS):**
```
NOTE: NPCs MAY speak, threaten, taunt, react emotionally, or take immediate in-scene actions (draw a weapon, block a door, shout a warning) — this IS expected. The prohibition is on NPCs resolving the OUTCOME of the scene without player input.
```
**Depois:** *(linha removida — a regra já está completa em NPC CHARACTER & PARTICIPATION)*

**Economia estimada:** ~50 tokens. (Risco: baixo — conteúdo preservado em NPC CHARACTER.)

---

## Cluster 3 — "segments: narrator é default; npc só quando fala" (3 → 1)

Mantém UMA versão técnica em GENERAL RULES (comprimida). O schema continua sendo só o schema. Remove a duplicação no bullet de NPC CHARACTER.

### 3a. GENERAL RULES (linha gigante)
**Antes:**
```
- "segments": type="narrator" is the DEFAULT and carries ALL prose, description, action and consequence — MOST turns contain ONLY narrator segments and NO npc segment. Add a type="npc" segment ONLY when an NPC speaks a LITERAL line of dialogue aloud this turn (the exact words the player would hear). An NPC that merely gestures, reacts, glares, stays silent, or is described WITHOUT spoken words is a NARRATOR segment, NEVER an npc segment. Do NOT invent dialogue just to fill an npc segment. No spoken NPC line → return a SINGLE type="narrator" segment. When you DO emit an npc segment: "text" must contain ONLY the spoken words (no narration mixed in), set "npcDisplayName" to the SAME friendly name used in the "npcs" array (or PRESENT NPCS), and copy "npcId" (the hash) when the NPC is already present.
```
**Depois:**
```
- "segments": type="narrator" is the DEFAULT and carries ALL prose/description/action/consequence. Add a type="npc" segment ONLY when an NPC speaks a LITERAL line aloud this turn — never for gestures, silence, or being described without words, and never invent dialogue to fill one. In an npc segment, "text" = only the spoken words; set "npcDisplayName" to the same name used in "npcs"/PRESENT NPCS and copy "npcId" when already present.
```

### 3b. NPC CHARACTER bullet (duplica o "may speak via segments")
**Antes:**
```
• NPCs may speak (via segments type="npc"), threaten, taunt, plead, negotiate, or react emotionally in ways consistent with their character.
```
**Depois:**
```
• NPCs may threaten, taunt, plead, negotiate, or react emotionally in ways consistent with their character.
```

**Economia estimada:** ~80 tokens. (Risco: médio — a linha 75 é instrução técnica de formato; vale conferir no teste de comparação que o modelo continua emitindo npc segments corretamente.)

---

## Cluster 4 — "Nunca citar regras/dados na narração" (2 → 1)

Funde a regra de imersão no item que já tem os exemplos úteis.

### 4a. DO NOT WRITE (mantém + absorve)
**Antes:**
```
• literal mechanical terms: "Shaken", "Wounded", "Fatigue" — narrate instead: "the arm gives out", "vision blurs"
```
**Depois:**
```
• any mention of rules, dice, or mechanics — including literal terms ("Shaken", "Wounded", "Fatigue"). Narrate the effect instead: "the arm gives out", "vision blurs".
```

### 4b. GENERAL RULES (linha redundante removida)
**Antes:**
```
- Never break immersion. Never mention rules, dice, or mechanics in the narrative text.
```
**Depois:** *(linha removida)*

**Economia estimada:** ~20 tokens. (Risco: baixo.)

---

## Total

| Cluster | ~tokens economizados | Risco |
|---|---|---|
| 1 — história vence lore | ~50 | baixo |
| 2 — NPC fala/age | ~50 | baixo |
| 3 — segments narrator default | ~80 | médio |
| 4 — nunca citar regras | ~20 | baixo |
| **Total** | **~200 tk** (~4% do estático) | — |

### Observação honesta sobre o tamanho do ganho
Com inventário/munição fora do escopo (crítico) e mantendo os blocos fortes (HIERARCHY) intactos, a economia só-de-redundância é **modesta (~200 tk)**. Os cortes que moveriam a agulha de verdade eram justamente o bloco de inventário e o enxugamento do HIERARCHY — ambos preservados por decisão sua.

Para reduzir **custo** sem cortar conteúdo, o caminho de maior impacto continua sendo **context caching** do prefixo estático (o prompt é idêntico turno a turno). Isso não some no contador de tokens do input, mas barateia bastante as leituras repetidas.
