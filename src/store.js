'use strict'
// 存档与配置：两个 JSON 文件，都在 userData 目录下。
const fs = require('node:fs')
const path = require('node:path')

function read(file) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (e) {
    if (e.code === 'ENOENT') return null // 第一次运行，没有文件是正常的
    throw e
  }
  try {
    return JSON.parse(text)
  } catch (e) {
    // 文件坏了不能当成「没有存档」直接覆盖——那等于把鱼全删了。挪到一边留着，再从头开始。
    const aside = `${file}.broken-${Date.now()}`
    fs.renameSync(file, aside)
    console.error(`[store] ${path.basename(file)} 解析失败，已挪到 ${aside}：${e.message}`)
    return null
  }
}

// 先写临时文件再改名：写到一半断电也不会留下半个存档。
function write(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(data))
  fs.renameSync(tmp, file)
}

module.exports = { read, write }
