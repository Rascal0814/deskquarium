'use strict'
// 主进程只当「宿主」：窗口挂到桌面图标后面、转发鼠标、取天气、读写存档、托盘。
// 养鱼的规则和画面全在页面里（src/sim、src/ui），这里不碰鱼。
const { app, BrowserWindow, Menu, Tray, dialog, ipcMain, nativeImage, screen, shell } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const store = require('./store')
const weather = require('./weather')
const { SCENES, DEFAULT_SCENE } = require('./scenes')

// ---- 启动参数 ----
// --window            普通窗口，不挂桌面（开发用，也能拖窗口大小看自适应）
// --save-dir=<目录>   存档换个地方放（开发用，不动真存档）
// --fast=<倍数>  --demo  --weather=<种类>  --light=<0~1>  --shot=<png>  --shot-after=<毫秒>
// --poke=<x,y;x,y>  --always-draw  --plain
//   这几个会让时间和存档变假（或只为调试），所以只在给了 --save-dir 时才认。
const flags = {}
for (const arg of process.argv.slice(1)) {
  const m = /^--([\w-]+)(?:=(.*))?$/.exec(arg)
  if (m) flags[m[1]] = m[2] ?? true
}
const windowMode = !!flags.window
const sandboxed = typeof flags['save-dir'] === 'string'
if (sandboxed) app.setPath('userData', path.resolve(flags['save-dir']))
const dev = sandboxed
  ? {
      fast: Number(flags.fast) > 0 ? Number(flags.fast) : 1,
      demo: !!flags.demo,
      weather: typeof flags.weather === 'string' ? flags.weather : null,
      light: flags.light != null && flags.light !== true ? Number(flags.light) : null,
      plain: !!flags.plain,
    }
  : { fast: 1, demo: false, weather: null, light: null, plain: false }

// Chromium 会自己判断「窗口被挡住了」然后停掉渲染；挂进 Progman 之后它判断不准，
// 关掉，改由我们自己看前台窗口来决定画不画（见 watchCovered）。
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')

// 只在真的要挂桌面时才加载 Win32 那一层。
const desktop = windowMode ? null : require('./desktop')

const file = (name) => path.join(app.getPath('userData'), name)

let win = null
let tray = null
let cityWin = null
let config = {}
let desk = null // 桌面的几层窗口句柄
let rect = null // 鱼池占的屏幕矩形（物理像素）
let display = null
// location 是城市（页面拿经纬度算日出日落），current 是现在的天气；各自可能没有。
const latestWeather = { location: null, current: null }
let covered = false
let flushed = false
const warned = new Set()

// 平时是不带控制台启动的，出了事（画面不动了、页面报错了）没处看。所以要紧的事记一行到存档目录的 log.txt：
// 页面报的错、页面进程崩了、画面停画和恢复。超过 1MB 就清空重来。
function note(text) {
  try {
    const f = file('log.txt')
    if (fs.existsSync(f) && fs.statSync(f).size > 1e6) fs.writeFileSync(f, '')
    fs.appendFileSync(f, `${new Date().toLocaleString('sv')} ${text}\n`)
  } catch (e) {
    // 记不下来就算了，不能因为记日志把鱼池弄挂。
  }
}

// 同一个错误只报一次：轮询里出错会每 30ms 来一遍。
function warnOnce(tag, err) {
  const key = `${tag}:${err && err.message}`
  if (warned.has(key)) return
  warned.add(key)
  console.error(`[${tag}]`, err)
  note(`[${tag}] ${(err && err.stack) || err}`)
}

function send(channel, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(`pond:${channel}`, ...args)
}

function saveConfig() {
  try {
    store.write(file('config.json'), config)
  } catch (e) {
    console.error('[config] 写不进去：', e)
  }
}

