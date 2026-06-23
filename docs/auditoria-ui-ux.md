# Auditoria de UI/UX — Aderência ao Modelo de Design

**Data:** 23/06/2026 · **Execução:** tarefa agendada `verificar-ui-ux` (automática)
**Escopo:** `frontend/src` (páginas, componentes, CSS)

## O que é o "modelo já implementado"

O sistema de design está definido em `frontend/src/styles/base.css` como um conjunto
de *design tokens* (variáveis CSS em `:root`): paleta de cores semânticas, espaçamentos
(`--space-*`), raios (`--radius-*`), tipografia (`--font-*`), sombras e gradientes.
A "aplicação do modelo" significa que páginas e componentes devem usar essas variáveis
em vez de valores fixos (hex, rgba, px).

## Resumo do que foi verificado

A maior parte do código **adere** ao modelo. Pontos positivos:

- As páginas usam classes CSS e estilos inline apenas para espaçamento via tokens
  (ex.: `style={{ marginTop: 'var(--space-3)' }}` em `CreateCharacterPage.tsx`) — uso correto.
- Praticamente nenhuma cor fixa nos arquivos `.tsx` (as únicas em `LoginPage.tsx` são as
  cores de marca do logo SVG do Google: `#4285F4`, `#34A853`, `#FBBC05`, `#EA4335` — devem
  permanecer fixas).

## Inconsistências encontradas

A divergência está concentrada nos arquivos de estilo `components.css` e `pages.css`,
que usam uma paleta paralela (em sua maioria valores padrão do Tailwind) em vez dos tokens.

| Tipo | Ocorrências (aprox.) | Observação |
|------|---------------------|------------|
| Cores hex fixas no CSS | ~96 | Bypass dos tokens de cor |
| Valores `rgba(...)` fixos no CSS | ~189 | Sombras/overlays sem token |
| Cores hex fixas em `.tsx` | 4 | Apenas logo Google (aceitável) |

> Os números são aproximados (contagem por *grep*); recomendo confirmar caso a caso antes de editar.

### Cores fixas mais frequentes e o token correspondente sugerido

| Valor fixo | Vezes | Token sugerido | Situação |
|-----------|-------|----------------|----------|
| `#ef4444` | 16 | `var(--action-danger)` | **Idêntico** ao token — substituição direta |
| `#f59e0b` | 13 | (criar token de "warning/amber") | Diverge de `--feedback-warn` (#FACC15) |
| `#9ca3af` | 10 | `var(--text-secondary)` | Próximo (#94A3B8), não idêntico |
| `#eab308` | 9 | `var(--feedback-warn)` | Diverge (#FACC15) |
| `#22c55e` | 7 | `var(--feedback-success)` | Diverge (#4ADE80) |
| `#fff` / `#000` | 9 | `var(--text-primary)` / criar token | Avaliar contraste sobre fundos |
| `#60a5fa`, `#3b82f6`, `#93c5fd`, `#bfdbfe` | 16 | (não há token azul) | Sistema usa índigo (#818CF8) como acento |
| `#c9963a`, `#c9a000`, `#e6b800` | 8 | (não há token "ouro") | Paleta de destaque fora do modelo |

A questão não é só "não usar variável": existe uma **paleta paralela** (verdes, amarelos,
azuis e dourados do Tailwind) que não corresponde às cores semânticas definidas em `base.css`.
Isso cria divergência visual sutil — ex.: dois tons de verde de "sucesso" (#22c55e no CSS
vs. #4ADE80 no token).

## Recomendações (em ordem de esforço/impacto)

1. **Substituições diretas (baixo risco):** trocar `#ef4444` → `var(--action-danger)`.
   16 ocorrências, valor idêntico, sem mudança visual.
2. **Alinhar semânticas (baixo risco visual aceitando o token):** `#eab308`/`#22c55e`/`#9ca3af`
   → tokens de warn/success/text-secondary. Muda levemente o tom, mas unifica a paleta.
3. **Criar tokens faltantes:** o modelo não tem token para "amber" (#f59e0b, 13 usos),
   nem para os azuis e dourados. Decidir se entram no `base.css` como tokens semânticos
   ou se a paleta deve convergir para o índigo/acento existente.
4. **Sombras/overlays:** os ~189 `rgba(...)` fixos podem migrar para `--shadow-*` e
   variáveis de overlay. Maior esforço, fazer de forma incremental.

## Próximo passo

Esta foi uma verificação somente-leitura (a tarefa não autorizou edição automática).
Posso aplicar as substituições do item 1 e 2 (as de baixo risco) e abrir as decisões
do item 3 para você, se confirmar.
