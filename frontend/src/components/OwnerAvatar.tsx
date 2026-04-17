type Props = {
  label: string
  photoUrl?: string
}

function buildFallbackLabel(label: string): string {
  const trimmed = label.trim()
  if (!trimmed) return 'U'
  return trimmed.charAt(0).toUpperCase()
}

export function OwnerAvatar({ label, photoUrl }: Props) {
  const fallbackLabel = buildFallbackLabel(label)

  return (
    <span className="entity-owner-avatar" title={label} aria-label={label}>
      {photoUrl ? (
        <img alt={label} className="entity-owner-avatar-image" src={photoUrl} />
      ) : (
        <span className="entity-owner-avatar-fallback" aria-hidden="true">
          {fallbackLabel}
        </span>
      )}
    </span>
  )
}