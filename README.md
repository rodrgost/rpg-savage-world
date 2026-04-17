# RPG-ADAPTAVEL

Projeto (Node + TypeScript) para um RPG com persistência em duas camadas, **usando Firebase/Firestore** e **Cloud Functions como engine**.

## Estrutura

- `functions/`: Cloud Functions (stateless) + engine determinística + persistência
- `frontend/`: app React (MVP)
- `backend/`: legado/alternativo (não é a arquitetura preferida)

## Persistência (Firestore)

- **Snapshot mecânico completo** por turno (fonte da verdade): `sessions/{sessionId}/snapshots/{turn}`
- **Resumo narrativo progressivo** (contexto para LLM, regenerável): `sessions/{sessionId}/_meta/summary`
- **Eventos estruturados** (keyEvents): `sessions/{sessionId}/events/*`

Coleções base (MVP):
- `campaigns/{campaignId}`
- `sessions/{sessionId}`
- `characters/{characterId}`
- `rule_sets/{ruleSetId}`

## Começar

1. Instale deps:
   - `npm install`
2. Copie env:
   - `copy .env.example .env`
3. Configure credenciais Firebase (uma das opções no `.env`)
4. Rodar:
   - `npm run dev`

Frontend (em outro terminal):
- `npm run dev:frontend`

Backend legado Nest (opcional):
- `npm run dev:backend`

Backend principal HTTP (migração em andamento):
- `npm -w backend run dev`

Opcional (emulador):
- `npm -w functions run emulators`

## Cloud Functions (MVP)

Funções callable (arquivo `functions/src/index.ts`):
- `createCampaign`
- `upsertRuleSet`
- `listRuleSets`
- `createWorld`
- `createCharacter`
- `startSession`
- `executeAction`

Obs: `createCampaign` usa `modName` (nome do mod/regra escolhido), não `systemProfileId`.

## Princípios

- **A LLM nunca decide regras**: ela só narra/condensa.
- **Nunca derive estado do resumo**: estado é sempre snapshot.