// ---- 屏幕自适应 ----
// 鱼池铺满一块屏幕（默认主屏，多屏时托盘里可以选）。分辨率、缩放、屏幕插拔变了就重新铺。
// 页面里的东西全按比例摆，所以这里只管把窗口摆对。
function pickDisplay() {
  const all = screen.getAllDisplays()
  return all.find((d) => d.id === config.displayId) || screen.getPrimaryDisplay()
}

// 任务栏占掉的边，面板要让开。
function insetsOf(d) {
  if (windowMode) return { top: 0, right: 0, bottom: 0, left: 0 }
  return {
    top: d.workArea.y - d.bounds.y,
    left: d.workArea.x - d.bounds.x,
    right: d.bounds.x + d.bounds.width - (d.workArea.x + d.workArea.width),
    bottom: d.bounds.y + d.bounds.height - (d.workArea.y + d.workArea.height),
  }
}

function hwndOf(w) {
  return w.getNativeWindowHandle().readBigUInt64LE()
}

function fit() {
  if (!win || win.isDestroyed()) return
  display = pickDisplay()
  send('insets', insetsOf(display))
  if (windowMode) return
  rect = screen.dipToScreenRect(null, display.bounds)
  try {
    if (desktop.stillAttached(desk)) desktop.place(hwndOf(win), rect, desk)
    else desk = desktop.attach(hwndOf(win), rect)
  } catch (e) {
    // explorer 正在重启时会找不到桌面，housekeeping 过几秒会再试。
    desk = null
    warnOnce('attach', e)
  }
}

let fitTimer = null
function fitSoon() {
  clearTimeout(fitTimer)
  fitTimer = setTimeout(fit, 300)
}

// ---- 鼠标 ----
// 壁纸窗口在图标层后面，一个鼠标消息也收不到，所以轮询光标和左键，把「移动」「点击」发给页面。
// 页面自己做命中判断（点的是面板按钮还是水面）。
const last = { x: -1, y: -1, over: false, down: false }
let press = null

function pollPointer() {
  if (!desk || !rect) return
  let pt
  try {
    pt = desktop.cursor()
    if (!pt) return
    const inside =
      pt.x >= rect.x && pt.x < rect.x + rect.width && pt.y >= rect.y && pt.y < rect.y + rect.height
    const over = inside && desktop.overDesktop(pt, desk)
    const x = (pt.x - rect.x) / display.scaleFactor
    const y = (pt.y - rect.y) / display.scaleFactor
    if (over && (x !== last.x || y !== last.y || !last.over)) send('pointer', { type: 'move', x, y })
    if (!over && last.over) send('pointer', { type: 'leave' })

    const down = desktop.leftDown()
    if (down && !last.down) press = over ? { x: pt.x, y: pt.y, t: Date.now() } : null
    if (!down && last.down && press) {
      const moved = Math.hypot(pt.x - press.x, pt.y - press.y)
      const quick = Date.now() - press.t < 700
      press = null
      // 拖动（框选图标）和长按不算点击。
      if (over && moved < 6 && quick) {
        // 等图标层处理完这次点击再问它：点在图标上会选中图标，点在空白处会清空选择。
        setTimeout(() => {
          try {
            if (desk && desktop.selectedIcons(desk) === 0) send('pointer', { type: 'click', x, y })
          } catch (e) {
            warnOnce('click', e)
          }
        }, 60)
      }
    }
    last.x = x
    last.y = y
    last.over = over
    last.down = down
  } catch (e) {
    warnOnce('pointer', e)
  }
}

// 每秒一次：explorer 重启过就重新挂；Electron 自己把窗口尺寸改回去了就再摆一次。
function housekeeping() {
  if (!win || win.isDestroyed()) return
  try {
    if (!desktop.stillAttached(desk)) {
      fit()
      return
    }
    const now = desktop.windowRect(hwndOf(win))
    if (now.width !== rect.width || now.height !== rect.height) desktop.place(hwndOf(win), rect, desk)
  } catch (e) {
    warnOnce('housekeeping', e)
  }
}

