import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DAY, HOUR, RULES, advance, aliveFish, breed, changeWater, createPond, eat, metabolism, quality,
  removeDead, stock, wantsFood, wasteFood,
} from '../src/sim/life.mjs'
import { SPECIES, crossGenome, makeRng, randomGenome } from '../src/sim/species.mjs'
import { readWeather } from '../src/sim/env.mjs'
import { sunTimes } from '../src/sim/sun.mjs'
import { createRequire } from 'node:module'

const T0 = Date.UTC(2026, 10, 13, 0, 0, 0)
const MILD = { airTemp: 20, rain: 0 } // 20°C：新陈代谢系数正好是 1

function pond(seed = 1) {
  const rng = makeRng(seed)
  const state = createPond(T0, rng, { koi: 4, goldfish: 2 })
  state.water.temp = 20
  return { state, rng }
}

// 每隔 everyHours 把所有活鱼喂饱一次，喂 days 天。
function keepFed(state, rng, days, everyHours = 12, env = MILD) {
  for (let t = T0; t < T0 + days * DAY; t += everyHours * HOUR) {
    for (const f of aliveFish(state)) {
      while (wantsFood(f, state.water.temp)) eat(state, f.id)
    }
    advance(state, t + everyHours * HOUR, env, rng)
    if (quality(state) < 70) changeWater(state, state.lastTick)
  }
}

test('不喂：36 小时饿空，约 5 天饿死，死因记饿死', () => {
  const { state, rng } = pond()
  for (const f of state.fish) f.satiety = 100
  advance(state, T0 + 35 * HOUR, MILD, rng)
  assert.ok(state.fish.every((f) => f.satiety > 0), '35 小时还没空')
  advance(state, T0 + 4 * DAY, MILD, rng)
  assert.equal(aliveFish(state).length, 6, '第 4 天都还活着（周末不开机不至于死）')
  advance(state, T0 + 5.5 * DAY, MILD, rng)
  assert.equal(aliveFish(state).length, 0, '5 天半全饿死')
  assert.ok(state.fish.every((f) => f.dead.cause === 'starve'))
  assert.ok(state.log.some((l) => l.text.includes('饿死了')))
})

test('按时喂：锦鲤一周长到 15cm 以上、30 天过 40cm；喂得少的明显小', () => {
  const a = pond(7)
  keepFed(a.state, a.rng, 7)
  const koiA = a.state.fish.filter((f) => f.species === 'koi')
  assert.ok(koiA.every((f) => f.length > 14 && f.length < 22), koiA.map((f) => f.length.toFixed(1)).join())
  keepFed(a.state, a.rng, 30)
  assert.ok(a.state.fish.filter((f) => f.species === 'koi').every((f) => f.length > 40))

  // 同样的鱼，三天才喂一次：大半时间饿着，长得慢，极限体长也被打了折。
  const b = pond(7)
  keepFed(b.state, b.rng, 7, 72)
  const koiB = b.state.fish.filter((f) => f.species === 'koi')
  assert.equal(aliveFish(b.state).length, 6, '三天一喂不至于死')
  for (let i = 0; i < koiA.length; i++) {
    assert.ok(koiB[i].length < koiA[i].length * 0.8, `${koiB[i].length} vs ${koiA[i].length}`)
    assert.ok(koiB[i].potential < 1)
  }
})

test('一粒饵料：小鱼一口饱，大鱼要好几粒；饱了不再吃', () => {
  const { state } = pond()
  const fish = state.fish[0]
  fish.satiety = 0
  fish.length = 5
  eat(state, fish.id)
  assert.equal(fish.satiety, 100)
  assert.equal(wantsFood(fish, 20), false)
  fish.satiety = 0
  fish.length = 50
  eat(state, fish.id)
  assert.equal(fish.satiety, 20)
  assert.equal(wantsFood(fish, 20), true)
})

test('喂多了：没吃掉的饵料烂在水里，水脏到一定程度鱼会病死', () => {
  const { state, rng } = pond()
  wasteFood(state, 40)
  assert.equal(quality(state), 75)
  wasteFood(state, 200)
  assert.equal(quality(state), 0)
  // 水一直是最脏的，鱼吃得再饱也撑不过 5 天。
  for (let d = 0; d < 5; d++) {
    for (const f of aliveFish(state)) f.satiety = 100
    state.water.dirt = 100
    advance(state, T0 + (d + 1) * DAY, MILD, rng)
  }
  assert.equal(aliveFish(state).length, 0)
  assert.ok(state.fish.every((f) => f.dead.cause === 'water'))
})

