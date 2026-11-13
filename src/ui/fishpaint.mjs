// 鱼的侧面像。不是矢量填色，是逐像素算出来的：
//   身体当成一个有厚度的立体（横截面是椭圆），每个像素算朝向、受光、鳞片的凹凸和反光；
//   花纹按「一片鳞一个颜色」落在鳞片上，边缘自然沿着鳞片走；
//   鳍是半透明的膜加鳍条，眼睛、鳃盖、嘴单独画。
// 只在贴图需要重画时跑一次（见 render.mjs 的 spriteFor），不是每帧跑。
//
// 坐标单位是「体长」：吻尖在 x=+0.5，尾柄末端在 x=-0.36，头朝右，y 向下。
// u 是沿身体的位置：0 吻尖，1 尾柄末端。v 是身体高度上的位置：-1 背缘，+1 腹缘。
import { COLORS } from '../sim/species.mjs'

const TAU = Math.PI * 2
const SL = 0.86 // 吻尖到尾柄末端
const U_END = 1.05 // 身体画到这里（盖住尾鳍根部，渐渐透明）
const N = 420 // 轮廓查表的精度
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const lerp = (a, b, t) => a + (b - a) * t
const smooth = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1)
  return t * t * (3 - 2 * t)
}
const X = (u) => 0.5 - u * SL

// ---------------------------------------------------------------------------
// 每种鱼的体型。dors / vent：背线、腹线离中轴多远，从 u=0 到 u=1 每隔 0.1 一个值。
// ---------------------------------------------------------------------------
const FORM = {
  // 锦鲤：纺锤形，头钝，嘴偏下带两对须，背鳍基很长。
  koi: {
    dors: [0.05, 0.092, 0.12, 0.135, 0.14, 0.136, 0.124, 0.104, 0.082, 0.064, 0.056],
    vent: [0.04, 0.078, 0.104, 0.12, 0.128, 0.127, 0.116, 0.096, 0.074, 0.058, 0.052],
    cap: 0.075, capPow: 0.5, nose: 0.014,
    thick: 0.8, round: 2, // 身体多厚（相对身高）、横截面多方
    head: 0.25, // 鳃盖后缘
    eye: { u: 0.108, v: -0.3, r: 0.0185, iris: [0.62, 0.58, 0.46], top: [0.12, 0.11, 0.1] },
    scale: 0.027, scaleAmt: 1, wrap: true, mouth: 'low', barbel: true, sideLine: true,
  },
  // 金鱼（琉金 / 文鱼一类）：蛋形身子，背高，双尾。
  goldfish: {
    dors: [0.05, 0.11, 0.165, 0.2, 0.215, 0.21, 0.19, 0.155, 0.115, 0.08, 0.062],
    vent: [0.045, 0.1, 0.15, 0.19, 0.215, 0.225, 0.21, 0.17, 0.12, 0.078, 0.058],
    cap: 0.08, capPow: 0.55, nose: 0.01,
    thick: 0.92, round: 2,
    head: 0.24,
    eye: { u: 0.105, v: -0.2, r: 0.024, iris: [0.8, 0.74, 0.55], top: [0.2, 0.17, 0.12] },
    scale: 0.031, scaleAmt: 0.9, wrap: true, mouth: 'mid', sideLine: true,
  },
  // 神仙鱼：身子是个侧扁的圆盘，背鳍臀鳍像两片后掠的帆，腹鳍是两根长丝。
  angelfish: {
    dors: [0.04, 0.14, 0.235, 0.295, 0.32, 0.315, 0.28, 0.215, 0.14, 0.075, 0.045],
    vent: [0.04, 0.12, 0.21, 0.275, 0.305, 0.3, 0.265, 0.2, 0.13, 0.07, 0.042],
    cap: 0.13, capPow: 0.72, nose: 0.03,
    thick: 0.3, round: 3.2,
    head: 0.3,
    eye: { u: 0.18, v: -0.12, r: 0.034, iris: [0.86, 0.34, 0.12], top: [0.45, 0.1, 0.05] },
    scale: 0.02, scaleAmt: 0.4, mouth: 'mid',
    back: [0.42, 0.4, 0.3], backAmt: 0.45,
  },
  // 孔雀鱼（公）：身子细，嘴朝上，背鳍靠后，一把大扇尾。
  guppy: {
    dors: [0.03, 0.06, 0.082, 0.096, 0.104, 0.106, 0.1, 0.088, 0.072, 0.06, 0.054],
    vent: [0.035, 0.075, 0.105, 0.125, 0.132, 0.125, 0.105, 0.085, 0.07, 0.06, 0.054],
    cap: 0.07, capPow: 0.6, nose: -0.02,
    thick: 0.62, round: 2,
    head: 0.235,
    eye: { u: 0.085, v: -0.2, r: 0.03, iris: [0.78, 0.8, 0.8], top: [0.12, 0.13, 0.14] },
    scale: 0.03, scaleAmt: 0.45, mouth: 'up',
    back: [0.42, 0.44, 0.34], backAmt: 0.6, rearTint: true,
  },
  // 红绿灯：小纺锤，眼睛大，鳍透明，有脂鳍。
  neon: {
    dors: [0.04, 0.078, 0.102, 0.116, 0.122, 0.12, 0.108, 0.088, 0.066, 0.05, 0.042],
    vent: [0.04, 0.08, 0.108, 0.124, 0.13, 0.126, 0.11, 0.088, 0.064, 0.046, 0.04],
    cap: 0.07, capPow: 0.55, nose: 0.004,
    thick: 0.6, round: 2,
    head: 0.24,
    eye: { u: 0.088, v: -0.15, r: 0.036, iris: [0.8, 0.84, 0.86], top: [0.1, 0.5, 0.62] },
    scale: 0.026, scaleAmt: 0.3, mouth: 'mid',
    back: [0.36, 0.36, 0.23], backAmt: 0.85, clearFins: true,
  },
}

// 颜料。沿用规则里的那套颜色（鱼册上的色点是同一套），几个颜色按真鱼调了一下。
const hexRgb = (hex) => {
  const v = parseInt(hex.slice(1), 16)
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255]
}
const PIG = Object.fromEntries(Object.entries(COLORS).map(([key, hex]) => [key, hexRgb(hex)]))
PIG.white = [0.97, 0.95, 0.91]
PIG.red = [0.86, 0.23, 0.09]
PIG.black = [0.055, 0.055, 0.065]
PIG.gold = [0.92, 0.7, 0.2]
PIG.silver = [0.8, 0.84, 0.86]
// 这个颜色的鳞片有多「金属」（反光带不带本色、多亮）。
const METAL = { gold: 0.85, silver: 0.7, orange: 0.5, yellow: 0.5, white: 0.3, cream: 0.3, blue: 0.35 }