// 桌面被最大化的窗口盖住就让页面停画，露出来马上接着画。
// 一秒查十次：以前是一秒一次，切回桌面的那一下最多要等一秒页面才知道，画面先定住再动，看着像卡了一下。
// 查一次只是问几句「前台窗口是谁、多大」，不花什么。
function watchCovered() {
  if (!win || win.isDestroyed() || !desk || !rect) return
  try {
    // 光标正指着桌面（last.over，见 pollPointer）就说明桌面露着，不管前台窗口是谁、有多大——
    // 前台窗口这个判断有看走眼的时候，这一条兜底，免得人看着桌面、画面却停着不动。
    const c = !(sandboxed && flags['always-draw']) && !last.over && desktop.desktopCovered(rect, desk)
    if (c !== covered) {
      covered = c
      send('visible', !covered)
      note(`画面${covered ? '停画' : '恢复'}：前台窗口 ${desktop.foregroundInfo()}`)
    }
  } catch (e) {
    warnOnce('covered', e)
  }
}

// ---- 天气 ----
async function resolveLocation() {
  if (config.location) return config.location
  const guess = weather.cityFromTimezone()
  if (!guess) return null
  const loc = await weather.geocode(guess)
  if (!loc) return null
  config.location = { ...loc, guessed: true }
  saveConfig()
  return config.location
}

async function refreshWeather() {
  if (dev.weather) return // 开发时指定了天气，不联网
  try {
    const loc = await resolveLocation()
    if (loc) {
      latestWeather.location = { name: loc.name, lat: loc.lat, lon: loc.lon }
      latestWeather.current = await weather.current(loc)
    }
  } catch (e) {
    // 取不到就留着上一次的；页面那边会把太旧的数据当成「没有天气」。
    console.error('[weather]', e.message)
  }
  send('weather', latestWeather)
  buildTray()
}

// ---- 背景 ----
// 背景是一张图，三种来源：自带的水族箱（几张水草缸的图，见 scenes.js）、自选的图片、跟随系统壁纸。
// 图片由主进程读成字节送给页面（页面的 CSP 不让它自己读本地文件）。
// 自带的图还带着「水草在哪」（plants），页面按它冒气泡；别的图不知道哪里有草，就不冒。
const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'avif']
const backgroundMode = () => (config.background && config.background.mode) || 'tank'
// 现在用的是自带的哪一张（配置里没写、或者写的那张已经没有了，就用默认的）。
const sceneKey = () => (config.background && SCENES[config.background.scene] ? config.background.scene : DEFAULT_SCENE)
let wallpaperSeen = '' // 跟随系统壁纸时，上次看到的是哪个文件、什么时候改的

function loadBackground() {
  const mode = backgroundMode()
  if (mode === 'tank') {
    const scene = SCENES[sceneKey()]
    try {
      return { mode, bytes: fs.readFileSync(path.join(__dirname, 'ui', 'backgrounds', scene.file)), plants: scene.plants }
    } catch (e) {
      // 图读不出来：页面退回去用代码画的那个水族箱，不至于没有背景。
      console.error('[background]', e)
      return { mode, bytes: null }
    }
  }
  let p = null
  try {
    p = mode === 'file' ? config.background.path : require('./desktop').systemWallpaper()
    if (!p) return { mode, bytes: null, problem: '系统壁纸是纯色的，没有图片可用，先用自带的水族箱' }
    return { mode, bytes: fs.readFileSync(p) }
  } catch (e) {
    console.error('[background]', e)
    const what = p ? path.basename(p) : '找不到路径'
    return { mode, bytes: null, problem: `背景图读不出来（${what}），先用自带的水族箱` }
  }
}

function setBackground(next) {
  config.background = next
  saveConfig()
  wallpaperSeen = ''
  send('background', loadBackground())
  buildTray()
}

