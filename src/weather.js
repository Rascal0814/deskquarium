'use strict'
// 天气。只在主进程联网，页面不联网。两个免费、不要 key 的源，一个不通换另一个：
//   Open-Meteo —— 首选；
//   met.no（挪威气象局）—— 备用。有的网络环境下 Open-Meteo 的预报接口会超时（本机走代理时实测如此）。
// 这里只取「现在的天气」；日出日落在页面里按经纬度本地算（src/sim/sun.mjs），不靠接口。
//
// 默认城市按系统时区猜（Asia/Tokyo → Tokyo），不按 IP 定位：
// 开着代理时 IP 定位出来的是代理出口，连国家都可能是错的；时区至少国家是对的。
// 猜得不准就在托盘里「设置城市」。
const { net } = require('electron')

async function getJson(url, timeoutMs) {
  const res = await net.fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    // met.no 的使用条款要求带一个能认出是哪个程序的 User-Agent；只写程序名，不带任何个人信息。
    headers: { 'User-Agent': 'deskquarium/0.1' },
  })
  if (!res.ok) throw new Error(`${new URL(url).host} 返回 ${res.status}`)
  return res.json()
}

// 城市名 → 经纬度。查不到返回 null。
async function geocode(name) {
  const url =
    'https://geocoding-api.open-meteo.com/v1/search?count=1&language=zh&format=json&name=' +
    encodeURIComponent(name)
  const data = await getJson(url, 10000)
  const hit = data.results && data.results[0]
  if (!hit) return null
  return {
    name: hit.name,
    region: [hit.country, hit.admin1].filter(Boolean).join(' '),
    // 两位小数约 1km，查天气足够，也不把精确位置发出去。
    lat: Math.round(hit.latitude * 100) / 100,
    lon: Math.round(hit.longitude * 100) / 100,
  }
}

function cityFromTimezone() {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''
  const city = tz.split('/').pop().replace(/_/g, ' ')
  return city && city !== 'UTC' ? city : null
}

// 两个源都换算成同一个形状：{ code（WMO 天气代码）, temp（°C）, wind（km/h）, precip（mm/h）, cloud（%） }

async function fromOpenMeteo(loc) {
  const url =
    'https://api.open-meteo.com/v1/forecast' +
    `?latitude=${loc.lat}&longitude=${loc.lon}` +
    '&current=temperature_2m,weather_code,wind_speed_10m,precipitation,cloud_cover'
  const data = await getJson(url, 6000)
  const c = data.current
  if (!c || typeof c.temperature_2m !== 'number' || typeof c.weather_code !== 'number') {
    throw new Error('Open-Meteo 的返回里没有 current.temperature_2m / weather_code')
  }
  return {
    code: c.weather_code,
    temp: c.temperature_2m,
    wind: c.wind_speed_10m,
    precip: c.precipitation,
    cloud: c.cloud_cover,
  }
}

// met.no 用的是自己的图标名（clearsky_day、lightrainshowers_night、heavysnowandthunder…），换成 WMO 代码。
// 先认雷、再认雪、再认雨：名字是拼起来的，「rainandthunder」里也有 rain。
function metNoCode(symbol) {
  const s = String(symbol || '')
  if (s.includes('thunder')) return 95
  if (s.includes('snow') || s.includes('sleet')) return 73
  if (s.includes('heavyrain')) return 65
  if (s.includes('lightrain')) return 53
  if (s.includes('rain')) return 63
  if (s.includes('fog')) return 45
  if (s.startsWith('partlycloudy')) return 2
  if (s.startsWith('cloudy')) return 3
  if (s.startsWith('fair')) return 1
  if (s.startsWith('clearsky')) return 0
  return 3
}

async function fromMetNo(loc) {
  const url = `https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${loc.lat}&lon=${loc.lon}`
  const data = await getJson(url, 10000)
  const first = data.properties && data.properties.timeseries && data.properties.timeseries[0]
  const now = first && first.data && first.data.instant && first.data.instant.details
  if (!now || typeof now.air_temperature !== 'number') {
    throw new Error('met.no 的返回里没有 timeseries[0].data.instant.details.air_temperature')
  }
  const hour = first.data.next_1_hours || first.data.next_6_hours || {}
  return {
    code: metNoCode(hour.summary && hour.summary.symbol_code),
    temp: now.air_temperature,
    wind: (now.wind_speed ?? 0) * 3.6, // m/s → km/h
    precip: (hour.details && hour.details.precipitation_amount) ?? 0,
    cloud: now.cloud_area_fraction ?? null,
  }
}

const sources = [
  ['Open-Meteo', fromOpenMeteo],
  ['met.no', fromMetNo],
]

// 现在的天气。上次哪个源通了，这次先问它（不通的那个每次都要白等一个超时）。
async function current(loc) {
  const errors = []
  for (let i = 0; i < sources.length; i++) {
    const [name, fetcher] = sources[i]
    try {
      const w = await fetcher(loc)
      if (i > 0) sources.unshift(sources.splice(i, 1)[0])
      return { ...w, source: name, fetchedAt: Date.now() }
    } catch (e) {
      errors.push(`${name}：${e.message}`)
    }
  }
  throw new Error(errors.join('；'))
}

module.exports = { geocode, cityFromTimezone, current, metNoCode }
