import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import monitorData from '@/assets/geo/monitor-points.json'

const STORAGE_KEY = 'quanzhou-monitor-points-v1'
// 旧版本（地图内就地编辑）使用的键，首次加载时自动迁移
const LEGACY_STORAGE_KEY = 'qz-monitor-points'
// 仅开发期存在：由 vite.config.js 的 monitor-data-persist 插件提供
const SAVE_ENDPOINT = '/api/monitor-points'
const SAVE_DELAY = 250

function cloneDefaults() {
  return JSON.parse(JSON.stringify(monitorData.intersections))
}

function readStoredRecord(raw) {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    // 兼容旧格式：直接存的是数组
    if (Array.isArray(parsed)) return { points: parsed, updatedAt: '' }
    if (parsed && Array.isArray(parsed.points)) {
      return { points: parsed.points, updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : '' }
    }
  } catch {
    return null
  }
  return null
}

function loadPoints() {
  const stored =
    readStoredRecord(localStorage.getItem(STORAGE_KEY)) ??
    readStoredRecord(localStorage.getItem(LEGACY_STORAGE_KEY))

  // 数据文件比本地缓存新（例如 pull 了别人的改动），以文件为准
  const fileUpdatedAt = typeof monitorData.updatedAt === 'string' ? monitorData.updatedAt : ''
  if (stored && (!fileUpdatedAt || stored.updatedAt >= fileUpdatedAt)) return stored.points

  return cloneDefaults()
}

export const useMonitorStore = defineStore('monitor', () => {
  const points = ref(loadPoints())

  // idle：直接用数据文件；saving：正在写回；saved：已写回；local：接口不可用，只存了浏览器
  const persistState = ref('idle')
  const persistError = ref('')
  const lastSavedAt = ref(typeof monitorData.updatedAt === 'string' ? monitorData.updatedAt : '')
  const savedFile = ref('src/assets/geo/monitor-points.json')

  const totalIntersections = computed(() => points.value.length)
  const totalCameras = computed(() => points.value.reduce((sum, item) => sum + (item.cameras?.length ?? 0), 0))

  let saveTimer = null
  let pendingSnapshot = null

  function scheduleSave(value) {
    const snapshot = JSON.parse(JSON.stringify(value))
    // localStorage 是同步写的，先落一份，关掉标签页也不会丢
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ updatedAt: new Date().toISOString(), points: snapshot }))
    pendingSnapshot = snapshot
    persistState.value = 'saving'
    clearTimeout(saveTimer)
    saveTimer = setTimeout(flushSave, SAVE_DELAY)
  }

  // 把当前点位写回 src/assets/geo/monitor-points.json；生产构建里没有该接口，自动降级
  async function flushSave() {
    clearTimeout(saveTimer)
    const snapshot = pendingSnapshot
    if (!snapshot) return
    pendingSnapshot = null

    try {
      const response = await fetch(SAVE_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ points: snapshot }),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const result = await response.json()
      if (!result?.ok) throw new Error(result?.message || '写入失败')

      persistState.value = 'saved'
      persistError.value = ''
      lastSavedAt.value = result.savedAt || new Date().toISOString()
      if (result.file) savedFile.value = result.file
    } catch (error) {
      // 写文件失败不影响本地使用
      persistState.value = 'local'
      persistError.value = error.message
    }
  }

  watch(points, scheduleSave, { deep: true })

  // 关标签页时防抖还没触发，用 sendBeacon 补一次（响应读不到，但数据已落盘）
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', () => {
      if (!pendingSnapshot) return
      const blob = new Blob([JSON.stringify({ points: pendingSnapshot })], { type: 'application/json' })
      navigator.sendBeacon?.(SAVE_ENDPOINT, blob)
      pendingSnapshot = null
    })
  }

  function nextId() {
    const timestamp = Date.now().toString(36)
    return `point-${timestamp}-${Math.random().toString(36).slice(2, 6)}`
  }

  function addPoint(payload) {
    const point = {
      id: payload.id || nextId(),
      name: payload.name,
      roads: payload.roads,
      lng: Number(payload.lng),
      lat: Number(payload.lat),
      cameras: payload.cameras.map((cam) => normalizeCamera(cam)),
    }
    points.value.push(point)
    return point.id
  }

  function updatePoint(id, payload) {
    const point = points.value.find((item) => item.id === id)
    if (!point) return
    point.name = payload.name
    point.roads = payload.roads
    point.lng = Number(payload.lng)
    point.lat = Number(payload.lat)
    point.cameras = payload.cameras.map((cam) => normalizeCamera(cam))
  }

  function removePoint(id) {
    const index = points.value.findIndex((item) => item.id === id)
    if (index !== -1) points.value.splice(index, 1)
  }

  // 导入 JSON 时整体替换；返回是否成功，失败抛出可读错误
  function replacePoints(list) {
    if (!Array.isArray(list) || !list.length) throw new Error('文件里没有点位数据')
    const mapped = list.map((item) => {
      const lng = Number(item.lng)
      const lat = Number(item.lat)
      if (!item.name || !Number.isFinite(lng) || !Number.isFinite(lat) || !Array.isArray(item.cameras)) {
        throw new Error('点位格式不正确，需要包含 name、lng、lat、cameras')
      }
      return {
        id: item.id || nextId(),
        name: item.name,
        roads: item.roads ?? '',
        lng,
        lat,
        cameras: item.cameras.map((cam) => normalizeCamera(cam)),
      }
    })
    points.value = mapped
  }

  function normalizeCamera(cam) {
    return {
      scene: cam.scene,
      type: cam.type || 'traffic',
      dir: cam.dir,
      bearing: Number(cam.bearing),
    }
  }

  return {
    points,
    totalIntersections,
    totalCameras,
    persistState,
    persistError,
    lastSavedAt,
    savedFile,
    addPoint,
    updatePoint,
    removePoint,
    replacePoints,
  }
})
