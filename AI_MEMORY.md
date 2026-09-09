# Memória do Projeto: RPG-ADAPTAVEL

## Visão Geral
- **Tipo de Projeto:** Monorepo (Node.js + TypeScript) para um RPG adaptável.
- **Estrutura de Pastas:**
  - `frontend/`: Aplicação web usando React e Vite. Lê variáveis de ambiente do `.env` na raiz.
  - `backend/`: API HTTP em NestJS que atende o frontend. Gerencia o fluxo web, pipeline de narração (integração com LLM), engine de regras do RPG e a persistência no banco de dados.
  - `scripts/`: Scripts utilitários e de migração de dados.

## Stack Tecnológica
- **Linguagem principal:** TypeScript, Node.js (v22.x)
- **Frontend:** React, Vite
- **Backend:** NestJS
- **Banco de Dados:** Firebase Firestore (uso de emuladores locais no desenvolvimento via `npm run dev:emulators`)
- **LLMs Suportados:** Gemini, DeepSeek, OpenAI (para texto/narração). Geração de imagens utiliza Gemini.

## Arquitetura de Dados (Firestore)
Coleções base do MVP:
- `campaigns/{campaignId}`
- `sessions/{sessionId}`
- `characters/{characterId}`
- `rule_sets/{ruleSetId}`

Subcoleções importantes de `sessions`:
- `snapshots/{turn}`: **Snapshot mecânico completo** por turno.
- `_meta/summary`: **Resumo narrativo progressivo** para manter o contexto do LLM sem estourar tokens.
- `messages/*` e `archivedMessages/*`: Mensagens de chat (ativas e arquivadas).
- `facts/*`: **Fatos canônicos** (eventos irreversíveis, ledger append-only).
- `events/*`: Eventos estruturados.

## Princípios Arquiteturais e Regras da IA
- **Papel da LLM:** A IA serve estritamente para narrar os eventos, resumir histórias e condensar o contexto.
- **Limitação Crítica:** A LLM **NUNCA** decide regras ou mecânicas do RPG.
- **Fonte da Verdade (SSOT):** O estado da partida não deriva da interpretação do resumo pela LLM. A fonte da verdade inquestionável é sempre o **snapshot mecânico** salvo no Firestore.

## Fluxo de Desenvolvimento
- Scripts principais (`package.json`):
  - Iniciar emuladores do Firebase: `npm run dev:emulators`
  - Iniciar API backend: `npm run dev:backend`
  - Iniciar client frontend: `npm run dev:frontend`
  - Build e validação de contratos TypeScript: `npm run validate` ou `npm run build:all`
- As variáveis de ambiente (como credenciais do LLM, configurações do Firebase e OAuth2) devem ficar centralizadas no arquivo `.env` na raiz do projeto, baseado no `.env.example`.
