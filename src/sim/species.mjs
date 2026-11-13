// 鱼种、花色基因、名字。纯数据加纯函数，不碰 DOM，node 里也能跑（用例直接 import）。

// 规则用的：maxLength（cm，吃好喝好能长到的体长）、growthK（每天向极限体长靠近的比例）、
//   fryLength（刚孵出来多长）、matureLength（长到这么大才能繁殖）、lifespanDays、clutch（一窝几条）。
// 画面用的（侧面的体型，都是相对体长的比例）：depth 身高、belly 肚子额外鼓出多少、
//   tail 尾鳍长度系数、tailShape 叉尾还是扇尾、fin 背鳍腹鳍的大小系数、barbel 嘴边有没有须、
//   swim 游速系数。
// 习性 habit（游动用，见 ui/motion.mjs），照着真鱼的脾气填：
//   layer：爱待的水层 [上, 下]，0 是水面、1 是池底
//   school：0 各逛各的 ~ 1 离不开群（同种的鱼跟着同一个群走）。群平时是松散的，受了惊才抱紧
//   idle：悬着不动的倾向，0 一刻不停 ~ 1 大半时间在发呆
//   forage：到池底低头啄食的倾向，0 从不 ~ 1 老在啄
export const SPECIES = {
  koi: {
    label: '锦鲤', blurb: '个头最大，长得慢，活得久',
    maxLength: 70, growthK: 0.035, fryLength: 3, matureLength: 25, lifespanDays: 240, clutch: [2, 4],
    swim: 1.0, depth: 0.27, belly: 0, tail: 1.0, tailShape: 'fork', fin: 1.0, barbel: true,
    habit: { layer: [0.25, 1], school: 0.35, idle: 0.2, forage: 0.5 }, // 三三两两慢慢巡游，爱在池底翻找
  },
  goldfish: {
    label: '金鱼', blurb: '圆滚滚、大尾巴，皮实好养',
    maxLength: 22, growthK: 0.05, fryLength: 2, matureLength: 9, lifespanDays: 150, clutch: [2, 4],
    swim: 0.7, depth: 0.42, belly: 0.2, tail: 1.9, tailShape: 'fork', fin: 1.5, barbel: false,
    habit: { layer: [0.3, 1], school: 0.3, idle: 0.3, forage: 0.7 }, // 不成群但爱凑堆，一天到晚在池底啄
  },
  angelfish: {
    label: '神仙鱼', blurb: '身子又高又扁，背鳍腹鳍像两片帆',
    maxLength: 15, growthK: 0.055, fryLength: 1.5, matureLength: 7, lifespanDays: 180, clutch: [2, 4],
    swim: 0.6, depth: 0.62, belly: 0, tail: 1.1, tailShape: 'fan', fin: 3.2, barbel: false,
    habit: { layer: [0.2, 0.75], school: 0.25, idle: 0.7, forage: 0 }, // 中层，常常悬在一处不动，动起来也慢
  },
  guppy: {
    label: '孔雀鱼', blurb: '小个子、花尾巴，长得快生得多，寿命短',
    maxLength: 6, growthK: 0.09, fryLength: 0.8, matureLength: 3, lifespanDays: 90, clutch: [3, 6],
    swim: 0.9, depth: 0.24, belly: 0.15, tail: 2.2, tailShape: 'fan', fin: 1.2, barbel: false,
    habit: { layer: [0, 0.45], school: 0.5, idle: 0.1, forage: 0 }, // 上层，松松散散一群，一刻不停
  },
  neon: {
    label: '红绿灯', blurb: '最小的一种，爱成群，一道蓝线一截红',
    maxLength: 4, growthK: 0.1, fryLength: 0.6, matureLength: 2.2, lifespanDays: 100, clutch: [3, 5],
    swim: 1.2, depth: 0.26, belly: 0.05, tail: 0.9, tailShape: 'fork', fin: 0.8, barbel: false,
    habit: { layer: [0.4, 0.85], school: 0.95, idle: 0.3, forage: 0 }, // 中下层，总是一群待在一起；平时松散，受惊才抱紧
  },
}

