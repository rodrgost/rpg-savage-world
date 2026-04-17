# RPG-ADAPTAVEL

Monorepo Node + TypeScript para um RPG adaptável com três frentes de execução:

- `frontend/`: interface React + Vite
- `backend/`: API HTTP em NestJS usada pelo frontend hoje
- `functions/`: Cloud Functions/Firebase para callable functions, emuladores e deploy

## Estrutura do repositório

- `frontend/`: interface web atual. O Vite usa `envDir: '..'`, então lê variáveis do `.env` da raiz.
- `backend/`: API HTTP em NestJS. É o caminho principal do fluxo web no estado atual do projeto.
- `functions/`: implementação voltada ao ecossistema Firebase, com engine determinística e integração com Firestore.
- `scripts/`: scripts de migração de dados.
- `firebase.json` e `firestore.rules`: configuração local do Firebase.

## Fluxos de execução

### Fluxo web atual

Para rodar a aplicação web completa localmente:

1. Instale as dependências com `npm install`.
2. Crie o arquivo `.env` na raiz a partir de `.env.example`.
3. Preencha as variáveis de Firebase Web SDK, OAuth2, Firebase Admin e Gemini.
4. Suba o backend HTTP com `npm run dev:backend`.
5. Em outro terminal, suba o frontend com `npm run dev:frontend`.

O frontend usa `VITE_BACKEND_URL`, que por padrão aponta para `http://localhost:3100`.

### Fluxo Firebase

Para trabalhar com Functions/Firebase:

- `npm run dev:functions`: watch local de `functions/`
- `npm run dev:emulators`: emuladores de Functions e Firestore
- `npm run build`: build das Cloud Functions

## Configuração de ambiente

O arquivo `.env.example` na raiz concentra as variáveis usadas pelo frontend e pelo backend. Em especial:

- `VITE_FIREBASE_*`: configuração do Firebase Web SDK no frontend
- `VITE_USE_FIREBASE_EMULATORS`: chave para apontar o frontend aos emuladores locais
- `VITE_BACKEND_URL`: URL base do backend HTTP
- `OAUTH2_CLIENT_ID`: configuração de autenticação OAuth2
- `FIREBASE_PROJECT_ID`, `FIREBASE_SERVICE_ACCOUNT_PATH` ou `FIREBASE_SERVICE_ACCOUNT_JSON`: credenciais administrativas
- `GEMINI_*`: configuração do narrador e geração de conteúdo

Se usar `FIREBASE_SERVICE_ACCOUNT_PATH`, mantenha o JSON fora do repositório ou em um caminho já ignorado pelo Git.

## Persistência no Firestore

- **Snapshot mecânico completo** por turno: `sessions/{sessionId}/snapshots/{turn}`
- **Resumo narrativo progressivo** para contexto de LLM: `sessions/{sessionId}/_meta/summary`
- **Eventos estruturados** por sessão: `sessions/{sessionId}/events/*`

Coleções base do MVP:

- `campaigns/{campaignId}`
- `sessions/{sessionId}`
- `characters/{characterId}`
- `rule_sets/{ruleSetId}`

## Comandos úteis

- `npm run dev`: watch local de `functions/`
- `npm run dev:frontend`: inicia o frontend
- `npm run dev:backend`: inicia o backend HTTP
- `npm run dev:functions`: inicia o watch de `functions/`
- `npm run dev:emulators`: inicia os emuladores do Firebase
- `npm -w frontend run build`: build do frontend
- `npm -w backend run build`: build do backend HTTP
- `npm -w functions run build`: build das Functions

## Princípios

- **A LLM nunca decide regras**: ela narra, resume e condensa.
- **O estado não nasce do resumo**: a fonte da verdade é sempre o snapshot.
- **O frontend usa backend HTTP por padrão no momento**: a trilha via Functions continua disponível, mas não é o fluxo web principal hoje.
