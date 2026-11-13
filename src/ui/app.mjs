// 页面入口：把规则（sim）、游动（motion）、画面（render）、面板（hud）、选鱼（chooser）串起来。
import * as life from '../sim/life.mjs'
import { SPECIES } from '../sim/species.mjs'
import { readWeather } from '../sim/env.mjs'
import { createRenderer } from './render.mjs'
import { fishLayer } from './fish3d.mjs'
import { WATER_BOTTOM, createMotion } from './motion.mjs'
import { createHud } from './hud.mjs'
import { createChooser } from './chooser.mjs'

const host = window.host
const boot = await host.boot()
// 鱼的 3D 模型先读进来，鱼和选鱼界面才画得出来（没有模型的鱼种用代码画的贴图，不用读）。
await fishLayer().loadAll(host.asset)
const dev = boot.dev
const rng = Math.random

// 时钟。--fast 只在开发存档下才有（主进程已经把关），正常运行就是真实时间。
const realStart = Date.now()
const perfStart = performance.now()
const now = () => (dev.fast > 1 ? realStart + (performance.now() - perfStart) * dev.fast : Date.now())

// ---- 状态 ----
// 没有存档就是一个空鱼缸：养什么鱼由用户在选鱼界面里挑（见最下面）。
let state = boot.save && boot.save.version === 1 ? boot.save : null
if (!state) {
  state = life.createPond(now(), rng, dev.demo ? { neon: 12 } : undefined)
  if (dev.demo) {
    // 演示：直接给一缸大小不一的鱼，看画面用。
    state.fish.forEach((f, i) => {
      const sp = SPECIES[f.species]
      f.length = sp.maxLength * f.genome.size * (0.45 + 0.5 * ((i * 37) % 10) / 10)
      f.bornAt -= 20 * life.DAY
      f.satiety = 30 + ((i * 13) % 60)
    })
    state.createdAt -= 37 * life.DAY
  }
}

// ---- 天气 ----
const WEATHER_MAX_AGE = 3 * life.HOUR // 断网太久的天气不算数，退回「没取到」
const FAKE = { clear: 0, partly: 2, cloudy: 3, fog: 45, drizzle: 53, rain: 63, snow: 73, thunder: 95 }
let weather = boot.weather // { location, current }
function currentEnv(t) {
  let w = weather.current && Date.now() - weather.current.fetchedAt < WEATHER_MAX_AGE ? weather.current : null
  let where = weather.location
  if (dev.weather && dev.weather in FAKE) {
    w = { code: FAKE[dev.weather], temp: dev.weather === 'snow' ? -1 : 16, wind: 14, precip: 2, cloud: null }
    where = { name: '演示' }
  }
  const env = readWeather(w, t, where)
  if (dev.light != null && Number.isFinite(dev.light)) env.light = dev.light
  return env
}

// ---- 画面与自适应 ----
const canvas = document.getElementById('pond')
const renderer = createRenderer(canvas, { plain: boot.plain })
const motion = createMotion()
const hud = createHud()
const chooser = createChooser()
hud.setInsets(boot.insets)
hud.show(boot.hud)
let view = { W: 1, H: 1, lenUnit: 1 }

// 窗口尺寸一变（换分辨率、换缩放、换屏幕、窗口模式下拖边）就整体重排。
function layout() {
  view = renderer.resize()
  motion.resize(view.W, view.H)
}
layout()
new ResizeObserver(layout).observe(canvas)
// 缩放比例变了但 CSS 尺寸没变时 ResizeObserver 不响，单独盯一下。
let dpr = window.devicePixelRatio
setInterval(() => {
  if (window.devicePixelRatio !== dpr) {
    dpr = window.devicePixelRatio
    layout()
  }
}, 2000)

// ---- 背景 ----
// 背景是一张图：自带的水族箱，或主进程送来的图片（自选的、或系统壁纸）。
async function applyBackground(bg) {
  if (!bg || !bg.bytes) {
    renderer.setBackground(null)
    if (bg && bg.problem) hud.say(bg.problem)
    return
  }
  try {
    renderer.setBackground(await createImageBitmap(new Blob([bg.bytes])), bg.plants)
  } catch (e) {
    console.error('[background] 图片解不开：', e)
    renderer.setBackground(null)
    hud.say('这张图打不开，先用回自带的水族箱')
  }
}
host.on('background', applyBackground)
await applyBackground(boot.background)