// ---------------------------------------------------------------------------
// 小工具：样条、噪声
// ---------------------------------------------------------------------------
function sample11(a, u) {
  if (u > 1) return a[10] + (u - 1) * (a[10] - a[9]) * 4
  const f = clamp(u, 0, 1) * 10
  const i = Math.min(9, Math.floor(f))
  const t = f - i
  const p0 = a[Math.max(0, i - 1)]
  const p1 = a[i]
  const p2 = a[i + 1]
  const p3 = a[Math.min(10, i + 2)]
  return 0.5 * (2 * p1 + (p2 - p0) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (3 * p1 - p0 - 3 * p2 + p3) * t * t * t)
}

function hash2(i, j, seed) {
  let h = (Math.imul(i, 374761393) + Math.imul(j, 668265263) + Math.imul(seed, 1274126177)) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}
function vnoise(x, y, seed) {
  const xi = Math.floor(x)
  const yi = Math.floor(y)
  const fx = x - xi
  const fy = y - yi
  const sx = fx * fx * (3 - 2 * fx)
  const sy = fy * fy * (3 - 2 * fy)
  const a = lerp(hash2(xi, yi, seed), hash2(xi + 1, yi, seed), sx)
  const b = lerp(hash2(xi, yi + 1, seed), hash2(xi + 1, yi + 1, seed), sx)
  return lerp(a, b, sy)
}
// 两层叠起来，值在 0～1。
const fbm = (x, y, seed) => vnoise(x, y, seed) * 0.65 + vnoise(x * 2.3, y * 2.3, seed + 17) * 0.35

const css = (c, a) => `rgba(${Math.round(clamp(c[0], 0, 1) * 255)},${Math.round(clamp(c[1], 0, 1) * 255)},${Math.round(clamp(c[2], 0, 1) * 255)},${a})`
const mix3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)]

// ---------------------------------------------------------------------------
// 一种鱼的几何：身体轮廓表、各片鳍的外形、贴图要多大。只跟鱼种有关，算一次存着。
// ---------------------------------------------------------------------------
const geometries = new Map()

function geometry(species) {
  let geo = geometries.get(species)
  if (geo) return geo
  const form = FORM[species]
  const top = new Float32Array(N + 1)
  const bot = new Float32Array(N + 1)
  let minY = 0
  let maxY = 0
  for (let i = 0; i <= N; i++) {
    const u = (i / N) * U_END
    const cap = u >= form.cap ? 1 : Math.pow(1 - Math.pow(1 - u / form.cap, 2), form.capPow)
    const axis = form.nose * (1 - smooth(0, 0.3, u))
    top[i] = axis - sample11(form.dors, u) * cap
    bot[i] = axis + sample11(form.vent, u) * cap
    minY = Math.min(minY, top[i])
    maxY = Math.max(maxY, bot[i])
  }
  const at = (tab, u) => {
    const f = (clamp(u, 0, U_END) / U_END) * N
    const i = Math.min(N - 1, Math.floor(f))
    return lerp(tab[i], tab[i + 1], f - i)
  }
  const T = (u) => at(top, u)
  const B = (u) => at(bot, u)
  const fins = finsFor(species, T, B)
  // 贴图的范围：身体加上所有鳍。
  let x0 = X(U_END)
  let x1 = 0.5
  let y0 = minY
  let y1 = maxY
  for (const fin of fins) {
    for (const p of fin.line) {
      x0 = Math.min(x0, p[0])
      x1 = Math.max(x1, p[0])
      y0 = Math.min(y0, p[1])
      y1 = Math.max(y1, p[1])
    }
  }
  const pad = 0.025
  const box = { left: -x0 + pad, up: -y0 + pad, width: x1 - x0 + pad * 2, height: y1 - y0 + pad * 2 }
  geo = { form, top, bot, T, B, fins, box, minY, maxY }
  geometries.set(species, geo)
  return geo
}

// 这种鱼的贴图范围（体长为单位）：left / up 是身体中心到贴图左边、上边的距离。
export const fishBox = (species) => geometry(species).box

