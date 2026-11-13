'use strict'
const { contextBridge, ipcRenderer } = require('electron')

// 主进程 → 页面的频道，只放行这几个。
const CHANNELS = ['pointer', 'weather', 'visible', 'action', 'insets', 'flush', 'hud', 'background', 'effects', 'nightlight']

contextBridge.exposeInMainWorld('host', {
  boot: () => ipcRenderer.invoke('pond:boot'),
  save: (state, final) => ipcRenderer.send('pond:save', state, !!final),
  // 读一个鱼的 3D 模型文件（src/ui/fish3d/ 下的 .glb），返回字节。
  asset: (name) => ipcRenderer.invoke('pond:asset', name),
  on: (channel, fn) => {
    if (!CHANNELS.includes(channel)) throw new Error(`未知频道 ${channel}`)
    ipcRenderer.on(`pond:${channel}`, (_e, ...args) => fn(...args))
  },
  // 设置城市的小窗口用。
  setCity: (name) => ipcRenderer.invoke('pond:set-city', name),
  closeCityWindow: () => ipcRenderer.send('pond:close-city'),
})
