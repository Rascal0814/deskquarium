'use strict'
// Win32 这一层只做两件事：
//   1. 把鱼池窗口挂到桌面图标后面（壁纸的位置）；
//   2. 轮询鼠标。图标层（SysListView32）盖在壁纸上面，会吃掉所有鼠标消息，
//      壁纸窗口自己一个事件也收不到，只能从外面看光标和按键，再由 main 注入给页面。
// 句柄一律按 uintptr_t 传：HWND 本来就是整数，省得在 koffi 的指针类型上绕。
const koffi = require('koffi')

const user32 = koffi.load('user32.dll')

const POINT = koffi.struct('POINT', { x: 'long', y: 'long' })
const RECT = koffi.struct('RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' })

const FindWindowW = user32.func('uintptr_t __stdcall FindWindowW(str16 cls, str16 title)')
const FindWindowExW = user32.func(
  'uintptr_t __stdcall FindWindowExW(uintptr_t parent, uintptr_t after, str16 cls, str16 title)',
)
const SendMessageTimeoutW = user32.func(
  'intptr_t __stdcall SendMessageTimeoutW(uintptr_t hwnd, uint32_t msg, uintptr_t wParam, intptr_t lParam, uint32_t flags, uint32_t timeout, _Out_ uintptr_t *result)',
)
const SetParent = user32.func('uintptr_t __stdcall SetParent(uintptr_t child, uintptr_t parent)')
const SetWindowPos = user32.func(
  'bool __stdcall SetWindowPos(uintptr_t hwnd, uintptr_t after, int x, int y, int cx, int cy, uint32_t flags)',
)
const GetWindowLongPtrW = user32.func('intptr_t __stdcall GetWindowLongPtrW(uintptr_t hwnd, int index)')
const SetWindowLongPtrW = user32.func(
  'intptr_t __stdcall SetWindowLongPtrW(uintptr_t hwnd, int index, intptr_t value)',
)
const SetLayeredWindowAttributes = user32.func(
  'bool __stdcall SetLayeredWindowAttributes(uintptr_t hwnd, uint32_t key, uint8_t alpha, uint32_t flags)',
)
const GetWindowRect = user32.func('bool __stdcall GetWindowRect(uintptr_t hwnd, _Out_ RECT *rect)')
const GetCursorPos = user32.func('bool __stdcall GetCursorPos(_Out_ POINT *pt)')
const WindowFromPoint = user32.func('uintptr_t __stdcall WindowFromPoint(POINT pt)')
const GetAncestor = user32.func('uintptr_t __stdcall GetAncestor(uintptr_t hwnd, uint32_t flags)')
const GetAsyncKeyState = user32.func('short __stdcall GetAsyncKeyState(int vk)')
const GetForegroundWindow = user32.func('uintptr_t __stdcall GetForegroundWindow()')
const IsZoomed = user32.func('bool __stdcall IsZoomed(uintptr_t hwnd)')
const IsWindow = user32.func('bool __stdcall IsWindow(uintptr_t hwnd)')
const GetClassNameW = user32.func('int __stdcall GetClassNameW(uintptr_t hwnd, void *buf, int max)')

const GWL_EXSTYLE = -20
const WS_EX_LAYERED = 0x00080000
const LWA_ALPHA = 0x2
const SWP_NOSIZE = 0x1
const SWP_NOMOVE = 0x2
const SWP_NOACTIVATE = 0x10
const SWP_SHOWWINDOW = 0x40
const SWP_NOSENDCHANGING = 0x400
const GA_ROOT = 2
const VK_LBUTTON = 0x01
const SMTO_ABORTIFHUNG = 0x2
const LVM_GETSELECTEDCOUNT = 0x1032
const WM_COMMAND = 0x0111
const CMD_TOGGLE_ICONS = 0x7402
// 没有文档的消息：让 Progman 把「壁纸层」单独拆出来（幻灯片壁纸切换动画用的就是它）。
// 所有动态壁纸软件都靠这一条。
const WM_SPAWN_WORKER = 0x052c

const n = (h) => Number(h)

function className(hwnd) {
  const buf = Buffer.alloc(256)
  const len = GetClassNameW(hwnd, buf, 128)
  return buf.toString('utf16le', 0, len * 2)
}

function rectOf(hwnd) {
  const r = {}
  // 取不到就当原点在 (0,0)：单屏时父窗口本来就在原点，多屏最坏是位置偏一屏，下一次 refit 会纠正。
  if (!GetWindowRect(hwnd, r)) return { left: 0, top: 0, right: 0, bottom: 0 }
  return r
}