test('换水：去掉七成脏东西，两小时内不能再换', () => {
  const { state } = pond()
  state.water.dirt = 80
  assert.equal(changeWater(state, T0).ok, true)
  assert.equal(quality(state), 76)
  const again = changeWater(state, T0 + HOUR)
  assert.equal(again.ok, false)
  assert.match(again.reason, /60 分钟后/)
  assert.equal(changeWater(state, T0 + 2 * HOUR).ok, true)
})

test('繁殖：没成年不行并说出差多少；成年吃饱的一公一母产卵，到点孵出带父母花色的鱼苗', () => {
  const { state, rng } = pond(3)
  const no = breed(state, T0, rng)
  assert.equal(no.ok, false)
  assert.match(no.reason, /还没成年/)

  const koi = state.fish.filter((f) => f.species === 'koi')
  const mother = koi.find((f) => f.sex === 'f')
  const father = koi.find((f) => f.sex === 'm')
  for (const f of [mother, father]) {
    f.length = 30
    f.satiety = 40
  }
  assert.match(breed(state, T0, rng).reason, /先喂一喂/)
  for (const f of [mother, father]) f.satiety = 90

  state.water.dirt = 60
  assert.match(breed(state, T0, rng).reason, /先换水/)
  state.water.dirt = 10

  const yes = breed(state, T0, rng, { x: 0.5, y: 0.5 })
  assert.equal(yes.ok, true)
  assert.equal(state.eggs.length, 1)
  assert.equal(mother.satiety, 65)
  assert.match(breed(state, T0 + HOUR, rng).reason, /要歇 3 天|凑不出|先喂/)

  const before = aliveFish(state).length
  for (const f of aliveFish(state)) f.satiety = 100
  advance(state, T0 + 23 * HOUR, MILD, rng)
  assert.equal(aliveFish(state).length, before, '23 小时还没孵')
  advance(state, T0 + 25 * HOUR, MILD, rng)
  const fry = aliveFish(state).slice(before)
  assert.equal(fry.length, yes.clutch.count)
  assert.equal(state.eggs.length, 0)
  for (const f of fry) {
    assert.equal(f.species, 'koi')
    assert.ok(f.length >= SPECIES.koi.fryLength && f.length < SPECIES.koi.fryLength + 0.3)
    assert.ok([mother.genome.base, father.genome.base].includes(f.genome.base))
    assert.ok(Math.abs(f.x - 0.5) < 0.05 && Math.abs(f.y - 0.5) < 0.05)
  }
})

test('后代花色只从父母来（突变的那一块除外）', () => {
  const rng = makeRng(11)
  for (let i = 0; i < 200; i++) {
    const m = randomGenome('koi', rng)
    const f = randomGenome('koi', rng)
    const child = crossGenome(m, f, rng)
    const parentColors = new Set([...m.marks, ...f.marks].map((x) => x.c))
    const strange = child.marks.filter((x) => !parentColors.has(x.c))
    assert.ok(strange.length <= 1)
    assert.ok(child.marks.every((x) => x.c !== child.base))
    assert.ok(child.marks.length <= 7)
  }
})

test('老死：过了寿命几天内死掉，死因记老死；死鱼 48 小时后自己没了，也可以先捞走', () => {
  const { state, rng } = pond()
  const old = state.fish[0]
  const life = SPECIES[old.species].lifespanDays * old.genome.life
  old.bornAt = T0 - (life + 0.01) * DAY
  for (let d = 0; d < 12 && !old.dead; d++) {
    for (const f of aliveFish(state)) f.satiety = 100
    advance(state, T0 + (d + 1) * DAY, MILD, rng)
  }
  assert.equal(old.dead.cause, 'age')
  assert.equal(aliveFish(state).length, 5)

  const copy = structuredClone(state)
  assert.equal(removeDead(copy, old.id), true)
  assert.equal(copy.fish.length, 5)

  for (const f of aliveFish(state)) f.satiety = 100
  advance(state, old.dead.at + 49 * HOUR, MILD, rng)
  assert.ok(!state.fish.some((f) => f.id === old.id))
})

