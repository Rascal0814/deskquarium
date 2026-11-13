'use strict'
// VSCode 集成终端会注入 ELECTRON_RUN_AS_NODE=1，让 Electron 退化成纯 Node：
// 主进程里 require('electron') 只拿到二进制路径字符串，app / BrowserWindow 全是 undefined。
// 这里剥掉该变量再拉起真正的 Electron。
const { spawn } = require('node:child_process')
const path = require('node:path')

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const bin = require('electron')
const child = spawn(bin, [path.join(__dirname, '..'), ...process.argv.slice(2)], {
  stdio: 'inherit',
  env,
  windowsHide: false,
})
child.on('close', (code) => process.exit(code ?? 0))
