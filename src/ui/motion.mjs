// 鱼怎么游、饵料怎么沉。鱼缸是从正侧面看的：鱼左右游、头朝左或朝右，上下只是微微抬头低头。
// 每种鱼的脾气不一样（species.mjs 的 habit）：待在哪一层水、成不成群、爱不爱发呆、去不去池底啄食。
// 只管画面上「快」的事，不存档（位置按比例写回 state.fish，存档时带上）。
import { SPECIES } from '../sim/species.mjs'
import { metabolism, wantsFood } from '../sim/life.mjs'

const TAU = Math.PI * 2
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

export const MIN_FISH_PX = 14 // 刚孵出来的鱼苗按体长算只有几个像素，给个下限才看得见
export const MAX_PELLETS = 120
// 鱼在画面上多长。不按真实比例：70cm 的锦鲤和 1cm 的孔雀鱼苗差 70 倍，照实画小鱼只剩一个点。
// 按体长的 0.6 次方算——小鱼也看得清，长大了照样明显变大。鱼册和提示里的厘米数是真的。
export const displayLength = (cm, unit) => unit * Math.pow(cm, 0.6)
// 鱼能游的范围：上面留给水面，下面留给池底（都是占屏幕高度的比例）。
export const WATER_TOP = 0.06
export const WATER_BOTTOM = 0.12
const PELLET_REST_S = 25 // 饵料沉到底后多久烂掉