test('离线补算和一直开着结果一样', () => {
  const a = pond(5)
  const b = pond(5)
  for (let t = T0; t < T0 + 3 * DAY; t += 60e3) advance(a.state, t, null, a.rng) // 每分钟推一次
  advance(a.state, T0 + 3 * DAY, null, a.rng)
  advance(b.state, T0 + 3 * DAY, null, b.rng) // 关了三天，一次补完
  assert.deepEqual(a.state, b.state)
})

test('水温：追着气温走；冷了饿得慢也长得慢，下雨水脏得慢', () => {
  assert.equal(metabolism(20), 1)
  assert.equal(metabolism(0), 0.4)
  assert.equal(metabolism(40), 1.2)

  const cold = pond(9)
  const warm = pond(9)
  for (const s of [cold.state, warm.state]) for (const f of s.fish) f.satiety = 100
  advance(cold.state, T0 + DAY, { airTemp: 5, rain: 0 }, cold.rng)
  advance(warm.state, T0 + DAY, { airTemp: 20, rain: 0 }, warm.rng)
  assert.ok(cold.state.water.temp < 6 && cold.state.water.temp > 5)
  assert.ok(cold.state.fish[0].satiety > warm.state.fish[0].satiety + 15)
  assert.ok(cold.state.fish[0].length < warm.state.fish[0].length)

  const dry = pond(9)
  const wet = pond(9)
  for (const s of [dry.state, wet.state]) s.water.dirt = 30
  advance(dry.state, T0 + DAY, { airTemp: 20, rain: 0 }, dry.rng)
  advance(wet.state, T0 + DAY, { airTemp: 20, rain: 1 }, wet.rng)
  assert.ok(wet.state.water.dirt < dry.state.water.dirt - 3)
})

test('选鱼：空池子起步，按选的鱼种放苗，一公一母轮着来，满了就放不进', () => {
  const rng = makeRng(2)
  const state = createPond(T0, rng)
  assert.equal(state.fish.length, 0)
  assert.equal(stock(state, {}, T0, rng).ok, false)

  const first = stock(state, { guppy: 3, neon: 4, angelfish: 2 }, T0, rng)
  assert.equal(first.ok, true)
  assert.deepEqual(state.fish.map((f) => f.species + f.sex).join(), 'guppym,guppyf,guppym,neonm,neonf,neonm,neonf,angelfishm,angelfishf')
  for (const f of state.fish) assert.equal(f.length, SPECIES[f.species].fryLength * 1.6)
  assert.match(state.log.at(-1).text, /3 条孔雀鱼苗、4 条红绿灯苗、2 条神仙鱼苗/)

  // 之后还能再添，添到满为止。
  const more = stock(state, { koi: 30 }, T0, rng)
  assert.equal(more.ok, true)
  assert.equal(aliveFish(state).length, RULES.capacity)
  assert.match(stock(state, { koi: 1 }, T0, rng).reason, /池子满了/)
})

test('五种鱼各自按自己的节奏长：孔雀鱼一周成年，锦鲤要十来天；小鱼一窝生得多', () => {
  const rng = makeRng(4)
  const state = createPond(T0, rng, { koi: 2, goldfish: 2, angelfish: 2, guppy: 2, neon: 2 })
  state.water.temp = 20
  keepFed(state, rng, 7)
  const of = (s) => state.fish.filter((f) => f.species === s)
  assert.ok(of('guppy').every((f) => f.length >= SPECIES.guppy.matureLength), '孔雀鱼一周成年')
  assert.ok(of('neon').every((f) => f.length >= SPECIES.neon.matureLength), '红绿灯一周成年')
  assert.ok(of('koi').every((f) => f.length < SPECIES.koi.matureLength), '锦鲤一周还没成年')
  for (const f of state.fish) assert.ok(f.length <= SPECIES[f.species].maxLength * f.genome.size)

  for (const f of aliveFish(state)) f.satiety = 100
  state.water.dirt = 0
  const r = breed(state, state.lastTick, rng)
  assert.equal(r.ok, true)
  assert.ok(['guppy', 'neon'].includes(r.clutch.species))
  assert.ok(r.clutch.count >= 3)
})