// 现在能养的鱼种：选鱼界面只列这几种。
// 鱼要一种一种做到逼真（有了像样的 3D 模型）才放出来，其余的规则和画法都留着，做好一种往这里加一种。
export const STOCKABLE = ['neon']

export const COLORS = {
  white: '#f3ede2',
  red: '#e2502b',
  orange: '#f08a2c',
  black: '#252220',
  gold: '#e9b23a',
  blue: '#6f8799',
  cream: '#f6d9a8',
  silver: '#c6d0d4',
  neonblue: '#35c6ee',
  yellow: '#f2d53c',
  purple: '#7d5cb8',
}

// 品种模板：底色、鳍色（不写就跟底色走）、色斑。
// marks 里 [颜色, 最少几块, 最多几块] 是随机摆的圆斑；写成对象的是固定的花纹：
//   bar 竖条（神仙鱼）、line 横线（红绿灯的蓝线）、under 下半身一截（红绿灯的红）。
const VARIETIES = {
  koi: [
    { label: '红白', base: 'white', marks: [['red', 2, 4]] },
    { label: '大正三色', base: 'white', marks: [['red', 2, 3], ['black', 1, 3]] },
    { label: '昭和三色', base: 'black', marks: [['red', 2, 3], ['white', 1, 2]] },
    { label: '黄金', base: 'gold', marks: [] },
    { label: '浅黄', base: 'blue', marks: [['orange', 1, 2]] },
    { label: '白写', base: 'white', marks: [['black', 2, 4]] },
  ],
  goldfish: [
    { label: '红金', base: 'orange', marks: [] },
    { label: '红白', base: 'white', marks: [['orange', 1, 3]] },
    { label: '黑金', base: 'black', marks: [['gold', 1, 2]] },
    { label: '樱花', base: 'cream', marks: [['red', 1, 3]] },
  ],
  angelfish: [
    {
      label: '银', base: 'silver',
      marks: [0.18, 0.42, 0.66, 0.9].map((at) => ({ kind: 'bar', c: 'black', at, w: 0.045 })),
    },
    { label: '黑', base: 'black', marks: [] },
    { label: '金', base: 'gold', marks: [] },
    { label: '大理石', base: 'silver', marks: [['black', 3, 5]] },
  ],
  guppy: [
    { label: '红尾', base: 'silver', fin: 'red', marks: [] },
    { label: '蓝尾', base: 'blue', fin: 'neonblue', marks: [] },
    { label: '黄尾', base: 'cream', fin: 'yellow', marks: [['black', 0, 1]] },
    { label: '紫尾', base: 'silver', fin: 'purple', marks: [['black', 1, 2]] },
  ],
  neon: [
    {
      label: '', base: 'silver',
      marks: [
        { kind: 'under', c: 'red', from: 0.52, to: 1 },
        { kind: 'line', c: 'neonblue', from: 0.08, to: 0.8, y: -0.25, w: 0.2 },
      ],
    },
    {
      label: '宝莲灯', base: 'silver',
      marks: [
        { kind: 'under', c: 'red', from: 0.14, to: 1 },
        { kind: 'line', c: 'neonblue', from: 0.08, to: 0.8, y: -0.25, w: 0.2 },
      ],
    },
  ],
}

const NAMES = [
  '团子', '年糕', '墨墨', '阿金', '雪球', '橘子', '芝麻', '汤圆', '豆包', '花卷', '小满', '大福',
  '可乐', '布丁', '栗子', '馒头', '阿福', '元宝', '锦锦', '糯米', '桂圆', '麻薯', '南瓜', '小鱼干',
  '火锅', '奶盖', '乌龙', '话梅', '山楂', '锅巴', '春卷', '月饼', '腊八', '小寒', '谷雨', '白露',
]

// 可复现的随机数（用例要确定性）。mulberry32。
export function makeRng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const between = (rng, lo, hi) => lo + (hi - lo) * rng()
const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)]
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

