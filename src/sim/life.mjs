// 养鱼的规则内核：饱食、体长、健康、水质、繁殖、死亡。
// 只管「慢」的事（按小时算），鱼怎么游是界面那边的事。纯函数加一个 state 对象，
// 不碰 DOM、不读时钟、不自己取随机数——时间和 rng 都由调用方给，用例才能定住。
import { SPECIES, crossGenome, pickName, randomGenome, varietyLabel } from './species.mjs'

export const HOUR = 3600e3
export const DAY = 24 * HOUR

// 所有数值都在这里，调手感只改这一处。
export const RULES = {
  stepMinutes: 5, // 推进步长；离线补算也按这个步长一步步走，和在线时走出来的结果一致
  capacity: 24, // 池子最多几条活鱼（含未孵化的卵）

  // 饱食（0 ～ 100）
  satietyDrainPerHour: 100 / 36, // 20°C 下 36 小时从饱到空
  pelletGainAt10cm: 100, // 一粒饵料让 10cm 的鱼涨多少饱食；鱼越大一粒越不顶饿（反比于体长）
  fullAt: 90, // 饱到这个数就不再吃

  // 体长
  growNeedsSatiety: 10, // 饱食低于它完全不长
  growFullSatiety: 50, // 饱食高于它按全速长
  stuntPerStarvingHour: 0.0005, // 每饿一小时，这条鱼能长到的极限体长永久少万分之五

  // 健康（0 ～ 100，到 0 就死）
  starveDamagePerHour: 1.2, // 饱食见底后每小时掉多少：20°C 下约 3.5 天饿死，加上前面的 36 小时约 5 天
  dirtHarmAbove: 60, // 脏度超过它开始伤鱼
  dirtDamagePerHour: 1.0, // 脏度到 100 时每小时掉多少
  ageDamagePerHour: 0.4, // 过了寿命后每小时掉多少
  ageDamageGrowthPerDay: 0.15, // 过寿命后每多一天再加多少
  recoverPerHour: 0.8,
  recoverSatiety: 30, // 吃得上饭、水也干净才恢复
  recoverDirt: 50,

  // 水（脏度 0 ～ 100，水质 = 100 - 脏度）
  fishDirtPerHour: 0.085, // 一条 30cm 的鱼每小时弄脏多少：6 条这样的鱼约 4 天把水质从 100 拉到 50
  hotDirtAbove: 24, // 水温高过它，水脏得更快
  hotDirtPerDegree: 0.06,
  rottenPelletDirt: 0.5, // 一粒没吃掉的饵料
  corpseDirtPerHour: 0.5, // 一条没捞走的死鱼
  corpseGoneAfterHours: 48, // 死鱼多久自己烂没了
  plantCleanPerHour: 0.02, // 水草的自净
  rainCleanPerHour: 0.2, // 雨水的稀释（乘降雨强度）
  dirtSlowsGrowthAbove: 40, // 脏度超过它开始拖慢生长
  waterChangeKeeps: 0.3, // 换一次水剩下三成脏东西
  waterChangeCooldownHours: 2,
  tempLagHours: 6, // 水温追气温的滞后
  tempMin: 2,
  tempMax: 32,

  // 繁殖
  breedHealth: 70,
  breedSatiety: 50,
  breedMaxDirt: 40,
  breedCooldownDays: 3,
  breedCostSatiety: 25,
  hatchHours: 24, // 20°C 下卵多久孵出来，水冷就更久
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

// 水温对新陈代谢的系数：5°C 时 0.4，20°C 时 1.0，25°C 以上 1.2 封顶。
// 冷了鱼吃得少、长得慢、也饿得慢；不让它掉到 0，否则冬天整整一季什么都不发生。
export function metabolism(tempC) {
  return clamp(0.4 + (tempC - 5) * 0.04, 0.4, 1.2)
}

export const quality = (state) => Math.round(100 - state.water.dirt)
export const aliveFish = (state) => state.fish.filter((f) => !f.dead)
export const ageDays = (fish, now) => (now - fish.bornAt) / DAY
// 养鱼第几天（建池当天算第 1 天）。
export const pondDay = (state, now) => Math.floor((now - state.createdAt) / DAY) + 1
export const limitLength = (fish) => SPECIES[fish.species].maxLength * fish.genome.size * fish.potential
export const isMature = (fish) => fish.length >= SPECIES[fish.species].matureLength
const eggCount = (state) => state.eggs.reduce((sum, c) => sum + c.count, 0)

function log(state, at, text) {
  state.log.push({ at, text })
  if (state.log.length > 40) state.log.splice(0, state.log.length - 40)
}

function addFish(state, species, genome, sex, length, now, rng) {
  const used = new Set(state.fish.map((f) => f.name))
  const fish = {
    id: state.nextId++,
    name: pickName(used, rng),
    species,
    sex,
    genome,
    bornAt: now,
    length,
    potential: 1, // 极限体长的折扣，饿过就永久打折（见 stuntPerStarvingHour）
    satiety: 60,
    health: 100,
    hurtBy: null, // 最近一次是什么在伤它：starve | water | age
    lastBredAt: 0,
    dead: null, // { at, cause }
    // 位置是相对整块屏幕的比例（0 ～ 1），换分辨率、换屏幕都不用换算。
    x: 0.15 + rng() * 0.7,
    y: 0.15 + rng() * 0.7,
    heading: rng() * Math.PI * 2,
  }
  state.fish.push(fish)
  return fish
}

// 建一个空池子。养什么鱼由用户自己选（stock），所以这里不放鱼；
// picks 是给用例和演示用的，传了就顺手放进去。
export function createPond(now, rng, picks) {
  const state = {
    version: 1,
    createdAt: now,
    lastTick: now,
    water: { dirt: 5, temp: 18, lastChange: 0 },
    fish: [],
    eggs: [],
    log: [],
    nextId: 1,
  }
  if (picks) stock(state, picks, now, rng)
  return state
}

// 往池子里放鱼苗。picks = { 鱼种: 条数 }。每种一公一母轮着放，两条以上就凑得出一对。
// 池子满了就放不进去，放了几条算几条。
export function stock(state, picks, now, rng) {
  const added = []
  for (const [species, count] of Object.entries(picks)) {
    const sp = SPECIES[species]
    if (!sp) continue
    let n = 0
    for (let i = 0; i < count; i++) {
      if (aliveFish(state).length + eggCount(state) >= RULES.capacity) break
      // 比刚孵出来的大一圈：买来的鱼苗不是刚出壳的。
      addFish(state, species, randomGenome(species, rng), i % 2 === 0 ? 'm' : 'f', sp.fryLength * 1.6, now, rng)
      n++
    }
    if (n > 0) added.push(`${n} 条${sp.label}苗`)
  }
  if (added.length === 0) {
    const full = aliveFish(state).length + eggCount(state) >= RULES.capacity
    return { ok: false, reason: full ? `池子满了（最多 ${RULES.capacity} 条）` : '一条都没选' }
  }
  log(state, now, `放了${added.join('、')}`)
  return { ok: true, added }
}

const CAUSE_TEXT = { starve: '饿死了', water: '水太脏，病死了', age: '老死了' }

function die(state, fish, cause, now) {
  fish.dead = { at: now, cause }
  fish.health = 0
  log(
    state,
    now,
    `${fish.name}${CAUSE_TEXT[cause]}（养了 ${Math.floor(ageDays(fish, now))} 天，${fish.length.toFixed(1)}cm）`,
  )
}

// 走一步。h 是小时数；env = { airTemp, rain }，没有天气数据时传 null（水温保持、不算雨）。
function stepOnce(state, h, env, now, rng) {
  const w = state.water
  if (env && Number.isFinite(env.airTemp)) {
    w.temp += (env.airTemp - w.temp) * (1 - Math.exp(-h / RULES.tempLagHours))
    w.temp = clamp(w.temp, RULES.tempMin, RULES.tempMax)
  }
  const m = metabolism(w.temp)
  const hot = 1 + Math.max(0, w.temp - RULES.hotDirtAbove) * RULES.hotDirtPerDegree
  let dirt = 0

  for (const fish of state.fish) {
    if (fish.dead) {
      dirt += RULES.corpseDirtPerHour * h
      continue
    }
    const sp = SPECIES[fish.species]
    fish.satiety = Math.max(0, fish.satiety - RULES.satietyDrainPerHour * m * h)

    // 三种伤害各算各的，死因记伤得最重的那一种。
    const hits = { starve: 0, water: 0, age: 0 }
    if (fish.satiety <= 0) {
      hits.starve = RULES.starveDamagePerHour * m * h
      fish.potential *= 1 - RULES.stuntPerStarvingHour * h
    }
    if (w.dirt > RULES.dirtHarmAbove) {
      hits.water =
        ((w.dirt - RULES.dirtHarmAbove) / (100 - RULES.dirtHarmAbove)) * RULES.dirtDamagePerHour * h
    }
    const over = ageDays(fish, now) - sp.lifespanDays * fish.genome.life
    if (over > 0) hits.age = (RULES.ageDamagePerHour + over * RULES.ageDamageGrowthPerDay) * h

    const total = hits.starve + hits.water + hits.age
    if (total > 0) {
      fish.health -= total
      fish.hurtBy = Object.keys(hits).reduce((a, b) => (hits[b] > hits[a] ? b : a))
      if (fish.health <= 0) {
        die(state, fish, fish.hurtBy, now)
        continue
      }
    } else {
      fish.hurtBy = null
      if (fish.satiety > RULES.recoverSatiety && w.dirt < RULES.recoverDirt) {
        fish.health = Math.min(100, fish.health + RULES.recoverPerHour * h)
      }
    }

    // 体长向个体的极限靠近（von Bertalanffy），吃不饱、水脏、水冷都打折。
    const fed = clamp(
      (fish.satiety - RULES.growNeedsSatiety) / (RULES.growFullSatiety - RULES.growNeedsSatiety),
      0,
      1,
    )
    const clean = clamp(1 - (w.dirt - RULES.dirtSlowsGrowthAbove) / 50, 0.2, 1)
    const room = limitLength(fish) - fish.length
    if (room > 0) fish.length += (sp.growthK / 24) * room * fed * clean * Math.min(1, m) * h

    // 小型鱼给个下限：按体长算它们几乎不弄脏水，一缸红绿灯就永远不用换水了。
    dirt += RULES.fishDirtPerHour * Math.max(0.12, Math.pow(fish.length / 30, 1.5)) * hot * h
  }

  const rain = env ? clamp(env.rain ?? 0, 0, 1) : 0
  dirt -= (RULES.plantCleanPerHour + RULES.rainCleanPerHour * rain) * h
  w.dirt = clamp(w.dirt + dirt, 0, 100)

  // 烂没了的死鱼。
  state.fish = state.fish.filter((f) => !f.dead || now - f.dead.at < RULES.corpseGoneAfterHours * HOUR)

  // 到点的卵孵出来。
  state.eggs = state.eggs.filter((clutch) => {
    if (now < clutch.hatchAt) return true
    const hatched = []
    for (let i = 0; i < clutch.count; i++) {
      if (aliveFish(state).length >= RULES.capacity) break
      const genome = crossGenome(clutch.mother, clutch.father, rng)
      const fry = addFish(state, clutch.species, genome, rng() < 0.5 ? 'm' : 'f', SPECIES[clutch.species].fryLength, now, rng)
      fry.x = clamp(clutch.x + (rng() - 0.5) * 0.04, 0.03, 0.97)
      fry.y = clamp(clutch.y + (rng() - 0.5) * 0.04, 0.03, 0.97)
      hatched.push(fry)
    }
    if (hatched.length > 0) {
      log(state, now, `孵出了 ${hatched.length} 条${SPECIES[clutch.species].label}苗：${hatched.map((f) => f.name).join('、')}`)
    } else {
      log(state, now, `池子满了，一窝${SPECIES[clutch.species].label}卵没孵出来`)
    }
    return false
  })
}

// 把池子推进到 toMs。开着的时候每帧调（不够一步就什么都不做），
// 关机再开时一次补算完，和一直开着走出来的结果一样。
export function advance(state, toMs, env, rng) {
  const stepMs = RULES.stepMinutes * 60e3
  let steps = 0
  while (state.lastTick + stepMs <= toMs) {
    state.lastTick += stepMs
    stepOnce(state, RULES.stepMinutes / 60, env, state.lastTick, rng)
    steps++
  }
  return steps
}

// 这条鱼现在肯不肯吃。水冷的时候胃口小，没饱也不吃了。
export function wantsFood(fish, tempC) {
  if (fish.dead) return false
  return fish.satiety < RULES.fullAt * Math.min(1, metabolism(tempC) + 0.25)
}

// 鱼吃到一粒饵料。
export function eat(state, fishId) {
  const fish = state.fish.find((f) => f.id === fishId)
  if (!fish || fish.dead) return false
  const gain = RULES.pelletGainAt10cm * Math.min(1, 10 / fish.length)
  fish.satiety = Math.min(100, fish.satiety + gain)
  return true
}

// 没吃掉的饵料烂在水里。喂多了的代价全在这里。
export function wasteFood(state, pellets) {
  state.water.dirt = clamp(state.water.dirt + pellets * RULES.rottenPelletDirt, 0, 100)
}

export function changeWater(state, now) {
  const wait = state.water.lastChange + RULES.waterChangeCooldownHours * HOUR - now
  if (wait > 0) {
    return { ok: false, reason: `刚换过水，${Math.ceil(wait / 60e3)} 分钟后再换（换太勤鱼受不了）` }
  }
  const before = quality(state)
  state.water.dirt *= RULES.waterChangeKeeps
  state.water.lastChange = now
  log(state, now, `换了水，水质 ${before} → ${quality(state)}`)
  return { ok: true }
}

// 挑一对能繁殖的鱼：同种、一公一母、成年、健康、吃饱、不在冷却期。挑不出来时说清楚差在哪。
export function breed(state, now, rng, place) {
  const alive = aliveFish(state)
  if (alive.length + eggCount(state) >= RULES.capacity) {
    return { ok: false, reason: `池子满了（最多 ${RULES.capacity} 条）` }
  }
  if (state.water.dirt > RULES.breedMaxDirt) {
    return { ok: false, reason: `水质 ${quality(state)}，要 ${100 - RULES.breedMaxDirt} 以上才肯产卵，先换水` }
  }
  const ready = (f) =>
    isMature(f) &&
    f.health >= RULES.breedHealth &&
    f.satiety >= RULES.breedSatiety &&
    now - f.lastBredAt >= RULES.breedCooldownDays * DAY
  for (const species of Object.keys(SPECIES)) {
    const mother = alive.find((f) => f.species === species && f.sex === 'f' && ready(f))
    const father = alive.find((f) => f.species === species && f.sex === 'm' && ready(f))
    if (!mother || !father) continue
    const [few, many] = SPECIES[species].clutch
    const count = few + Math.floor(rng() * (many - few + 1))
    const clutch = {
      id: state.nextId++,
      species,
      mother: mother.genome,
      father: father.genome,
      count: Math.min(count, RULES.capacity - alive.length - eggCount(state)),
      laidAt: now,
      hatchAt: now + (RULES.hatchHours / metabolism(state.water.temp)) * HOUR,
      x: place?.x ?? mother.x,
      y: place?.y ?? mother.y,
    }
    state.eggs.push(clutch)
    for (const f of [mother, father]) {
      f.lastBredAt = now
      f.satiety = Math.max(0, f.satiety - RULES.breedCostSatiety)
    }
    const hours = Math.round((clutch.hatchAt - now) / HOUR)
    log(state, now, `${mother.name} 和 ${father.name} 产了一窝卵，约 ${hours} 小时后孵出`)
    return { ok: true, clutch, mother, father }
  }
  return { ok: false, reason: whyNoPair(alive, now) }
}

function whyNoPair(alive, now) {
  if (alive.length < 2) return '至少要两条鱼'
  const mature = alive.filter(isMature)
  if (mature.length < 2) {
    const biggest = alive.reduce((a, b) => (b.length / SPECIES[b.species].matureLength > a.length / SPECIES[a.species].matureLength ? b : a))
    const need = SPECIES[biggest.species].matureLength
    return `鱼还没成年：最接近的是 ${biggest.name}（${biggest.length.toFixed(1)}cm，${SPECIES[biggest.species].label}要 ${need}cm）`
  }
  const paired = Object.keys(SPECIES).some(
    (s) => mature.some((f) => f.species === s && f.sex === 'f') && mature.some((f) => f.species === s && f.sex === 'm'),
  )
  if (!paired) return '成年的鱼里凑不出同种的一公一母'
  if (mature.every((f) => now - f.lastBredAt < RULES.breedCooldownDays * DAY)) {
    return `刚产过卵，要歇 ${RULES.breedCooldownDays} 天`
  }
  return `成年的鱼要吃饱（饱食 ${RULES.breedSatiety} 以上）、健康（${RULES.breedHealth} 以上）才肯产卵，先喂一喂`
}

// 把死鱼捞走。
export function removeDead(state, fishId) {
  const before = state.fish.length
  state.fish = state.fish.filter((f) => !(f.id === fishId && f.dead))
  return state.fish.length < before
}

// 给界面用的一行描述。
export function describeFish(fish, now) {
  const sp = SPECIES[fish.species]
  return {
    title: `${fish.name} · ${varietyLabel(fish.species, fish.genome)}${sp.label} ${fish.sex === 'm' ? '♂' : '♀'}`,
    days: Math.floor(ageDays(fish, now)),
    length: fish.length,
    mature: isMature(fish),
  }
}