const TOKYO = { name: '东京', lat: 35.69, lon: 139.69 }
const jst = (h, m = 0) => Date.UTC(2026, 10, 13, h - 9, m) // 2026-11-13 的东京时间

test('日出日落：东京 11 月 13 日约 06:14 / 16:36；极昼极夜不报错', () => {
  const sun = sunTimes(TOKYO.lat, TOKYO.lon, jst(12))
  assert.ok(Math.abs(sun.sunrise - jst(6, 14)) < 6 * 60e3, new Date(sun.sunrise).toISOString())
  assert.ok(Math.abs(sun.sunset - jst(16, 36)) < 6 * 60e3, new Date(sun.sunset).toISOString())
  // 凌晨和深夜问，答的都是「今天」这个太阳日。
  assert.ok(Math.abs(sunTimes(TOKYO.lat, TOKYO.lon, jst(2)).sunrise - sun.sunrise) < 60e3)
  assert.ok(Math.abs(sunTimes(TOKYO.lat, TOKYO.lon, jst(23)).sunset - sun.sunset) < 60e3)
  assert.equal(sunTimes(78, 15, Date.UTC(2026, 5, 21, 12)).always, 'day') // 斯瓦尔巴的夏至
  assert.equal(sunTimes(78, 15, Date.UTC(2026, 11, 21, 12)).always, 'night')
})

test('天气换算：代码 → 种类与强度；昼夜跟着城市的日出日落渐变', () => {
  const base = { temp: 12, wind: 20, cloud: 100 }
  const rain = readWeather({ ...base, code: 63, precip: 3 }, jst(12), TOKYO)
  assert.equal(rain.kind, 'rain')
  assert.ok(rain.rain > 0.7 && rain.rain <= 1)
  assert.equal(rain.light, 1)
  assert.equal(rain.wind, 0.5)
  assert.equal(rain.city, '东京')
  assert.equal(readWeather({ ...base, code: 0, precip: 0 }, jst(12), TOKYO).rain, 0)
  assert.equal(readWeather({ ...base, code: 73, precip: 1 }, jst(12), TOKYO).kind, 'snow')
  assert.equal(readWeather({ ...base, code: 95, precip: 5 }, jst(12), TOKYO).thunder, true)
  assert.equal(readWeather({ ...base, code: 0 }, jst(19), TOKYO).light, 0, '日落两个多小时后全黑')
  assert.equal(readWeather({ ...base, code: 0 }, jst(3), TOKYO).light, 0, '凌晨全黑')
  const dusk = readWeather({ ...base, code: 0 }, jst(16, 36), TOKYO).light
  assert.ok(dusk > 0.4 && dusk < 0.6, `日落那一刻一半亮：${dusk}`)
  // 取不到天气但知道城市：昼夜照常，城市名还在。
  const blind = readWeather(null, jst(19), TOKYO)
  assert.equal(blind.known, false)
  assert.equal(blind.light, 0)
  assert.equal(blind.city, '东京')
  // 连城市都没有：不报错。
  assert.equal(readWeather(null, jst(12), null).known, false)
})

test('met.no 的图标名换成 WMO 代码：先认雷、再认雪、再认雨', () => {
  const { metNoCode } = createRequire(import.meta.url)('../src/weather.js')
  const kind = (symbol) => readWeather({ code: metNoCode(symbol), temp: 10 }, jst(12), TOKYO).kind
  assert.equal(kind('clearsky_day'), 'clear')
  assert.equal(kind('fair_night'), 'partly')
  assert.equal(kind('partlycloudy_day'), 'partly')
  assert.equal(kind('cloudy'), 'cloudy')
  assert.equal(kind('fog'), 'fog')
  assert.equal(kind('lightrainshowers_day'), 'drizzle')
  assert.equal(kind('rain'), 'rain')
  assert.equal(kind('heavyrainshowers_night'), 'rain')
  assert.equal(kind('lightsnow'), 'snow')
  assert.equal(kind('sleet'), 'snow')
  assert.equal(kind('heavyrainandthunder'), 'thunder')
  assert.equal(kind('lightsnowshowersandthunder_day'), 'thunder')
  assert.equal(kind(undefined), 'cloudy')
})
