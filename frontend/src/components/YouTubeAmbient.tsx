import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

/* ── Tipos do YouTube IFrame API ── */
declare global {
  interface Window {
    YT: typeof YT
    onYouTubeIframeAPIReady: (() => void) | undefined
  }
}

type Props = {
  youtubeUrl: string
}

/**
 * Extrai o videoId de URLs do YouTube (watch, youtu.be, embed, shorts).
 */
function extractVideoId(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.hostname.includes('youtube.com') && parsed.searchParams.has('v')) {
      return parsed.searchParams.get('v')
    }
    if (parsed.hostname === 'youtu.be') {
      return parsed.pathname.slice(1).split('/')[0] || null
    }
    const embedMatch = parsed.pathname.match(/\/embed\/([^/?]+)/)
    if (embedMatch) return embedMatch[1]
    const shortsMatch = parsed.pathname.match(/\/shorts\/([^/?]+)/)
    if (shortsMatch) return shortsMatch[1]
  } catch {
    // URL inválida
  }
  return null
}

/** Carrega o script da IFrame API uma única vez */
let ytApiPromise: Promise<void> | null = null
function loadYTApi(): Promise<void> {
  if (ytApiPromise) return ytApiPromise
  if (window.YT?.Player) return (ytApiPromise = Promise.resolve())

  ytApiPromise = new Promise<void>((resolve) => {
    const prev = window.onYouTubeIframeAPIReady
    window.onYouTubeIframeAPIReady = () => {
      prev?.()
      resolve()
    }
    const tag = document.createElement('script')
    tag.src = 'https://www.youtube.com/iframe_api'
    document.head.appendChild(tag)
  })
  return ytApiPromise
}

export function YouTubeAmbient({ youtubeUrl }: Props) {
  const videoId = useMemo(() => extractVideoId(youtubeUrl), [youtubeUrl])
  const [showMini, setShowMini] = useState(true)
  const [volume, setVolume] = useState(30)
  const [muted, setMuted] = useState(false)
  const [apiReady, setApiReady] = useState(false)

  const bgPlayerRef = useRef<YT.Player | null>(null)
  const miniPlayerRef = useRef<YT.Player | null>(null)
  const bgContainerRef = useRef<HTMLDivElement>(null)
  const miniContainerRef = useRef<HTMLDivElement>(null)

  // Carrega API
  useEffect(() => {
    loadYTApi().then(() => setApiReady(true))
  }, [])

  // Cria players quando a API estiver pronta
  useEffect(() => {
    if (!apiReady || !videoId) return

    // Background player (mudo, sem controles)
    if (bgContainerRef.current && !bgPlayerRef.current) {
      bgPlayerRef.current = new YT.Player(bgContainerRef.current, {
        videoId,
        playerVars: {
          autoplay: 1,
          mute: 1,
          loop: 1,
          playlist: videoId,
          controls: 0,
          showinfo: 0,
          rel: 0,
          modestbranding: 1,
          disablekb: 1,
        },
      })
    }

    // Mini player (controle de áudio)
    if (miniContainerRef.current && !miniPlayerRef.current) {
      miniPlayerRef.current = new YT.Player(miniContainerRef.current, {
        videoId,
        playerVars: {
          autoplay: 1,
          loop: 1,
          playlist: videoId,
          controls: 1,
          rel: 0,
          modestbranding: 1,
        },
        events: {
          onReady: (e: YT.PlayerEvent) => {
            e.target.setVolume(volume)
            if (muted) e.target.mute()
          },
        },
      })
    }

    return () => {
      bgPlayerRef.current?.destroy()
      bgPlayerRef.current = null
      miniPlayerRef.current?.destroy()
      miniPlayerRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiReady, videoId])

  // Sincroniza volume
  useEffect(() => {
    const p = miniPlayerRef.current
    if (!p || typeof p.setVolume !== 'function') return
    p.setVolume(volume)
    if (muted) { p.mute() } else { p.unMute() }
  }, [volume, muted])

  const handleToggle = useCallback(() => {
    setShowMini((prev) => !prev)
  }, [])

  const handleVolumeChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const v = Number(e.target.value)
    setVolume(v)
    if (v > 0 && muted) setMuted(false)
  }, [muted])

  const toggleMute = useCallback(() => {
    setMuted((prev) => !prev)
  }, [])

  if (!videoId) return null

  return (
    <>
      {/* Background layer — vídeo fullscreen com baixa opacidade */}
      <div className="yt-background-layer" aria-hidden="true">
        <div ref={bgContainerRef} className="yt-background-iframe" />
      </div>

      {/* Mini player button + volume — canto inferior direito */}
      <div className="yt-controls">
        <div className="yt-volume-group" style={{ display: showMini ? 'flex' : 'none' }}>
          <button
            className="yt-mute-btn"
            onClick={toggleMute}
            title={muted ? 'Ativar som' : 'Silenciar'}
            type="button"
          >
            {muted || volume === 0 ? '🔇' : volume < 50 ? '🔉' : '🔊'}
          </button>
          <input
            className="yt-volume-slider"
            type="range"
            min={0}
            max={100}
            value={muted ? 0 : volume}
            onChange={handleVolumeChange}
            title={`Volume: ${muted ? 0 : volume}%`}
          />
        </div>

        <button
          className="yt-mini-player"
          onClick={handleToggle}
          title={showMini ? 'Esconder player' : 'Mostrar player'}
          type="button"
        >
          {showMini ? '♫ ▼' : '♫ ▲'}
        </button>
      </div>

      <div
        className="yt-mini-player-panel"
        style={{ display: showMini ? 'block' : 'none' }}
      >
        <div ref={miniContainerRef} className="yt-mini-iframe" />
      </div>
    </>
  )
}