async function chooseBackground() {
  const r = await dialog.showOpenDialog({
    title: '选一张背景图',
    properties: ['openFile'],
    filters: [{ name: '图片', extensions: IMAGE_EXT }],
  })
  // 取消了：重建菜单，把单选点回原来那一项。
  if (r.canceled || r.filePaths.length === 0) return buildTray()
  setBackground({ mode: 'file', path: r.filePaths[0] })
}

// 跟随系统壁纸时，壁纸换了（或幻灯片轮到下一张）就跟着换。每 10 秒看一眼。
function watchWallpaper() {
  if (backgroundMode() !== 'system') return
  try {
    const p = require('./desktop').systemWallpaper()
    const seen = p ? `${p}|${fs.statSync(p).mtimeMs}` : ''
    if (seen === wallpaperSeen) return
    const first = wallpaperSeen === ''
    wallpaperSeen = seen
    if (!first) send('background', loadBackground()) // 第一次只是记下来：启动时页面已经拿到这张图了
  } catch (e) {
    warnOnce('wallpaper', e)
  }
}

// ---- 托盘 ----
function trayIcon() {
  // 手画一条 32×32 的小橙鱼，省一个图片文件。像素格式是 BGRA。
  const S = 32
  const buf = Buffer.alloc(S * S * 4)
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const px = x + 0.5
      const py = y + 0.5
      const body = ((px - 13) / 11) ** 2 + ((py - 16) / 6.5) ** 2 <= 1
      const tail = px >= 22 && px <= 30 && Math.abs(py - 16) <= (px - 21) * 0.85
      if (!body && !tail) continue
      const eye = Math.hypot(px - 7, py - 14) <= 1.3
      const i = (y * S + x) * 4
      buf[i] = eye ? 0x20 : 0x2c
      buf[i + 1] = eye ? 0x20 : 0x8a
      buf[i + 2] = eye ? 0x20 : 0xf0
      buf[i + 3] = 0xff
    }
  }
  return nativeImage.createFromBitmap(buf, { width: S, height: S })
}

function buildTray() {
  if (!tray) return
  const loc = config.location
  const where = loc ? `${loc.name}${loc.guessed ? '（按时区猜的）' : ''}` : '没有城市'
  const now = latestWeather.current ? `${Math.round(latestWeather.current.temp)}°C` : '没取到天气'
  const displays = screen.getAllDisplays()
  const bgMode = backgroundMode()
  const items = [
    { label: `${where} · ${now}`, enabled: false },
    { type: 'separator' },
    { label: '喂食', click: () => send('action', 'feed') },
    { label: '换水', click: () => send('action', 'water') },
    { label: '繁殖', click: () => send('action', 'breed') },
    { label: '添鱼…', click: () => send('action', 'stock') },
    { type: 'separator' },
    {
      label: '背景',
      submenu: [
        ...Object.entries(SCENES).map(([key, scene]) => ({
          label: scene.label,
          type: 'radio',
          checked: bgMode === 'tank' && sceneKey() === key,
          click: () => setBackground({ mode: 'tank', scene: key }),
        })),
        { type: 'separator' },
        { label: '跟随系统壁纸', type: 'radio', checked: bgMode === 'system', click: () => setBackground({ mode: 'system' }) },
        {
          label: bgMode === 'file' ? `自选图片：${path.basename(config.background.path)}` : '自选图片…',
          type: 'radio',
          checked: bgMode === 'file',
          click: chooseBackground,
        },
      ],
    },
    {
      label: '显示面板',
      type: 'checkbox',
      checked: config.hud !== false,
      click: (item) => {
        config.hud = item.checked
        saveConfig()
        send('hud', item.checked)
      },
    },
    {
      // 关掉就是「干净」的画面：背景上不叠暗角、光柱、水纹，也不随天气、昼夜、水质变灰变暗。
      // 天气和水质照样算、面板上照样看得到，只是不画在画面上。
      label: '光影和天气效果',
      type: 'checkbox',
      checked: config.effects !== false,
      click: (item) => {
        config.effects = item.checked
        saveConfig()
        send('effects', item.checked)
      },
    },
    { label: '设置城市…', click: openCityWindow },
  ]
  // 桌面图标挡鱼：一键藏起来，再点一下放回来。只有挂在桌面上时才有这一项。
  // 不做成勾选框：这个开关是系统的，在桌面右键菜单里也能改，这里记的状态会不准。
  if (!windowMode) {
    items.push({
      label: '隐藏 / 显示桌面图标',
      click: () => {
        try {
          if (!desk || !desktop.toggleIcons(desk)) console.error('[icons] 桌面没有回应，图标没切换')
        } catch (e) {
          warnOnce('icons', e)
        }
      },
    })
  }
  if (displays.length > 1 && !windowMode) {
    items.push({
      label: '放在哪块屏幕',
      submenu: displays.map((d, i) => ({
        label: `屏幕 ${i + 1}（${d.size.width}×${d.size.height}）`,
        type: 'radio',
        checked: d.id === pickDisplay().id,
        click: () => {
          config.displayId = d.id
          saveConfig()
          fit()
        },
      })),
    })
  }
  items.push(
    { label: '打开存档目录', click: () => shell.openPath(app.getPath('userData')) },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  )
  tray.setContextMenu(Menu.buildFromTemplate(items))
  tray.setToolTip(`桌面鱼池 · ${where} ${now}`)
}