// 各片鳍。base：鳍根的两端（都略微埋进身体里，被身体盖住）；margin：鳍的外缘，从前缘到后缘。
// 画的顺序就是数组的顺序；front 的画在身体前面，其余在后面。
function finsFor(species, T, B) {
  const top = (u, d = 0) => [X(u), T(u) - d]
  const bot = (u, d = 0) => [X(u), B(u) + d]
  const bx = X(1)
  const tailBase = [[bx + 0.04, T(0.96) + 0.012], [bx + 0.04, B(0.96) - 0.012]]
  let list
  if (species === 'koi') {
    const pec = { base: [[X(0.258), 0.055], [X(0.272), 0.095]], margin: [[X(0.33), 0.088], [X(0.4), 0.128], [X(0.438), 0.168], [X(0.418), 0.192], [X(0.36), 0.178], [X(0.3), 0.138]] }
    const pel = { base: [bot(0.455, -0.014), bot(0.505, -0.014)], margin: [[X(0.5), B(0.47) + 0.06], [X(0.555), B(0.5) + 0.088], [X(0.6), B(0.55) + 0.072], [X(0.59), B(0.57) + 0.03]] }
    list = [
      { key: 'pectoral', far: true, ...pec },
      { key: 'pelvic', far: true, ...pel },
      { key: 'caudal', base: tailBase, margin: [[bx - 0.09, -0.088], [bx - 0.18, -0.138], [bx - 0.245, -0.158], [bx - 0.225, -0.118], [bx - 0.16, -0.05], [bx - 0.125, 0], [bx - 0.16, 0.05], [bx - 0.225, 0.118], [bx - 0.245, 0.158], [bx - 0.18, 0.138], [bx - 0.09, 0.088]] },
      { key: 'dorsal', base: [top(0.4, -0.014), top(0.8, -0.012)], margin: [[X(0.435), T(0.4) - 0.1], [X(0.5), T(0.47) - 0.088], [X(0.58), T(0.56) - 0.064], [X(0.68), T(0.66) - 0.048], [X(0.78), T(0.76) - 0.04], [X(0.845), T(0.84) - 0.024]] },
      { key: 'anal', base: [bot(0.735, -0.012), bot(0.805, -0.01)], margin: [[X(0.765), B(0.74) + 0.06], [X(0.805), B(0.76) + 0.082], [X(0.85), B(0.8) + 0.06], [X(0.855), B(0.84) + 0.02]] },
      { key: 'pelvic', ...pel },
      { key: 'pectoral', front: true, ...pec },
    ]
  } else if (species === 'goldfish') {
    const pec = { base: [[X(0.25), 0.075], [X(0.262), 0.115]], margin: [[X(0.32), 0.12], [X(0.39), 0.175], [X(0.42), 0.225], [X(0.39), 0.245], [X(0.33), 0.215], [X(0.285), 0.165]] }
    const pel = { base: [bot(0.48, -0.016), bot(0.54, -0.016)], margin: [[X(0.54), B(0.5) + 0.08], [X(0.61), B(0.52) + 0.125], [X(0.66), B(0.56) + 0.1], [X(0.63), B(0.6) + 0.04]] }
    const tail = { base: tailBase, margin: [[bx - 0.1, -0.14], [bx - 0.23, -0.215], [bx - 0.36, -0.235], [bx - 0.385, -0.17], [bx - 0.31, -0.075], [bx - 0.245, 0], [bx - 0.3, 0.085], [bx - 0.375, 0.19], [bx - 0.35, 0.25], [bx - 0.22, 0.215], [bx - 0.09, 0.13]] }
    // 双尾：远的那一片稍微往上翘一点，画在后面。
    const rot = (p, a) => {
      const dx = p[0] - bx
      const dy = p[1]
      return [bx + dx * Math.cos(a) - dy * Math.sin(a), dx * Math.sin(a) + dy * Math.cos(a)]
    }
    list = [
      { key: 'pectoral', far: true, ...pec },
      { key: 'pelvic', far: true, ...pel },
      { key: 'caudal', far: true, base: tail.base, margin: tail.margin.map((p) => rot(p, 0.2)) },
      { key: 'caudal', ...tail },
      { key: 'dorsal', base: [top(0.34, -0.018), top(0.72, -0.014)], margin: [[X(0.385), T(0.34) - 0.19], [X(0.47), T(0.42) - 0.185], [X(0.57), T(0.52) - 0.14], [X(0.67), T(0.62) - 0.1], [X(0.77), T(0.72) - 0.075], [X(0.8), T(0.78) - 0.03]] },
      { key: 'anal', base: [bot(0.77, -0.014), bot(0.85, -0.012)], margin: [[X(0.81), B(0.78) + 0.075], [X(0.87), B(0.8) + 0.105], [X(0.92), B(0.84) + 0.08], [X(0.91), B(0.88) + 0.03]] },
      { key: 'pelvic', ...pel },
      { key: 'pectoral', front: true, ...pec },
    ]
  } else if (species === 'angelfish') {
    const pec = { base: [[X(0.305), 0.055], [X(0.31), 0.1]], margin: [[X(0.37), 0.07], [X(0.44), 0.1], [X(0.46), 0.14], [X(0.42), 0.165], [X(0.36), 0.145]] }
    const thread = [[X(0.33), B(0.33) - 0.012], [X(0.4), B(0.33) + 0.17], [X(0.57), B(0.33) + 0.4]]
    list = [
      { key: 'pelvic', far: true, thread: thread.map((p) => [p[0] - 0.02, p[1]]) },
      { key: 'caudal', base: tailBase, margin: [[bx - 0.08, -0.085], [bx - 0.17, -0.14], [bx - 0.27, -0.19], [bx - 0.225, -0.105], [bx - 0.215, -0.035], [bx - 0.215, 0.035], [bx - 0.225, 0.105], [bx - 0.27, 0.19], [bx - 0.17, 0.14], [bx - 0.08, 0.085]] },
      { key: 'dorsal', sail: 1, base: [top(0.36, -0.018), top(0.88, -0.012)], margin: [[X(0.47), T(0.4) - 0.07], [X(0.6), T(0.48) - 0.16], [X(0.76), T(0.55) - 0.27], [X(0.9), T(0.6) - 0.35], [X(0.84), T(0.68) - 0.2], [X(0.89), T(0.78) - 0.1], [X(0.945), T(0.88) - 0.045]] },
      { key: 'anal', sail: -1, base: [bot(0.47, -0.018), bot(0.88, -0.012)], margin: [[X(0.56), B(0.5) + 0.08], [X(0.68), B(0.55) + 0.18], [X(0.82), B(0.6) + 0.3], [X(0.94), B(0.62) + 0.38], [X(0.87), B(0.7) + 0.21], [X(0.905), B(0.8) + 0.1], [X(0.95), B(0.88) + 0.04]] },
      { key: 'pelvic', thread },
      { key: 'pectoral', front: true, clear: true, ...pec },
    ]
  } else if (species === 'guppy') {
    const pec = { base: [[X(0.24), 0.03], [X(0.25), 0.06]], margin: [[X(0.295), 0.03], [X(0.35), 0.045], [X(0.365), 0.075], [X(0.325), 0.095], [X(0.28), 0.085]] }
    list = [
      { key: 'caudal', fancy: true, base: tailBase, margin: [[bx - 0.12, -0.125], [bx - 0.27, -0.235], [bx - 0.4, -0.29], [bx - 0.445, -0.18], [bx - 0.46, -0.06], [bx - 0.46, 0.06], [bx - 0.445, 0.18], [bx - 0.4, 0.29], [bx - 0.27, 0.235], [bx - 0.12, 0.125]] },
      { key: 'dorsal', fancy: true, base: [top(0.56, -0.012), top(0.68, -0.01)], margin: [[X(0.6), T(0.56) - 0.07], [X(0.7), T(0.6) - 0.13], [X(0.83), T(0.66) - 0.15], [X(0.93), T(0.7) - 0.11], [X(0.86), T(0.72) - 0.06], [X(0.76), T(0.7) - 0.025]] },
      { key: 'anal', clear: true, base: [bot(0.6, -0.01), bot(0.655, -0.01)], margin: [[X(0.65), B(0.6) + 0.045], [X(0.7), B(0.62) + 0.07], [X(0.71), B(0.66) + 0.035]] },
      { key: 'pelvic', clear: true, base: [bot(0.47, -0.01), bot(0.51, -0.01)], margin: [[X(0.52), B(0.48) + 0.035], [X(0.565), B(0.5) + 0.05], [X(0.57), B(0.54) + 0.02]] },
      { key: 'pectoral', front: true, clear: true, ...pec },
    ]
  } else {
    const pec = { base: [[X(0.25), 0.05], [X(0.26), 0.078]], margin: [[X(0.305), 0.065], [X(0.36), 0.095], [X(0.37), 0.12], [X(0.33), 0.125], [X(0.285), 0.105]] }
    list = [
      { key: 'caudal', base: tailBase, margin: [[bx - 0.07, -0.075], [bx - 0.15, -0.125], [bx - 0.215, -0.145], [bx - 0.195, -0.1], [bx - 0.13, -0.04], [bx - 0.1, 0], [bx - 0.13, 0.04], [bx - 0.195, 0.1], [bx - 0.215, 0.145], [bx - 0.15, 0.125], [bx - 0.07, 0.075]] },
      { key: 'dorsal', base: [top(0.47, -0.012), top(0.575, -0.01)], margin: [[X(0.5), T(0.47) - 0.075], [X(0.545), T(0.5) - 0.105], [X(0.6), T(0.55) - 0.08], [X(0.635), T(0.6) - 0.025]] },
      { key: 'adipose', base: [top(0.8, -0.008), top(0.835, -0.008)], margin: [[X(0.83), T(0.8) - 0.022], [X(0.86), T(0.83) - 0.022], [X(0.862), T(0.85) - 0.006]] },
      { key: 'anal', base: [bot(0.62, -0.01), bot(0.85, -0.008)], margin: [[X(0.65), B(0.62) + 0.06], [X(0.69), B(0.64) + 0.085], [X(0.75), B(0.7) + 0.05], [X(0.82), B(0.78) + 0.03], [X(0.88), B(0.86) + 0.015]] },
      { key: 'pelvic', base: [bot(0.455, -0.01), bot(0.495, -0.01)], margin: [[X(0.5), B(0.47) + 0.04], [X(0.545), B(0.48) + 0.065], [X(0.56), B(0.52) + 0.03]] },
      { key: 'pectoral', front: true, ...pec },
    ]
  }
  for (const fin of list) fin.line = fin.thread ? fin.thread : finLine(fin)
  return list
}

