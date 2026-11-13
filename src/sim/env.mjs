// 把天气数据换算成鱼池要用的量：画面用的（雨、雪、云、雾、风、亮度）和规则用的（气温、降雨）。
// 输入是 main 进程取回来的那几个字段（见 src/weather.js）；取不到天气时传 null，只算昼夜。
import { sunTimes } from './sun.mjs'

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const smooth = (t) => {
  const x = clamp(t, 0, 1)
  return x * x * (3 - 2 * x)
}

// WMO 天气代码 → 天气种类。代码表见 Open-Meteo 文档的 weather_code 一节。
function kindOf(code) {
  if (code === 0) return 'clear'
  if (code === 1 || code === 2) return 'partly'
  if (code === 3) return 'cloudy'
  if (code === 45 || code === 48) return 'fog'
  if (code >= 51 && code <= 57) return 'drizzle'
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return 'rain'
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow'
  if (code >= 95) return 'thunder'
  return 'cloudy'
}

const LABEL = {
  clear: ['晴', '☀️', '🌙'],
  partly: ['多云', '⛅', '☁️'],
  cloudy: ['阴', '☁️', '☁️'],
  fog: ['雾', '🌫️', '🌫️'],
  drizzle: ['毛毛雨', '🌦️', '🌧️'],
  rain: ['雨', '🌧️', '🌧️'],
  snow: ['雪', '🌨️', '🌨️'],
  thunder: ['雷雨', '⛈️', '⛈️'],
}

const TWILIGHT = 45 * 60e3 // 日出日落前后各 45 分钟渐变

// 亮度：白天 1，夜里 0，日出日落各有一段渐变。
// 知道城市就按经纬度算日出日落；不知道就按本机时钟当 6 点到 18 点是白天。
function daylight(location, now) {
  if (location && Number.isFinite(location.lat) && Number.isFinite(location.lon)) {
    const sun = sunTimes(location.lat, location.lon, now)
    if (sun.always) return sun.always === 'day' ? 1 : 0
    return Math.min(
      smooth((now - sun.sunrise + TWILIGHT) / (2 * TWILIGHT)),
      smooth((sun.sunset - now + TWILIGHT) / (2 * TWILIGHT)),
    )
  }
  const d = new Date(now)
  const hour = d.getHours() + d.getMinutes() / 60
  return Math.min(smooth((hour - 5.25) / 1.5), smooth((18.75 - hour) / 1.5))
}

// weather：现在的天气（取不到或太旧时传 null）；location：{ name, lat, lon }（没设城市时传 null）。
export function readWeather(weather, now, location) {
  const light = daylight(location, now)
  const city = location ? location.name : ''
  if (!weather) {
    return {
      known: false, kind: 'clear', label: '没取到天气', icon: light > 0.5 ? '☀️' : '🌙',
      airTemp: null, rain: 0, snow: 0, cloud: 0.2, fog: 0, wind: 0.15, thunder: false, light, city,
    }
  }
  const kind = kindOf(weather.code)
  const mm = weather.precip ?? 0
  // 降水强度：代码说在下就至少给个底，雨量越大越密，10mm/h 封顶。
  const wet = { drizzle: 0.2, rain: 0.45, thunder: 0.7 }[kind]
  const rain = wet ? clamp(wet + mm / 10, 0, 1) : 0
  const snow = kind === 'snow' ? clamp(0.35 + mm / 4, 0, 1) : 0
  const cloudBase = { clear: 0.05, partly: 0.4, cloudy: 0.85, fog: 0.7, drizzle: 0.8, rain: 0.9, snow: 0.85, thunder: 1 }[kind]
  const cloud = weather.cloud == null ? cloudBase : clamp((cloudBase + weather.cloud / 100) / 2, 0, 1)
  const [name, dayIcon, nightIcon] = LABEL[kind]
  return {
    known: true,
    kind,
    label: name,
    icon: light > 0.5 ? dayIcon : nightIcon,
    airTemp: weather.temp,
    rain,
    snow,
    cloud,
    fog: kind === 'fog' ? 1 : 0,
    wind: clamp((weather.wind ?? 0) / 40, 0, 1), // 40km/h 算满
    thunder: kind === 'thunder',
    light,
    city,
  }
}
