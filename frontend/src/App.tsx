import { NavLink, Navigate, Outlet, Route, Routes, useLocation, useParams } from 'react-router-dom'
import { useEffect, useMemo, useState } from 'react'

import { signOutCurrentUser, subscribeToAuthState, type AuthSession } from './lib/firebase'
import { LoginPage } from './pages/LoginPage'
import { HomePage } from './pages/HomePage'
import { CreateWorldPage } from './pages/CreateWorldPage'
import { WorldsPage } from './pages/WorldsPage'
import { CampaignsPage } from './pages/CampaignsPage'
import { CreateCampaignPage } from './pages/CreateCampaignPage'
import { CreateCharacterPage } from './pages/CreateCharacterPage'
import { GamePage } from './pages/GamePage'
import { CharactersPage } from './pages/CharactersPage'
import { RulesPage } from './pages/RulesPage'

/** Redirect /worlds/:worldId/campaigns → /campaigns?worldId=X */
function WorldCampaignsRedirect() {
  const { worldId } = useParams<{ worldId: string }>()
  return <Navigate to={`/campaigns?worldId=${worldId}`} replace />
}

function RequireAuth({ currentUser }: { currentUser: AuthSession | null }) {
  const location = useLocation()

  if (!currentUser || currentUser.isAnonymous) {
    return <Navigate to="/login" replace state={{ from: `${location.pathname}${location.search}${location.hash}` }} />
  }

  return <Outlet />
}

function AuthenticatedLayout({
  currentUser,
  authError,
  onSignOut
}: {
  currentUser: AuthSession
  authError: string
  onSignOut: () => Promise<void>
}) {
  const accountLabel = currentUser.displayName || currentUser.email || `UID ${currentUser.uid.slice(0, 8)}`

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar-inner">
          <h1>RPG Adaptável</h1>
          <nav>
            <NavLink className={({ isActive }) => (isActive ? 'active' : '')} end to="/">
              Home
            </NavLink>
            <NavLink className={({ isActive }) => (isActive ? 'active' : '')} to="/worlds">
              Universos
            </NavLink>
            <NavLink className={({ isActive }) => (isActive ? 'active' : '')} to="/campaigns">
              Campanhas
            </NavLink>
            <NavLink className={({ isActive }) => (isActive ? 'active' : '')} to="/characters">
              Personagens
            </NavLink>
            <NavLink className={({ isActive }) => (isActive ? 'active' : '')} to="/rules">
              Regras
            </NavLink>
          </nav>

          <div className="topbar-session">
            <div className="topbar-session-meta">
              <span className="topbar-session-label">Conta ativa</span>
              <strong>{accountLabel}</strong>
            </div>
            <button type="button" className="button-secondary button-sm" onClick={() => void onSignOut()}>
              Sair
            </button>
          </div>
        </div>
      </header>

      <main className="content">
        {authError ? <p className="error">{authError}</p> : null}
        <Outlet />
      </main>
    </div>
  )
}

export function App() {
  const [authReady, setAuthReady] = useState(false)
  const [currentUser, setCurrentUser] = useState<AuthSession | null>(null)
  const [authError, setAuthError] = useState('')

  useEffect(() => {
    const unsubscribe = subscribeToAuthState((user) => {
      setCurrentUser(user)
      setAuthReady(true)
    })

    return unsubscribe
  }, [])

  const uid = currentUser && !currentUser.isAnonymous ? currentUser.uid : ''
  const accountLabel = useMemo(() => {
    if (!currentUser || currentUser.isAnonymous) return ''
    return currentUser.displayName || currentUser.email || `UID ${currentUser.uid.slice(0, 8)}`
  }, [currentUser])
  const userPhotoUrl = currentUser && !currentUser.isAnonymous ? currentUser.photoURL : undefined

  async function handleSignOut() {
    setAuthError('')
    try {
      await signOutCurrentUser()
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : 'Falha ao encerrar a sessão.')
    }
  }

  if (!authReady) {
    return (
      <div className="auth-screen auth-screen--loading">
        <section className="auth-loading-card">
          <span className="auth-kicker">Inicializando autenticação</span>
          <h2>Conferindo a sessão salva neste navegador.</h2>
          <p>Se houver uma conta ativa, a aplicação libera o painel automaticamente. Caso contrário, a tela de acesso será exibida.</p>
        </section>
      </div>
    )
  }

  return (
    <Routes>
      <Route path="/login" element={<LoginPage currentUser={currentUser} />} />

      <Route element={<RequireAuth currentUser={currentUser} />}>
        <Route
          element={
            <AuthenticatedLayout currentUser={currentUser!} authError={authError} onSignOut={handleSignOut} />
          }
        >
          <Route path="/" element={<HomePage accountLabel={accountLabel} />} />
          <Route path="/worlds/new" element={<CreateWorldPage uid={uid} />} />
          <Route path="/worlds/:worldId/edit" element={<CreateWorldPage uid={uid} />} />
          <Route path="/worlds/:worldId/campaigns" element={<WorldCampaignsRedirect />} />
          <Route path="/worlds/:worldId/campaigns/new" element={<CreateCampaignPage uid={uid} />} />
          <Route path="/campaigns" element={<CampaignsPage uid={uid} ownerLabel={accountLabel} ownerPhotoUrl={userPhotoUrl} />} />
          <Route path="/campaigns/:campaignId/edit" element={<CreateCampaignPage uid={uid} />} />
          <Route path="/worlds" element={<WorldsPage uid={uid} ownerLabel={accountLabel} ownerPhotoUrl={userPhotoUrl} />} />
          <Route path="/characters" element={<CharactersPage uid={uid} ownerLabel={accountLabel} ownerPhotoUrl={userPhotoUrl} />} />
          <Route path="/characters/new" element={<CreateCharacterPage uid={uid} />} />
          <Route path="/characters/:characterId/edit" element={<CreateCharacterPage uid={uid} />} />
          <Route path="/rules" element={<RulesPage />} />
          <Route path="/game/:sessionId" element={<GamePage />} />
        </Route>
      </Route>

      <Route path="*" element={<Navigate to={currentUser && !currentUser.isAnonymous ? '/' : '/login'} replace />} />
    </Routes>
  )
}
