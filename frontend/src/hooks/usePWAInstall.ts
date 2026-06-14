import { useEffect, useState } from 'react'

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

export type PWAInstallState =
  | { status: 'not-ready' }
  | { status: 'ready'; install: () => Promise<void> }
  | { status: 'ios' }            // iOS Safari: mostrar instruções manuais
  | { status: 'installed' }      // já está rodando como app instalado

function isIOS() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent) && !(window.navigator as { standalone?: boolean }).standalone
}

function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches ||
    (window.navigator as { standalone?: boolean }).standalone === true
}

export function usePWAInstall(): PWAInstallState {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null)
  const [installed, setInstalled] = useState(isStandalone)

  useEffect(() => {
    if (isStandalone()) return

    function onBeforeInstall(e: Event) {
      e.preventDefault()
      setDeferredPrompt(e as BeforeInstallPromptEvent)
    }

    function onAppInstalled() {
      setInstalled(true)
      setDeferredPrompt(null)
    }

    window.addEventListener('beforeinstallprompt', onBeforeInstall)
    window.addEventListener('appinstalled', onAppInstalled)
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstall)
      window.removeEventListener('appinstalled', onAppInstalled)
    }
  }, [])

  if (installed) return { status: 'installed' }
  if (isStandalone()) return { status: 'installed' }
  if (isIOS()) return { status: 'ios' }
  if (!deferredPrompt) return { status: 'not-ready' }

  return {
    status: 'ready',
    install: async () => {
      await deferredPrompt.prompt()
      const { outcome } = await deferredPrompt.userChoice
      if (outcome === 'accepted') {
        setDeferredPrompt(null)
        setInstalled(true)
      }
    },
  }
}
