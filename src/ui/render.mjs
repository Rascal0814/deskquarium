// 画面：从正侧面看的鱼缸。最底下是一张背景图（自带的水族箱，或换上的任意图片），
// 上面是鱼、饵料、气泡和水面上的天气，用 canvas 2D 画；
// 有 3D 模型的鱼种例外：它们由 fish3d.mjs 画在一张透明的 WebGL 画布上，这里每帧把那张画布贴进来。
// 尺寸自适应：所有位置按屏幕比例或短边比例算，换分辨率 / 缩放 / 横竖屏只要重新 resize。
import { SPECIES, makeRng, randomGenome } from '../sim/species.mjs'
import { WATER_BOTTOM } from './motion.mjs'
import { bakeFish, fishBox } from './fishpaint.mjs'
import { fishLayer } from './fish3d.mjs'

const TAU = Math.PI * 2
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
// 4K 屏不按原生分辨率画：壁纸看不出差别，显卡负担差四倍。
const MAX_PIXELS = 2560 * 1440

// ---------------------------------------------------------------------------
// 鱼的贴图：给还没有 3D 模型的鱼种用（有模型的见 fish3d.mjs）。
// 坐标单位是「体长」：吻在 x=+0.5，尾柄在 x=-0.36，头朝右，y 向下。
// 贴图是代码逐像素画的（fishpaint.mjs），画一次存着（见 createRenderer 里的 spriteFor），
// 游动时只是把贴图切成竖条错开来贴。
// ---------------------------------------------------------------------------

// 这种鱼的贴图范围（体长为单位）。
const boxFor = fishBox

// 画一张贴图：want 是一个体长画成多少像素；fade：0 正常，越大越发灰（不健康 / 死了）。
function makeSprite(fish, fade, want) {
  const sp = SPECIES[fish.species]
  const youth = clamp((sp.matureLength - fish.length) / sp.matureLength, 0, 1) // 鱼苗眼睛显得大
  return bakeFish({ ...fish, youth }, fade, want)
}

// 选鱼界面用：把这种鱼的样子画到一个小 canvas 上。
export function paintPreview(canvas, species) {
  const sp = SPECIES[species]
  const box = boxFor(species)
  const dpr = window.devicePixelRatio || 1
  const w = canvas.clientWidth
  const h = canvas.clientHeight
  canvas.width = Math.round(w * dpr)
  canvas.height = Math.round(h * dpr)
  const k = canvas.getContext('2d')
  k.setTransform(dpr, 0, 0, dpr, 0, 0)
  if (fishLayer().has(species)) return fishLayer().preview(species, k, w, h, dpr)
  const len = Math.min(w / box.width, h / box.height) * 0.94
  // 固定种子：每次打开选鱼界面看到的是同一条。
  const fish = { species, genome: randomGenome(species, makeRng(species.length * 7919)), length: sp.maxLength * 0.8 }
  const sprite = makeSprite(fish, 0, Math.max(24, Math.round(len * dpr)))
  k.imageSmoothingQuality = 'high'
  k.drawImage(sprite, (w - box.width * len) / 2, (h - box.height * len) / 2, box.width * len, box.height * len)
}

// ---------------------------------------------------------------------------