// ---- 存档 ----
let dirty = false
let lastSave = performance.now()
function save(final) {
  host.save(state, final)
  dirty = false
  lastSave = performance.now()
}
host.on('flush', () => save(true))

// ---- 动作 ----
function openChooser() {
  const room = life.RULES.capacity - life.aliveFish(state).length - state.eggs.reduce((n, c) => n + c.count, 0)
  if (room <= 0) return hud.say(`鱼缸满了（最多 ${life.RULES.capacity} 条）`)
  chooser.open(room, state.fish.length === 0)
}

function act(name, id) {
  const t = now()
  if (name === 'feed') {
    let dropped = 0
    for (let i = 0; i < 3; i++) {
      const x = view.W * (0.15 + Math.random() * 0.7)
      const y = view.H * 0.1
      const n = motion.dropFood(x, y, 6)
      if (n > 0) renderer.addRipple(x, y, 1.6)
      dropped += n
    }
    hud.say(dropped > 0 ? '撒了三把饵料' : '水里的饵料够多了，吃不完会烂在水里')
  } else if (name === 'water') {
    const r = life.changeWater(state, t)
    if (r.ok) renderer.splash()
    hud.say(r.ok ? `换好水了，水质 ${life.quality(state)}` : r.reason)
  } else if (name === 'breed') {
    // 卵产在母鱼正下方的池底。
    const r = life.breed(state, t, rng, { y: 1 - WATER_BOTTOM })
    hud.say(r.ok ? `${r.mother.name} 和 ${r.father.name} 在池底产了卵` : r.reason)
  } else if (name === 'stock') {
    return openChooser()
  } else if (name === 'pick-plus' || name === 'pick-minus') {
    return chooser.change(id, name === 'pick-plus' ? 1 : -1)
  } else if (name === 'pick-cancel') {
    return chooser.close()
  } else if (name === 'pick-ok') {
    const r = life.stock(state, chooser.picks(), t, rng)
    if (!r.ok) return hud.say(r.reason)
    chooser.close()
    hud.say(`${r.added.join('、')}下水了，记得喂`)
  } else if (name === 'scoop') {
    if (life.removeDead(state, Number(id))) hud.say('捞走了')
  } else if (name === 'book') {
    hud.toggleBook(state, t)
    return
  }
  hud.refresh(state, currentEnv(t), t)
  save(false)
}
host.on('action', (name) => act(name))

// ---- 鼠标 ----
// 挂在桌面上时页面收不到真的鼠标事件，由主进程轮询后发过来；窗口模式下用 DOM 事件。两条路进同一组函数。
const pointer = { x: -1, y: -1, over: false }
const tip = document.getElementById('tip')
let hot = null
let hover = null

function onMove(x, y) {
  pointer.x = x
  pointer.y = y
  pointer.over = true
  const under = document.elementFromPoint(x, y)
  hud.el.classList.toggle('near', !!(under && under.closest('#hud')))
  const btn = under && under.closest('button')
  if (btn !== hot) {
    if (hot) hot.classList.remove('hot')
    if (btn) btn.classList.add('hot')
    hot = btn
  }
}

function onLeave() {
  pointer.over = false
  hud.el.classList.remove('near')
  if (hot) hot.classList.remove('hot')
  hot = null
}

function onClick(x, y) {
  const under = document.elementFromPoint(x, y)
  const btn = under && under.closest('[data-act]')
  if (btn) return btn.disabled ? undefined : act(btn.dataset.act, btn.dataset.id)
  if (under !== canvas) return // 点在面板或选鱼界面的空白处
  // 点在水里：点到死鱼就捞走，否则撒一把饵料。
  const fish = motion.fishAt(x, y, state)
  if (fish && fish.dead) return act('scoop', fish.id)
  const n = motion.dropFood(x, y, 6)
  if (n > 0) renderer.addRipple(x, y, 1.6)
  else hud.say('水里的饵料够多了，吃不完会烂在水里')
}

