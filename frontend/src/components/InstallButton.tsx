import { useState } from 'react'
import { usePWAInstall } from '../hooks/usePWAInstall'

export function InstallButton() {
  const pwa = usePWAInstall()
  const [showIOSGuide, setShowIOSGuide] = useState(false)

  if (pwa.status === 'installed' || pwa.status === 'not-ready') return null

  if (pwa.status === 'ios') {
    return (
      <>
        <button
          type="button"
          className="button-secondary button-sm"
          onClick={() => setShowIOSGuide(true)}
          title="Instalar como app"
        >
          Instalar
        </button>

        {showIOSGuide && (
          <div className="pwa-overlay" role="dialog" aria-modal="true" aria-label="Instalar no iOS">
            <div className="pwa-modal">
              <h3>Instalar no iPhone / iPad</h3>
              <ol className="pwa-ios-steps">
                <li>Toque no botão <strong>Compartilhar</strong> <span className="pwa-icon-share">⎙</span> na barra do Safari</li>
                <li>Role para baixo e toque em <strong>"Adicionar à Tela de Início"</strong></li>
                <li>Confirme tocando em <strong>"Adicionar"</strong></li>
              </ol>
              <button
                type="button"
                onClick={() => setShowIOSGuide(false)}
              >
                Entendi
              </button>
            </div>
          </div>
        )}
      </>
    )
  }

  return (
    <button
      type="button"
      className="button-secondary button-sm"
      onClick={() => void pwa.install()}
      title="Instalar Mesa Infinita como app"
    >
      Instalar app
    </button>
  )
}
