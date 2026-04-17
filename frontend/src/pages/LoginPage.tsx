import { FormEvent, useEffect, useMemo, useState } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router-dom'

import { mergeAnonymousOwnership } from '../lib/api'
import {
  clearPendingGoogleRedirectState,
  loginWithEmail,
  loginWithGoogle,
  hasPendingGoogleRedirect,
  readPendingGoogleRedirectState,
  registerWithEmail,
  resolveGoogleRedirectResult,
  signOutCurrentUser,
  type AuthFlowResult,
  type AuthSession
} from '../lib/firebase'

type Props = {
  currentUser: AuthSession | null
}

type Mode = 'signin' | 'signup'

function isAuthenticatedUser(user: AuthSession | null): user is AuthSession {
  return Boolean(user && !user.isAnonymous)
}

export function LoginPage({ currentUser }: Props) {
  const navigate = useNavigate()
  const location = useLocation()
  const [recoveringGoogleRedirect] = useState(() => hasPendingGoogleRedirect())
  const [mode, setMode] = useState<Mode>('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [loading, setLoading] = useState(recoveringGoogleRedirect)
  const [error, setError] = useState('')
  const [pendingMergeToken, setPendingMergeToken] = useState<string | null>(null)
  const [holdRedirect, setHoldRedirect] = useState(recoveringGoogleRedirect)

  const destination = useMemo(() => {
    const state = location.state as { from?: string } | null
    return state?.from || '/'
  }, [location.state])
  const [postAuthDestination, setPostAuthDestination] = useState(destination)

  const hasAnonymousProgress = Boolean(currentUser?.isAnonymous)
  const isAuthenticated = isAuthenticatedUser(currentUser)

  async function finalizeFlow(result: AuthFlowResult, nextDestination = postAuthDestination) {
    setPostAuthDestination(nextDestination)

    if (result.anonymousMergeToken) {
      try {
        await mergeAnonymousOwnership(result.anonymousMergeToken)
        setPendingMergeToken(null)
      } catch (mergeError) {
        setPendingMergeToken(result.anonymousMergeToken)
        setHoldRedirect(true)
        throw new Error(
          mergeError instanceof Error
            ? `Você entrou na conta, mas a migração dos dados locais falhou: ${mergeError.message}`
            : 'Você entrou na conta, mas a migração dos dados locais falhou.'
        )
      }
    }

    setHoldRedirect(false)
    navigate(nextDestination, { replace: true })
  }

  useEffect(() => {
    let cancelled = false

    if (!recoveringGoogleRedirect) return

    async function recoverGoogleRedirect() {
      const pendingRedirect = readPendingGoogleRedirectState()
      if (!pendingRedirect) {
        setHoldRedirect(false)
        setLoading(false)
        return
      }

      setError('')

      try {
        let redirectRecovery

        if (currentUser && !currentUser.isAnonymous) {
          await Promise.resolve()
          redirectRecovery = {
            pending: true,
            destination: pendingRedirect.destination,
            flowResult: {
              user: currentUser,
              anonymousMergeToken: pendingRedirect.anonymousMergeToken,
              preservedAnonymousData: false
            },
            errorMessage: null
          }
        } else {
          redirectRecovery = await resolveGoogleRedirectResult()
        }

        if (cancelled) return

        if (!redirectRecovery.pending) {
          setHoldRedirect(false)
          return
        }

        const nextDestination = redirectRecovery.destination ?? pendingRedirect.destination

        if (redirectRecovery.errorMessage) {
          clearPendingGoogleRedirectState()
          setPostAuthDestination(nextDestination)
          setError(redirectRecovery.errorMessage)
          setHoldRedirect(false)
          return
        }

        if (!redirectRecovery.flowResult) {
          clearPendingGoogleRedirectState()
          setPostAuthDestination(nextDestination)
          setError('O retorno do login com Google não foi concluído. Tente novamente.')
          setHoldRedirect(false)
          return
        }

        try {
          await finalizeFlow(redirectRecovery.flowResult, nextDestination)
        } finally {
          clearPendingGoogleRedirectState()
        }
      } catch (submitError) {
        if (cancelled) return

        clearPendingGoogleRedirectState()
        setError(submitError instanceof Error ? submitError.message : 'Falha ao concluir o login com Google.')
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }

    void recoverGoogleRedirect()

    return () => {
      cancelled = true
    }
  }, [currentUser, recoveringGoogleRedirect])

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (loading) return

    if (!email.trim()) {
      setError('Informe o e-mail para continuar.')
      return
    }

    if (!password) {
      setError('Informe a senha para continuar.')
      return
    }

    if (mode === 'signup' && password !== confirmPassword) {
      setError('A confirmação da senha não confere.')
      return
    }

    setLoading(true)
    setError('')
    setHoldRedirect(true)

    try {
      const result =
        mode === 'signup'
          ? await registerWithEmail(email, password)
          : await loginWithEmail(email, password)
      await finalizeFlow(result)
    } catch (submitError) {
      setHoldRedirect(false)
      setError(submitError instanceof Error ? submitError.message : 'Falha ao autenticar.')
    } finally {
      setLoading(false)
    }
  }

  async function handleGoogleLogin() {
    if (loading) return

    setLoading(true)
    setError('')
    setHoldRedirect(true)
    let redirected = false

    try {
      const result = await loginWithGoogle({ redirectFallbackDestination: postAuthDestination })
      if ('redirected' in result) {
        redirected = true
        return
      }

      await finalizeFlow(result)
    } catch (submitError) {
      setHoldRedirect(false)
      setError(submitError instanceof Error ? submitError.message : 'Falha ao entrar com Google.')
    } finally {
      if (!redirected) {
        setLoading(false)
      }
    }
  }

  async function retryAnonymousMerge() {
    if (!pendingMergeToken || loading) return

    setLoading(true)
    setError('')
    try {
      await mergeAnonymousOwnership(pendingMergeToken)
      setPendingMergeToken(null)
      setHoldRedirect(false)
      navigate(postAuthDestination, { replace: true })
    } catch (mergeError) {
      setError(mergeError instanceof Error ? mergeError.message : 'Falha ao migrar os dados locais.')
    } finally {
      setLoading(false)
    }
  }

  function handleContinueWithoutMerge() {
    setPendingMergeToken(null)
    setHoldRedirect(false)
    navigate(postAuthDestination, { replace: true })
  }

  async function handleSignOut() {
    setLoading(true)
    setError('')
    try {
      await signOutCurrentUser()
      setPendingMergeToken(null)
      setHoldRedirect(false)
    } catch (logoutError) {
      setError(logoutError instanceof Error ? logoutError.message : 'Falha ao sair da conta.')
    } finally {
      setLoading(false)
    }
  }

  if (isAuthenticated && !loading && !holdRedirect) {
    return <Navigate to={destination} replace />
  }

  return (
    <div className="auth-screen">
      <section className="auth-stage">
        <div className="auth-panel auth-panel--hero">
          <span className="auth-kicker">Acesso protegido</span>
          <h1>Entre para abrir o RPG Adaptável.</h1>
          <p>
            Agora a aplicação inteira exige autenticação real. Isso protege os dados de mundos, campanhas,
            personagens e sessões do chat.
          </p>

          <div className="auth-highlights">
            <div>
              <strong>Conta com e-mail</strong>
              <p>Crie uma conta nova ou entre em uma já existente sem perder o fluxo principal da aplicação.</p>
            </div>
            <div>
              <strong>Google integrado</strong>
              <p>Use sua conta Google no Firebase sem abrir páginas da aplicação antes do login.</p>
            </div>
            <div>
              <strong>Progressos locais</strong>
              <p>Se este navegador tiver uma sessão anônima antiga, tentaremos preservar os dados ao converter sua conta.</p>
            </div>
          </div>
        </div>

        <div className="auth-panel auth-panel--form">
          <div className="auth-mode-switch">
            <button type="button" className={mode === 'signin' ? 'active' : ''} onClick={() => setMode('signin')}>
              Entrar
            </button>
            <button type="button" className={mode === 'signup' ? 'active' : ''} onClick={() => setMode('signup')}>
              Criar conta
            </button>
          </div>

          <div className="auth-copy">
            <h2>{mode === 'signin' ? 'Acesse sua conta' : 'Crie sua conta protegida'}</h2>
            <p>
              {mode === 'signin'
                ? 'Entre com e-mail e senha ou use Google para liberar o restante da aplicação.'
                : 'Crie a conta agora. Se este navegador tiver progresso local anônimo, tentaremos preservá-lo.'}
            </p>
          </div>

          {hasAnonymousProgress && (
            <div className="auth-note">
              <strong>Progresso local detectado</strong>
              <p>
                Encontramos uma sessão antiga salva neste navegador. Ao criar conta, a preservação tende a manter o mesmo UID.
                Ao entrar em conta existente, faremos uma migração automática para essa conta.
              </p>
            </div>
          )}

          {isAuthenticated && holdRedirect && pendingMergeToken && (
            <div className="auth-note auth-note--warn">
              <strong>Conta autenticada, migração pendente</strong>
              <p>Você já entrou, mas a transferência dos dados locais deste navegador ainda não terminou.</p>
              <div className="auth-note-actions">
                <button type="button" onClick={retryAnonymousMerge} disabled={loading}>
                  Tentar migração novamente
                </button>
                <button type="button" className="button-secondary" onClick={handleContinueWithoutMerge} disabled={loading}>
                  Continuar sem migrar
                </button>
              </div>
            </div>
          )}

          <form className="auth-form" onSubmit={handleSubmit}>
            <label>
              E-mail
              <input
                type="email"
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="voce@exemplo.com"
                required
              />
            </label>

            <label>
              Senha
              <input
                type="password"
                autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="Mínimo de 6 caracteres"
                required
              />
            </label>

            {mode === 'signup' && (
              <label>
                Confirmar senha
                <input
                  type="password"
                  autoComplete="new-password"
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                  placeholder="Repita a senha"
                  required
                />
              </label>
            )}

            <button type="submit" className="button-full" disabled={loading}>
              {loading
                ? mode === 'signin'
                  ? 'Entrando...'
                  : 'Criando conta...'
                : mode === 'signin'
                  ? 'Entrar com e-mail'
                  : 'Criar conta com e-mail'}
            </button>
          </form>

          <div className="auth-divider">
            <span>ou</span>
          </div>

          <button type="button" className="button-secondary button-full auth-google-button" onClick={handleGoogleLogin} disabled={loading}>
            Entrar com Google
          </button>

          {error && <p className="error auth-error">{error}</p>}

          <div className="auth-footer">
            <p>
              {mode === 'signin' ? 'Ainda não tem conta?' : 'Já possui uma conta?'}{' '}
              <button type="button" className="auth-inline-button" onClick={() => setMode(mode === 'signin' ? 'signup' : 'signin')}>
                {mode === 'signin' ? 'Criar agora' : 'Entrar'}
              </button>
            </p>

            {isAuthenticated && holdRedirect && (
              <p>
                <button type="button" className="auth-inline-button" onClick={handleSignOut}>
                  Sair desta conta
                </button>
              </p>
            )}
          </div>
        </div>
      </section>
    </div>
  )
}