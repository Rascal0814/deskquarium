// 日出日落：按经纬度和日期在本地算，不靠任何接口（接口挂了昼夜也照常）。
// 公式是通用的「日出方程」（平太阳正午 → 近点角 → 黄经 → 赤纬 → 时角），误差一两分钟，画昼夜渐变足够。

const RAD = Math.PI / 180
const J2000 = 2451545
const sin = (deg) => Math.sin(deg * RAD)
const cos = (deg) => Math.cos(deg * RAD)

// 返回 nowMs 所在那个太阳日的日出、日落（毫秒时间戳）。
// 极昼返回 { always: 'day' }，极夜返回 { always: 'night' }。
export function sunTimes(lat, lon, nowMs) {
  const jd = nowMs / 86400e3 + 2440587.5
  const n = Math.round(jd - J2000 - 0.0009 + lon / 360)
  const noon = J2000 + 0.0009 - lon / 360 + n // 当地的平太阳正午
  const M = (357.5291 + 0.98560028 * (noon - J2000)) % 360
  const C = 1.9148 * sin(M) + 0.02 * sin(2 * M) + 0.0003 * sin(3 * M)
  const L = (M + C + 180 + 102.9372) % 360
  const transit = noon + 0.0053 * sin(M) - 0.0069 * sin(2 * L)
  const dec = Math.asin(sin(L) * sin(23.4397)) / RAD
  // -0.833°：太阳上缘碰到地平线，外加大气折射
  const cosH = (sin(-0.833) - sin(lat) * sin(dec)) / (cos(lat) * cos(dec))
  if (cosH > 1) return { always: 'night' }
  if (cosH < -1) return { always: 'day' }
  const H = Math.acos(cosH) / RAD
  const toMs = (j) => (j - 2440587.5) * 86400e3
  return { sunrise: toMs(transit - H / 360), sunset: toMs(transit + H / 360) }
}