function randomBlob(rng, color) {
  return {
    c: color,
    at: between(rng, 0.08, 0.82), // 沿身体的位置，0 是头
    side: between(rng, -0.7, 0.7), // 偏背还是偏腹
    r: between(rng, 0.07, 0.17), // 半径占体长的比例
    stretch: between(rng, 1.0, 1.9), // 沿身体方向拉长多少
  }
}

// variety 不传就随机挑一个品种。
export function randomGenome(species, rng, variety) {
  const v = variety ?? pick(rng, VARIETIES[species])
  const marks = []
  for (const m of v.marks) {
    if (!Array.isArray(m)) {
      marks.push({ ...m })
      continue
    }
    const [color, lo, hi] = m
    const count = lo + Math.floor(rng() * (hi - lo + 1))
    for (let i = 0; i < count; i++) marks.push(randomBlob(rng, color))
  }
  return {
    base: v.base,
    fin: v.fin ?? null,
    marks,
    size: between(rng, 0.88, 1.12), // 个体的极限体长系数
    life: between(rng, 0.85, 1.15), // 个体的寿命系数
  }
}

// 后代的花色：底色、鳍色各随一方；色斑每块各有一半机会传下去；小概率突变出一块新的。
export function crossGenome(mother, father, rng) {
  const base = rng() < 0.5 ? mother.base : father.base
  const fin = rng() < 0.5 ? mother.fin : father.fin
  const marks = []
  for (const m of [...mother.marks, ...father.marks]) {
    if (m.c === base) continue // 和底色同色的斑看不见，留着只会让基因越攒越长
    if (rng() >= 0.5) continue
    // 固定花纹（竖条、横线）原样传；同一条花纹父母各带一份时只留一份。
    if (m.kind) {
      if (!marks.some((x) => x.kind === m.kind && x.c === m.c && (x.at ?? x.from) === (m.at ?? m.from))) marks.push({ ...m })
      continue
    }
    marks.push({
      ...m,
      at: clamp(m.at + between(rng, -0.08, 0.08), 0.05, 0.85),
      side: clamp(m.side + between(rng, -0.2, 0.2), -0.8, 0.8),
    })
  }
  if (rng() < 0.15) {
    const palette = Object.keys(COLORS).filter((c) => c !== base)
    marks.push(randomBlob(rng, pick(rng, palette)))
  }
  return {
    base,
    fin: fin ?? null,
    marks: marks.slice(0, 8),
    size: clamp((mother.size + father.size) / 2 + between(rng, -0.05, 0.05), 0.8, 1.2),
    life: clamp((mother.life + father.life) / 2 + between(rng, -0.05, 0.05), 0.8, 1.2),
  }
}

// 花色叫什么。按底色、鳍色、色斑颜色认，认不出的统一叫「花」。
export function varietyLabel(species, genome) {
  const have = new Set(genome.marks.map((m) => m.c))
  for (const v of VARIETIES[species]) {
    if (v.base !== genome.base || (v.fin ?? null) !== (genome.fin ?? null)) continue
    // 模板里「最少 0 块」的颜色可有可无，其余的必须有；模板里没有的颜色不能出现。
    const allowed = new Set(v.marks.map((m) => (Array.isArray(m) ? m[0] : m.c)))
    const required = v.marks.filter((m) => !Array.isArray(m) || m[1] > 0).map((m) => (Array.isArray(m) ? m[0] : m.c))
    if (required.every((c) => have.has(c)) && [...have].every((c) => allowed.has(c))) return v.label
  }
  return '花'
}

export function pickName(usedNames, rng) {
  const free = NAMES.filter((n) => !usedNames.has(n))
  if (free.length > 0) return pick(rng, free)
  // 名字用完了就加序号，不让两条鱼同名（鱼册里分不清）。
  for (let i = 2; ; i++) {
    const name = pick(rng, NAMES) + i
    if (!usedNames.has(name)) return name
  }
}