// 把鳍的外形取样成一条折线（样条穿过鳍根两端和外缘各点，鳍尖自然是圆的），顺便记下沿线的累计长度。
function finLine(fin) {
  const pts = [fin.base[0], ...fin.margin, fin.base[1]]
  const out = []
  const STEP = 8
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)]
    const p1 = pts[i]
    const p2 = pts[i + 1]
    const p3 = pts[Math.min(pts.length - 1, i + 2)]
    for (let s = 0; s < STEP; s++) {
      const t = s / STEP
      const t2 = t * t
      const t3 = t2 * t
      out.push([0, 1].map((c) => 0.5 * (2 * p1[c] + (p2[c] - p0[c]) * t + (2 * p0[c] - 5 * p1[c] + 4 * p2[c] - p3[c]) * t2 + (3 * p1[c] - p0[c] - 3 * p2[c] + p3[c]) * t3)))
    }
  }
  out.push(pts[pts.length - 1])
  let len = 0
  out[0][2] = 0
  for (let i = 1; i < out.length; i++) {
    len += Math.hypot(out[i][0] - out[i - 1][0], out[i][1] - out[i - 1][1])
    out[i][2] = len
  }
  return out
}

// 沿外缘走到 t（0～1，按长度）的那个点。
function alongLine(line, t) {
  const want = t * line[line.length - 1][2]
  let i = 1
  while (i < line.length - 1 && line[i][2] < want) i++
  const a = line[i - 1]
  const b = line[i]
  const f = b[2] > a[2] ? (want - a[2]) / (b[2] - a[2]) : 0
  return [lerp(a[0], b[0], f), lerp(a[1], b[1], f)]
}

// ---------------------------------------------------------------------------
// 鳍：一片从根到边越来越透的膜，上面是会分叉的鳍条。
// look: { rgb, aRoot, aEdge, ray（鳍条的颜色）, rayA }
// ---------------------------------------------------------------------------
function paintFin(k, fin, look, S, deco) {
  const line = fin.line
  const path = new Path2D()
  path.moveTo(line[0][0], line[0][1])
  for (let i = 1; i < line.length; i++) path.lineTo(line[i][0], line[i][1])
  path.closePath()
  const [b0, b1] = fin.base
  const rx = (b0[0] + b1[0]) / 2
  const ry = (b0[1] + b1[1]) / 2
  let far = line[0]
  let farD = 0
  for (const p of line) {
    const d = Math.hypot(p[0] - rx, p[1] - ry)
    if (d > farD) {
      farD = d
      far = p
    }
  }
  const gr = k.createLinearGradient(rx, ry, far[0], far[1])
  gr.addColorStop(0, css(mix3(look.rgb, [0, 0, 0], 0.22), look.aRoot))
  gr.addColorStop(0.22, css(look.rgb, look.aRoot))
  gr.addColorStop(0.7, css(mix3(look.rgb, [1, 1, 1], 0.12), lerp(look.aRoot, look.aEdge, 0.7)))
  gr.addColorStop(1, css(mix3(look.rgb, [1, 1, 1], 0.25), look.aEdge))
  k.fillStyle = gr
  k.fill(path)

  k.save()
  k.clip(path)
  if (deco) deco(k, fin, path)
  // 鳍条：主条从根到边；一半长的地方开始多出一道（分叉）；再往外又多一倍。贴图太小就只画主条。
  const total = line[line.length - 1][2]
  const n = clamp(Math.round(total / 0.02), 5, 30)
  k.lineCap = 'round'
  const stroke = (from, count, shift, width, alpha) => {
    if (width * S < 0.35) return
    k.strokeStyle = css(look.ray, alpha)
    k.lineWidth = width
    k.beginPath()
    for (let i = 0; i < count; i++) {
      const t = clamp((i + shift) / count, 0.02, 0.98)
      const root = [lerp(b0[0], b1[0], t), lerp(b0[1], b1[1], t)]
      const tip = alongLine(line, t)
      k.moveTo(lerp(root[0], tip[0], from), lerp(root[1], tip[1], from))
      k.lineTo(tip[0], tip[1])
    }
    k.stroke()
  }
  stroke(0, n, 0.5, 0.0034, look.rayA)
  stroke(0.5, n, 0, 0.0026, look.rayA * 0.85)
  stroke(0.76, n * 2, 0.25, 0.002, look.rayA * 0.7)
  k.restore()

  // 外缘一道细边：真鳍的边缘比中间略实一点。
  if (0.003 * S >= 0.4) {
    k.strokeStyle = css(mix3(look.rgb, [1, 1, 1], 0.3), Math.min(1, look.aEdge + 0.25))
    k.lineWidth = 0.003
    k.lineJoin = 'round'
    k.beginPath()
    k.moveTo(line[0][0], line[0][1])
    for (let i = 1; i < line.length; i++) k.lineTo(line[i][0], line[i][1])
    k.stroke()
  }
}

// 细长的丝（神仙鱼的腹鳍、锦鲤的须）：一道从粗到细的曲线。
function paintThread(k, pts, rgb, width, alpha) {
  const [a, b, c] = pts
  const at = (t) => [(1 - t) * (1 - t) * a[0] + 2 * (1 - t) * t * b[0] + t * t * c[0], (1 - t) * (1 - t) * a[1] + 2 * (1 - t) * t * b[1] + t * t * c[1]]
  k.strokeStyle = css(rgb, alpha)
  k.lineCap = 'round'
  const SEG = 10
  for (let i = 0; i < SEG; i++) {
    const p = at(i / SEG)
    const q = at((i + 1) / SEG)
    k.lineWidth = width * (1 - (i / SEG) * 0.82)
    k.beginPath()
    k.moveTo(p[0], p[1])
    k.lineTo(q[0], q[1])
    k.stroke()
  }
}

