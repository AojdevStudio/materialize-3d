import jsQR from 'jsqr'

/** A phone photo is far larger than a code needs. Reading a smaller copy keeps the read under a second. */
const LONGEST_SIDE = 1600

/** The text of the QR code in a picture, or null when the picture holds none. */
export async function readQrPicture(picture: Blob): Promise<string | null> {
  const bitmap = await createImageBitmap(picture)
  const scale = Math.min(1, LONGEST_SIDE / Math.max(bitmap.width, bitmap.height))
  const width = Math.round(bitmap.width * scale)
  const height = Math.round(bitmap.height * scale)
  const canvas = new OffscreenCanvas(width, height)
  const context = canvas.getContext('2d')
  if (!context) throw new Error('This device could not read the picture.')
  context.drawImage(bitmap, 0, 0, width, height)
  bitmap.close()
  return jsQR(context.getImageData(0, 0, width, height).data, width, height)?.data ?? null
}
