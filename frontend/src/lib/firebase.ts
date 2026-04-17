import { initializeApp } from 'firebase/app'
import type { FirebaseError } from 'firebase/app'
import type { User } from 'firebase/auth'
import {
  EmailAuthProvider,
  GoogleAuthProvider,
  connectAuthEmulator,
  createUserWithEmailAndPassword,
  getAuth,
  getRedirectResult,
  linkWithCredential,
  linkWithPopup,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signInWithPopup,
  signInWithRedirect,
  signOut
} from 'firebase/auth'
import { connectFirestoreEmulator, getFirestore } from 'firebase/firestore'
import { connectFunctionsEmulator, getFunctions } from 'firebase/functions'

export type AuthSession = {
  uid: string
  email?: string
  displayName?: string
  photoURL?: string
  isAnonymous: boolean
}

export type AuthFlowResult = {
  user: AuthSession
  anonymousMergeToken: string | null
  preservedAnonymousData: boolean
}

export type AuthRedirectStartResult = {
  redirected: true
}

export type GoogleLoginResult = AuthFlowResult | AuthRedirectStartResult

export type GoogleRedirectRecoveryResult = {
  pending: boolean
  destination: string | null
  flowResult: AuthFlowResult | null
  errorMessage: string | null
}

export type PendingGoogleRedirectState = {
  destination: string
  anonymousMergeToken: string | null
}

const googleRedirectStorageKey = 'rpg-adaptavel.googleRedirect'

function getProviderProfile(user: User): { displayName?: string; photoURL?: string } {
  for (const provider of user.providerData) {
    const displayName = provider.displayName?.trim() || undefined
    const photoURL = provider.photoURL || undefined
    if (displayName || photoURL) {
      return { displayName, photoURL }
    }
  }

  return {}
}

function mapAuthSession(user: User | null): AuthSession | null {
  if (!user) return null

  const providerProfile = getProviderProfile(user)

  return {
    uid: user.uid,
    email: user.email ?? undefined,
    displayName: user.displayName?.trim() || providerProfile.displayName,
    photoURL: user.photoURL ?? providerProfile.photoURL,
    isAnonymous: user.isAnonymous
  }
}

function getAnonymousUser(): User | null {
  return auth.currentUser?.isAnonymous ? auth.currentUser : null
}

async function captureAnonymousMergeToken(): Promise<string | null> {
  const anonymousUser = getAnonymousUser()
  if (!anonymousUser) return null
  return await anonymousUser.getIdToken()
}

function getPendingGoogleRedirectState(): PendingGoogleRedirectState | null {
  if (typeof window === 'undefined') return null

  try {
    const raw = window.sessionStorage.getItem(googleRedirectStorageKey)
    if (!raw) return null

    const parsed = JSON.parse(raw) as Partial<PendingGoogleRedirectState>
    if (typeof parsed.destination !== 'string' || !parsed.destination) return null

    return {
      destination: parsed.destination,
      anonymousMergeToken: typeof parsed.anonymousMergeToken === 'string' ? parsed.anonymousMergeToken : null
    }
  } catch {
    return null
  }
}

function setPendingGoogleRedirectState(state: PendingGoogleRedirectState): void {
  if (typeof window === 'undefined') return

  try {
    window.sessionStorage.setItem(googleRedirectStorageKey, JSON.stringify(state))
  } catch {
    // Ignore storage failures and let the redirect continue without recovery state.
  }
}

export function clearPendingGoogleRedirectState(): void {
  if (typeof window === 'undefined') return

  try {
    window.sessionStorage.removeItem(googleRedirectStorageKey)
  } catch {
    // Ignore storage cleanup failures.
  }
}

export function hasPendingGoogleRedirect(): boolean {
  return getPendingGoogleRedirectState() !== null
}

export function readPendingGoogleRedirectState(): PendingGoogleRedirectState | null {
  return getPendingGoogleRedirectState()
}

function isCredentialConflict(code: string | undefined): boolean {
  return code === 'auth/credential-already-in-use' || code === 'auth/email-already-in-use'
}

function shouldFallbackToRedirect(code: string | undefined): boolean {
  return code === 'auth/popup-blocked' || code === 'auth/cancelled-popup-request'
}

