'use strict'
const form = document.getElementById('form')
const input = document.getElementById('name')
const msg = document.getElementById('msg')
const button = form.querySelector('button')

form.addEventListener('submit', async (e) => {
  e.preventDefault()
  button.disabled = true
  msg.className = ''
  msg.textContent = '查询中…'
  const r = await window.host.setCity(input.value)
  button.disabled = false
  if (!r.ok) {
    msg.textContent = r.reason
    return
  }
  msg.className = 'ok'
  msg.textContent = `已设为 ${r.loc.name}（${r.loc.region}）`
  setTimeout(() => window.host.closeCityWindow(), 1200)
})