if (boot.windowMode) {
  window.addEventListener('mousemove', (e) => onMove(e.clientX, e.clientY))
  window.addEventListener('mouseleave', onLeave)
  window.addEventListener('click', (e) => onClick(e.clientX, e.clientY))
}
host.on('pointer', (p) => {
  if (p.type === 'move') onMove(p.x, p.y)
  else if (p.type === 'leave') onLeave()
  else if (p.type === 'click') onClick(p.x, p.y)
})

function updateTip(t) {
  const under = pointer.over ? document.elementFromPoint(pointer.x, pointer.y) : null
  hover = under === canvas ? motion.fishAt(pointer.x, pointer.y, state) : null
  if (!hover) {
    tip.hidden = true
    return
  }
  const d = life.describeFish(hover, t)
  tip.textContent = hover.dead
    ? `${d.title}\n已经死了（${hover.length.toFixed(1)}cm，养了 ${d.days} 天）\n点一下捞走`
    : `${d.title}\n第 ${d.days + 1} 天 · ${hover.length.toFixed(1)}cm${d.mature ? ' · 成年' : ''}\n饱食 ${Math.round(hover.satiety)} · 健康 ${Math.round(hover.health)}`
  tip.hidden = false
  tip.style.left = `${Math.min(pointer.x + 18, view.W - 220)}px`
  tip.style.top = `${Math.min(pointer.y + 18, view.H - 90)}px`
}

// ---- 主循环 ----
host.on('weather', (w) => {
  weather = w
})
host.on('insets', (i) => hud.setInsets(i))
host.on('hud', (v) => hud.show(v))
host.on('effects', (on) => renderer.setPlain(!on))

let lastHud = 0

// 规则那一层：推进到现在。开着时每帧调（不够一步什么都不做），刚打开时一次补完离线的时间。
function simulate(t, env) {
  const steps = life.advance(state, t, { airTemp: env.airTemp, rain: env.rain }, rng)
  if (steps > 0) dirty = true
  const p = performance.now()
  if (steps > 0 || p - lastHud > 1000) {
    hud.refresh(state, env, t)
    lastHud = p
  }
  if (dirty && p - lastSave > 60e3) save(false)
}

const motionCtx = {
  state,
  lenUnit: 1,
  wind: 0,
  pointer, // 鼠标在哪：在鱼群旁边猛地一动，鱼会受惊
  onEat: (fishId, pellet) => {
    life.eat(state, fishId)
    renderer.addRipple(pellet.x, pellet.y, 0.8)
    dirty = true
  },
  onWaste: (n) => {
    life.wasteFood(state, n)
    dirty = true
  },
}

let visible = true
let looping = false
let lastFrame = 0
function frame(ts) {
  if (!visible) {
    looping = false
    return
  }
  requestAnimationFrame(frame)
  // 约 30 帧就够：这是壁纸，不值得跟着 144Hz 的屏幕烧显卡。
  if (ts - lastFrame < 31) return
  const dt = Math.min(0.1, (ts - lastFrame) / 1000)
  lastFrame = ts
  const t = now()
  const env = currentEnv(t)
  simulate(t, env)
  motionCtx.lenUnit = view.lenUnit
  motionCtx.wind = env.wind
  motion.update(dt, motionCtx)
  updateTip(t)
  renderer.draw({ t: ts / 1000, dt, state, bodies: motion.bodies, food: motion.food, env, hover })
}
function kick() {
  if (looping) return
  looping = true
  lastFrame = performance.now()
  requestAnimationFrame(frame)
}

// 桌面被最大化的窗口盖住时不画，但鱼照样在长、在饿：每 5 秒推进一次规则。
host.on('visible', (v) => {
  visible = v
  if (v) kick()
})
setInterval(() => {
  if (visible) return
  const t = now()
  simulate(t, currentEnv(t))
}, 5000)

hud.refresh(state, currentEnv(now()), now())
kick()
// 鱼缸是空的（第一次打开，或者都养没了）：先让用户选养什么。
if (state.fish.length === 0 && state.eggs.length === 0) openChooser()
