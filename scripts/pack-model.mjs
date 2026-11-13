// 把下载来的鱼模型（scene.gltf + scene.bin + textures/）打成一个 .glb，放进 src/ui/fish3d/。
// 用法：node scripts/pack-model.mjs models/angelfish/scene.gltf src/ui/fish3d/angelfish.glb
// 为什么要打包：页面是从本地文件打开的，只能通过主进程读文件；一个模型一个文件最省事。
// 顺手做两件事：
//   - 老的材质写法（KHR_materials_pbrSpecularGlossiness）新版 three.js 不认，改写成现在通用的写法，不然贴图会丢。
//   - 作者和授权（Sketchfab 写在 asset.extras 里）原样留着，另外打印出来方便记进 CREDITS.md。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, extname } from 'node:path'

const [src, out] = process.argv.slice(2)
if (!src || !out) {
  console.error('用法：node scripts/pack-model.mjs <scene.gltf> <输出.glb>')
  process.exit(1)
}
const dir = dirname(src)
const json = JSON.parse(readFileSync(src, 'utf8'))
const pad4 = (n) => (n + 3) & ~3

// 读一个 uri：可能是旁边的文件，也可能是内嵌的 data: 地址。
function readUri(uri) {
  if (uri.startsWith('data:')) return Buffer.from(uri.slice(uri.indexOf(',') + 1), 'base64')
  return readFileSync(join(dir, decodeURIComponent(uri)))
}

// 所有 buffer 接成一块（glb 只能带一块二进制），bufferView 的偏移跟着挪。
const parts = []
let size = 0
const push = (bytes) => {
  const at = size
  parts.push(bytes)
  const padded = pad4(bytes.length)
  if (padded > bytes.length) parts.push(Buffer.alloc(padded - bytes.length))
  size += padded
  return at
}
const bufferStart = (json.buffers ?? []).map((b) => push(readUri(b.uri)))
for (const v of json.bufferViews ?? []) {
  v.byteOffset = (v.byteOffset ?? 0) + bufferStart[v.buffer]
  v.buffer = 0
}
json.bufferViews ??= []

// 贴图也塞进那一块里。
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }
for (const img of json.images ?? []) {
  if (img.uri == null) continue
  const bytes = readUri(img.uri)
  const mimeType = img.uri.startsWith('data:') ? img.uri.slice(5, img.uri.indexOf(';')) : MIME[extname(img.uri).toLowerCase()]
  if (!mimeType) throw new Error(`不认识的贴图格式：${img.uri}`)
  json.bufferViews.push({ buffer: 0, byteOffset: push(bytes), byteLength: bytes.length })
  img.name ??= img.uri.startsWith('data:') ? undefined : img.uri
  img.bufferView = json.bufferViews.length - 1
  img.mimeType = mimeType
  delete img.uri
}
json.buffers = [{ byteLength: size }]

// 老材质 → 通用材质：颜色贴图原样用，光泽度换算成粗糙度。
const OLD = 'KHR_materials_pbrSpecularGlossiness'
for (const m of json.materials ?? []) {
  const old = m.extensions?.[OLD]
  if (!old) continue
  m.pbrMetallicRoughness = {
    baseColorFactor: old.diffuseFactor ?? [1, 1, 1, 1],
    ...(old.diffuseTexture ? { baseColorTexture: old.diffuseTexture } : {}),
    metallicFactor: 0,
    roughnessFactor: 1 - (old.glossinessFactor ?? 1) * 0.6,
  }
  delete m.extensions[OLD]
  if (Object.keys(m.extensions).length === 0) delete m.extensions
}
for (const key of ['extensionsUsed', 'extensionsRequired']) {
  if (!json[key]) continue
  json[key] = json[key].filter((e) => e !== OLD)
  if (json[key].length === 0) delete json[key]
}

// glb = 12 字节文件头 + JSON 块 + 二进制块，每块 4 字节对齐（JSON 用空格补，二进制用 0 补）。
const text = Buffer.from(JSON.stringify(json), 'utf8')
const jsonChunk = Buffer.concat([text, Buffer.alloc(pad4(text.length) - text.length, 0x20)])
const bin = Buffer.concat(parts)
const header = Buffer.alloc(12)
header.writeUInt32LE(0x46546c67, 0) // 'glTF'
header.writeUInt32LE(2, 4)
header.writeUInt32LE(12 + 8 + jsonChunk.length + 8 + bin.length, 8)
const chunkHead = (length, type) => {
  const h = Buffer.alloc(8)
  h.writeUInt32LE(length, 0)
  h.writeUInt32LE(type, 4)
  return h
}
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, Buffer.concat([header, chunkHead(jsonChunk.length, 0x4e4f534a), jsonChunk, chunkHead(bin.length, 0x004e4942), bin]))

const x = json.asset?.extras ?? {}
console.log(`${out}  ${(12 + 16 + jsonChunk.length + bin.length) >> 10} KB`)
console.log(`  名称：${x.title ?? '?'}\n  作者：${x.author ?? '?'}\n  授权：${x.license ?? '?'}\n  来源：${x.source ?? '?'}`)
console.log(`  动画：${(json.animations ?? []).map((a) => a.name).join('、') || '无'}`)
