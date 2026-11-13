// 右下角的面板：天气、水质、鱼数、一排按钮、鱼册。只读 state，不改它。
import { COLORS, SPECIES } from '../sim/species.mjs'
import { aliveFish, describeFish, pondDay, quality } from '../sim/life.mjs'

const $ = (id) => document.getElementById(id)
const level = (v) => (v >= 60 ? '' : v >= 30 ? 'warn' : 'bad')
const CAUSE = { starve: '饿死', water: '病死', age: '老死' }

function el(tag, cls, text) {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text != null) e.textContent = text
  return e
}

function meter(value) {
  const box = el('div', 'mini')
  const fill = el('i', level(value))
  fill.style.width = `${Math.round(value)}%`
  box.append(fill)
  return box
}

export function createHud() {
  const hud = $('hud')
  const book = $('book')
  const toast = $('toast')
  let toastTimer = 0
  let bookOpen = false

  function refresh(state, env, now) {
    const q = quality(state)
    $('wx').textContent = env.known
      ? `${env.icon} ${env.label} ${Math.round(env.airTemp)}°C${env.city ? ' · ' + env.city : ''}`
      : `${env.icon} ${env.label}`
    $('day').textContent = `养鱼第 ${pondDay(state, now)} 天`
    $('q').style.width = `${q}%`
    $('q').className = level(q)
    $('qn').textContent = q
    $('wt').textContent = `水温 ${state.water.temp.toFixed(0)}°C`
    const alive = aliveFish(state)
    const dead = state.fish.length - alive.length
    const hungry = alive.filter((f) => f.satiety < 25).length
    const parts = [`鱼 ${alive.length} 条`]
    if (hungry > 0) parts.push(`${hungry} 条饿了`)
    if (state.eggs.length > 0) parts.push(`卵 ${state.eggs.length} 窝`)
    if (dead > 0) parts.push(`死鱼 ${dead} 条（点它捞走）`)
    $('count').textContent = parts.join(' · ')
    const lastLog = state.log[state.log.length - 1]
    $('last').textContent = lastLog ? lastLog.text : ''
    if (bookOpen) fillBook(state, now)
  }

  function fillBook(state, now) {
    book.replaceChildren()
    if (state.fish.length === 0) {
      book.append(el('div', 'empty', '鱼缸里没有鱼，点「添鱼」'))
      return
    }
    const head = el('div', 'fish head')
    head.append(el('span'), el('span', 'name', '名字'), el('span', 'num', '体长'), el('span', null, '饱食'), el('span', null, '健康'))
    book.append(head)
    const sorted = [...state.fish].sort((a, b) => !!a.dead - !!b.dead || b.length - a.length)
    for (const fish of sorted) {
      const d = describeFish(fish, now)
      const row = el('div', fish.dead ? 'fish dead' : 'fish')
      const dot = el('i', 'dot')
      dot.style.background = COLORS[fish.genome.base]
      const name = el('span', 'name', fish.name)
      if (fish.dead) {
        name.append(el('small', null, `${CAUSE[fish.dead.cause]} · ${fish.length.toFixed(1)}cm · 养了 ${d.days} 天`))
        const scoop = el('button', null, '捞走')
        scoop.dataset.act = 'scoop'
        scoop.dataset.id = fish.id
        row.append(dot, name, scoop)
      } else {
        name.append(el('small', null, `${SPECIES[fish.species].label}${fish.sex === 'm' ? '♂' : '♀'} ${d.days + 1}天${d.mature ? ' 成年' : ''}`))
        row.append(dot, name, el('span', 'num', `${fish.length.toFixed(1)}cm`), meter(fish.satiety), meter(fish.health))
      }
      book.append(row)
    }
  }

  function toggleBook(state, now) {
    bookOpen = !bookOpen
    book.hidden = !bookOpen
    if (bookOpen) fillBook(state, now)
  }

  function say(text) {
    toast.textContent = text
    toast.hidden = false
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => {
      toast.hidden = true
    }, 4500)
  }

  function setInsets(insets) {
    const root = document.documentElement.style
    for (const side of ['top', 'right', 'bottom', 'left']) root.setProperty(`--inset-${side}`, `${insets[side] || 0}px`)
  }

  return { el: hud, refresh, toggleBook, say, setInsets, show: (v) => (hud.hidden = !v) }
}
