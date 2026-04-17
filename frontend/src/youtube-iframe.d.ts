declare namespace YT {
  interface Player {
    destroy(): void
    mute(): void
    unMute(): void
    setVolume(volume: number): void
  }

  interface PlayerEvent {
    target: Player
  }

  interface PlayerOptions {
    videoId?: string
    playerVars?: Record<string, string | number>
    events?: {
      onReady?: (event: PlayerEvent) => void
    }
  }

  interface PlayerConstructor {
    new (elementId: string | HTMLElement, options?: PlayerOptions): Player
  }

  const Player: PlayerConstructor
}