// ---------------------------------------------------------------------------
// 身体：逐像素。返回一块 ImageData 和它在贴图里的位置。
// ---------------------------------------------------------------------------
function shadeBody(S, geo, fish, species) {
  const { form, top, bot, box } = geo
  const g = fish.genome
  const seed = Math.round((g.size ?? 1) * 1e6) | 0
  const basePig = PIG[g.base] ?? PIG.silver
  const baseMetal = METAL[g.base] ?? 0.1
  const darkBase = g.base === 'black'
  const finPig = PIG[g.fin ?? g.base] ?? basePig
  const asagi = species === 'koi' && g.base === 'blue' // 浅黄：背上网纹，肚子发红
  const paleBack = form.back && (g.base === 'silver' || g.base === 'cream' || g.base === 'blue')

  // 身体轮廓：查表（值和沿 x 的斜率）。
  const lookup = (tab, u) => {
    const f = (u / U_END) * N
    const i = f <= 0 ? 0 : f >= N - 1 ? N - 1 : Math.floor(f)
    return tab[i] + (tab[i + 1] - tab[i]) * (f - i)
  }
  const du = U_END / N

  // 色斑先换算好。
  const marks = (g.marks ?? []).map((m, idx) => {
    const rgb = PIG[m.c] ?? PIG.black
    if (m.kind === 'bar') return { kind: 'bar', rgb: [0.07, 0.065, 0.07], x: X(m.at), w: m.w * 1.5, first: m.at < 0.3, soft: m.at > 0.3 && m.at < 0.55 }
    if (m.kind === 'line') return { kind: 'line', from: m.from, to: m.to, cv: m.y * 0.85, hw: m.w * 0.9 }
    if (m.kind === 'under') return { kind: 'under', rgb: [0.9, 0.1, 0.09], from: m.from }
    // 圆斑：锦鲤、金鱼的斑是从背上披下来的，所以圆心靠背、往上拉长。
    const k = (m.side + 0.7) / 1.4
    const where = form.wrap ? 0.02 + 0.42 * k : 0.15 + 0.7 * k
    return {
      kind: 'blob', rgb, metal: METAL[m.c] ?? 0.1, cx: X(m.at), cy: lerp(lookup(top, m.at), lookup(bot, m.at), where),
      rx: m.r * m.stretch * 1.15, ry: m.r * (form.wrap ? 1.25 : 1), seed: seed + idx * 131,
    }
  })

  // 这一点是什么颜色（底色加花纹，还没算光）。soft：边缘是柔的（头上没鳞）还是一刀切（按鳞片算）。
  // 结果写到 cr / cg / cb / cm（金属感）/ ce（自发光，红绿灯那道蓝线用）。
  let cr = 0
  let cg = 0
  let cb = 0
  let cm = 0
  let ce = 0
  function pigmentAt(u, v, x, y, soft) {
    cr = basePig[0]
    cg = basePig[1]
    cb = basePig[2]
    cm = baseMetal
    ce = 0
    if (paleBack) {
      const t = smooth(-0.25, -0.75, v) * form.backAmt
      cr = lerp(cr, form.back[0], t)
      cg = lerp(cg, form.back[1], t)
      cb = lerp(cb, form.back[2], t)
    }
    if (form.rearTint && g.fin) {
      // 孔雀鱼：后半身染上尾巴的颜色。
      const t = smooth(0.42, 0.78, u) * 0.85
      cr = lerp(cr, finPig[0], t)
      cg = lerp(cg, finPig[1], t)
      cb = lerp(cb, finPig[2], t)
    }
    if (asagi) {
      const t = smooth(0.25, 0.6, v) * 0.9
      cr = lerp(cr, 0.88, t)
      cg = lerp(cg, 0.36, t)
      cb = lerp(cb, 0.16, t)
    }
    for (const m of marks) {
      let a = 0
      if (m.kind === 'blob') {
        const dx = (x - m.cx) / m.rx
        let dy = (y - m.cy) / m.ry
        if (form.wrap && dy < 0) dy *= 0.5
        const q = 1 - Math.sqrt(dx * dx + dy * dy) + (fbm(x * 13 + 5, y * 13 + 9, m.seed) - 0.5) * 0.8
        a = soft ? smooth(-0.07, 0.07, q) : q > 0 ? 1 : 0
        if (a > 0) cm = lerp(cm, m.metal, a)
      } else if (m.kind === 'bar') {
        // 神仙鱼的竖条：中间宽、两头收，边缘是柔的；第二条天生淡一些。
        const w = m.w * (0.7 + 0.5 * (1 - v * v)) * (m.first ? 0.75 : 1)
        const bend = 0.02 * v * v + (fbm(y * 9, 3, seed) - 0.5) * 0.012
        a = smooth(w / 2 + 0.012, w / 2 - 0.008, Math.abs(x - m.x + bend)) * (m.soft ? 0.7 : 0.94)
      } else if (m.kind === 'under') {
        // 红绿灯下半身那截红：从 from 开始渐渐出来，到尾柄铺满。
        a = smooth(m.from - 0.05, m.from + 0.07, u) * smooth(-0.14, 0.04, v) * (1 - smooth(0.62, 0.95, v) * (1 - smooth(0.7, 0.95, u))) * 0.95
      } else if (m.kind === 'line') {
        // 红绿灯那道蓝线：上缘偏绿、下缘偏深蓝，自己会「亮」。
        const hw = m.hw * smooth(m.from - 0.02, m.from + 0.08, u) * (1 - 0.45 * smooth(m.to - 0.3, m.to, u))
        const dv = v - m.cv
        a = hw > 0.001 ? smooth(hw, hw * 0.5, Math.abs(dv)) * (1 - smooth(m.to - 0.03, m.to + 0.02, u)) : 0
        if (a > 0) {
          const t = clamp(dv / hw, -1, 1) * 0.5 + 0.5
          cr = lerp(cr, lerp(0.3, 0.1, t), a)
          cg = lerp(cg, lerp(0.95, 0.5, t), a)
          cb = lerp(cb, lerp(0.88, 1, t), a)
          cm = lerp(cm, 0.9, a)
          ce = Math.max(ce, a * 0.55)
        }
        continue
      }
      if (a > 0) {
        cr = lerp(cr, m.rgb[0], a)
        cg = lerp(cg, m.rgb[1], a)
        cb = lerp(cb, m.rgb[2], a)
      }
    }
  }

  // 鳞片：一片不到两三个像素就不画了（糊成一片反而脏）。
  const sc = form.scale
  const scaleOn = sc * S >= 2.6 ? form.scaleAmt * smooth(2.6, 5, sc * S) : 0
  const rh = sc * 0.56
  const rr = sc * 0.64
  const scaleColor = new Map() // 这片鳞是什么颜色：一片算一次

  const W = Math.ceil(box.width * S)
  const px0 = Math.max(0, Math.floor((X(U_END) + box.left) * S) - 1)
  const px1 = Math.min(W, Math.ceil((0.5 + box.left) * S) + 2)
  const py0 = Math.max(0, Math.floor((geo.minY + box.up) * S) - 1)
  const py1 = Math.ceil((geo.maxY + box.up) * S) + 2
  const w = px1 - px0
  const h = py1 - py0
  const img = new ImageData(w, h)
  const data = img.data

  // 光：主光从上方偏前打下来，四周是水里的散射光（上面偏冷、下面是池底反上来的，偏暖）。
  const LX = 0.2
  const LY = -0.78
  const LZ = 0.593
  const HX = 0.112 // 高光方向（光和视线的中间）
  const HY = -0.437
  const HZ = 0.893
  const p = form.round
  const thick = form.thick
  const eyeX = X(form.eye.u)

  for (let py = 0; py < h; py++) {
    const y = (py + py0 + 0.5) / S - box.up
    for (let px = 0; px < w; px++) {
      const x = (px + px0 + 0.5) / S - box.left
      const u = (0.5 - x) / SL
      if (u < 0 || u > U_END) continue
      const f = (u / U_END) * N
      const i = f >= N - 1 ? N - 1 : Math.floor(f)
      const fr = f - i
      const t = top[i] + (top[i + 1] - top[i]) * fr
      const b = bot[i] + (bot[i + 1] - bot[i]) * fr
      if (y < t - 1.5 / S || y > b + 1.5 / S) continue
      const half = (b - t) / 2
      if (half < 1e-5) continue
      // 轮廓沿 x 的斜率（x 往右 = u 变小）。
      const st = -(top[i + 1] - top[i]) / (du * SL)
      const sb = -(bot[i + 1] - bot[i]) / (du * SL)
      // 离边缘还有几个像素 → 边缘的透明度（抗锯齿）。
      const edge = Math.min((y - t) / Math.sqrt(1 + st * st), (b - y) / Math.sqrt(1 + sb * sb)) * S
      let alpha = clamp(edge + 0.5, 0, 1) * (1 - smooth(1, U_END, u))
      if (alpha <= 0) continue
      const mid = (t + b) / 2
      const v = clamp((y - mid) / half, -1, 1)
      const av = Math.abs(v)

      // 朝向：横截面是个（超）椭圆，再加上身体沿长度方向的收窄。
      const wz = Math.pow(1 - Math.pow(av, p), 1 / p) // 这一点有多「鼓」出来
      let nx = -((sb - st) / 2) * thick * wz
      let ny = thick * (v < 0 ? -1 : 1) * Math.pow(av, p - 1)
      let nz = p === 2 ? wz : Math.pow(wz, p - 1)

      // 头上没有鳞：鳃盖后缘是一道往后鼓的弧。
      const uo = form.head - 0.07 * v * v
      const od = (u - uo) * SL
      const scaly = scaleOn * smooth(0, 0.03, od) * Math.sqrt(Math.max(0, nz))

      // 鳞片：像瓦片一样一片压一片（靠头的压在上面），露出来的是每片靠尾巴的那道圆边。
      let sMul = 1
      let glint = 1
      let quant = false
      if (scaly > 0.01) {
        const s = u * SL
        const tt = half * (v + thick * (Math.asin(v) - v)) // 绕着身体量的距离：靠近背缘腹缘的鳞看起来更扁
        const j0 = Math.round(tt / rh)
        let bestS = Infinity
        let bi = 0
        let bj = 0
        let bt = 0
        for (let j = j0 - 1; j <= j0 + 1; j++) {
          const dt = tt - j * rh
          const reach2 = rr * rr - dt * dt
          if (reach2 <= 0) continue
          const reach = Math.sqrt(reach2)
          const off = j & 1 ? sc * 0.5 : 0
          const ii = Math.ceil((s - reach - off) / sc)
          const cs = ii * sc + off
          if (cs <= s + reach && cs < bestS) {
            bestS = cs
            bi = ii
            bj = j
            bt = dt
          }
        }
        if (bestS < Infinity) {
          const ex = (s - bestS) / rr
          const ey = bt / rr
          const d = Math.sqrt(ex * ex + ey * ey)
          const rim = smooth(0.78, 1, d)
          const rnd = hash2(bi, bj, seed)
          if (asagi) {
            // 浅黄的网纹：每片鳞中间深、边上浅。
            sMul = 1 + scaly * (0.3 * rim - 0.32 * (1 - smooth(0.15, 0.75, d))) + (rnd - 0.5) * 0.06
          } else {
            const glow = smooth(0.25, 0.8, d) * (1 - rim) * Math.max(0, ex)
            sMul = 1 + scaly * ((darkBase ? 0.5 : 0.16) * glow - (darkBase ? 0.2 : 0.36) * rim) + (rnd - 0.5) * 0.09 * scaly
          }
          glint = 1 + scaly * (hash2(bi, bj, seed + 3) * 1.6 - 0.8)
          nx -= scaly * 0.3 * ex
          ny += scaly * 0.22 * ey
          // 花纹按整片鳞算。
          const key = (bi + 2048) * 4096 + (bj + 2048)
          let c = scaleColor.get(key)
          if (!c) {
            const cu = clamp(bestS / SL, 0, U_END)
            const ct = lookup(top, cu)
            const cbm = lookup(bot, cu)
            const cv = clamp(v - bt / half, -1, 1)
            pigmentAt(cu, cv, X(cu), (ct + cbm) / 2 + (cv * (cbm - ct)) / 2, false)
            c = [cr, cg, cb, cm, ce]
            scaleColor.set(key, c)
          }
          if (scaly > 0.45 * form.scaleAmt) {
            cr = c[0]
            cg = c[1]
            cb = c[2]
            cm = c[3]
            ce = c[4]
            quant = true
          }
        }
      }
      if (!quant) pigmentAt(u, v, x, y, true)
      // 细条纹（神仙鱼、红绿灯）不按鳞片量化，直接按像素算更干净。
      if (quant && !form.wrap) pigmentAt(u, v, x, y, true)

      const nl = Math.sqrt(nx * nx + ny * ny + nz * nz)
      nx /= nl
      ny /= nl
      nz /= nl

      // 反荫蔽：背上深、肚子浅——几乎所有鱼都这样。
      const lum = cr * 0.3 + cg * 0.55 + cb * 0.15
      const backT = smooth(-0.2, -0.95, v)
      const bellyT = smooth(0.3, 0.92, v)
      const backMul = 1 - (form.wrap ? 0.16 : 0.24) * backT
      cr *= backMul
      cg *= backMul
      cb *= backMul
      const bellyAmt = bellyT * (lum < 0.2 ? 0.1 : asagi ? 0.15 : 0.5)
      cr = lerp(cr, 0.96, bellyAmt)
      cg = lerp(cg, 0.95, bellyAmt)
      cb = lerp(cb, 0.93, bellyAmt)
      // 一点不均匀：真鱼的皮不是一块纯色。
      const mott = 1 + (fbm(x * 34, y * 34, seed + 5) - 0.5) * 0.09
      // 鳃盖：一道暗缝，缝前面略鼓、缝后面一点阴影。
      let detail = 1
      if (od > -0.05 && od < 0.05) {
        const span = smooth(-0.82, -0.55, v) * (1 - smooth(0.72, 0.92, v))
        detail *= 1 - 0.42 * span * Math.exp(-(od * od) / (0.0045 * 0.0045))
        detail *= 1 + 0.08 * span * Math.exp(-((od + 0.014) * (od + 0.014)) / (0.012 * 0.012))
        if (od > 0) detail *= 1 - 0.14 * span * Math.exp(-(od * od) / (0.016 * 0.016))
      }
      // 侧线：身体中间偏下一道很淡的线。
      if (form.sideLine && od > 0.02) {
        const dl = (v - 0.08) * half
        detail *= 1 - 0.13 * Math.exp(-(dl * dl) / (0.003 * 0.003)) * scaly
      }
      // 眼窝周围略暗一圈。
      {
        const dx = x - eyeX
        const dy = y - (mid + form.eye.v * half)
        const de = Math.sqrt(dx * dx + dy * dy) / form.eye.r
        if (de < 1.7) detail *= 1 - 0.22 * (1 - smooth(1, 1.7, de))
      }

      const ndl = nx * LX + ny * LY + nz * LZ
      const dif = clamp((ndl + 0.3) / 1.3, 0, 1)
      const upness = 0.5 - 0.5 * ny
      const ambR = lerp(0.5, 0.36, upness)
      const ambG = lerp(0.47, 0.4, upness)
      const ambB = lerp(0.42, 0.44, upness)
      const rimDark = 1 - 0.3 * Math.pow(1 - nz, 2.5)
      const shade = sMul * mott * detail * rimDark
      let r = cr * (ambR + 0.62 * dif) * shade
      let gg = cg * (ambG + 0.62 * dif) * shade
      let bb = cb * (ambB + 0.6 * dif) * shade
      // 反光：一道宽而淡的光泽，加上一片片鳞各自的闪光。金属色的鱼反光带本色。
      const nh = Math.max(0, nx * HX + ny * HY + nz * HZ)
      const nh2 = nh * nh
      const nh8 = nh2 * nh2 * nh2 * nh2
      const spec = (nh8 * nh8 * nh8 * nh8 * 0.34 * glint + nh2 * nh2 * nh2 * 0.1) * (darkBase && lum < 0.2 ? 0.75 : 1) * (0.6 + 0.6 * cm) * detail
      r += spec * lerp(1, 0.55 + cr * 0.9, cm)
      gg += spec * lerp(1, 0.55 + cg * 0.9, cm)
      bb += spec * lerp(1, 0.55 + cb * 0.9, cm)
      if (ce > 0) {
        r = lerp(r, cr * 1.05, ce)
        gg = lerp(gg, cg * 1.05, ce)
        bb = lerp(bb, cb * 1.05, ce)
      }
      const o = (py * w + px) * 4
      data[o] = clamp(r, 0, 1) * 255
      data[o + 1] = clamp(gg, 0, 1) * 255
      data[o + 2] = clamp(bb, 0, 1) * 255
      data[o + 3] = alpha * 255
    }
  }
  return { img, x: px0, y: py0, w, h }
}

