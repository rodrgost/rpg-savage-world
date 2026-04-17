# Frontend (MVP)

Aplicação React + Vite para o fluxo básico do RPG:

- Home
- Criação de mundo
- Lista de mundos
- Criação de personagem
- Cadastro de mod de regras
- Jogo como chat contínuo (ação por ação)

## Rodar

Na raiz do monorepo:

1. Instalar dependências:
	- `npm install`
2. Configurar variáveis do Firebase Web SDK no `.env` da raiz (`VITE_FIREBASE_*`).
3. Configurar URL do backend Nest em `frontend/.env` (`VITE_BACKEND_URL`).
4. Subir frontend:
	- `npm -w frontend run dev`

Para rodar o fluxo completo (frontend + backend HTTP):

- Terminal 1: `npm -w backend run dev`
- Terminal 2: `npm -w frontend run dev`

## Rotas

- `/`
- `/worlds/new`
- `/worlds`
- `/characters/new`
- `/mods/new`
- `/game/:sessionId`

## Integração backend

O frontend usa API HTTP do backend Nest (`VITE_BACKEND_URL`):

- `POST /campaigns`
- `GET /campaigns`
- `POST /rule-sets`
- `GET /rule-sets`
- `POST /worlds`
- `GET /worlds`
- `DELETE /worlds/:worldId`
- `POST /characters`
- `GET /characters`
- `POST /sessions/start`
- `GET /sessions/:sessionId`
- `GET /sessions/:sessionId/events`
- `POST /sessions/:sessionId/actions`