// 找到桌面的几层窗口。两种布局：
//   老布局（Win10 ～ Win11 23H2）：发完 0x052C 后图标层搬到一个顶层 WorkerW 里，
//     它后面紧跟着一个空的顶层 WorkerW，壁纸挂进那个空的。
//   新布局（Win11 24H2 起）：图标层留在 Progman 里，Progman 下面多一个子 WorkerW 画静态壁纸，
//     壁纸要挂成 Progman 的子窗口，夹在图标层和那个 WorkerW 之间。
function findDesktop() {
  const progman = n(FindWindowW('Progman', null))
  if (!progman) throw new Error('找不到 Progman（explorer 没起来？）')
  const out = [0]
  SendMessageTimeoutW(progman, WM_SPAWN_WORKER, 0xd, 0x1, 0, 1000, out)

  const defViewInProgman = n(FindWindowExW(progman, 0, 'SHELLDLL_DefView', null))
  if (defViewInProgman) {
    return {
      layout: 'raised',
      progman,
      defView: defViewInProgman,
      host: progman,
      staticWallpaper: n(FindWindowExW(progman, 0, 'WorkerW', null)),
    }
  }
  let w = 0
  for (;;) {
    w = n(FindWindowExW(0, w, 'WorkerW', null))
    if (!w) break
    const defView = n(FindWindowExW(w, 0, 'SHELLDLL_DefView', null))
    if (defView) {
      const host = n(FindWindowExW(0, w, 'WorkerW', null))
      if (host) return { layout: 'classic', progman, defView, host, iconsRoot: w }
    }
  }
  throw new Error('没找到壁纸层（WorkerW）')
}

// 把窗口挂到图标后面，铺满 rect（屏幕物理像素）。
function attach(hwnd, rect) {
  hwnd = n(hwnd)
  const desk = findDesktop()
  if (desk.layout === 'raised') {
    // 新布局下 Progman 带 WS_EX_NOREDIRECTIONBITMAP，子窗口不是 layered 就不参与合成（黑的或干脆不显示）。
    const ex = n(GetWindowLongPtrW(hwnd, GWL_EXSTYLE))
    SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex | WS_EX_LAYERED)
    SetLayeredWindowAttributes(hwnd, 0, 255, LWA_ALPHA)
  }
  SetParent(hwnd, desk.host)
  place(hwnd, rect, desk)
  return desk
}

// 摆位置。坐标是相对父窗口的，父窗口的原点是虚拟桌面的左上角（多屏时可能是负数）。
function place(hwnd, rect, desk) {
  hwnd = n(hwnd)
  const origin = rectOf(desk.host)
  const x = rect.x - origin.left
  const y = rect.y - origin.top
  // SWP_NOSENDCHANGING：不让 Chromium 插手这次改尺寸。它会把无边框窗口的高度压回工作区
  // （任务栏那一条就露出旧壁纸），而壁纸必须连任务栏后面也铺满。
  const flags = SWP_NOACTIVATE | SWP_SHOWWINDOW | SWP_NOSENDCHANGING
  if (desk.layout === 'raised') {
    // z 序：图标层 > 鱼池 > 静态壁纸。
    SetWindowPos(hwnd, desk.defView, x, y, rect.width, rect.height, flags)
    if (desk.staticWallpaper) {
      SetWindowPos(desk.staticWallpaper, hwnd, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE)
    }
  } else {
    SetWindowPos(hwnd, 0, x, y, rect.width, rect.height, flags)
  }
}

// explorer 重启后原来的句柄全部作废，要重新挂。
function stillAttached(desk) {
  return !!desk && IsWindow(desk.host) && IsWindow(desk.defView)
}

function cursor() {
  const p = {}
  if (!GetCursorPos(p)) return null
  return p
}

// 光标下面是不是桌面（而不是别的程序的窗口）。
function overDesktop(pt, desk) {
  const h = n(WindowFromPoint(pt))
  if (!h) return false
  const root = n(GetAncestor(h, GA_ROOT))
  return root === desk.progman || root === desk.iconsRoot || root === desk.host
}

function leftDown() {
  return (GetAsyncKeyState(VK_LBUTTON) & 0x8000) !== 0
}

