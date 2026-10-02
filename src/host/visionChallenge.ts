export interface VisionAnswer {
  code: string
  left: VisionSymbol
  right: VisionSymbol
}

interface VisionSymbol {
  shape: 'circle' | 'square' | 'triangle'
  color: 'red' | 'green' | 'blue' | 'orange'
}

const SHAPES: readonly VisionSymbol['shape'][] = ['circle', 'square', 'triangle']
const COLORS: readonly VisionSymbol['color'][] = ['red', 'green', 'blue', 'orange']
const RGB: Record<VisionSymbol['color'], readonly [number, number, number]> = {
  red: [220, 35, 45], green: [25, 155, 65], blue: [35, 85, 220], orange: [240, 140, 20],
}
const DIGITS = [0x3f, 0x06, 0x5b, 0x4f, 0x66, 0x6d, 0x7d, 0x07, 0x7f, 0x6f] as const
const WIDTH = 384
const HEIGHT = 288

function chooseIndex(length: number): number {
  // 测试挑战只需避免固定答案，不承担密钥生成职责。
  return Math.floor(Math.random() * length)
}

function differentIndex(length: number, previous: number): number {
  const index = chooseIndex(length - 1)
  return index >= previous ? index + 1 : index
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let crc = index
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
  return crc >>> 0
})

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function put32(data: Uint8Array, offset: number, value: number): void {
  data[offset] = value >>> 24
  data[offset + 1] = value >>> 16
  data[offset + 2] = value >>> 8
  data[offset + 3] = value
}

function chunk(type: string, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(payload.length + 12)
  put32(out, 0, payload.length)
  for (let index = 0; index < 4; index++) out[4 + index] = type.charCodeAt(index)
  out.set(payload, 8)
  put32(out, out.length - 4, crc32(out.subarray(4, out.length - 4)))
  return out
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

function storeZlib(raw: Uint8Array): Uint8Array {
  // DEFLATE 的 stored block 无需压缩库；小图仍满足原生附件字节预算。
  const blocks = Math.ceil(raw.length / 65535)
  const out = new Uint8Array(2 + raw.length + blocks * 5 + 4)
  out.set([0x78, 0x01])
  let offset = 2
  for (let start = 0; start < raw.length; start += 65535) {
    const size = Math.min(65535, raw.length - start)
    out[offset++] = start + size === raw.length ? 1 : 0
    out[offset++] = size & 0xff
    out[offset++] = size >>> 8
    out[offset++] = (size ^ 0xffff) & 0xff
    out[offset++] = (size ^ 0xffff) >>> 8
    out.set(raw.subarray(start, start + size), offset)
    offset += size
  }
  let a = 1
  let b = 0
  for (const byte of raw) {
    a = (a + byte) % 65521
    b = (b + a) % 65521
  }
  put32(out, offset, ((b << 16) | a) >>> 0)
  return out
}

function encodePng(pixels: Uint8Array): Uint8Array {
  const stride = WIDTH * 3
  const raw = new Uint8Array((stride + 1) * HEIGHT)
  for (let row = 0; row < HEIGHT; row++) {
    // 每行使用 PNG filter 0，使沙箱编码无需依赖宿主 API。
    raw.set(pixels.subarray(row * stride, (row + 1) * stride), row * (stride + 1) + 1)
  }
  const header = new Uint8Array(13)
  put32(header, 0, WIDTH)
  put32(header, 4, HEIGHT)
  header[8] = 8
  header[9] = 2
  // 仅包含图像必需块；不把答案写入文本、EXIF 或其它元数据。
  return concat([
    Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10),
    chunk('IHDR', header), chunk('IDAT', storeZlib(raw)), chunk('IEND', new Uint8Array()),
  ])
}