function openCityWindow() {
  if (cityWin && !cityWin.isDestroyed()) {
    cityWin.focus()
    return
  }
  cityWin = new BrowserWindow({
    width: 420,
    height: 210,
    resizable: false,
    minimizable: false,
    maximizable: false,
    alwaysOnTop: true,
    autoHideMenuBar: true,
    title: '设置城市',
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  })
  cityWin.loadFile(path.join(__dirname, 'ui', 'city.html'))
}

// ---- 页面 ↔ 主进程 ----
const fromPond = (e) => win && !win.isDestroyed() && e.sender === win.webContents

ipcMain.handle('pond:boot', (e) => {
  if (!fromPond(e)) return null
  return {
    save: store.read(file('save.json')),
    hud: config.hud !== false,
    plain: dev.plain || config.effects === false,
    weather: latestWeather,
    background: loadBackground(),
    insets: insetsOf(pickDisplay()),
    windowMode,
    dev,
  }
})

// 鱼的 3D 模型：页面是从本地文件打开的，自己读不了文件，由这里读了递过去。只认 src/ui/fish3d/ 下的 .glb。
ipcMain.handle('pond:asset', (e, name) => {
  if (!fromPond(e) || !/^[\w-]+\.glb$/.test(String(name))) return null
  return fs.promises.readFile(path.join(__dirname, 'ui', 'fish3d', name))
})

ipcMain.on('pond:save', (e, state, final) => {
  if (!fromPond(e)) return
  try {
    store.write(file('save.json'), state)
  } catch (err) {
    console.error('[save] 存档写不进去：', err)
  }
  if (final) finishQuit()
})

ipcMain.handle('pond:set-city', async (_e, raw) => {
  const name = String(raw ?? '').trim().slice(0, 60)
  if (!name) return { ok: false, reason: '请输入城市名' }
  let loc
  try {
    loc = await weather.geocode(name)
  } catch (err) {
    return { ok: false, reason: `查询失败：${err.message}` }
  }
  if (!loc) return { ok: false, reason: `没查到「${name}」，换个写法试试（比如只写市名）` }
  config.location = loc
  saveConfig()
  latestWeather.current = null // 上一座城市的天气不能接着用
  // 不等它：结果会走 pond:weather 推给页面，失败在 refreshWeather 里已经记日志。
  refreshWeather()
  return { ok: true, loc }
})

ipcMain.on('pond:close-city', () => {
  if (cityWin && !cityWin.isDestroyed()) cityWin.close()
})

// ---- 退出：先让页面把最后的状态存下来 ----
function finishQuit() {
  if (flushed) return
  flushed = true
  app.quit()
}