// 桌面上当前选中了几个图标。点在图标上会选中它，点在空白处会清空选择——
// 用这个分辨「点的是图标」还是「点的是水面」，不用跨进程去做 LVM_HITTEST。
function selectedIcons(desk) {
  const list = n(FindWindowExW(desk.defView, 0, 'SysListView32', null))
  if (!list) return 0
  const out = [0]
  const ok = SendMessageTimeoutW(list, LVM_GETSELECTEDCOUNT, 0, 0, SMTO_ABORTIFHUNG, 150, out)
  // explorer 没在 150ms 内回话：当作点在图标上，宁可少喂一次也不误触。
  if (!ok) return 1
  return n(out[0])
}

// 显示 / 隐藏桌面图标。和在桌面上右键「查看 → 显示桌面图标」是同一个开关：
// 往图标层发那一项菜单的命令号（0x7402，没有文档，但从 XP 一直用到现在；本机 26300 实测可用）。
// 开关是系统自己记的，鱼池退出、重启电脑之后都还是那个状态。返回 explorer 有没有接下这条消息。
function toggleIcons(desk) {
  const out = [0]
  return n(SendMessageTimeoutW(desk.defView, WM_COMMAND, CMD_TOGGLE_ICONS, 0, SMTO_ABORTIFHUNG, 1000, out)) !== 0
}

// 系统自己的浮层：任务栏、桌面本身，还有 Alt+Tab / 任务视图 / 开始菜单这些。
// 后面几个会铺满整块屏幕、也会当上前台窗口，但它们是透明的，桌面照样看得见——
// 不能算「盖住了」。实测（log.txt）Alt+Tab 那一层（XamlExplorerHostIslandWindow）就是 2560×1440 的前台窗口，
// 以前被当成盖住，人看着桌面、画面却停着。
const SHELL_OVERLAYS = new Set([
  'Shell_TrayWnd', 'Shell_SecondaryTrayWnd', 'WorkerW', 'Progman',
  'XamlExplorerHostIslandWindow', 'ForegroundStaging', 'MultitaskingViewFrame', 'TaskSwitcherWnd',
  'Windows.UI.Core.CoreWindow', 'TopLevelWindowForOverflowXamlIsland', 'NotifyIconOverflowWindow',
])

// 前台窗口是不是把整块屏幕盖住了（最大化或全屏）。盖住了就不用画。
function desktopCovered(rect, desk) {
  const fg = n(GetForegroundWindow())
  if (!fg) return false
  const root = n(GetAncestor(fg, GA_ROOT)) || fg
  if (root === desk.progman || root === desk.iconsRoot || root === desk.host) return false
  const cls = className(root)
  if (SHELL_OVERLAYS.has(cls)) return false
  const r = rectOf(root)
  if (IsZoomed(root)) {
    // 最大化在别的屏幕上的窗口盖不住这块屏幕。
    const cx = (r.left + r.right) / 2
    const cy = (r.top + r.bottom) / 2
    return cx >= rect.x && cx < rect.x + rect.width && cy >= rect.y && cy < rect.y + rect.height
  }
  return (
    r.left <= rect.x &&
    r.top <= rect.y &&
    r.right >= rect.x + rect.width &&
    r.bottom >= rect.y + rect.height
  )
}

// 前台窗口是谁（记日志用）：类名、是不是最大化、位置和大小。
function foregroundInfo() {
  const fg = n(GetForegroundWindow())
  if (!fg) return '（没有）'
  const root = n(GetAncestor(fg, GA_ROOT)) || fg
  const r = rectOf(root)
  return `${className(root)}${IsZoomed(root) ? ' 最大化' : ''} ${r.left},${r.top} ${r.right - r.left}×${r.bottom - r.top}`
}

const SystemParametersInfoW = user32.func(
  'bool __stdcall SystemParametersInfoW(uint32_t action, uint32_t param, void *buf, uint32_t winIni)',
)
const SPI_GETDESKWALLPAPER = 0x0073

// 系统当前壁纸的图片路径。纯色壁纸时是空串，返回 null。
function systemWallpaper() {
  const buf = Buffer.alloc(1040)
  if (!SystemParametersInfoW(SPI_GETDESKWALLPAPER, 520, buf, 0)) return null
  const end = buf.indexOf('\0\0', 0, 'utf16le')
  const text = buf.toString('utf16le', 0, end < 0 ? buf.length : end + (end % 2))
  return text.replace(/\0+$/, '') || null
}

// 窗口现在实际占的位置（屏幕物理像素），用来发现 Electron 自己把尺寸改回去了。
function windowRect(hwnd) {
  const r = rectOf(n(hwnd))
  return { x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top }
}

module.exports = {
  systemWallpaper, findDesktop, attach, place, stillAttached, cursor, overDesktop, leftDown, selectedIcons, toggleIcons, desktopCovered, foregroundInfo, windowRect,
}