// ---------------------------------------------------------------------------
// 眼睛：虹膜是带金属光的一圈（上半暗），瞳孔外一道细金环，角膜上一点高光。
// ---------------------------------------------------------------------------
function paintEye(k, x, y, r, eye, cloudy) {
  const iris = k.createRadialGradient(x, y, r * 0.45, x, y, r)
  iris.addColorStop(0, css(mix3(eye.iris, [1, 1, 1], 0.25), 1))
  iris.addColorStop(0.7, css(eye.iris, 1))
  iris.addColorStop(1, css(mix3(eye.iris, [0, 0, 0], 0.55), 1))
  k.fillStyle = iris
  k.beginPath()
  k.arc(x, y, r, 0, TAU)
  k.fill()
  k.save()
  k.beginPath()
  k.arc(x, y, r, 0, TAU)
  k.clip()
  const lid = k.createLinearGradient(0, y - r, 0, y + r * 0.5)
  lid.addColorStop(0, css(eye.top, 0.95))
  lid.addColorStop(0.55, css(eye.top, 0.35))
  lid.addColorStop(1, css(eye.top, 0))
  k.fillStyle = lid
  k.fillRect(x - r, y - r, r * 2, r * 2)
  k.restore()
  // 瞳孔
  k.fillStyle = '#050608'
  k.beginPath()
  k.arc(x + r * 0.04, y, r * 0.54, 0, TAU)
  k.fill()
  k.strokeStyle = 'rgba(232,206,140,0.55)'
  k.lineWidth = r * 0.07
  k.beginPath()
  k.arc(x + r * 0.04, y, r * 0.58, 0, TAU)
  k.stroke()
  // 眼眶
  k.strokeStyle = 'rgba(10,10,12,0.55)'
  k.lineWidth = r * 0.1
  k.beginPath()
  k.arc(x, y, r, 0, TAU)
  k.stroke()
  if (cloudy) {
    k.fillStyle = 'rgba(205,212,210,0.72)'
    k.beginPath()
    k.arc(x, y, r, 0, TAU)
    k.fill()
    return
  }
  // 角膜的高光：左上一小点，右下一弯很淡的反光。
  const hl = k.createRadialGradient(x - r * 0.28, y - r * 0.34, 0, x - r * 0.28, y - r * 0.34, r * 0.3)
  hl.addColorStop(0, 'rgba(255,255,255,0.95)')
  hl.addColorStop(0.5, 'rgba(255,255,255,0.55)')
  hl.addColorStop(1, 'rgba(255,255,255,0)')
  k.fillStyle = hl
  k.beginPath()
  k.arc(x - r * 0.28, y - r * 0.34, r * 0.3, 0, TAU)
  k.fill()
  k.strokeStyle = 'rgba(255,255,255,0.16)'
  k.lineWidth = r * 0.1
  k.beginPath()
  k.arc(x, y, r * 0.74, 0.25, 1.2)
  k.stroke()
}