app.on('before-quit', (e) => {
  if (flushed || !win || win.isDestroyed()) return
  e.preventDefault()
  send('flush')
  setTimeout(finishQuit, 1000) // 页面没回话也要能退出
})

// ---- 启动 ----
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.whenReady().then(start)
}

function start() {
  config = store.read(file('config.json')) || {}
  display = pickDisplay()

  const webPreferences = {
    preload: path.join(__dirname, 'preload.js'),
    backgroundThrottling: false, // 窗口永远不在前台，不关掉这个动画会被降到 1 帧
  }
  win = windowMode
    ? new BrowserWindow({ width: 1280, height: 760, backgroundColor: '#0b3b4a', title: '桌面鱼池（窗口模式）', autoHideMenuBar: true, webPreferences })
    : new BrowserWindow({
        ...display.bounds,
        frame: false,
        thickFrame: false, // 不关掉的话无边框窗口仍带 8px 的隐形缩放边，铺不满屏幕
        enableLargerThanScreen: true, // 否则高度会被压到工作区（任务栏那一条露出旧壁纸）
        show: false,
        skipTaskbar: true,
        focusable: false,
        resizable: false,
        backgroundColor: '#0b3b4a',
        webPreferences,
      })
  win.on('close', (e) => {
    if (flushed) return
    e.preventDefault()
    app.quit()
  })
  // 页面里出的错记下来；页面进程崩了就重新载入（存档是主进程管的，不会丢）。
  win.webContents.on('console-message', (e, level, message, line, source) => {
    const lv = typeof e.level === 'string' ? e.level : level >= 3 ? 'error' : level === 2 ? 'warning' : 'info'
    if (lv !== 'error') return
    const where = e.sourceId ?? source
    note(`[页面] ${e.message ?? message}（${where ? path.basename(String(where)) : '?'}:${e.lineNumber ?? line}）`)
  })
  win.webContents.on('render-process-gone', (_e, details) => {
    note(`[页面进程没了] ${details.reason}，重新载入`)
    if (!flushed && win && !win.isDestroyed()) win.webContents.reload()
  })
  win.webContents.on('unresponsive', () => note('[页面卡死] 没有响应'))
  note(`启动（${windowMode ? '窗口模式' : '挂在桌面上'}）`)
  win.loadFile(path.join(__dirname, 'ui', 'index.html'))
  win.once('ready-to-show', () => {
    fit()
    if (!windowMode) {
      win.showInactive()
      fit() // show 之后 Electron 可能把尺寸改回去，再摆一次
      setInterval(pollPointer, 30)
      setInterval(housekeeping, 1000)
      setInterval(watchCovered, 100)
    }
  })

  for (const ev of ['display-metrics-changed', 'display-added', 'display-removed']) {
    screen.on(ev, () => {
      fitSoon()
      buildTray()
    })
  }

  tray = new Tray(trayIcon())
  buildTray()

  refreshWeather()
  setInterval(refreshWeather, 20 * 60e3)
  setInterval(watchWallpaper, 10e3)

  // 开发用：--poke=x,y;x,y 每隔一秒往页面发一次「点击」，不用真的动鼠标就能验页面那一半。
  if (sandboxed && typeof flags.poke === 'string') {
    flags.poke.split(';').forEach((pair, i) => {
      const [x, y] = pair.split(',').map(Number)
      setTimeout(() => {
        send('pointer', { type: 'move', x, y })
        send('pointer', { type: 'click', x, y })
      }, 3000 + i * 1000)
    })
  }

  if (sandboxed && typeof flags.shot === 'string') {
    const after = Number(flags['shot-after']) > 0 ? Number(flags['shot-after']) : 5000
    setTimeout(async () => {
      try {
        const img = await win.webContents.capturePage()
        fs.writeFileSync(path.resolve(flags.shot), img.toPNG())
      } catch (e) {
        console.error('[shot]', e)
      }
      app.quit()
    }, after)
  }
}