export function createMotion() {
  const bodies = new Map() // fish.id → 画面上的身体
  const food = []
  // 成群的鱼种：每种一个「群」——一个看不见的点，自己在这种鱼爱待的水层里游过来游过去、到地方歇一会儿；
  // 群里的鱼各自在它周围占个位置跟着走，所以一群鱼是一起动、朝同一个方向的。
  // 真鱼平时只是松松地待在一起，受了惊才紧紧抱团一起窜：alarm 就是「惊」的程度，鼠标在群旁边猛地一动拉满，几秒后消退。
  const schools = new Map() // 鱼种 → { x, y, tx, ty, pause, dir, moving, n, len, alarm }
  let lastPointer = null // 上一帧鼠标在哪，用来算它动得多快
  let W = 1
  let H = 1

  function resize(w, h) {
    W = w
    H = h
    // 位置按比例存，换了尺寸直接按新尺寸摆回去。
    for (const b of bodies.values()) {
      b.x = b.nx * W
      b.y = b.ny * H
    }
    for (const p of food) {
      p.x = p.nx * W
      p.y = p.ny * H
    }
  }

  const floorY = () => H * (1 - WATER_BOTTOM)

  function newBody(fish) {
    return {
      nx: fish.x, ny: fish.y, x: fish.x * W, y: fish.y * H,
      dir: Math.cos(fish.heading ?? 0) >= 0 ? 1 : -1, // 1 朝右，-1 朝左
      pitch: 0, // 抬头（负）低头（正）的角度
      turn: 0, // 0 没在掉头；(0, 1) 掉头的进度，过半时换朝向
      flipped: false,
      speed: 0, effort: 0, phase: Math.random() * TAU,
      tx: fish.x * W, ty: fish.y * H, retarget: 0, rest: 0, lenPx: MIN_FISH_PX,
      slot: null, // 跟着群走时，自己在群里的位置 { x, y }（相对群的中心，单位是群的半径）
      peck: 0, // 池底啄食：-1 正往池底去，> 0 在低头啄、还剩几秒，0 没这回事
    }
  }

  // 这种鱼爱待的水层，换算成屏幕上的上下界。
  function layerOf(habit, minY, maxY) {
    return [minY + (maxY - minY) * habit.layer[0], minY + (maxY - minY) * habit.layer[1]]
  }

  // 群的半径：鱼越多、这种鱼越松散，圈子越大；平时摊得开，受惊时缩成一团。
  const spread = (school, habit) => school.len * (1.2 + 0.9 * Math.sqrt(school.n)) * (1.6 - habit.school) * (1.9 - 1.2 * school.alarm)

  // 每个群往前挪一步。dash：鼠标这一帧动得多快（像素 / 秒），不在画面上就是 0。
  function updateSchools(dt, state, pointer, dash) {
    const groups = new Map()
    for (const fish of state.fish) {
      const b = bodies.get(fish.id)
      if (!b || fish.dead || SPECIES[fish.species].habit.school < 0.2) continue
      if (!groups.has(fish.species)) groups.set(fish.species, [])
      groups.get(fish.species).push(b)
    }
    for (const species of schools.keys()) if ((groups.get(species)?.length ?? 0) < 2) schools.delete(species)
    for (const [species, members] of groups) {
      if (members.length < 2) continue // 一条鱼成不了群
      const sp = SPECIES[species]
      const mean = (pick) => members.reduce((sum, m) => sum + pick(m), 0) / members.length
      let s = schools.get(species)
      if (!s) {
        s = { x: mean((m) => m.x), y: mean((m) => m.y), tx: 0, ty: 0, pause: 0.5 + Math.random() * 2, dir: 1, moving: false, alarm: 0 }
        schools.set(species, s)
      }
      s.n = members.length
      s.len = mean((m) => m.lenPx)
      s.alarm = Math.max(0, s.alarm - dt / 7)
      // 受惊：鼠标在群旁边猛地一动（慢慢挪过来看鱼不算）。整群抱紧，往远离鼠标的那边窜。
      if (dash > 700 && s.alarm < 0.6 && members.some((m) => Math.hypot(m.x - pointer.x, m.y - pointer.y) < 140 + s.len * 2)) {
        s.alarm = 1
        s.pause = 0
        const tall = s.len * sp.depth
        const [top, bottom] = layerOf(sp.habit, H * WATER_TOP + tall * 0.7, floorY() - tall * 0.7)
        const margin = Math.min(W * 0.2, s.len * 3)
        s.tx = clamp(s.x + (s.x >= pointer.x ? 1 : -1) * W * 0.35, margin, W - margin)
        s.ty = top + Math.random() * (bottom - top)
      }
      if (s.pause > 0) {
        // 歇着：原地不动，鱼在周围各自转悠。歇够了挑下一个去处——横着跨大半个缸，上下不出自己的水层。
        s.moving = false
        s.pause -= dt
        if (s.pause <= 0) {
          const tall = s.len * sp.depth
          const [top, bottom] = layerOf(sp.habit, H * WATER_TOP + tall * 0.7, floorY() - tall * 0.7)
          const margin = Math.min(W * 0.2, s.len * 3)
          s.tx = margin + Math.random() * (W - margin * 2)
          s.ty = top + Math.random() * (bottom - top)
        }
        continue
      }
      const dx = s.tx - s.x
      const dy = s.ty - s.y
      const d = Math.hypot(dx, dy)
      // 平时慢悠悠地挪（比鱼自己巡游慢得多，鱼跟得很从容）；受惊时快。
      const v = (14 + 3 * Math.sqrt(s.len)) * sp.swim * (0.45 + 1.25 * s.alarm)
      if (d < v * dt + 20) {
        s.pause = (1.5 + Math.random() * (2 + 8 * sp.habit.idle)) * (s.alarm > 0.3 ? 0.3 : 1.6)
      } else {
        s.x += (dx / d) * v * dt
        s.y += (dy / d) * v * dt
        s.dir = dx >= 0 ? 1 : -1
        s.moving = true
      }
    }
  }

  // 没在追饵料时，接下来去哪。
  function pickTarget(b, fish, box) {
    const habit = SPECIES[fish.species].habit
    const [top, bottom] = layerOf(habit, box.minY, box.maxY)
    b.slot = null
    const school = schools.get(fish.species)
    if (school && Math.random() < habit.school) {
      // 跟着群：在群周围占个位置。群在赶路时位置偏前，免得老是掉头去够。
      const ahead = school.moving ? school.dir * Math.random() * 0.5 : 0
      b.slot = { x: ahead + (Math.random() - 0.5) * 2, y: (Math.random() - 0.5) * 0.9 }
      return
    }
    if (Math.random() < habit.forage * 0.5) {
      // 下到池底啄一会儿。
      b.tx = clamp(b.x + (Math.random() - 0.5) * W * 0.3, box.minX, box.maxX)
      b.ty = box.maxY
      b.peck = -1 // 到了地方再开始计时
      return
    }
    // 自己逛：左右随便去，上下只小幅挪，不出自己的水层。
    b.tx = box.minX + Math.random() * (box.maxX - box.minX)
    b.ty = clamp(b.y + (Math.random() - 0.5) * H * 0.4, top, bottom)
  }

  // ctx: { state, lenUnit, wind, pointer: { x, y, over }, onEat(fishId, pellet), onWaste(n) }
  function update(dt, ctx) {
    const { state } = ctx
    const m = metabolism(state.water.temp)
    const live = new Set()
    const pointer = ctx.pointer?.over ? ctx.pointer : null
    const dash = pointer && lastPointer && dt > 0 ? Math.hypot(pointer.x - lastPointer.x, pointer.y - lastPointer.y) / dt : 0
    lastPointer = pointer ? { x: pointer.x, y: pointer.y } : null
    updateSchools(dt, state, pointer, dash)

    for (const fish of state.fish) {
      live.add(fish.id)
      let b = bodies.get(fish.id)
      if (!b) {
        b = newBody(fish)
        bodies.set(fish.id, b)
      }
      const sp = SPECIES[fish.species]
      b.lenPx = Math.max(MIN_FISH_PX, displayLength(fish.length, ctx.lenUnit))
      const tall = b.lenPx * sp.depth
      const box = {
        minX: b.lenPx * 0.55 + 6,
        maxX: W - b.lenPx * 0.55 - 6,
        minY: H * WATER_TOP + tall * 0.7,
        maxY: floorY() - tall * 0.7,
      }

      if (fish.dead) {
        // 死鱼翻着肚子浮到水面，顺着风慢慢漂。
        const top = H * WATER_TOP * 0.5 + tall * 0.35
        b.y += (top - b.y) * Math.min(1, dt * 0.5)
        b.x = clamp(b.x + (2 + ctx.wind * 10) * dt, box.minX, box.maxX)
        b.pitch *= 1 - Math.min(1, dt * 2)
        b.speed = 0
        b.effort = 0
        b.turn = 0
      } else {
        const vigor = (0.45 + 0.55 * Math.min(1, m)) * (0.5 + 0.5 * (fish.health / 100))
        const cruise = (14 + 3 * Math.sqrt(b.lenPx)) * sp.swim * vigor

        // 想去哪：饿了又有饵料就奔最近的一粒，否则逛。
        let goal = null
        if (food.length > 0 && wantsFood(fish, state.water.temp)) {
          let best = Infinity
          for (const p of food) {
            const d = Math.hypot(p.x - b.x, (p.y - b.y) * 1.6) // 上下的距离算贵一点：鱼更愿意横着游
            if (d < best) {
              best = d
              goal = p
            }
          }
        }
        if (goal) {
          b.rest = 0
          const mouthX = b.x + b.dir * b.lenPx * 0.45
          if (Math.hypot(goal.x - mouthX, goal.y - b.y) < Math.max(10, b.lenPx * 0.15)) {
            food.splice(food.indexOf(goal), 1)
            ctx.onEat(fish.id, goal)
            goal = null
          }
        }
        if (goal) {
          b.slot = null
          b.peck = 0
        } else {
          const habit = sp.habit
          const mine = schools.get(fish.species)
          if (mine && mine.alarm > 0.5) {
            // 群受惊了：不管刚才在干什么，立刻归队。
            b.slot ??= { x: (Math.random() - 0.5) * 2, y: (Math.random() - 0.5) * 0.9 }
            b.rest = 0
            b.peck = 0
          }
          const school = b.slot ? mine : null
          if (b.slot && !school) b.slot = null // 群散了（同种的只剩自己）
          if (school) {
            // 群在动、在松在紧，自己的位置都跟着变。
            const r = spread(school, habit)
            b.tx = clamp(school.x + b.slot.x * r, box.minX, box.maxX)
            b.ty = clamp(school.y + b.slot.y * r, box.minY, box.maxY)
          }
          b.retarget -= dt
          const behind = (b.tx - b.x) * b.dir < 0 && Math.abs(b.tx - b.x) <= b.lenPx * 0.4
          const near = Math.hypot(b.tx - b.x, b.ty - b.y) < (school ? Math.max(10, b.lenPx * 0.5) : 40)
          if (b.peck < 0 && (near || b.retarget <= 0)) {
            b.peck = 1.5 + Math.random() * 3 // 到池底了：低头啄一会儿
          } else if (b.peck > 0) {
            b.peck = Math.max(0, b.peck - dt)
          } else if (b.peck === 0 && (b.retarget <= 0 || behind || near)) {
            pickTarget(b, fish, box)
            b.retarget = b.slot ? 3 + Math.random() * 5 : 6 + Math.random() * 14
            // 停下来悬一会儿：越爱发呆的鱼停得越勤、越久。跟着群赶路的时候不停，不然就掉队了。
            const travelling = b.slot && schools.get(fish.species)?.moving
            if (!travelling && Math.random() < 0.1 + 0.5 * habit.idle) b.rest = (2 + Math.random() * 5) * (0.5 + 1.5 * habit.idle)
          }
        }
        const gx = goal ? goal.x : b.tx
        let gy = goal ? goal.y : b.ty
        const dx = gx - b.x

        // 别和别的鱼叠在一起：挨得太近就上下错开。
        for (const [id, o] of bodies) {
          if (id === fish.id) continue
          if (Math.abs(b.x - o.x) < (b.lenPx + o.lenPx) * 0.4 && Math.abs(b.y - o.y) < (b.lenPx + o.lenPx) * 0.1) {
            gy += (b.y >= o.y ? 1 : -1) * b.lenPx * (goal ? 0.15 : 0.5)
          }
        }
        gy = clamp(gy, box.minY, box.maxY)
        const dy = gy - b.y

        // 目标在身后就掉头：先收窄（像转身），过半时换朝向，再展开。
        const wantDir = dx >= 0 ? 1 : -1
        if (b.turn === 0 && wantDir !== b.dir && Math.abs(dx) > b.lenPx * 0.4) b.turn = 0.0001
        if (b.turn > 0) {
          b.turn += dt / clamp(b.lenPx / 260, 0.35, 0.9) // 大鱼转身慢
          if (b.turn >= 0.5 && !b.flipped) {
            b.dir = -b.dir
            b.flipped = true
          }
          if (b.turn >= 1) {
            b.turn = 0
            b.flipped = false
          }
        }

        // 啄食时头朝下扎着；平时按要去的方向微微抬头低头。
        const wantPitch = b.peck > 0 ? 0.8 : clamp(Math.atan2(dy, Math.max(Math.abs(dx), b.lenPx * 0.7)), -0.55, 0.55)
        b.pitch += (wantPitch - b.pitch) * Math.min(1, dt * 2.5)

        b.rest = Math.max(0, b.rest - dt)
        const above = goal && Math.abs(dx) < b.lenPx * 0.35 // 饵料就在头顶或脚下：别往前冲过头
        let target = cruise * (goal ? 2.3 : 1)
        if (b.rest > 0) target *= 0.12
        if (b.peck > 0) target *= 0.08
        // 跟群：离自己的位置远就加把劲追，到位了就慢下来——一群鱼的快慢自然就齐了。受惊时整体再快一截。
        const school = b.slot && !goal ? schools.get(fish.species) : null
        if (school) target *= clamp(Math.hypot(dx, dy) / spread(school, sp.habit), 0.35, 1.7) * (1 + 0.9 * school.alarm)
        if (b.turn > 0) target *= 0.3
        if (above) target *= 0.25
        b.speed += (target - b.speed) * Math.min(1, dt * 1.8)
        b.effort = b.speed / (cruise * 2.3)
        const lift = goal ? clamp(dy / b.lenPx, -1, 1) * cruise * 0.7 : 0
        b.x = clamp(b.x + b.dir * Math.cos(b.pitch) * b.speed * dt, box.minX, box.maxX)
        b.y = clamp(b.y + (Math.sin(b.pitch) * b.speed + lift) * dt, box.minY, box.maxY)
        // 顶到缸壁还朝外：马上换个目标，别贴着玻璃原地游。
        if ((b.x <= box.minX && b.dir < 0) || (b.x >= box.maxX && b.dir > 0)) b.retarget = 0
      }
      // 尾巴摆动的快慢跟着速度走。
      b.phase += dt * (2.4 + (b.speed / b.lenPx) * 10)
      b.nx = b.x / W
      b.ny = b.y / H
      fish.x = b.nx
      fish.y = b.ny
      fish.heading = b.dir > 0 ? 0 : Math.PI
    }
    for (const id of bodies.keys()) if (!live.has(id)) bodies.delete(id)

    // 饵料：晃晃悠悠往下沉，沉到底躺一会儿，没鱼吃就烂掉。
    let wasted = 0
    const bottom = floorY() + H * 0.015
    for (let i = food.length - 1; i >= 0; i--) {
      const p = food[i]
      p.age += dt
      if (p.y < bottom) {
        p.y = Math.min(bottom, p.y + p.sink * dt)
        p.x = clamp(p.x + Math.sin(p.age * 2 + p.wob) * 8 * dt + ctx.wind * 4 * dt, 6, W - 6)
      } else {
        p.rested += dt
        if (p.rested > PELLET_REST_S) {
          food.splice(i, 1)
          wasted++
          continue
        }
      }
      p.nx = p.x / W
      p.ny = p.y / H
    }
    if (wasted > 0) ctx.onWaste(wasted)
  }

  // 在 (x, y) 撒一把。返回实际撒了几粒（水里太多就不撒了）。
  function dropFood(x, y, count) {
    const n = Math.min(count, MAX_PELLETS - food.length)
    for (let i = 0; i < n; i++) {
      const px = clamp(x + (Math.random() - 0.5) * 50, 6, W - 6)
      const py = clamp(y + (Math.random() - 0.5) * 24, H * WATER_TOP * 0.6, floorY())
      food.push({
        x: px, y: py, nx: px / W, ny: py / H,
        sink: (14 + Math.random() * 10) * (Math.min(W, H) / 1080),
        wob: Math.random() * TAU, age: 0, rested: 0,
      })
    }
    return n
  }

  // 这个点上是哪条鱼（悬停提示、点击捞死鱼用）。
  function fishAt(x, y, state) {
    let hit = null
    let best = Infinity
    for (const fish of state.fish) {
      const b = bodies.get(fish.id)
      if (!b) continue
      const dx = (x - b.x) / (b.lenPx * 0.58 + 6)
      const dy = (y - b.y) / (b.lenPx * SPECIES[fish.species].depth * 0.7 + 8)
      const d = dx * dx + dy * dy
      if (d < 1 && d < best) {
        best = d
        hit = fish
      }
    }
    return hit
  }

  return { bodies, food, resize, update, dropFood, fishAt }
}