function formatAuthError(error: unknown): string {
  const firebaseError = error as FirebaseError | undefined
  switch (firebaseError?.code) {
    case 'auth/email-already-in-use':
      return 'Este e-mail já está em uso. Use a aba Entrar para acessar a conta existente.'
    case 'auth/invalid-email':
      return 'Informe um e-mail válido.'
    case 'auth/missing-password':
      return 'Informe a senha para continuar.'
    case 'auth/weak-password':
      return 'A senha deve ter pelo menos 6 caracteres.'
    case 'auth/user-not-found':
    case 'auth/wrong-password':
    case 'auth/invalid-credential':
      return 'E-mail ou senha inválidos.'
    case 'auth/popup-closed-by-user':
      return 'A janela do Google foi fechada antes da conclusão do login.'
    case 'auth/popup-blocked':
      return 'O navegador bloqueou a janela do Google. Libere pop-ups e tente novamente.'
    case 'auth/account-exists-with-different-credential':
      return 'Já existe uma conta com este e-mail usando outro método de acesso.'
    case 'auth/too-many-requests':
      return 'Muitas tentativas em sequência. Aguarde alguns minutos e tente novamente.'
    case 'auth/network-request-failed':
      return 'Falha de rede ao falar com o Firebase. Verifique sua conexão.'
    case 'auth/operation-not-allowed':
      return 'Este método de login está desabilitado no Firebase Authentication.'
    default:
      return error instanceof Error ? error.message : 'Falha ao autenticar com o Firebase.'
  }
}

function normalizeEnvValue(value: unknown): string {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  return trimmed.replace(/^"(.*)"$/, '$1')
}

const firebaseConfig = {
  apiKey: normalizeEnvValue(import.meta.env.VITE_FIREBASE_API_KEY),
  authDomain: normalizeEnvValue(import.meta.env.VITE_FIREBASE_AUTH_DOMAIN),
  projectId: normalizeEnvValue(import.meta.env.VITE_FIREBASE_PROJECT_ID),
  storageBucket: normalizeEnvValue(import.meta.env.VITE_FIREBASE_STORAGE_BUCKET),
  messagingSenderId: normalizeEnvValue(import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID),
  appId: normalizeEnvValue(import.meta.env.VITE_FIREBASE_APP_ID),
  measurementId: normalizeEnvValue(import.meta.env.VITE_FIREBASE_MEASUREMENT_ID)
}

if (!firebaseConfig.apiKey || firebaseConfig.apiKey.includes(':')) {
  throw new Error(
    'Firebase API key inválida ou ausente. Confira VITE_FIREBASE_API_KEY em frontend/.env e reinicie o Vite.'
  )
}

const app = initializeApp(firebaseConfig)
export const auth = getAuth(app)
export const db = getFirestore(app)
export const functions = getFunctions(app)

const useEmulators = import.meta.env.VITE_USE_FIREBASE_EMULATORS === 'true'

if (useEmulators) {
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true })
  connectFirestoreEmulator(db, '127.0.0.1', 8080)
  connectFunctionsEmulator(functions, '127.0.0.1', 5001)
}

export function subscribeToAuthState(listener: (user: AuthSession | null) => void) {
  return onAuthStateChanged(auth, (user) => listener(mapAuthSession(user)))
}

export function getCurrentAuthSession(): AuthSession | null {
  return mapAuthSession(auth.currentUser)
}

export async function resolveGoogleRedirectResult(): Promise<GoogleRedirectRecoveryResult> {
  const pendingState = getPendingGoogleRedirectState()
  if (!pendingState) {
    return {
      pending: false,
      destination: null,
      flowResult: null,
      errorMessage: null
    }
  }

  try {
    const redirectResult = await getRedirectResult(auth)
    const resolvedUser = redirectResult?.user ?? auth.currentUser

    if (!resolvedUser || resolvedUser.isAnonymous) {
      return {
        pending: true,
        destination: pendingState.destination,
        flowResult: null,
        errorMessage: 'O retorno do login com Google não foi concluído. Tente novamente.'
      }
    }

    return {
      pending: true,
      destination: pendingState.destination,
      flowResult: {
        user: mapAuthSession(resolvedUser)!,
        anonymousMergeToken: pendingState.anonymousMergeToken,
        preservedAnonymousData: false
      },
      errorMessage: null
    }
  } catch (error) {
    return {
      pending: true,
      destination: pendingState.destination,
      flowResult: null,
      errorMessage: formatAuthError(error)
    }
  }
}