// ---------------------------------------------------------------------------
// 把一条鱼画成贴图。want：一个「体长」画成多少像素；fade：0 正常，越大越发灰（不健康 / 死了）。
// 返回 OffscreenCanvas，尺寸是 fishBox 的宽高乘 want（向上取整）。
// ---------------------------------------------------------------------------
export function bakeFish(fish, fade, want) {
  const species = fish.species
  const geo = geometry(species)
  const { form, box, T, B } = geo
  const g = fish.genome
  const outW = Math.ceil(box.width * want)
  const outH = Math.ceil(box.height * want)
  // 小贴图按两倍画再缩回去：边缘和鳞片都更干净。
  const ss = want <= 520 ? 2 : 1
  const S = want * ss
  const work = new OffscreenCanvas(outW * ss, outH * ss)
  const k = work.getContext('2d')
  const unit = () => k.setTransform(S, 0, 0, S, box.left * S, box.up * S)
  unit()

  // 鳍的颜色
  const finKey = g.fin ?? g.base
  const basePig = PIG[g.base] ?? PIG.silver
  const dark = finKey === 'black'
  let finRgb = PIG[finKey] ?? basePig
  if (species === 'angelfish' && finKey === 'silver') finRgb = [0.62, 0.65, 0.66]
  if (species === 'koi' && g.base === 'blue') finRgb = [0.86, 0.84, 0.82]
  const solid = {
    rgb: dark ? [0.1, 0.1, 0.115] : finRgb,
    aRoot: dark ? 0.96 : 0.92,
    aEdge: dark ? 0.72 : species === 'angelfish' ? 0.42 : 0.5,
    ray: dark ? [0.6, 0.62, 0.66] : mix3(finRgb, [0.2, 0.12, 0.06], 0.55),
    rayA: dark ? 0.2 : 0.3,
  }
  const clear = { rgb: [0.86, 0.9, 0.92], aRoot: 0.3, aEdge: 0.1, ray: [0.95, 0.97, 1], rayA: 0.32 }
  const bodyClear = { ...clear, rgb: mix3(basePig, [0.9, 0.93, 0.95], 0.6) }
  const lookFor = (fin) => {
    if (form.clearFins || fin.clear) return bodyClear
    if (species === 'guppy' && !fin.fancy) return bodyClear
    if (fin.far) return { ...solid, rgb: mix3(solid.rgb, [0, 0.05, 0.1], 0.32), aRoot: solid.aRoot * 0.9, aEdge: solid.aEdge * 0.9 }
    return solid
  }
  // 鳍上的花：神仙鱼的竖条一直延到背鳍臀鳍里；孔雀鱼的尾巴上有斑点和一道深边。
  const rng = (() => {
    let n = 0
    const seed = Math.round((g.size ?? 1) * 1e6) | 0
    return () => hash2(n++, 7, seed)
  })()
  const mainBar = species === 'angelfish' && (g.marks ?? []).find((m) => m.kind === 'bar' && m.at > 0.55 && m.at < 0.8)
  const deco = (kk, fin) => {
    if (fin.sail && mainBar) {
      const tip = fin.margin[3]
      const y0 = fin.sail > 0 ? T(mainBar.at) : B(mainBar.at)
      kk.strokeStyle = 'rgba(14,13,15,0.78)'
      kk.lineWidth = 0.07
      kk.lineCap = 'butt'
      kk.beginPath()
      kk.moveTo(X(mainBar.at), y0)
      kk.quadraticCurveTo(lerp(X(mainBar.at), tip[0], 0.35), lerp(y0, tip[1], 0.6), tip[0], tip[1])
      kk.stroke()
    }
    if (fin.fancy && g.fin) {
      const far = fin.key === 'caudal'
      const bx = X(1)
      kk.fillStyle = 'rgba(20,14,24,0.5)'
      for (let i = 0; i < (far ? 26 : 8); i++) {
        const a = (rng() - 0.5) * 1.1
        const d = 0.12 + rng() * 0.33
        const px = far ? bx - Math.cos(a) * d : lerp(fin.base[0][0], fin.margin[3][0], rng())
        const py = far ? Math.sin(a) * d : lerp(fin.base[0][1], fin.margin[2][1], 0.25 + rng() * 0.6)
        kk.beginPath()
        kk.ellipse(px, py, 0.008 + rng() * 0.014, 0.006 + rng() * 0.009, a, 0, TAU)
        kk.fill()
      }
    }
  }

  for (const fin of geo.fins) {
    if (fin.front) continue
    if (fin.thread) paintThread(k, fin.thread, fin.far ? mix3(solid.rgb, [0, 0.05, 0.1], 0.35) : solid.rgb, 0.016, fin.far ? 0.75 : 0.9)
    else paintFin(k, fin, lookFor(fin), S, deco)
  }

  // 身体
  const body = shadeBody(S, geo, fish, species)
  const tmp = new OffscreenCanvas(body.w, body.h)
  tmp.getContext('2d').putImageData(body.img, 0, 0)
  k.setTransform(1, 0, 0, 1, 0, 0)
  k.drawImage(tmp, body.x, body.y)
  unit()

  // 胸鳍在身体前面，底下带一点影子。
  for (const fin of geo.fins) {
    if (!fin.front) continue
    k.save()
    k.shadowColor = 'rgba(0,0,0,0.28)'
    k.shadowBlur = 0.012 * S
    k.shadowOffsetY = 0.006 * S
    paintFin(k, fin, lookFor(fin), S, null)
    k.restore()
  }

  // 嘴、须、鼻孔
  const axis = form.nose
  const line = dark || g.base === 'black' ? 'rgba(200,200,205,0.35)' : 'rgba(40,18,8,0.5)'
  k.strokeStyle = line
  k.lineCap = 'round'
  k.lineWidth = 0.0055
  k.beginPath()
  if (form.mouth === 'low') {
    k.moveTo(0.497, axis + 0.01)
    k.quadraticCurveTo(0.482, axis + 0.016, 0.468, axis + 0.034)
  } else if (form.mouth === 'up') {
    k.moveTo(0.492, axis - 0.004)
    k.quadraticCurveTo(0.484, axis + 0.002, 0.476, axis + 0.012)
  } else {
    k.moveTo(0.498, axis + 0.002)
    k.quadraticCurveTo(0.488, axis + 0.006, 0.476, axis + 0.016)
  }
  k.stroke()
  if (form.barbel) {
    const c = mix3(basePig, [0.25, 0.12, 0.05], g.base === 'black' ? 0 : 0.3)
    paintThread(k, [[0.482, axis + 0.02], [0.478, axis + 0.04], [0.466, axis + 0.05]], c, 0.006, 0.9)
    paintThread(k, [[0.47, axis + 0.034], [0.462, axis + 0.062], [0.44, axis + 0.074]], c, 0.007, 0.9)
  }
  {
    const nu = form.eye.u * 0.45
    const ny = lerp(T(nu), B(nu), 0.5 + form.eye.v * 0.5 - 0.06)
    k.fillStyle = g.base === 'black' ? 'rgba(0,0,0,0.6)' : 'rgba(30,14,8,0.42)'
    k.beginPath()
    k.ellipse(X(nu), ny, 0.0055, 0.004, -0.4, 0, TAU)
    k.fill()
  }

  // 眼睛
  {
    const e = form.eye
    const t = T(e.u)
    const b = B(e.u)
    // 鱼苗的眼睛相对更大（调用方按体长给 fish.youth，没有就当成鱼）。
    paintEye(k, X(e.u), (t + b) / 2 + (e.v * (b - t)) / 2, e.r * (1 + 0.35 * (fish.youth ?? 0)), e, fade > 0.5)
  }

  // 不健康 / 死了：整条鱼往灰白里褪。
  if (fade > 0) {
    k.setTransform(1, 0, 0, 1, 0, 0)
    k.globalCompositeOperation = 'source-atop'
    k.fillStyle = `rgba(200,208,204,${fade})`
    k.fillRect(0, 0, work.width, work.height)
    k.globalCompositeOperation = 'source-over'
  }

  if (ss === 1) return work
  const out = new OffscreenCanvas(outW, outH)
  const o = out.getContext('2d')
  o.imageSmoothingQuality = 'high'
  o.drawImage(work, 0, 0, outW, outH)
  return out
}
