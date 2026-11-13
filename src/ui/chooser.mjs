// 选鱼界面：第一次打开、或者之后点「添鱼」时出来。每种鱼一张卡片，加减条数，确定后放进鱼缸。
// 按钮都带 data-act，点击由 app.mjs 统一分发（挂在桌面上时没有真的鼠标事件，不能在这里绑 click）。
import { SPECIES, STOCKABLE } from '../sim/species.mjs'
import { paintPreview } from './render.mjs'

const $ = (id) => document.getElementById(id)

function el(tag, cls, text) {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text != null) e.textContent = text
  return e
}

export function createChooser() {
  const root = $('chooser')
  const list = $('species')
  const counts = {}
  const labels = {}
  let room = 0

  // 卡片只建一次。
  for (const key of STOCKABLE) {
    const sp = SPECIES[key]
    counts[key] = 0
    const card = el('div', 'card-fish')
    const pic = el('canvas', 'pic')
    pic.dataset.species = key
    const minus = el('button', null, '−')
    minus.dataset.act = 'pick-minus'
    minus.dataset.id = key
    const plus = el('button', null, '+')
    plus.dataset.act = 'pick-plus'
    plus.dataset.id = key
    labels[key] = el('b', 'n', '0')
    const stepper = el('div', 'stepper')
    stepper.append(minus, labels[key], plus)
    card.append(
      pic,
      el('h2', null, sp.label),
      el('p', null, sp.blurb),
      el('p', 'facts', `最大 ${sp.maxLength}cm · ${sp.matureLength}cm 成年 · 约活 ${sp.lifespanDays} 天`),
      stepper,
    )
    list.append(card)
  }

  const total = () => Object.values(counts).reduce((a, b) => a + b, 0)

  function sync() {
    for (const key of Object.keys(counts)) labels[key].textContent = counts[key]
    const n = total()
    $('chooser-sum').textContent = n === 0 ? `还能放 ${room} 条` : `选了 ${n} 条，还能放 ${room - n} 条`
    $('chooser-ok').disabled = n === 0
  }

  function open(roomLeft, first) {
    room = roomLeft
    for (const key of Object.keys(counts)) counts[key] = 0
    $('chooser-title').textContent = first ? '选几种鱼开始养' : '再添几条鱼'
    $('chooser-note').textContent = '每种放两条以上才凑得出一公一母，以后才能繁殖。'
    root.hidden = false
    // 预览图要等界面显示出来才有尺寸可量。
    for (const pic of list.querySelectorAll('canvas')) paintPreview(pic, pic.dataset.species)
    sync()
  }

  function change(species, delta) {
    if (!(species in counts)) return
    const next = counts[species] + delta
    if (next < 0 || (delta > 0 && total() >= room)) return
    counts[species] = next
    sync()
  }

  return {
    open,
    change,
    close: () => (root.hidden = true),
    picks: () => Object.fromEntries(Object.entries(counts).filter(([, n]) => n > 0)),
  }
}