export async function getAuthenticatedIdToken(): Promise<string> {
  const currentUser = auth.currentUser
  if (!currentUser || currentUser.isAnonymous) {
    throw new Error('Faça login para continuar.')
  }

  return await currentUser.getIdToken()
}

export async function signOutCurrentUser(): Promise<void> {
  try {
    await signOut(auth)
  } catch (error) {
    throw new Error(formatAuthError(error))
  }
}

export async function registerWithEmail(email: string, password: string): Promise<AuthFlowResult> {
  const normalizedEmail = email.trim()

  try {
    const anonymousUser = getAnonymousUser()
    if (anonymousUser) {
      const credential = EmailAuthProvider.credential(normalizedEmail, password)
      const linked = await linkWithCredential(anonymousUser, credential)
      return {
        user: mapAuthSession(linked.user)!,
        anonymousMergeToken: null,
        preservedAnonymousData: true
      }
    }

    const created = await createUserWithEmailAndPassword(auth, normalizedEmail, password)
    return {
      user: mapAuthSession(created.user)!,
      anonymousMergeToken: null,
      preservedAnonymousData: false
    }
  } catch (error) {
    throw new Error(formatAuthError(error))
  }
}

export async function loginWithEmail(email: string, password: string): Promise<AuthFlowResult> {
  const normalizedEmail = email.trim()
  const anonymousMergeToken = await captureAnonymousMergeToken()

  try {
    const credentials = await signInWithEmailAndPassword(auth, normalizedEmail, password)
    return {
      user: mapAuthSession(credentials.user)!,
      anonymousMergeToken,
      preservedAnonymousData: false
    }
  } catch (error) {
    throw new Error(formatAuthError(error))
  }
}

async function startGoogleRedirectFallback(
  provider: GoogleAuthProvider,
  destination: string,
  anonymousMergeToken: string | null
): Promise<AuthRedirectStartResult> {
  setPendingGoogleRedirectState({ destination, anonymousMergeToken })

  try {
    await signInWithRedirect(auth, provider)
    return { redirected: true }
  } catch (error) {
    clearPendingGoogleRedirectState()
    throw error
  }
}

export async function loginWithGoogle(options?: { redirectFallbackDestination?: string }): Promise<GoogleLoginResult> {
  const provider = new GoogleAuthProvider()
  provider.setCustomParameters({ prompt: 'select_account' })
  const anonymousMergeToken = await captureAnonymousMergeToken()

  try {
    const anonymousUser = getAnonymousUser()
    if (anonymousUser) {
      try {
        const linked = await linkWithPopup(anonymousUser, provider)
        return {
          user: mapAuthSession(linked.user)!,
          anonymousMergeToken: null,
          preservedAnonymousData: true
        }
      } catch (error) {
        const firebaseError = error as FirebaseError
        if (shouldFallbackToRedirect(firebaseError?.code) && options?.redirectFallbackDestination) {
          return await startGoogleRedirectFallback(provider, options.redirectFallbackDestination, anonymousMergeToken)
        }

        if (!isCredentialConflict(firebaseError?.code)) {
          throw error
        }
      }

      let signedIn
      try {
        signedIn = await signInWithPopup(auth, provider)
      } catch (error) {
        const firebaseError = error as FirebaseError
        if (shouldFallbackToRedirect(firebaseError?.code) && options?.redirectFallbackDestination) {
          return await startGoogleRedirectFallback(provider, options.redirectFallbackDestination, anonymousMergeToken)
        }

        throw error
      }

      return {
        user: mapAuthSession(signedIn.user)!,
        anonymousMergeToken,
        preservedAnonymousData: false
      }
    }

    let signedIn
    try {
      signedIn = await signInWithPopup(auth, provider)
    } catch (error) {
      const firebaseError = error as FirebaseError
      if (shouldFallbackToRedirect(firebaseError?.code) && options?.redirectFallbackDestination) {
        return await startGoogleRedirectFallback(provider, options.redirectFallbackDestination, null)
      }

      throw error
    }

    return {
      user: mapAuthSession(signedIn.user)!,
      anonymousMergeToken: null,
      preservedAnonymousData: false
    }
  } catch (error) {
    throw new Error(formatAuthError(error))
  }
}
