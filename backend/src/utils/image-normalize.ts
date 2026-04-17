import sharp from 'sharp'

export type StoredImage = {
  mimeType: string
  base64: string
}

type NormalizeOptions = {
  width: number
  height: number
  quality?: number
  maxBase64Chars?: number
}

function isProbablyBase64(value: string): boolean {
  return /^[A-Za-z0-9+/=\r\n]+$/.test(value)
}

export async function normalizeToWebp(input: StoredImage, options: NormalizeOptions): Promise<StoredImage> {
  const cleanedBase64 = input.base64.trim()
  if (!cleanedBase64) throw new Error('Imagem base64 vazia')
  if (!isProbablyBase64(cleanedBase64)) throw new Error('Imagem base64 inválida')

  const maxBase64Chars = options.maxBase64Chars ?? 750_000

  const source = Buffer.from(cleanedBase64, 'base64')
  const targetWidth = Math.max(16, Math.trunc(options.width))
  const targetHeight = Math.max(16, Math.trunc(options.height))

  const attempts: number[] = [options.quality ?? 70, 60, 50]
  for (const quality of attempts) {
    const buffer = await sharp(source)
      .resize(targetWidth, targetHeight, { fit: 'cover' })
      .webp({ quality })
      .toBuffer()

    const base64 = buffer.toString('base64')
    if (base64.length <= maxBase64Chars) {
      return { mimeType: 'image/webp', base64 }
    }
  }

  throw new Error('Imagem gerada ficou grande demais para persistir (base64 excede limite)')
}