// plain（托盘里关掉「光影和天气效果」，或开发用的 --plain）：背景上什么都不叠——暗角、光柱、水纹、
// 水质和天气的雾、夜色全关，只剩背景图、鱼、气泡，画面和背景图本身一样清楚。
export function createRenderer(canvas, opts = {}) {
  let plain = !!opts.plain
  let nightlight = opts.nightlight !== false // 小夜灯：夜里右上角亮一盏灯（托盘里能关）
  const g =canvas.getContext('2d', { alpha: false })
  let W = 1
  let H = 1
  let short = 1
  let scale = 1
  let floor = null // 每帧贴的那张底图（背景加四周的暗角），resize 或换背景时重烤
  let picture = null // 换上的背景图；null 就用自带的水族箱
  let causticPattern = null
  const layer3d = fishLayer()
  let ambient = null // 背景的平均颜色 [r, g, b]（0~1）：3D 的鱼身上的光往这个色调上靠，鱼和背景才像在同一处
  const sprites = new Map() // fish.id → { key, bitmap, box }
  const rings = [] // 饵料落水、鱼吃食的小水圈
  const drops = [] // 雨点打在水面上
  const flakes = []
  const bubbles = []
  let flash = 0
  let nextFlash = 4
  let fresh = 0 // 刚换过水的那一下亮光
  let rainCarry = 0
  let snowCarry = 0
  let bubbleCarry = 0
  let plants = [] // 背景里的每丛水草在画面上的哪里 { x, y, rx, ry }（中心和左右、上下的半径）；不知道哪里有草就是空的
  let pictureSpots = [] // 背景图带来的水草位置（按图片的比例，0~1）；铺到画面上之后换算成 plants

  const sandTop = () => H * (1 - WATER_BOTTOM + 0.02)

  function resize() {
    W = Math.max(1, canvas.clientWidth)
    H = Math.max(1, canvas.clientHeight)
    short = Math.min(W, H)
    scale = Math.min(window.devicePixelRatio || 1, Math.sqrt(MAX_PIXELS / (W * H)))
    canvas.width = Math.round(W * scale)
    canvas.height = Math.round(H * scale)
    layer3d.setSize(W, H, scale)
    bakeFloor()
    if (!causticPattern) causticPattern = g.createPattern(bakeCaustic().transferToImageBitmap(), 'repeat')
    rings.length = drops.length = flakes.length = bubbles.length = 0
    // 一条 70cm 的锦鲤约占短边的五分之一（1440p 上 300 像素左右），其余按 displayLength 折算。
    return { W, H, lenUnit: (short * 0.208) / Math.pow(70, 0.6) }
  }

  // 背景：一次画好存成图，每帧只贴一下。背景就是「一张壁纸」——
  // 默认是自带的水族箱（水、沙底、石头、水草都画在这张图里），也可以换成任意图片（setBackground）。
  // 鱼、饵料、天气都画在它上面。
  function bakeFloor() {
    const c = new OffscreenCanvas(canvas.width, canvas.height)
    const f = c.getContext('2d')
    f.setTransform(scale, 0, 0, scale, 0, 0)
    plants = []
    if (picture) paintPicture(f)
    else paintTank(f)
    // 四周压暗一点，图标和面板在边上更好认。
    if (!plain) {
      const vg = f.createRadialGradient(W / 2, H / 2, short * 0.5, W / 2, H / 2, Math.hypot(W, H) * 0.58)
      vg.addColorStop(0, 'rgba(0,0,0,0)')
      vg.addColorStop(1, 'rgba(0,12,24,0.36)')
      f.fillStyle = vg
      f.fillRect(0, 0, W, H)
    }
    // 顺手量一下背景整体是什么颜色（缩成 4×4 再取平均）。
    const tiny = new OffscreenCanvas(4, 4).getContext('2d', { willReadFrequently: true })
    tiny.drawImage(c, 0, 0, 4, 4)
    const px = tiny.getImageData(0, 0, 4, 4).data
    ambient = [0, 0, 0]
    for (let i = 0; i < px.length; i += 4) for (let j = 0; j < 3; j++) ambient[j] += px[i + j] / (255 * 16)
    // 转成 ImageBitmap：它是显存里的一张贴图，每帧贴一下几乎不花钱。
    // 直接拿 OffscreenCanvas 去 drawImage 的话，每帧都要把整屏像素重新传一遍（实测显卡进程吃掉半个核）。
    if (floor) floor.close()
    floor = c.transferToImageBitmap()
  }

  // 换背景。传 ImageBitmap 换成那张图，传 null 用代码画的水族箱（自带的图读不出来时的后备）。
  // spots：这张图里水草在哪（按图片的比例，见 scenes.js）；不知道就不传，那就不冒气泡。
  function setBackground(bitmap, spots) {
    if (picture) picture.close()
    picture = bitmap
    pictureSpots = bitmap && Array.isArray(spots) ? spots : []
    bakeFloor()
  }

  // 换上的图按「铺满、居中、超出的裁掉」摆：什么比例的屏幕都不留黑边、不变形。
  function paintPicture(f) {
    const k = Math.max(W / picture.width, H / picture.height)
    const w = picture.width * k
    const h = picture.height * k
    f.imageSmoothingQuality = 'high'
    f.drawImage(picture, (W - w) / 2, (H - h) / 2, w, h)
    // 图里的水草跟着图一起铺到画面上（裁到画面外面去的就不要了）。
    for (const s of pictureSpots) {
      const x = (W - w) / 2 + s.x * w
      const y = (H - h) / 2 + s.y * h
      if (x >= 0 && x <= W && y >= 0 && y <= H) plants.push({ x, y, rx: s.rx * w, ry: s.ry * h })
    }
  }

  // 自带的水族箱：水、远处的礁石和水草剪影、沙底、石头、近处的水草。
  function paintTank(f) {
    const rng = makeRng(42)
    const sand = sandTop()
    const water = f.createLinearGradient(0, 0, 0, H)
    water.addColorStop(0, '#4ab6d4')
    water.addColorStop(0.3, '#2189b0')
    water.addColorStop(0.72, '#0f6088')
    water.addColorStop(1, '#083c5e')
    f.fillStyle = water
    f.fillRect(0, 0, W, H)

    // 远处：发蓝发虚的礁石和水草，只是剪影
    f.fillStyle = 'rgba(9,66,98,0.5)'
    for (let i = 0; i < 6; i++) {
      const x = rng() * W
      const w = short * (0.25 + rng() * 0.35)
      const h = short * (0.1 + rng() * 0.22)
      f.beginPath()
      f.moveTo(x - w / 2, sand + 4)
      f.bezierCurveTo(x - w * 0.35, sand - h * 1.2, x + w * 0.2, sand - h * 1.1, x + w / 2, sand + 4)
      f.fill()
    }
    for (let i = 0; i < 40; i++) {
      blade(f, rng() * W, sand + 4, short * (0.08 + rng() * 0.2), short * 0.012, (rng() - 0.5) * short * 0.08, '#0c5468', '#146874', 0.45)
    }

    // 沙底：上沿有点起伏
    const hill = (x) => sand + Math.sin(x / (short * 0.21) + 1.3) * short * 0.008 + Math.sin(x / (short * 0.07)) * short * 0.003
    f.beginPath()
    f.moveTo(0, H)
    for (let x = 0; x <= W + 16; x += 16) f.lineTo(x, hill(x))
    f.lineTo(W, H)
    f.closePath()
    const sg = f.createLinearGradient(0, sand, 0, H)
    sg.addColorStop(0, '#e6d3a1')
    sg.addColorStop(0.5, '#c2a56c')
    sg.addColorStop(1, '#8e7348')
    f.fillStyle = sg
    f.fill()
    const grains = ['#f4e6bd', '#b89a63', '#9c8052', '#d9c48f', '#7f6a45']
    for (let i = 0, n = Math.round(W * 1.2); i < n; i++) {
      const x = rng() * W
      f.globalAlpha = 0.25 + rng() * 0.45
      f.fillStyle = grains[Math.floor(rng() * grains.length)]
      f.beginPath()
      f.arc(x, hill(x) + 3 + rng() * (H - sand), 0.6 + rng() * 1.6, 0, TAU)
      f.fill()
    }
    f.globalAlpha = 1

    // 石头：半埋在沙里
    for (let i = 0; i < 9; i++) {
      const x = rng() * W
      const rx = short * (0.025 + rng() * 0.05)
      const ry = rx * (0.5 + rng() * 0.3)
      const y = hill(x) + ry * 0.25
      const rg = f.createRadialGradient(x - rx * 0.3, y - ry * 0.6, rx * 0.1, x, y, rx * 1.1)
      rg.addColorStop(0, '#9aa7a6')
      rg.addColorStop(0.6, '#5f6f72')
      rg.addColorStop(1, '#374548')
      f.fillStyle = rg
      f.beginPath()
      f.ellipse(x, y, rx, ry, 0, Math.PI, TAU)
      f.ellipse(x, y, rx, ry * 0.35, 0, 0, Math.PI)
      f.fill()
    }

    // 近处的水草：几丛，每丛几片叶子
    const greens = [['#1f7a48', '#58b85a'], ['#22805c', '#6cc487'], ['#2a6e3a', '#86c34e'], ['#7a3f36', '#c06a52']]
    for (const cx of [0.2, 0.33, 0.47, 0.61, 0.74, 0.88, 0.96]) {
      const [lo, hi] = greens[Math.floor(rng() * greens.length)]
      const count = 5 + Math.floor(rng() * 6)
      const tall = short * (0.12 + rng() * 0.26)
      plants.push({ x: cx * W, y: sand - tall * 0.55, rx: short * 0.03, ry: tall * 0.35 }) // 记下这丛草在哪：气泡从草叶上冒
      for (let i = 0; i < count; i++) {
        const x = cx * W + (rng() - 0.5) * short * 0.07
        blade(f, x, hill(x) + 6, tall * (0.5 + rng() * 0.5), short * (0.008 + rng() * 0.008), (rng() - 0.5) * short * 0.1, lo, hi, 1)
      }
    }
  }

  // 一片水草叶子：从 (x, y) 往上长 h 高，底宽 w，叶尖往旁边偏 lean。
  function blade(f, x, y, h, w, lean, lo, hi, alpha) {
    const lg = f.createLinearGradient(0, y, 0, y - h)
    lg.addColorStop(0, lo)
    lg.addColorStop(1, hi)
    f.globalAlpha = alpha
    f.fillStyle = lg
    f.beginPath()
    f.moveTo(x - w, y)
    f.quadraticCurveTo(x - w + lean * 0.15, y - h * 0.55, x + lean, y - h)
    f.quadraticCurveTo(x + w + lean * 0.45, y - h * 0.5, x + w, y)
    f.closePath()
    f.fill()
    f.globalAlpha = 1
  }

  // 水里晃动的光网：一张能无缝平铺的贴图，运行时叠两层、各自慢慢移动。
  function bakeCaustic() {
    // 做法：撒一把点，每个像素算「到最近的点」和「到第二近的点」的距离差——
    // 差越小越靠近两个格子的交界，交界处最亮，连起来就是水底那种网状的光。
    // 距离按环绕算（出了右边从左边回来），所以贴图四边能接上。
    const S = 256
    const c = new OffscreenCanvas(S, S)
    const k = c.getContext('2d')
    const img = k.createImageData(S, S)
    const rng = makeRng(7)
    const pts = Array.from({ length: 44 }, () => [rng() * S, rng() * S])
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        let f1 = Infinity
        let f2 = Infinity
        // 取样点先扭一下，格子的边就不是笔直的；扭的周期整除贴图边长，四边照样接得上。
        const sx = x + 6 * Math.sin((TAU * 3 * y) / S) + 3 * Math.sin((TAU * 5 * x) / S + 1)
        const sy = y + 6 * Math.sin((TAU * 2 * x) / S + 2) + 3 * Math.sin((TAU * 4 * y) / S)
        for (const p of pts) {
          let dx = Math.abs((((sx - p[0]) % S) + S) % S)
          let dy = Math.abs((((sy - p[1]) % S) + S) % S)
          if (dx > S / 2) dx = S - dx
          if (dy > S / 2) dy = S - dy
          const d = Math.hypot(dx, dy)
          if (d < f1) {
            f2 = f1
            f1 = d
          } else if (d < f2) {
            f2 = d
          }
        }
        const i = (y * S + x) * 4
        img.data[i] = img.data[i + 1] = img.data[i + 2] = 255
        img.data[i + 3] = Math.round(255 * Math.pow(1 - clamp((f2 - f1) / 13, 0, 1), 2.4))
      }
    }
    k.putImageData(img, 0, 0)
    return c
  }

  // ---- 鱼 ----
  // 这条鱼现在该用哪张贴图。体长每涨 25%、健康变了一档、或者死了，才重画一张。
  // 重画不便宜（代码画的鱼是逐像素算的），一帧最多画 bakeBudget 张；轮不到的先用旧图，连旧图都没有就这一帧先不画。
  let bakeBudget = 0
  function spriteFor(fish, b) {
    const want = Math.min(1000, Math.pow(1.25, Math.ceil(Math.log(Math.max(24, b.lenPx * scale)) / Math.log(1.25))))
    const fade = fish.dead ? 0.62 : (Math.round((1 - fish.health / 100) * 4) / 4) * 0.4
    const key = `${Math.round(want)}|${fade}`
    let s = sprites.get(fish.id)
    if (s && s.key === key) return s
    if (bakeBudget <= 0) return s ?? null
    bakeBudget--
    if (s) s.bitmap.close()
    s = { key, bitmap: makeSprite(fish, fade, Math.round(want)).transferToImageBitmap(), box: boxFor(fish.species) }
    sprites.set(fish.id, s)
    return s
  }

  // 把贴图切成竖条，从头到尾一条条错开来贴：尾巴那头上下摆，摆到侧面时看起来短一点。
  // 每条竖条按摆动曲线的斜率斜切一下，相邻两条的边正好接上，轮廓不会出台阶。
  function drawFish(b, fish) {
    const s = spriteFor(fish, b)
    if (!s) return
    const L = b.lenPx
    const { box, bitmap } = s
    const dead = !!fish.dead
    const squash = b.turn > 0 ? Math.max(0.1, Math.abs(Math.cos(Math.PI * b.turn))) : 1
    g.save()
    g.translate(b.x, b.y)
    g.rotate(b.dir * b.pitch)
    g.scale(b.dir * squash, dead ? -1 : 1) // 死鱼肚皮朝上
    if (dead) g.globalAlpha = 0.85
    const w = box.width * L
    const h = box.height * L
    const top = -box.up * L
    const strips = dead || L < 30 ? 1 : L < 90 ? 10 : 18
    if (strips === 1) {
      g.drawImage(bitmap, -box.left * L, top, w, h)
    } else {
      const amp = (0.02 + 0.045 * clamp(b.effort, 0, 1)) * L
      const sway = Math.sin(b.phase - 2.4)
      const sw = bitmap.width / strips
      // u：0 头，1 尾。这一处往上下偏多少。
      const wave = (u) => amp * u * u * Math.sin(b.phase - u * 2.4)
      let right = w - box.left * L
      for (let i = strips - 1; i >= 0; i--) {
        const uR = 1 - (i + 1) / strips
        const uL = 1 - i / strips
        const squeeze = uL > 0.6 ? 1 - 0.3 * (((uL + uR) / 2 - 0.6) / 0.4) * (0.5 + 0.5 * sway) : 1
        const dw = (w / strips) * Math.max(0.4, squeeze)
        const yR = wave(uR)
        const yL = wave(uL)
        const shear = (yR - yL) / dw
        const left = right - dw
        g.save()
        g.transform(1, shear, 0, 1, 0, yL - shear * left)
        g.drawImage(bitmap, i * sw, 0, sw, bitmap.height, left - 0.35, top, dw + 0.7, h)
        g.restore()
        right = left
      }
    }
    g.restore()
  }

  function addRipple(x, y, size = 1) {
    rings.push({ x, y, age: 0, life: 0.7 + Math.random() * 0.5, r: (8 + Math.random() * 10) * size })
  }

  // 换水的那一下：水亮一下，满缸冒泡。
  function splash() {
    fresh = 1
    for (let i = 0; i < 90; i++) {
      bubbles.push({ x: Math.random() * W, y: sandTop() - Math.random() * H * 0.7, r: 1.5 + Math.random() * 4, vy: 50 + Math.random() * 80, wob: Math.random() * TAU })
    }
  }

  // scene: { t（秒）, dt, state, bodies, food, env, hover }
  function draw(scene) {
    const { t, dt, state, bodies, food, env } = scene
    const surface = 5 // 水面离屏幕顶边几个像素
    g.setTransform(scale, 0, 0, scale, 0, 0)
    g.globalAlpha = 1
    g.globalCompositeOperation = 'source-over'
    g.drawImage(floor, 0, 0, W, H)

    // 水脏了发绿发浑。水质 80 以上是清的，一点不蒙；再往下才慢慢浑起来
    // （以前从一开始就蒙，刚换完水画面也是灰的，看着像图糊了）。
    const murk = clamp((state.water.dirt / 100 - 0.2) / 0.8, 0, 1)
    if (murk > 0 && !plain) {
      g.fillStyle = `rgba(74,98,24,${(murk * 0.6).toFixed(3)})`
      g.fillRect(0, 0, W, H)
    }

    // 从水面斜着照下来的几道光（在鱼的后面）：白天是日光，晴朗的夜里是月光
    const sun = env.light * (1 - env.cloud * 0.85)
    const moon = clamp((0.4 - env.light) / 0.4, 0, 1) * (1 - env.cloud) * 0.45
    const beam = Math.max(sun, moon)
    if (beam > 0.03 && !plain) {
      g.globalCompositeOperation = 'lighter'
      const reach = H * 0.9
      const bg = g.createLinearGradient(0, 0, 0, reach)
      const tone = sun >= moon ? '255,248,214' : '190,214,255'
      // 背景是图片时调淡：图里本来就有光，再叠上几道笔直的光柱就显得是画上去的。
      bg.addColorStop(0, `rgba(${tone},${((picture ? 0.035 : 0.09) * beam).toFixed(3)})`)
      bg.addColorStop(1, `rgba(${tone},0)`)
      g.fillStyle = bg
      for (let i = 0; i < 5; i++) {
        const x = W * (0.12 + i * 0.2) + Math.sin(t * 0.17 + i * 1.9) * W * 0.02
        const w = short * (0.03 + 0.022 * (i % 3))
        const lean = -reach * (0.28 + env.wind * 0.1)
        g.beginPath()
        g.moveTo(x, 0)
        g.lineTo(x + w, 0)
        g.lineTo(x + w * 2.6 + lean, reach)
        g.lineTo(x - w * 0.8 + lean, reach)
        g.closePath()
        g.fill()
      }
      g.globalCompositeOperation = 'source-over'
    }

    // 卵：池底一小簇透明的珠子
    for (const clutch of state.eggs) {
      const rng = makeRng(clutch.id * 977)
      const ex = clutch.x * W
      const ey = sandTop() + 2
      for (let i = 0; i < clutch.count * 6; i++) {
        const a = Math.PI + rng() * Math.PI
        const d = rng() * 22
        const x = ex + Math.cos(a) * d
        const y = ey + Math.sin(a) * d * 0.5
        g.fillStyle = 'rgba(255,236,190,0.6)'
        g.beginPath()
        g.arc(x, y, 2.8, 0, TAU)
        g.fill()
        g.fillStyle = 'rgba(120,80,30,0.7)'
        g.beginPath()
        g.arc(x + 0.6, y + 0.4, 1, 0, TAU)
        g.fill()
      }
    }

    // 鱼：从小到大画（大鱼在前面）
    bakeBudget = 2
    const order = state.fish
      .map((fish) => [fish, bodies.get(fish.id)])
      .filter(([, b]) => b)
      .sort((a, b) => a[1].lenPx - b[1].lenPx)
    const solid = [] // 有 3D 模型的鱼攒起来一起画
    for (const [fish, b] of order) {
      if (!layer3d.has(fish.species)) {
        drawFish(b, fish)
        continue
      }
      // 掉头：真的转过来，中途正对着人。b.dir 在转到一半时换向，所以起始朝向要看 flipped。
      const from = b.flipped ? -b.dir : b.dir
      const k = b.turn > 0 ? b.turn * b.turn * (3 - 2 * b.turn) : 0
      solid.push({
        id: fish.id, species: fish.species, x: b.x, y: b.y, lenPx: b.lenPx,
        yaw: from > 0 ? -Math.PI * k : -Math.PI * (1 - k),
        pitch: b.pitch * (b.peck > 0 ? 0.9 : 0.4), // 真鱼上下挪的时候身子没有歪那么多；在池底啄食时才真的扎下去
        phase: b.phase, effort: b.effort, dt,
        tone: fish.genome?.base, dead: !!fish.dead,
        fade: fish.dead ? 0.62 : (Math.round((1 - fish.health / 100) * 4) / 4) * 0.4,
      })
    }
    if (solid.length > 0 || layer3d.count() > 0) {
      layer3d.render(solid, { level: plain ? 1 : 0.5 + 0.5 * sun, tint: ambient }) // 画面不随昼夜变暗时，鱼也不变暗
      if (solid.length > 0) g.drawImage(layer3d.canvas, 0, 0, W, H)
    }
    if (sprites.size > order.length) {
      const here = new Set(order.map(([fish]) => fish.id))
      for (const [id, s] of sprites) {
        if (!here.has(id)) {
          s.bitmap.close()
          sprites.delete(id)
        }
      }
    }

    // 饵料
    for (const p of food) {
      g.globalAlpha = p.rested > 0 ? clamp(1 - (p.rested - 15) / 10, 0.2, 1) : 1
      g.fillStyle = '#a8742f'
      g.beginPath()
      g.arc(p.x, p.y, 3, 0, TAU)
      g.fill()
      g.fillStyle = 'rgba(255,226,160,0.7)'
      g.beginPath()
      g.arc(p.x - 0.9, p.y - 0.9, 1.1, 0, TAU)
      g.fill()
    }
    g.globalAlpha = 1

    // 气泡：水草见了光做光合作用，叶子上冒出细小的氧气泡——光越强冒得越多，阴天少，夜里没有。
    // 缸里没装气泵，所以没有别的来源：背景里没有水草（自选的图、系统壁纸）就不冒泡；草少的缸泡也少。
    // 换水时满缸的那一阵是另一回事，见 splash。
    if (plants.length > 0 && sun > 0.15) {
      bubbleCarry += dt * 4 * (sun - 0.15) * Math.min(1.5, plants.length / 7)
      while (bubbleCarry >= 1 && bubbles.length < 160) {
        bubbleCarry -= 1
        const p = plants[Math.floor(Math.random() * plants.length)]
        bubbles.push({
          x: p.x + (Math.random() - 0.5) * 2 * p.rx,
          y: p.y + (Math.random() - 0.5) * 2 * p.ry,
          r: 0.7 + Math.random() * 1.4, vy: 30 + Math.random() * 35, wob: Math.random() * TAU,
        })
      }
    }
    g.lineWidth = 1
    g.strokeStyle = 'rgba(235,250,255,0.55)'
    g.fillStyle = 'rgba(235,250,255,0.12)'
    for (let i = bubbles.length - 1; i >= 0; i--) {
      const q = bubbles[i]
      q.y -= q.vy * dt
      q.x += Math.sin(t * 3 + q.wob) * 12 * dt
      if (q.y < surface + 2) {
        bubbles.splice(i, 1)
        continue
      }
      g.beginPath()
      g.arc(q.x, q.y, q.r, 0, TAU)
      g.fill()
      g.stroke()
    }

    // 饵料落水、鱼吃食溅起的小水圈
    g.lineWidth = 1.2
    for (let i = rings.length - 1; i >= 0; i--) {
      const r = rings[i]
      r.age += dt
      const k = r.age / r.life
      if (k >= 1) {
        rings.splice(i, 1)
        continue
      }
      g.strokeStyle = `rgba(230,246,252,${((1 - k) * 0.5).toFixed(3)})`
      g.beginPath()
      g.arc(r.x, r.y, r.r * (0.2 + k), 0, TAU)
      g.stroke()
    }

    // 悬停的那条鱼：一圈虚线
    if (scene.hover) {
      const b = bodies.get(scene.hover.id)
      if (b) {
        g.strokeStyle = 'rgba(255,255,255,0.6)'
        g.lineWidth = 1.5
        g.setLineDash([6, 6])
        g.beginPath()
        g.ellipse(b.x, b.y, b.lenPx * 0.62 + 8, b.lenPx * SPECIES[scene.hover.species].depth * 0.8 + 10, 0, 0, TAU)
        g.stroke()
        g.setLineDash([])
      }
    }

    // 水里晃动的光网，晴天才有
    if (sun > 0.03 && causticPattern && !plain) {
      g.globalCompositeOperation = 'lighter'
      g.fillStyle = causticPattern
      g.globalAlpha = (picture ? 0.018 : 0.04) * sun // 背景是图片时调淡，不然一张网罩在照片上很假
      for (const [s, vx, vy] of [[3.2, 9, 5], [4.6, -6, 8]]) {
        causticPattern.setTransform(new DOMMatrix().translate(t * vx, t * vy).scale(s * (short / 1080)))
        g.fillRect(0, 0, W, H)
      }
      g.globalCompositeOperation = 'source-over'
      g.globalAlpha = 1
    }

    // 阴天整体发灰发暗；雾天蒙一层白
    if (env.cloud > 0.25 && !plain) {
      g.fillStyle = `rgba(30,44,58,${(env.cloud * 0.26).toFixed(3)})`
      g.fillRect(0, 0, W, H)
    }
    if (env.fog > 0 && !plain) {
      g.fillStyle = 'rgba(222,230,235,0.24)'
      g.fillRect(0, 0, W, H)
    }

    // 水面：屏幕最上面一道起伏的亮线，风越大浪越大
    const wave = (x) => surface + Math.sin(x * 0.012 + t * 1.3) * (1.5 + env.wind * 6) + Math.sin(x * 0.031 - t * 0.9) * 1.2
    g.beginPath()
    g.moveTo(0, 0)
    for (let x = 0; x <= W + 24; x += 24) g.lineTo(x, wave(x))
    g.lineTo(W, 0)
    g.closePath()
    g.fillStyle = 'rgba(255,255,255,0.16)'
    g.fill()
    g.strokeStyle = 'rgba(255,255,255,0.4)'
    g.lineWidth = 1.5
    g.beginPath()
    for (let x = 0; x <= W + 24; x += 24) g.lineTo(x, wave(x))
    g.stroke()

    // 雨：打在水面上，溅一圈、带一道水痕扎进水里
    if (env.rain > 0) {
      rainCarry += env.rain * (W / 1000) * 46 * dt
      while (rainCarry >= 1 && drops.length < 400) {
        rainCarry -= 1
        drops.push({ x: Math.random() * W, age: 0, life: 0.5 + Math.random() * 0.5, len: (30 + Math.random() * 70) * (0.6 + env.rain) })
      }
    }
    g.lineCap = 'round'
    for (let i = drops.length - 1; i >= 0; i--) {
      const d = drops[i]
      d.age += dt
      const k = d.age / d.life
      if (k >= 1) {
        drops.splice(i, 1)
        continue
      }
      const y = wave(d.x)
      g.strokeStyle = `rgba(228,244,252,${((1 - k) * 0.6).toFixed(3)})`
      g.lineWidth = 1.3
      g.beginPath()
      g.ellipse(d.x, y, 4 + k * 16, 1.5 + k * 3, 0, 0, TAU)
      g.stroke()
      g.lineWidth = 2
      g.beginPath()
      g.moveTo(d.x, y + d.len * k * 0.5)
      g.lineTo(d.x - 2, y + d.len * Math.min(1, k * 1.6))
      g.stroke()
    }

    // 雪：落到水面，往下飘一小段就化了
    if (env.snow > 0) {
      snowCarry += env.snow * (W / 1000) * 18 * dt
      while (snowCarry >= 1 && flakes.length < 500) {
        snowCarry -= 1
        flakes.push({ x: Math.random() * W, y: -4, r: 1.5 + Math.random() * 2.5, age: 0, life: 2.5 + Math.random() * 3, sway: Math.random() * TAU })
      }
    }
    g.fillStyle = '#ffffff'
    for (let i = flakes.length - 1; i >= 0; i--) {
      const f = flakes[i]
      f.age += dt
      const k = f.age / f.life
      if (k >= 1) {
        flakes.splice(i, 1)
        continue
      }
      f.x += (env.wind * 50 + Math.sin(f.sway + t * 1.5) * 14) * dt
      f.y += 26 * dt
      g.globalAlpha = (1 - k) * 0.9
      g.beginPath()
      g.arc(f.x, f.y, f.r * (1 - k * 0.5), 0, TAU)
      g.fill()
    }
    g.globalAlpha = 1

    // 夜里压暗
    const night = 1 - env.light
    // 小夜灯：挂在右上角，天快黑透了才慢慢亮起来，天亮前慢慢灭。0 = 没亮，1 = 全亮。
    const { lamp, x: lx, y: ly, u } = nightState(env)
    if (night > 0.01 && !plain) {
      // 最暗压到四成：再暗的话整个晚上桌面都是灰蒙蒙一片，看着像图糊了（原来是 0.58）。
      // 开着夜灯时远处再暗一点（屋里关了灯），灯照到的那一片几乎不压——有明有暗才看得出是一盏灯。
      const dark = night * (0.4 + 0.22 * lamp)
      if (lamp > 0) {
        const film = g.createRadialGradient(lx, ly, short * 0.05, lx, ly, short * 1.05)
        film.addColorStop(0, `rgba(3,10,32,${(dark * (1 - 0.92 * lamp)).toFixed(3)})`)
        film.addColorStop(0.45, `rgba(3,10,32,${(dark * (1 - 0.5 * lamp)).toFixed(3)})`)
        film.addColorStop(1, `rgba(3,10,32,${dark.toFixed(3)})`)
        g.fillStyle = film
      } else {
        g.fillStyle = `rgba(3,10,32,${dark.toFixed(3)})`
      }
      g.fillRect(0, 0, W, H)
    }
    if (lamp > 0) {
      // 灯光：一团暖黄的光晕罩在水里，离灯越远越淡
      const reach = short * 0.8
      g.globalCompositeOperation = 'lighter'
      const glow = g.createRadialGradient(lx, ly, 0, lx, ly, reach)
      glow.addColorStop(0, `rgba(255,206,138,${(0.42 * lamp).toFixed(3)})`)
      glow.addColorStop(0.25, `rgba(255,194,118,${(0.17 * lamp).toFixed(3)})`)
      glow.addColorStop(0.6, `rgba(255,190,110,${(0.05 * lamp).toFixed(3)})`)
      glow.addColorStop(1, 'rgba(255,186,104,0)')
      g.fillStyle = glow
      g.fillRect(lx - reach, 0, reach * 2, ly + reach)
      g.globalCompositeOperation = 'source-over'
      // 灯本身：从顶边垂下来一截杆子，一个小灯罩，底下一颗亮着的灯泡
      g.globalAlpha = lamp
      g.fillStyle = '#1b2228'
      g.fillRect(lx - 2.5 * u, 0, 5 * u, ly - 16 * u)
      g.beginPath()
      g.moveTo(lx - 11 * u, ly - 18 * u)
      g.lineTo(lx + 11 * u, ly - 18 * u)
      g.lineTo(lx + 25 * u, ly)
      g.lineTo(lx - 25 * u, ly)
      g.closePath()
      g.fill()
      const bulb = g.createRadialGradient(lx, ly + 2 * u, 0, lx, ly + 2 * u, 20 * u)
      bulb.addColorStop(0, 'rgba(255,250,232,1)')
      bulb.addColorStop(0.4, 'rgba(255,224,160,0.95)')
      bulb.addColorStop(1, 'rgba(255,200,120,0)')
      g.fillStyle = bulb
      g.beginPath()
      g.ellipse(lx, ly + 2 * u, 20 * u, 9 * u, 0, 0, TAU)
      g.fill()
      g.globalAlpha = 1
    }

    // 雷：隔一阵闪一下（两连闪）
    if (env.thunder) {
      nextFlash -= dt
      if (nextFlash <= 0) {
        flash = 1
        nextFlash = 6 + Math.random() * 14
      }
    }
    if (flash > 0) {
      const a = flash > 0.6 ? flash : flash > 0.45 ? 0.1 : flash * 1.6
      g.fillStyle = `rgba(235,240,255,${(a * 0.5).toFixed(3)})`
      g.fillRect(0, 0, W, H)
      flash = Math.max(0, flash - dt * 2.2)
    }

    if (fresh > 0) {
      g.fillStyle = `rgba(190,235,255,${(fresh * 0.28).toFixed(3)})`
      g.fillRect(0, 0, W, H)
      fresh = Math.max(0, fresh - dt * 0.6)
    }
  }

  // 开关「干净」的画面。暗角是烤在底图里的，所以要重烤一次。
  function setPlain(v) {
    plain = !!v
    bakeFloor()
  }

  function setNightlight(v) {
    nightlight = !!v
  }

  // 画面上现在有多「夜」：dark 天黑透了没有（0~1，天快黑透才开始涨；画面不随昼夜变暗时一直是 0），
  // lamp 小夜灯亮了几成，(x, y) 灯在哪，u 灯的大小单位。画面和鱼的作息（motion）都看这一个数，两边才对得上。
  function nightState(env) {
    const k = plain ? 0 : clamp((1 - env.light - 0.55) / 0.35, 0, 1)
    const dark = k * k * (3 - 2 * k)
    const u = (short / 1080) * 1.5
    return { dark, lamp: nightlight ? dark : 0, x: W - 130 * u, y: 36 * u, u }
  }

  return { resize, draw, addRipple, splash, setBackground, setPlain, setNightlight, nightState }
}