/** 生成随机四位数字和左右不同形状、不同颜色的合成测试图。 */
export function createVisionChallenge(): { data: Uint8Array; width: number; height: number; expected: VisionAnswer } {
  const leftShape = chooseIndex(SHAPES.length)
  const leftColor = chooseIndex(COLORS.length)
  const expected: VisionAnswer = {
    code: Array.from({ length: 4 }, () => chooseIndex(10)).join(''),
    left: { shape: SHAPES[leftShape], color: COLORS[leftColor] },
    right: { shape: SHAPES[differentIndex(SHAPES.length, leftShape)], color: COLORS[differentIndex(COLORS.length, leftColor)] },
  }
  const pixels = new Uint8Array(WIDTH * HEIGHT * 3).fill(255)
  const paint = (x: number, y: number, color: readonly [number, number, number]) => {
    if (x < 0 || y < 0 || x >= WIDTH || y >= HEIGHT) return
    const offset = (y * WIDTH + x) * 3
    pixels[offset] = color[0]
    pixels[offset + 1] = color[1]
    pixels[offset + 2] = color[2]
  }
  const rectangle = (x: number, y: number, width: number, height: number, color: readonly [number, number, number]) => {
    for (let row = y; row < y + height; row++) {
      for (let column = x; column < x + width; column++) paint(column, row, color)
    }
  }
  const ink: readonly [number, number, number] = [25, 25, 25]
  for (let index = 0; index < 4; index++) {
    const x = 68 + index * 68
    const y = 24
    const segments: readonly (readonly [number, number, number, number])[] = [
      [x + 9, y, 26, 9], [x + 35, y + 9, 9, 30], [x + 35, y + 48, 9, 31],
      [x + 9, y + 79, 26, 9], [x, y + 48, 9, 31], [x, y + 9, 9, 30], [x + 9, y + 39, 26, 9],
    ]
    const mask = DIGITS[Number(expected.code[index])]
    for (let segment = 0; segment < segments.length; segment++) {
      if ((mask & (1 << segment)) !== 0) rectangle(...segments[segment], ink)
    }
  }
  const drawSymbol = (symbol: VisionSymbol, centerX: number) => {
    const color = RGB[symbol.color]
    const centerY = 210
    if (symbol.shape === 'square') {
      rectangle(centerX - 38, centerY - 38, 76, 76, color)
    } else if (symbol.shape === 'circle') {
      for (let y = -38; y <= 38; y++) {
        for (let x = -38; x <= 38; x++) if (x * x + y * y <= 38 * 38) paint(centerX + x, centerY + y, color)
      }
    } else {
      for (let row = 0; row <= 82; row++) {
        const halfWidth = Math.floor(row * 45 / 82)
        for (let x = -halfWidth; x <= halfWidth; x++) paint(centerX + x, centerY - 41 + row, color)
      }
    }
  }
  drawSymbol(expected.left, 106)
  drawSymbol(expected.right, 278)
  return { data: encodePng(pixels), width: WIDTH, height: HEIGHT, expected }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function matchesSymbol(value: unknown, expected: VisionSymbol): boolean {
  return isRecord(value) && value.shape === expected.shape && value.color === expected.color
}

/** 仅接受完整 JSON 回答；文字中碰巧包含答案不能算图片验证通过。 */
export function matchesVisionAnswer(reply: string, expected: VisionAnswer): boolean {
  if (reply.length > 20000) return false
  const trimmed = reply.trim()
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/i.exec(trimmed)
  const source = fenced ? fenced[1].trim() : trimmed
  try {
    const answer: unknown = JSON.parse(source)
    return isRecord(answer) && typeof answer.code === 'string' && answer.code === expected.code
      && matchesSymbol(answer.left, expected.left) && matchesSymbol(answer.right, expected.right)
  } catch {
    return false
  }
}

function utf8(text: string): Uint8Array {
  const bytes: number[] = []
  for (let index = 0; index < text.length; index++) {
    let point = text.charCodeAt(index)
    if (point >= 0xd800 && point <= 0xdbff) {
      const next = text.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        point = 0x10000 + ((point - 0xd800) << 10) + next - 0xdc00
        index++
      } else point = 0xfffd
    } else if (point >= 0xdc00 && point <= 0xdfff) point = 0xfffd
    if (point < 0x80) bytes.push(point)
    else if (point < 0x800) bytes.push(0xc0 | (point >>> 6), 0x80 | (point & 0x3f))
    else if (point < 0x10000) bytes.push(0xe0 | (point >>> 12), 0x80 | ((point >>> 6) & 0x3f), 0x80 | (point & 0x3f))
    else bytes.push(0xf0 | (point >>> 18), 0x80 | ((point >>> 12) & 0x3f), 0x80 | ((point >>> 6) & 0x3f), 0x80 | (point & 0x3f))
  }
  return Uint8Array.from(bytes)
}

const SHA256_K = Uint32Array.of(
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
)

function rotateRight(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits))
}

/** 用 SHA-256 绑定验证与配置，状态中只保存摘要而不重复保存认证内容。 */
export function verificationDigest(text: string): string {
  // 自带 UTF-8 编码，兼容没有 TextEncoder、WebCrypto 或 Node crypto 的 Host 沙箱。
  const input = utf8(text)
  const padded = new Uint8Array(Math.ceil((input.length + 9) / 64) * 64)
  padded.set(input)
  padded[input.length] = 0x80
  const bitLength = input.length * 8
  put32(padded, padded.length - 8, Math.floor(bitLength / 0x100000000))
  put32(padded, padded.length - 4, bitLength >>> 0)
  const hash = Uint32Array.of(0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19)
  const words = new Uint32Array(64)
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let index = 0; index < 16; index++) {
      const at = offset + index * 4
      words[index] = ((padded[at] << 24) | (padded[at + 1] << 16) | (padded[at + 2] << 8) | padded[at + 3]) >>> 0
    }
    for (let index = 16; index < 64; index++) {
      const x = words[index - 15]
      const y = words[index - 2]
      const s0 = rotateRight(x, 7) ^ rotateRight(x, 18) ^ (x >>> 3)
      const s1 = rotateRight(y, 17) ^ rotateRight(y, 19) ^ (y >>> 10)
      words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0
    }
    let [a, b, c, d, e, f, g, h] = hash
    for (let index = 0; index < 64; index++) {
      const s1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25)
      const choose = (e & f) ^ (~e & g)
      const t1 = (h + s1 + choose + SHA256_K[index] + words[index]) >>> 0
      const s0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22)
      const majority = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (s0 + majority) >>> 0
      h = g; g = f; f = e; e = (d + t1) >>> 0
      d = c; c = b; b = a; a = (t1 + t2) >>> 0
    }
    const result = [a, b, c, d, e, f, g, h]
    for (let index = 0; index < hash.length; index++) hash[index] = (hash[index] + result[index]) >>> 0
  }
  return Array.from(hash, (word) => word.toString(16).padStart(8, '0')).join('')
}
