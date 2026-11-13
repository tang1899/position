import roadData from '@/assets/geo/main-roads.json'
import monitorData from '@/assets/geo/monitor-points.json'

const roads = roadData.roads
const intersections = monitorData.intersections

function normalize(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[交叉路口口×xX·，,。]/g, '')
}

const knownPoints = new Map()
const roadsByName = new Map()

intersections.forEach((item) => {
  knownPoints.set(normalize(item.name), {
    lat: item.lat,
    lng: item.lng,
    label: item.name,
  })
  if (item.roads) knownPoints.set(normalize(item.roads), {
    lat: item.lat,
    lng: item.lng,
    label: item.roads,
  })
})

roads.forEach((road) => {
  roadsByName.set(normalize(road.name), road)
})

function findRoad(name) {
  const key = normalize(name)
  if (roadsByName.has(key)) return roadsByName.get(key)
  return roads.find((road) => {
    const roadKey = normalize(road.name)
    return roadKey.includes(key) || key.includes(roadKey)
  })
}

function splitRoads(value) {
  const raw = String(value || '').trim()
  const bySymbol = raw
    .split(/\s*[×xX]\s*/)
    .map((part) => part.trim())
    .filter(Boolean)
  if (bySymbol.length === 2) return bySymbol

  const phraseTokens = raw
    .replace(/与|和|以及|的|交叉口|交叉|路口|交口|交界|交会/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
  if (phraseTokens.length === 2) return phraseTokens
  if (phraseTokens.length > 2) return phraseTokens.slice(0, 2)

  const matched = []
  const sortedRoads = [...roadsByName.values()].sort((a, b) => b.name.length - a.name.length)
  for (const road of sortedRoads) {
    if (raw.includes(road.name) && !matched.includes(road.name)) matched.push(road.name)
    if (matched.length === 2) break
  }
  return matched.length === 2 ? matched : phraseTokens
}

function distance(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1])
}

function roadIntersection(roadA, roadB) {
  let best = null
  for (const segmentA of roadA.segments) {
    for (const segmentB of roadB.segments) {
      for (const pointA of segmentA.coords) {
        for (const pointB of segmentB.coords) {
          const dist = distance(pointA, pointB)
          if (!best || dist < best.dist) {
            best = {
              dist,
              point: [(pointA[0] + pointB[0]) / 2, (pointA[1] + pointB[1]) / 2],
            }
          }
        }
      }
    }
  }
  return best
}

function midpointOfRoad(road) {
  const longest = road.segments.reduce((a, b) => (a.length >= b.length ? a : b))
  const coords = longest.coords
  const index = Math.floor(coords.length / 2)
  const [lng, lat] = coords[index]
  return { lat, lng, label: road.name }
}

export function localGeocode(value) {
  const query = String(value || '').trim()
  if (!query) return null

  const key = normalize(query)
  if (knownPoints.has(key)) return knownPoints.get(key)

  const roadNames = splitRoads(query)
  if (roadNames.length === 2) {
    const roadA = findRoad(roadNames[0])
    const roadB = findRoad(roadNames[1])
    if (roadA && roadB && roadA.name !== roadB.name) {
      const crossing = roadIntersection(roadA, roadB)
      if (crossing && crossing.dist < 0.001) {
        return {
          lat: crossing.point[1],
          lng: crossing.point[0],
          label: `${roadA.name} × ${roadB.name}`,
        }
      }
    }
  }

  const road = findRoad(roadNames[0] || query)
  if (road) return midpointOfRoad(road)

  return null
}

async function nominatimGeocode(value) {
  const query = `泉州市 ${value}`
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&accept-language=zh-CN&q=${encodeURIComponent(query)}`
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(6000),
  })
  if (!response.ok) throw new Error(`geocode failed: ${response.status}`)
  const data = await response.json()
  if (!Array.isArray(data) || !data.length) return null
  return {
    lat: Number(data[0].lat),
    lng: Number(data[0].lon),
    label: data[0].display_name,
  }
}

export async function geocodeAddress(value) {
  const local = localGeocode(value)
  if (local) return local
  try {
    return await nominatimGeocode(value)
  } catch {
    return null
  }
}
