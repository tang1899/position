<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import quanzhouGeo from '@/assets/geo/licheng-fengze.json'
import roadData from '@/assets/geo/main-roads.json'
import { useMonitorStore } from '@/stores/monitor'
import { consumeSavedFromForm } from '@/utils/view-state'

const router = useRouter()
const monitorStore = useMonitorStore()

const roads = roadData.roads
const intersections = computed(() => monitorStore.points)
const totalIntersections = computed(() => monitorStore.totalIntersections)
const totalCameras = computed(() => monitorStore.totalCameras)

function formatClock(iso) {
  if (!iso) return '--'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '--'
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
}

// 保存状态提示：写入的是源码里的 JSON，不是只存在浏览器里
const saveHint = computed(() => {
  switch (monitorStore.persistState) {
    case 'saving':
      return '正在写入 monitor-points.json…'
    case 'saved':
      return `已写入 monitor-points.json · ${formatClock(monitorStore.lastSavedAt)}`
    case 'local':
      return `仅保存到浏览器：${monitorStore.persistError || '写文件接口不可用'}`
    default:
      return monitorStore.lastSavedAt
        ? `数据文件 · 最近写入 ${formatClock(monitorStore.lastSavedAt)}`
        : '数据文件：src/assets/geo/monitor-points.json'
  }
})

const DIR = {
  horizontal: { label: '横向', color: '#b23a2f' },
  vertical: { label: '纵向', color: '#23475e' },
}

const weightedRoads = [...roads].sort((a, b) => {
  const tierOrder = { minor: 0, main: 1 }
  const order = { secondary: 1, primary: 2, trunk: 3, tertiary: 1, residential: 1, pedestrian: 0, unclassified: 1 }
  const tierDiff = (tierOrder[a.tier] ?? 0) - (tierOrder[b.tier] ?? 0)
  if (tierDiff) return tierDiff
  return (order[a.type] ?? 1) - (order[b.type] ?? 1)
})

const horizontal = computed(() =>
  roads.filter((r) => r.dir === 'horizontal').sort((a, b) => (a.tier === b.tier ? b.total - a.total : a.tier === 'main' ? -1 : 1)),
)
const vertical = computed(() =>
  roads.filter((r) => r.dir === 'vertical').sort((a, b) => (a.tier === b.tier ? b.total - a.total : a.tier === 'main' ? -1 : 1)),
)
const mainCount = computed(() => roads.filter((r) => r.tier === 'main').length)
const minorCount = computed(() => roads.filter((r) => r.tier === 'minor').length)

const searchResults = computed(() => {
  const query = searchQuery.value.trim().toLowerCase()
  if (!query) return { intersections: [], roads: [] }

  const matchIntersection = (item) => {
    const haystack = [
      item.name,
      item.roads,
      ...(item.cameras ?? []).map((cam) => `${cam.scene} ${cam.dir}`),
    ]
      .join(' ')
      .toLowerCase()
    return query.split(/\s+/).every((token) => haystack.includes(token)) || haystack.includes(query)
  }

  const intersectionsMatches = intersections.value
    .filter(matchIntersection)
    .sort((a, b) => {
      const aStarts = a.name.toLowerCase().startsWith(query) ? 0 : 1
      const bStarts = b.name.toLowerCase().startsWith(query) ? 0 : 1
      return aStarts - bStarts
    })
    .slice(0, 8)

  const roadMatches = roads
    .filter((road) => road.name.toLowerCase().includes(query))
    .sort((a, b) => {
      const aStarts = a.name.toLowerCase().startsWith(query) ? 0 : 1
      const bStarts = b.name.toLowerCase().startsWith(query) ? 0 : 1
      return aStarts - bStarts
    })
    .slice(0, 5)

  return { intersections: intersectionsMatches, roads: roadMatches }
})

const hasSearchResults = computed(
  () => searchResults.value.intersections.length > 0 || searchResults.value.roads.length > 0,
)

const mapEl = ref(null)
const selectedRoad = ref('')
const showLabels = ref(true)
const loaded = ref(false)
const activePoint = ref('')
// 手机竖屏：图鉴默认收起、点位清单用底部抽屉，地图占满全屏
const phoneLayout = window.innerWidth <= 768
// 从表单保存返回时：图鉴收起、点位清单展开，首帧就按这个状态渲染
const savedFromForm = consumeSavedFromForm()
const railOpen = ref(!savedFromForm && !phoneLayout)
const panelOpen = ref(savedFromForm || (!phoneLayout && window.innerWidth > 1180))
const searchQuery = ref('')
const searchOpen = ref(false)
const pickMode = ref(false)
const importInput = ref(null)
const deferredInstallPrompt = ref(null)
const isStandalone = ref(false)
const showInstallHelp = ref(false)

const isAppleMobile =
  /iphone|ipad|ipod/i.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
const isAndroidMobile = /android/i.test(navigator.userAgent)
const canInstall = computed(
  () => !isStandalone.value && Boolean(deferredInstallPrompt.value || isAppleMobile || isAndroidMobile),
)

let map = null
let districtLayer = null
let districtBounds = null
let labelLayerGroup = null
let camLabelGroup = null
const layersByRoad = {}
const camMarkers = {}

const DISTRICT_LABEL_POS = { '350502': [0.34, 0.16], '350503': [0.84, 0.56] }

const widthOf = (type, tier) =>
  tier === 'minor' ? 1.05 : type === 'trunk' ? 3.4 : type === 'primary' ? 2.4 : 1.8

function fitPadding() {
  if (window.innerWidth <= 768) {
    return { paddingTopLeft: [28, 28], paddingBottomRight: [28, 96] }
  }
  return { paddingTopLeft: [40, 36], paddingBottomRight: [56, 76] }
}

function styleOf(road) {
  const isSelected = selectedRoad.value === road.name
  const dimmed = selectedRoad.value && !isSelected
  return {
    color: DIR[road.dir].color,
    weight: isSelected ? 4.6 : widthOf(road.type, road.tier),
    opacity: dimmed ? 0.1 : road.tier === 'minor' ? 0.45 : 0.88,
    lineCap: 'round',
  }
}

function refreshStyles() {
  roads.forEach((road) => {
    ;(layersByRoad[road.name] ?? []).forEach((layer) => layer.setStyle(styleOf(road)))
  })
}

function selectRoad(name) {
  selectedRoad.value = selectedRoad.value === name ? '' : name
  refreshStyles()
  if (!selectedRoad.value) return
  const layers = layersByRoad[selectedRoad.value] ?? []
  if (!layers.length || !map) return
  map.flyToBounds(L.featureGroup(layers).getBounds(), {
    ...fitPadding(),
    maxZoom: 15,
    duration: 0.6,
  })
}

function clearSelection() {
  if (!selectedRoad.value) return
  selectedRoad.value = ''
  refreshStyles()
}

const CAM_COLOR = { traffic: '#e8452c', ptz: '#0f9d8f' }

// 每个路口一台相机一支朝向箭头，箭头从路口中心朝镜头方向指出去
function cameraIcon(item, active, compact = false) {
  if (compact) {
    const color = item.cameras.some((c) => c.type === 'traffic') ? CAM_COLOR.traffic : CAM_COLOR.ptz
    const ticks = item.cameras
      .map(
        (cam) =>
          `<g transform="rotate(${cam.bearing} 12 12)"><line x1="12" y1="7" x2="12" y2="3" stroke="${color}" stroke-width="1.8" stroke-linecap="round"/></g>`,
      )
      .join('')
    return L.divIcon({
      className: 'cam-point',
      html: `<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
        ${active ? '<circle class="cam-ring" cx="12" cy="12" r="9" fill="none" stroke="#20d9a2" stroke-width="1.2" stroke-dasharray="2.5 3"/>' : ''}
        ${ticks}
        <circle cx="12" cy="12" r="3.6" fill="#1b1e23" stroke="#f7f2e7" stroke-width="1.4"/>
      </svg>`,
      iconSize: [24, 24],
      iconAnchor: [12, 12],
    })
  }

  const n = item.cameras.length
  const arrows = item.cameras
    .map((cam, i) => {
      const offset = (i - (n - 1) / 2) * 7
      const color = CAM_COLOR[cam.type] ?? '#1b1e23'
      return `<g transform="rotate(${cam.bearing} 32 32) translate(${offset} 0)">
        <line x1="32" y1="21" x2="32" y2="11.5" stroke="${color}" stroke-width="2.6" stroke-linecap="round"/>
        <path d="M32 4.5 L${32 - 3.6} 11.5 L${32 + 3.6} 11.5 Z" fill="${color}"/>
      </g>`
    })
    .join('')
  return L.divIcon({
    className: 'cam-point',
    html: `<svg viewBox="0 0 64 64" width="64" height="64" aria-hidden="true">
      ${active ? '<circle class="cam-ring" cx="32" cy="32" r="15.5" fill="none" stroke="#20d9a2" stroke-width="1.4" stroke-dasharray="3 4"/>' : ''}
      ${arrows}
      <circle cx="32" cy="32" r="6" fill="#1b1e23" stroke="#f7f2e7" stroke-width="2"/>
    </svg>`,
    iconSize: [64, 64],
    iconAnchor: [32, 32],
  })
}

// 视野缩小时收成小圆点，避免 19 个路口挤在一处
function updateCameraIcons() {
  if (!map) return
  const compact = map.getZoom() < 13
  intersections.value.forEach((item) => {
    camMarkers[item.id]?.setIcon(cameraIcon(item, item.id === activePoint.value, compact))
  })
}

const CAM_LABEL = { traffic: '路口交通机', ptz: '联动快球' }

// 点位上方白框：路口名 + 每台相机的场景、类型、方位和角度
function pointCardHtml(item) {
  const rows = item.cameras
    .map((cam) => {
      const type = cam.type === 'ptz' ? 'ptz' : 'traffic'
      const bearing = Number.isFinite(Number(cam.bearing)) ? Number(cam.bearing) : 0
      return `<li class="pc-cam">
        <span class="pc-dot ${type}"></span>
        <span class="pc-cam-main">
          <span class="pc-scene">${escapeHtml(cam.scene)}</span>
          <span class="pc-meta">
            <span class="pc-type">${CAM_LABEL[type]}</span>
            <span class="pc-bearing">
              <svg class="pc-arrow" style="transform:rotate(${bearing}deg)" viewBox="0 0 16 16" width="10" height="10" aria-hidden="true"><path d="M8 1.6 L11.6 11.4 L8 9.3 L4.4 11.4 Z" fill="currentColor"/></svg>
              ${escapeHtml(cam.dir)} · ${bearing}°
            </span>
          </span>
        </span>
      </li>`
    })
    .join('')

  return `<div class="point-card">
    <button type="button" class="pc-close" data-pc-close aria-label="关闭">×</button>
    <p class="pc-kicker">TRAFFIC CAM · ${item.cameras.length}</p>
    <h3 class="pc-title">${escapeHtml(item.name)}</h3>
    <p class="pc-road">${escapeHtml(item.roads || '—')}</p>
    <ul class="pc-list">${rows}</ul>
  </div>`
}

let pointPopup = null
let focusToken = 0

function openPointCard(item) {
  if (!map) return
  pointPopup =
    pointPopup ||
    L.popup({
      className: 'point-card-popup',
      closeButton: false,
      closeOnClick: true,
      autoPan: false,
      offset: [0, -20],
      minWidth: 240,
      maxWidth: 330,
    })
  pointPopup.setLatLng([item.lat, item.lng]).setContent(pointCardHtml(item)).openOn(map)
}

function closePointCard() {
  focusToken += 1
  if (map && pointPopup) map.closePopup(pointPopup)
  if (!activePoint.value) return
  activePoint.value = ''
  updateCameraIcons()
  updateLabels()
}

// 卡片上的 × 由 Leaflet 注入 DOM，用事件委托处理
function handleCardCloseClick(event) {
  if (event.target instanceof Element && event.target.closest('[data-pc-close]')) closePointCard()
}

function selectPoint(id) {
  const item = intersections.value.find((x) => x.id === id)
  if (!item) return

  // 再点同一个点位：收起卡片
  if (activePoint.value === id) {
    closePointCard()
    return
  }

  activePoint.value = id
  updateCameraIcons()
  updateLabels()
  if (!map) return

  // 点位清单收起，把地图让出来
  const wasPanelOpen = panelOpen.value
  panelOpen.value = false

  const token = (focusToken += 1)
  const focus = () => {
    if (!map || token !== focusToken || activePoint.value !== id) return
    map.flyTo([item.lat, item.lng], Math.max(map.getZoom(), 15.5), { duration: 0.55 })
    openPointCard(item)
  }

  // 宽屏下清单占布局宽度，等收拢动画结束再取景，避免卡片位置偏掉
  if (wasPanelOpen && window.innerWidth > 1180) relayoutMap(focus)
  else focus()
}

function goAdd() {
  router.push('/monitor/new')
}

function editPoint(id) {
  router.push(`/monitor/${encodeURIComponent(id)}/edit`)
}

function pickIntersection(id) {
  searchQuery.value = ''
  searchOpen.value = false
  selectPoint(id)
}

function pickRoad(name) {
  searchQuery.value = ''
  searchOpen.value = false
  selectRoad(name)
}

function pickFirstSearchResult() {
  const firstIntersection = searchResults.value.intersections[0]
  const firstRoad = searchResults.value.roads[0]
  if (firstIntersection) pickIntersection(firstIntersection.id)
  else if (firstRoad) pickRoad(firstRoad.name)
}

function clearSearch() {
  searchQuery.value = ''
  searchOpen.value = false
}

function deletePoint(id) {
  const point = intersections.value.find((item) => item.id === id)
  if (!point) return
  const confirmed = window.confirm(`确定删除点位「${point.name}」及其 ${point.cameras.length} 台相机吗？`)
  if (confirmed) {
    if (activePoint.value === id) closePointCard()
    monitorStore.removePoint(id)
  }
}

function pointSegMeters(lat, lng, a, b, cos) {
  const px = (lng - a[0]) * 111320 * cos
  const py = (lat - a[1]) * 111320
  const bx = (b[0] - a[0]) * 111320 * cos
  const by = (b[1] - a[1]) * 111320
  const len2 = bx * bx + by * by
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (px * bx + py * by) / len2))
  return Math.hypot(px - bx * t, py - by * t)
}

// 吸附 30 米内最近的横向 / 纵向道路
function nearestRoad(lat, lng, dir) {
  const cos = Math.cos((lat * Math.PI) / 180)
  let best = null
  roads.forEach((road) => {
    if (road.dir !== dir) return
    road.segments.forEach((segment) => {
      for (let i = 1; i < segment.coords.length; i += 1) {
        const distance = pointSegMeters(lat, lng, segment.coords[i - 1], segment.coords[i], cos)
        if (distance <= 30 && (!best || distance < best.distance)) best = { road, distance }
      }
    })
  })
  return best?.road ?? null
}

function togglePickMode() {
  pickMode.value = !pickMode.value
  if (pickMode.value) {
    clearSelection()
    closePointCard()
  }
}

// 地图点选后带着坐标、道路名跳到表单页继续填写相机
function handleMapClick(event) {
  if (!pickMode.value) {
    closePointCard()
    return
  }
  const { lat, lng } = event.latlng
  const names = [
    nearestRoad(lat, lng, 'horizontal'),
    nearestRoad(lat, lng, 'vertical'),
  ]
    .filter(Boolean)
    .map((road) => road.name)
  pickMode.value = false
  router.push({
    path: '/monitor/new',
    query: {
      lat: lat.toFixed(6),
      lng: lng.toFixed(6),
      roads: names.join(' × '),
      name: names.map((name) => name.replace(/(大道|路|街|巷|支路)$/u, '')).join(''),
    },
  })
}

function handleKeydown(event) {
  if (event.key !== 'Escape') return
  if (pickMode.value) pickMode.value = false
  closePointCard()
}

function exportPoints() {
  const payload = {
    source: 'quanzhou-monitor-points',
    total: { intersections: totalIntersections.value, cameras: totalCameras.value },
    intersections: intersections.value,
  }
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = 'monitor-points.json'
  anchor.click()
  URL.revokeObjectURL(url)
}

function pickImportFile() {
  importInput.value?.click()
}

async function importPoints(event) {
  const file = event.target.files?.[0]
  event.target.value = ''
  if (!file) return
  try {
    const parsed = JSON.parse(await file.text())
    monitorStore.replacePoints(Array.isArray(parsed) ? parsed : parsed.intersections)
  } catch (error) {
    window.alert(`导入失败：${error.message}`)
  }
}

function addDistrictNames(layer) {
  const props = layer.feature.properties
  const bounds = layer.getBounds()
  const [rx, ry] = DISTRICT_LABEL_POS[props.adcode] ?? [0.5, 0.5]
  const latlng = [
    bounds.getSouth() + (bounds.getNorth() - bounds.getSouth()) * ry,
    bounds.getWest() + (bounds.getEast() - bounds.getWest()) * rx,
  ]
  L.marker(latlng, {
    icon: L.divIcon({
      className: 'district-name-wrap',
      html: `<span class="district-name">${props.name}</span>`,
      iconSize: null,
    }),
    interactive: false,
    keyboard: false,
    pane: 'districtNamePane',
  }).addTo(map)
}

function labelAnchor(road, ratio = 0.5, segments = road.segments) {
  const longest = segments.reduce((a, b) => (a.length >= b.length ? a : b))
  const coords = longest.coords
  const segDist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1])
  let total = 0
  for (let i = 1; i < coords.length; i++) total += segDist(coords[i - 1], coords[i])
  let walked = 0
  for (let i = 1; i < coords.length; i++) {
    const d = segDist(coords[i - 1], coords[i])
    if (walked + d >= total * ratio) {
      const t = d === 0 ? 0 : (total * ratio - walked) / d
      return [
        coords[i - 1][1] + (coords[i][1] - coords[i - 1][1]) * t,
        coords[i - 1][0] + (coords[i][0] - coords[i - 1][0]) * t,
      ]
    }
    walked += d
  }
  return [coords[0][1], coords[0][0]]
}

const LABEL_PRIORITY = { trunk: 5, primary: 4, secondary: 3, tertiary: 2, unclassified: 1.6, residential: 1.2, pedestrian: 0.8, living_street: 0.6 }

// 老城核心街巷：无论缩放到哪一级都优先争取名称位置
const OLD_TOWN = new Set([
  '中山北路', '中山中路', '中山南路', '西街', '东街', '新门街', '涂门街',
  '打锡街', '南俊路', '镇抚巷', '承天巷', '庄府巷', '花巷', '敷仁巷',
  '新华南路', '新华北路', '义全街', '天后路',
])

function boxesOverlap(a, b) {
  return !(a.x + a.w < b.x || b.x + b.w < a.x || a.y + a.h < b.y || b.y + b.h < a.y)
}

function escapeHtml(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch],
  )
}

function segmentBounds(coords) {
  let south = Infinity
  let west = Infinity
  let north = -Infinity
  let east = -Infinity
  coords.forEach(([lng, lat]) => {
    if (lat < south) south = lat
    if (lat > north) north = lat
    if (lng < west) west = lng
    if (lng > east) east = lng
  })
  return L.latLngBounds([south, west], [north, east])
}

// 预计算每条道路的包围盒，避免每个缩放级别重复遍历全部折线
const roadBounds = new Map(
  roads.map((road) => [road, segmentBounds(road.segments.flatMap((segment) => segment.coords))]),
)

// 点位名称常驻在地图标记下方，缩小后也不会认不出是哪个路口
function placeCameraLabels(placed, zoom, onlyActive) {
  const compact = zoom < 13
  const fontSize = compact ? 10.5 : 11.5
  const charSize = fontSize + 1.2
  const size = map.getSize()
  // 默认放正下方，被占用时依次尝试上方与左右侧，尽量不让名称消失
  const offsets = compact
    ? [[0, 22], [0, -22], [20, 0], [-20, 0]]
    : [[0, 44], [0, -44], [46, 0], [-46, 0]]
  const items = intersections.value.filter((item) =>
    onlyActive ? item.id === activePoint.value : item.id !== activePoint.value,
  )

  for (const item of items) {
    const p = map.latLngToContainerPoint([item.lat, item.lng])
    const w = item.name.length * charSize + 12
    const h = fontSize + 9

    for (const [dx, dy] of offsets) {
      const box = { x: p.x + dx - w / 2, y: p.y + dy - h / 2, w, h }
      if (box.x < 6 || box.y < 6 || box.x + w > size.x - 6 || box.y + h > size.y - 6) continue
      if (placed.some((other) => boxesOverlap(other, box))) continue
      placed.push(box)
      L.marker(map.containerPointToLatLng([p.x + dx, p.y + dy]), {
        icon: L.divIcon({
          className: 'cam-label-wrap',
          html: `<span class="cam-label${compact ? ' compact' : ''}${item.id === activePoint.value ? ' on' : ''}">${escapeHtml(item.name)}</span>`,
          iconSize: null,
        }),
        interactive: false,
        keyboard: false,
        pane: 'camLabelPane',
      }).addTo(camLabelGroup)
      break
    }
  }
}

// 任何缩放级别都参与渲染，只按视口与屏幕碰撞剔除，避免重叠
function updateLabels() {
  if (!map || !labelLayerGroup || !camLabelGroup) return
  labelLayerGroup.clearLayers()
  camLabelGroup.clearLayers()

  const zoom = map.getZoom()
  const size = map.getSize()
  const placed = []

  // 摄像头点位名称先占位（选中点最优先），滚轮缩放时也不会被路名挤掉
  placeCameraLabels(placed, zoom, true)
  placeCameraLabels(placed, zoom, false)

  if (showLabels.value) {
    const viewport = map.getBounds().pad(0.08)
    const isNarrow = window.innerWidth <= 768
    const fontSize = isNarrow ? 11 : 12
    // 沿道路多个锚点尝试，尽量为每条可见道路找到不重叠的位置
    const RATIOS = [0.5, 0.36, 0.64, 0.24, 0.76, 0.12, 0.88]

    // 不再按缩放阈值隐藏，视口内所有道路都参与，只做碰撞剔除
    const candidates = roads
      .map((road) => {
        const bounds = roadBounds.get(road)
        if (!bounds || !bounds.intersects(viewport)) return null
        const segs = road.segments.filter((segment) => segmentBounds(segment.coords).intersects(viewport))
        return segs.length ? { road, segs } : null
      })
      .filter(Boolean)
      .map((candidate) => ({
        ...candidate,
        score:
          (candidate.road.tier === 'main' ? 20 : 4) +
          (LABEL_PRIORITY[candidate.road.type] ?? 1) * 1.5 +
          Math.min(candidate.road.total / 3000, 3) +
          (OLD_TOWN.has(candidate.road.name) ? 15 : 0),
      }))
      .sort((a, b) => b.score - a.score || a.road.name.localeCompare(b.road.name))

    // 同一条道路在数据里可能拆成多段，视口内只保留一个名称
    const labeled = new Set()

    for (const item of candidates) {
      const { road, segs } = item
      if (labeled.has(road.name)) continue
      const vertical = road.dir === 'vertical'
      const isMain = road.tier === 'main'
      const labelSize = isMain ? 13 : fontSize
      const lineH = labelSize * 1.25
      const w = vertical ? labelSize + 10 : road.name.length * (labelSize + 1) + 10
      const h = vertical ? road.name.length * (lineH + 2) + 6 : lineH + 8

      let chosen = null
      for (const ratio of RATIOS) {
        const point = labelAnchor(road, ratio, segs)
        const p = map.latLngToContainerPoint(point)
        // 预留 3px 间距，避免文字贴在一起显得拥挤
        const box = { x: p.x - w / 2 - 3, y: p.y - h / 2 - 3, w: w + 6, h: h + 6 }
        if (box.x < 8 || box.y < 8 || box.x + w > size.x - 8 || box.y + h > size.y - 8) continue
        if (placed.some((b) => boxesOverlap(b, box))) continue
        chosen = { point, box }
        break
      }
      if (!chosen) continue
      placed.push(chosen.box)
      labeled.add(road.name)

      const icon = L.divIcon({
        className: 'road-label-wrap',
        html: `<span class="road-label${isMain ? ' main' : ''}${vertical ? ' v' : ''}">${road.name}</span>`,
        iconSize: null,
      })
      L.marker(chosen.point, {
        icon,
        interactive: false,
        keyboard: false,
        pane: 'roadLabelPane',
      }).addTo(labelLayerGroup)
    }
  }
}

function toggleLabels() {
  updateLabels()
}

let layoutTimer = null
function relayoutMap(onDone) {
  clearTimeout(layoutTimer)
  layoutTimer = setTimeout(() => {
    if (!map) return
    map.invalidateSize({ animate: false })
    updateLabels()
    onDone?.()
  }, 340)
}

function toggleRail() {
  railOpen.value = !railOpen.value
  relayoutMap()
}

function togglePanel() {
  panelOpen.value = !panelOpen.value
  // 打开清单即回到列表模式，收起地图上的点位卡片
  if (panelOpen.value) closePointCard()
  relayoutMap()
}

function resetView() {
  selectedRoad.value = ''
  refreshStyles()
  closePointCard()
  intersections.value.forEach((item) => camMarkers[item.id]?.setIcon(cameraIcon(item, false, true)))
  updateLabels()
  if (map && districtBounds) {
    map.flyToBounds(districtBounds, { ...fitPadding(), duration: 0.6 })
  }
}

function syncCameraMarkers() {
  if (!map) return
  const ids = new Set(intersections.value.map((item) => item.id))
  if (activePoint.value && !ids.has(activePoint.value)) {
    activePoint.value = ''
    if (pointPopup) map.closePopup(pointPopup)
  }
  Object.keys(camMarkers).forEach((id) => {
    if (ids.has(id)) return
    camMarkers[id].remove()
    delete camMarkers[id]
  })

  const compact = map.getZoom() < 13
  intersections.value.forEach((item) => {
    const tooltip = `${item.name} · ${item.cameras.length} 台`
    if (camMarkers[item.id]) {
      camMarkers[item.id].setLatLng([item.lat, item.lng])
      camMarkers[item.id].setIcon(cameraIcon(item, item.id === activePoint.value, compact))
      camMarkers[item.id].setTooltipContent(tooltip)
      return
    }
    camMarkers[item.id] = L.marker([item.lat, item.lng], {
      icon: cameraIcon(item, item.id === activePoint.value, compact),
      keyboard: false,
      riseOnHover: true,
      pane: 'camPane',
    })
      .bindTooltip(tooltip, {
        direction: 'top',
        offset: [0, -20],
        className: 'cam-tip',
      })
      .on('click', (event) => {
        // 阻止冒泡到地图，否则地图点击会立刻把刚打开的卡片关掉
        if (event.originalEvent) L.DomEvent.stopPropagation(event.originalEvent)
        selectPoint(item.id)
      })
      .addTo(map)
  })
  updateLabels()
}

function updateStandaloneState() {
  isStandalone.value =
    window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true
}

function handleBeforeInstallPrompt(event) {
  event.preventDefault()
  deferredInstallPrompt.value = event
}

function handleAppInstalled() {
  deferredInstallPrompt.value = null
  isStandalone.value = true
  showInstallHelp.value = false
}

async function installApp() {
  if (!deferredInstallPrompt.value) {
    showInstallHelp.value = true
    return
  }
  const prompt = deferredInstallPrompt.value
  deferredInstallPrompt.value = null
  try {
    await prompt.prompt()
    await prompt.userChoice
  } catch {
    showInstallHelp.value = true
  }
}

function closeInstallHelp() {
  showInstallHelp.value = false
}

onMounted(() => {
  updateStandaloneState()
  window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt)
  window.addEventListener('appinstalled', handleAppInstalled)

  map = L.map(mapEl.value, {
    center: [24.9018, 118.597],
    zoom: 13,
    zoomControl: false,
    attributionControl: false,
    minZoom: 11,
    maxZoom: 17,
    zoomSnap: 0.25,
  })
  map.getContainer().addEventListener('click', handleCardCloseClick)

  districtLayer = L.geoJSON(quanzhouGeo, {
    style: (feature) => ({
      color: '#6b5b47',
      weight: 1,
      opacity: 0.55,
      fillColor: feature.properties.adcode === '350502' ? '#b23a2f' : '#23475e',
      fillOpacity: 0.035,
      dashArray: '5 6',
    }),
    onEachFeature: (feature, layer) => {
      layer.on({ click: clearSelection })
    },
  }).addTo(map)

  map.createPane('roadLabelPane').style.zIndex = 610
  map.createPane('districtNamePane').style.zIndex = 620

  districtLayer.eachLayer(addDistrictNames)
  districtBounds = districtLayer.getBounds()

  weightedRoads.forEach((road) => {
    layersByRoad[road.name] = road.segments.map((segment) =>
      L.polyline(segment.coords.map(([lng, lat]) => [lat, lng]), styleOf(road))
        .bindTooltip(road.name, {
          direction: 'top',
          offset: [0, -6],
          className: 'hover-label',
        })
        .on('click', () => selectRoad(road.name))
        .addTo(map),
    )
  })

  labelLayerGroup = L.layerGroup().addTo(map)
  camLabelGroup = L.layerGroup().addTo(map)
  map.createPane('camLabelPane').style.zIndex = 615
  map.createPane('camPane').style.zIndex = 605

  syncCameraMarkers()

  L.control.zoom({ position: 'topright' }).addTo(map)

  map.on('zoomend', () => {
    updateLabels()
    updateCameraIcons()
  })
  map.on('click', handleMapClick)
  window.addEventListener('keydown', handleKeydown)
  map.fitBounds(districtBounds, { ...fitPadding(), animate: false })
  map.setMaxBounds(districtBounds.pad(0.08))
  updateLabels()
  updateCameraIcons()

  loaded.value = true
})

watch(
  () => monitorStore.points,
  () => syncCameraMarkers(),
  { deep: true },
)

let resizeTimer = null
let wasWide = window.innerWidth > 1180
let wasPhone = window.innerWidth <= 768

function handleResize() {
  clearTimeout(resizeTimer)
  resizeTimer = setTimeout(() => {
    if (!map) return
    const wide = window.innerWidth > 1180
    if (wide !== wasWide) {
      wasWide = wide
      panelOpen.value = wide
    }
    const phone = window.innerWidth <= 768
    if (phone !== wasPhone) {
      wasPhone = phone
      if (phone) railOpen.value = false
    }
    map.invalidateSize({ animate: false })
    if (districtBounds) map.fitBounds(districtBounds, { ...fitPadding(), animate: false })
    updateLabels()
    updateCameraIcons()
  }, 200)
}

window.addEventListener('resize', handleResize)

onBeforeUnmount(() => {
  clearTimeout(resizeTimer)
  clearTimeout(layoutTimer)
  window.removeEventListener('resize', handleResize)
  window.removeEventListener('keydown', handleKeydown)
  window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt)
  window.removeEventListener('appinstalled', handleAppInstalled)
  if (map) {
    map.getContainer().removeEventListener('click', handleCardCloseClick)
    map.remove()
    map = null
  }
})
</script>

<template>
  <div class="atlas">
    <aside class="rail" :class="{ 'is-closed': !railOpen }">
      <div class="rail-head">
        <p class="eyebrow">QUANZHOU · CITY ATLAS 01</p>
        <h1 class="title">鲤城<span class="sep">与</span>丰泽</h1>
        <p class="subtitle">主 干 道 路 网 图</p>
        <button type="button" class="rail-close" @click="toggleRail">收起</button>
      </div>

      <div class="stats">
        <div class="stat">
          <b>{{ mainCount }}</b>
          <span>主干道</span>
        </div>
        <div class="stat">
          <b>{{ minorCount }}</b>
          <span>街 · 巷</span>
        </div>
      </div>

      <div class="legend">
        <span><i class="mark h"></i>横向 · 东西 {{ horizontal.length }}</span>
        <span><i class="mark v"></i>纵向 · 南北 {{ vertical.length }}</span>
      </div>

      <div class="index">
        <section class="index-block">
          <h2><span>01</span>横向 · 东西</h2>
          <ul>
            <li v-for="road in horizontal" :key="road.name">
              <button
                type="button"
                :class="{ on: selectedRoad === road.name, minor: road.tier === 'minor' }"
                @click="selectRoad(road.name)"
              >
                {{ road.name }}
              </button>
            </li>
          </ul>
        </section>
        <section class="index-block">
          <h2><span>02</span>纵向 · 南北</h2>
          <ul>
            <li v-for="road in vertical" :key="road.name">
              <button
                type="button"
                :class="{ on: selectedRoad === road.name, minor: road.tier === 'minor' }"
                @click="selectRoad(road.name)"
              >
                {{ road.name }}
              </button>
            </li>
          </ul>
        </section>
      </div>

      <footer class="rail-foot">
        <label class="switch">
          <input v-model="showLabels" type="checkbox" @change="toggleLabels" />
          <span class="track"></span>
          路名标注
        </label>
        <div class="foot-actions">
          <span>OSM 数据 · 已裁切两区</span>
          <div class="foot-buttons">
            <button v-if="canInstall" type="button" class="install-app" @click="installApp">安装 App</button>
            <button type="button" class="reset" @click="resetView">复位</button>
          </div>
        </div>
      </footer>
    </aside>

    <div v-if="railOpen" class="rail-scrim" aria-hidden="true" @click="toggleRail"></div>

    <main class="stage">
      <div ref="mapEl" class="map" :class="{ 'is-loaded': loaded, 'pick-on': pickMode }"></div>

      <div v-if="pickMode" class="pick-hint">
        点击地图选择路口位置 · 自动吸附 30m 内道路 · Esc 取消
      </div>

      <div class="search" :class="{ 'has-results': searchOpen && searchQuery }">
        <div class="search-box">
          <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
            <circle cx="8.5" cy="8.5" r="5.5" fill="none" stroke="currentColor" stroke-width="1.5" />
            <path d="M13 13 L17.5 17.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
          </svg>
          <input
            v-model="searchQuery"
            type="text"
            :placeholder="phoneLayout ? '搜索路口 / 道路' : '搜索路口、道路关键词'"
            aria-label="搜索路口或道路"
            @focus="searchOpen = true"
            @input="searchOpen = true"
            @blur="searchOpen = false"
            @keydown.enter.prevent="pickFirstSearchResult"
            @keydown.esc="clearSearch"
          />
          <button v-if="searchQuery" type="button" class="search-clear" @mousedown.prevent="clearSearch">×</button>
        </div>

        <div v-if="searchOpen && searchQuery" class="search-results">
          <template v-if="searchResults.intersections.length">
            <p class="search-group">路口点位</p>
            <button
              v-for="item in searchResults.intersections"
              :key="item.id"
              type="button"
              class="search-item"
              @mousedown.prevent="pickIntersection(item.id)"
            >
              <span class="search-pin"></span>
              <span class="search-main">
                <b>{{ item.name }}</b>
                <i>{{ item.roads }}</i>
              </span>
              <span class="search-count">{{ item.cameras.length }}</span>
            </button>
          </template>

          <template v-if="searchResults.roads.length">
            <p class="search-group">道路</p>
            <button
              v-for="road in searchResults.roads"
              :key="road.name"
              type="button"
              class="search-item"
              @mousedown.prevent="pickRoad(road.name)"
            >
              <span class="search-road-line"></span>
              <span class="search-main">
                <b>{{ road.name }}</b>
                <i>{{ road.dir === 'vertical' ? '纵向' : '横向' }} · {{ road.type }}</i>
              </span>
            </button>
          </template>

          <p v-if="!hasSearchResults" class="search-empty">未找到相关路口或道路</p>
        </div>
      </div>

      <div class="frame">
        <span class="corner tl"></span>
        <span class="corner tr"></span>
        <span class="corner bl"></span>
        <span class="corner br"></span>
      </div>

      <div class="compass" aria-hidden="true">
        <svg viewBox="0 0 40 56" width="30" height="42">
          <path d="M20 2 L28 34 L20 28 L12 34 Z" fill="#241f1a" opacity="0.82" />
          <text x="20" y="50" text-anchor="middle" font-size="10" fill="#6b5f51">N</text>
        </svg>
      </div>

      <div class="edition">
        <span>区域裁剪 · 鲤城区 / 丰泽区</span>
        <span class="coord">24.90°N · 118.59°E</span>
      </div>

      <div v-if="!loaded" class="loading">正在铺绘路网…</div>
      <button v-if="loaded && !railOpen" type="button" class="rail-open" @click="toggleRail">图鉴</button>
      <button v-if="loaded && !panelOpen" type="button" class="mon-toggle" @click="togglePanel">
        点位清单
      </button>
    </main>

    <aside class="monitor" :class="{ open: panelOpen, 'is-closed': !panelOpen }">
      <header class="mon-head">
        <p class="mon-eyebrow">TRAFFIC CAM · {{ totalCameras }}</p>
        <h2>路口监控点位</h2>
        <button type="button" class="mon-add" @click="goAdd">+ 添加</button>
        <button type="button" class="panel-close mon-close" @click="togglePanel">收起</button>
        <div class="mon-meta">
          <span>{{ totalIntersections }} 个路口</span>
          <span>{{ totalCameras }} 路相机</span>
        </div>
        <div class="mon-legend">
          <span><i class="dot traffic"></i>路口交通机</span>
          <span><i class="dot ptz"></i>联动快球</span>
        </div>
        <div class="mon-actions">
          <button type="button" class="mon-act" :class="{ on: pickMode }" @click="togglePickMode">
            {{ pickMode ? '点选中…' : '地图点选' }}
          </button>
          <button type="button" class="mon-act" @click="exportPoints">导出</button>
          <button type="button" class="mon-act" @click="pickImportFile">导入</button>
          <button v-if="canInstall" type="button" class="mon-act mon-install" @click="installApp">安装 App</button>
          <input
            ref="importInput"
            type="file"
            accept="application/json,.json"
            hidden
            @change="importPoints"
          />
        </div>
        <p class="mon-save" :class="`is-${monitorStore.persistState}`" :title="saveHint">{{ saveHint }}</p>
      </header>

      <ul class="mon-list">
        <li
          v-for="(item, idx) in intersections"
          :key="item.id"
          :data-point="item.id"
          :class="{ on: activePoint === item.id }"
        >
          <div
            class="mon-row"
            role="button"
            tabindex="0"
            @click="selectPoint(item.id)"
            @keydown.enter="selectPoint(item.id)"
            @keydown.space.prevent="selectPoint(item.id)"
          >
            <span class="mon-no">{{ String(idx + 1).padStart(2, '0') }}</span>
            <span class="mon-name">{{ item.name }}</span>
            <span class="mon-road">{{ item.roads }}</span>
            <span class="mon-tools">
              <button type="button" class="mon-edit" title="修改点位" @click.stop="editPoint(item.id)">✎</button>
              <button type="button" class="mon-del" title="删除点位" @click.stop="deletePoint(item.id)">✕</button>
              <span class="mon-count">{{ item.cameras.length }}</span>
            </span>
          </div>
          <ul v-if="activePoint === item.id" class="cam-list">
            <li v-for="(cam, ci) in item.cameras" :key="ci">
              <i class="cam-dot" :class="cam.type"></i>
              <span class="cam-scene">{{ cam.scene }}</span>
              <b class="cam-dir">{{ cam.dir }}</b>
            </li>
          </ul>
        </li>
      </ul>
    </aside>

    <Teleport to="body">
      <div v-if="showInstallHelp" class="install-modal" @click.self="closeInstallHelp">
        <section class="install-card" role="dialog" aria-modal="true" aria-labelledby="install-title">
          <button type="button" class="install-close" title="关闭" @click="closeInstallHelp">×</button>
          <p class="install-eyebrow">APP INSTALL</p>
          <h2 id="install-title">安装到手机</h2>
          <template v-if="isAppleMobile">
            <p>用 Safari 打开本页面，点击工具栏的分享按钮，再选择“添加到主屏幕”。</p>
          </template>
          <template v-else>
            <p>打开浏览器菜单，选择“安装应用”或“添加到主屏幕”，即可从桌面启动。</p>
          </template>
          <button type="button" class="install-done" @click="closeInstallHelp">知道了</button>
        </section>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.atlas {
  --paper: #f1ebdf;
  --paper-deep: #e7dfd0;
  --ink: #241f1a;
  --ink-soft: #6b5f51;
  --vermilion: #b23a2f;
  --indigo: #23475e;
  --hairline: rgba(52, 40, 28, 0.16);

  display: flex;
  width: 100%;
  height: 100%;
  overflow: hidden;
  position: relative;
  background-color: var(--paper);
  background-image:
    radial-gradient(circle at 16% 8%, rgba(178, 58, 47, 0.055), transparent 40%),
    radial-gradient(circle at 88% 92%, rgba(35, 71, 94, 0.07), transparent 46%),
    url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.045'/%3E%3C/svg%3E");
  color: var(--ink);
  font-family: 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif;
}

/* ---------- 左侧图鉴栏 ---------- */
.rail {
  position: relative;
  z-index: 20;
  display: flex;
  flex-direction: column;
  width: 316px;
  flex-shrink: 0;
  padding: 34px 26px 22px;
  background: linear-gradient(180deg, rgba(255, 252, 245, 0.72), rgba(231, 223, 208, 0.65));
  border-right: 1px solid var(--hairline);
  box-shadow: 1px 0 0 rgba(255, 255, 255, 0.5) inset;
  transition: margin-left 0.32s ease;
}

.rail.is-closed {
  margin-left: -316px;
}

.rail-scrim {
  display: none;
}

.rail-close {
  position: absolute;
  top: -2px;
  right: 0;
  padding: 3px 8px;
  font-family: inherit;
  font-size: 9.5px;
  letter-spacing: 1px;
  color: var(--ink-soft);
  background: rgba(255, 252, 245, 0.6);
  border: 1px solid rgba(52, 40, 28, 0.22);
  border-radius: 2px;
  cursor: pointer;
  transition: 0.18s;
}

.rail-close:hover {
  color: var(--paper);
  background: var(--ink);
  border-color: var(--ink);
}

.rail-head {
  position: relative;
  padding-bottom: 20px;
  border-bottom: 1px solid var(--hairline);
}

.eyebrow {
  margin: 0 0 14px;
  font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
  font-size: 9px;
  letter-spacing: 2.4px;
  color: var(--ink-soft);
  opacity: 0.75;
}

.title {
  margin: 0;
  font-family: 'Songti SC', 'STSong', 'Noto Serif SC', 'Source Han Serif SC', 'SimSun', serif;
  font-size: 40px;
  font-weight: 700;
  line-height: 1.06;
  letter-spacing: 2px;
  color: var(--ink);
}

.title .sep {
  display: inline-block;
  margin: 0 6px;
  font-size: 18px;
  font-weight: 400;
  color: var(--vermilion);
  transform: translateY(-6px);
}

.subtitle {
  margin: 12px 0 0;
  font-size: 11px;
  letter-spacing: 5px;
  color: var(--ink-soft);
}

.stats {
  display: flex;
  padding: 18px 0 16px;
  border-bottom: 1px solid var(--hairline);
}

.stat {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.stat + .stat {
  padding-left: 18px;
  border-left: 1px solid var(--hairline);
}

.stat b {
  font-family: 'Songti SC', 'STSong', 'Noto Serif SC', 'SimSun', serif;
  font-size: 34px;
  font-weight: 600;
  line-height: 1;
  letter-spacing: 1px;
}

.stat span {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 10.5px;
  letter-spacing: 1px;
  color: var(--ink-soft);
}

.legend {
  display: flex;
  gap: 18px;
  padding: 10px 0 0;
  font-size: 10px;
  letter-spacing: 0.4px;
  color: var(--ink-soft);
}

.legend span {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.mark {
  width: 12px;
  height: 2px;
  border-radius: 99px;
}

.mark.h {
  background: var(--vermilion);
}

.mark.v {
  background: var(--indigo);
}

.index {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 18px 2px 12px 0;
  scrollbar-width: thin;
  scrollbar-color: rgba(52, 40, 28, 0.22) transparent;
}

.index::-webkit-scrollbar {
  width: 3px;
}

.index::-webkit-scrollbar-thumb {
  background: rgba(52, 40, 28, 0.22);
}

.index-block + .index-block {
  margin-top: 20px;
}

.index-block h2 {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin: 0 0 8px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 2px;
  color: var(--ink);
}

.index-block h2 span {
  font-family: ui-monospace, 'SFMono-Regular', Menlo, monospace;
  font-size: 9px;
  color: var(--vermilion);
  letter-spacing: 0;
}

.index-block ul {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0 12px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.index-block li {
  border-bottom: 1px dotted rgba(52, 40, 28, 0.16);
}

.index-block button {
  width: 100%;
  padding: 5px 0;
  font-family: inherit;
  font-size: 11.5px;
  text-align: left;
  color: var(--ink-soft);
  background: none;
  border: 0;
  cursor: pointer;
  transition: color 0.18s, padding-left 0.18s;
}

.index-block button:hover {
  color: var(--ink);
  padding-left: 3px;
}

.index-block button.minor:not(.on) {
  font-size: 11px;
  color: rgba(107, 95, 81, 0.62);
}

.index-block button.on {
  color: var(--vermilion);
  font-weight: 600;
}

.rail-foot {
  padding-top: 14px;
  border-top: 1px solid var(--hairline);
  font-size: 10px;
  color: var(--ink-soft);
}

.switch {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
  cursor: pointer;
  letter-spacing: 1px;
}

.switch input {
  position: absolute;
  opacity: 0;
  pointer-events: none;
}

.switch .track {
  position: relative;
  width: 26px;
  height: 14px;
  border: 1px solid rgba(52, 40, 28, 0.35);
  border-radius: 99px;
  transition: 0.2s;
}

.switch .track::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--ink-soft);
  transition: 0.2s;
}

.switch input:checked + .track {
  border-color: var(--vermilion);
}

.switch input:checked + .track::after {
  left: 14px;
  background: var(--vermilion);
}

.foot-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 9.5px;
  letter-spacing: 0.6px;
  color: rgba(107, 95, 81, 0.85);
}

.foot-buttons {
  display: flex;
  align-items: center;
  gap: 6px;
}

.install-app {
  padding: 4px 9px;
  font-family: inherit;
  font-size: 10px;
  color: #0f7d68;
  background: rgba(32, 217, 162, 0.08);
  border: 1px solid rgba(15, 125, 104, 0.38);
  border-radius: 2px;
  cursor: pointer;
  white-space: nowrap;
  transition: 0.18s;
}

.install-app:hover {
  color: #14161a;
  background: #20d9a2;
  border-color: #20d9a2;
}

.reset {
  padding: 4px 9px;
  font-family: inherit;
  font-size: 10px;
  color: var(--ink-soft);
  background: transparent;
  border: 1px solid rgba(52, 40, 28, 0.3);
  border-radius: 2px;
  cursor: pointer;
  transition: 0.18s;
}

.reset:hover {
  color: var(--paper);
  background: var(--ink);
  border-color: var(--ink);
}

/* ---------- PWA 安装说明 ---------- */
.install-modal {
  position: fixed;
  inset: 0;
  z-index: 2000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(20, 22, 26, 0.48);
  backdrop-filter: blur(3px);
}

.install-card {
  position: relative;
  width: min(380px, 100%);
  padding: 26px 24px 22px;
  color: #241f1a;
  background: #f7f2e7;
  border: 1px solid rgba(52, 40, 28, 0.24);
  border-radius: 4px;
  box-shadow: 0 18px 50px rgba(20, 22, 26, 0.28);
}

.install-eyebrow {
  margin: 0 0 8px;
  font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
  font-size: 9px;
  letter-spacing: 2px;
  color: #0f7d68;
}

.install-card h2 {
  margin: 0 0 12px;
  font-family: 'Songti SC', 'STSong', 'Noto Serif SC', 'SimSun', serif;
  font-size: 24px;
  letter-spacing: 2px;
}

.install-card p {
  margin: 0;
  font-size: 12px;
  line-height: 1.8;
  color: #6b5f51;
}

.install-close {
  position: absolute;
  top: 10px;
  right: 10px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  font-size: 17px;
  color: #6b5f51;
  background: transparent;
  border: 0;
  cursor: pointer;
}

.install-close:hover {
  color: #241f1a;
}

.install-done {
  width: 100%;
  margin-top: 18px;
  padding: 9px 14px;
  font-family: inherit;
  font-size: 12px;
  letter-spacing: 1px;
  color: #f1ebdf;
  background: #23475e;
  border: 1px solid #23475e;
  border-radius: 2px;
  cursor: pointer;
}

.install-done:hover {
  background: #18364a;
}

/* ---------- 地图区 ---------- */
.stage {
  position: relative;
  flex: 1;
  min-width: 0;
  overflow: hidden;
}

.stage::before {
  content: '';
  position: absolute;
  inset: 0;
  background-image:
    linear-gradient(rgba(36, 31, 26, 0.045) 1px, transparent 1px),
    linear-gradient(90deg, rgba(36, 31, 26, 0.045) 1px, transparent 1px);
  background-size: 44px 44px;
  pointer-events: none;
}

.map {
  position: absolute;
  inset: 0;
  z-index: 1;
  background: transparent;
  opacity: 0;
  transition: opacity 1s ease 0.1s;
}

.map.is-loaded {
  opacity: 1;
}

.search {
  position: absolute;
  top: 24px;
  left: 50%;
  z-index: 50;
  width: min(420px, calc(100% - 44px));
  transform: translateX(-50%);
}

.search-box {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 38px;
  padding: 0 10px;
  color: var(--ink-soft);
  background: rgba(249, 245, 237, 0.96);
  border: 1px solid rgba(52, 40, 28, 0.24);
  border-radius: 2px;
  box-shadow: 0 3px 14px rgba(52, 40, 28, 0.1);
}

.search-box input {
  flex: 1;
  min-width: 0;
  height: 100%;
  padding: 0;
  font-family: inherit;
  font-size: 12.5px;
  letter-spacing: 0.4px;
  color: var(--ink);
  background: transparent;
  border: 0;
  outline: none;
}

.search-box input::placeholder {
  color: rgba(107, 95, 81, 0.7);
}

.search-clear {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  font-size: 15px;
  line-height: 1;
  color: var(--ink-soft);
  background: transparent;
  border: 0;
  border-radius: 50%;
  cursor: pointer;
}

.search-clear:hover {
  color: var(--paper);
  background: var(--ink);
}

.search-results {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  right: 0;
  max-height: 320px;
  overflow-y: auto;
  background: rgba(249, 245, 237, 0.98);
  border: 1px solid rgba(52, 40, 28, 0.2);
  border-radius: 2px;
  box-shadow: 0 12px 28px rgba(52, 40, 28, 0.18);
}

.search-group {
  margin: 0;
  padding: 9px 12px 5px;
  font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
  font-size: 9px;
  letter-spacing: 1.6px;
  color: rgba(107, 95, 81, 0.85);
}

.search-item {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  padding: 8px 12px;
  font-family: inherit;
  text-align: left;
  color: var(--ink);
  background: transparent;
  border: 0;
  border-left: 2px solid transparent;
  cursor: pointer;
  transition: 0.16s;
}

.search-item:hover {
  background: rgba(178, 58, 47, 0.06);
  border-left-color: var(--vermilion);
}

.search-pin {
  flex: none;
  width: 7px;
  height: 7px;
  border: 1.5px solid var(--vermilion);
  border-radius: 50%;
}

.search-road-line {
  flex: none;
  width: 12px;
  height: 2px;
  background: var(--indigo);
}

.search-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.search-main b {
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.4px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.search-main i {
  font-size: 9.5px;
  font-style: normal;
  color: var(--ink-soft);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.search-count {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 20px;
  height: 20px;
  padding: 0 5px;
  font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
  font-size: 9px;
  color: var(--ink-soft);
  border: 1px solid rgba(52, 40, 28, 0.22);
  border-radius: 2px;
}

.search-empty {
  margin: 0;
  padding: 14px 12px;
  font-size: 11px;
  letter-spacing: 0.4px;
  color: var(--ink-soft);
  text-align: center;
}

.frame {
  position: absolute;
  inset: 20px;
  z-index: 5;
  border: 1px solid rgba(52, 40, 28, 0.18);
  pointer-events: none;
}

.corner {
  position: absolute;
  width: 14px;
  height: 14px;
}

.corner.tl {
  top: -1px;
  left: -1px;
  border-top: 2px solid var(--ink);
  border-left: 2px solid var(--ink);
}

.corner.tr {
  top: -1px;
  right: -1px;
  border-top: 2px solid var(--ink);
  border-right: 2px solid var(--ink);
}

.corner.bl {
  bottom: -1px;
  left: -1px;
  border-bottom: 2px solid var(--ink);
  border-left: 2px solid var(--ink);
}

.corner.br {
  bottom: -1px;
  right: -1px;
  border-bottom: 2px solid var(--ink);
  border-right: 2px solid var(--ink);
}

.compass {
  position: absolute;
  right: 34px;
  bottom: 68px;
  z-index: 6;
  opacity: 0.85;
  pointer-events: none;
}

.edition {
  position: absolute;
  right: 34px;
  bottom: 32px;
  z-index: 6;
  display: flex;
  align-items: center;
  gap: 14px;
  font-family: ui-monospace, 'SFMono-Regular', Menlo, monospace;
  font-size: 9px;
  letter-spacing: 1.2px;
  color: var(--ink-soft);
  pointer-events: none;
}

.edition .coord {
  padding-left: 14px;
  border-left: 1px solid rgba(52, 40, 28, 0.25);
}

.loading {
  position: absolute;
  inset: 0;
  z-index: 30;
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: 'Songti SC', 'STSong', 'SimSun', serif;
  font-size: 13px;
  letter-spacing: 4px;
  color: var(--ink-soft);
  background: var(--paper);
}

/* ---------- Leaflet 内标注 ---------- */
:deep(.district-name-wrap) {
  background: transparent;
  border: 0;
}

:deep(.district-name) {
  display: block;
  transform: translate(-50%, -50%);
  font-family: 'Songti SC', 'STSong', 'Noto Serif SC', 'SimSun', serif;
  font-size: 19px;
  font-weight: 600;
  letter-spacing: 7px;
  color: rgba(36, 31, 26, 0.3);
  white-space: nowrap;
  pointer-events: none;
}

:deep(.road-label-wrap) {
  background: transparent;
  border: 0;
}

:deep(.road-label) {
  display: block;
  transform: translate(-50%, -50%);
  padding: 0 3px;
  font-size: 12px;
  line-height: 1.25;
  letter-spacing: 0.4px;
  color: #6b5f51;
  white-space: nowrap;
  text-shadow:
    0 0 2px var(--paper),
    0 0 2px var(--paper),
    0 0 3px var(--paper);
  pointer-events: none;
}

:deep(.road-label.main) {
  font-size: 13px;
  font-weight: 600;
  color: #3c3229;
}

:deep(.cam-label-wrap) {
  background: transparent;
  border: 0;
}

:deep(.cam-label) {
  display: block;
  transform: translate(-50%, -50%);
  padding: 1px 6px;
  font-size: 11.5px;
  font-weight: 500;
  letter-spacing: 0.5px;
  color: #1b1e23;
  white-space: nowrap;
  pointer-events: none;
  background: rgba(249, 245, 237, 0.92);
  border: 1px solid rgba(36, 31, 26, 0.34);
  border-radius: 2px;
  box-shadow: 0 1px 4px rgba(52, 40, 28, 0.18);
}

:deep(.cam-label.compact) {
  padding: 0 4px;
  font-size: 10.5px;
}

:deep(.cam-label.on) {
  color: #f7f2e7;
  background: #b23a2f;
  border-color: #b23a2f;
}

:deep(.road-label.v) {
  writing-mode: vertical-rl;
  text-orientation: upright;
  padding: 3px 0;
  letter-spacing: 2px;
}

:deep(.hover-label) {
  padding: 3px 7px;
  font-size: 11.5px;
  letter-spacing: 0.5px;
  color: #3c3229;
  background: rgba(249, 245, 237, 0.96);
  border: 1px solid rgba(52, 40, 28, 0.22);
  border-radius: 2px;
  box-shadow: 0 3px 10px rgba(52, 40, 28, 0.12);
}

:deep(.hover-label::before) {
  border-top-color: rgba(52, 40, 28, 0.22);
}

:deep(.leaflet-control-zoom) {
  margin: 26px 26px 0 0;
  border: 1px solid rgba(52, 40, 28, 0.25);
  border-radius: 2px;
  box-shadow: 0 2px 10px rgba(52, 40, 28, 0.08);
  overflow: hidden;
}

:deep(.leaflet-control-zoom a) {
  width: 28px;
  height: 28px;
  line-height: 27px;
  font-size: 15px;
  color: var(--ink);
  background: rgba(249, 245, 237, 0.92);
  border-bottom-color: rgba(52, 40, 28, 0.16);
}

:deep(.leaflet-control-zoom a:hover) {
  background: var(--paper-deep);
}

/* ---------- 右侧监控点位栏 ---------- */
.monitor {
  position: relative;
  z-index: 25;
  display: flex;
  flex-direction: column;
  width: 296px;
  flex-shrink: 0;
  background: #14161a;
  color: #e6dfd1;
  border-left: 1px solid rgba(0, 0, 0, 0.5);
  transition: margin-right 0.32s ease;
}

.monitor.is-closed {
  margin-right: -296px;
}

.mon-head {
  position: relative;
  padding: 26px 20px 16px;
  border-bottom: 1px solid rgba(230, 223, 209, 0.12);
}

.mon-close {
  position: absolute;
  top: 24px;
  right: 20px;
  padding: 3px 8px;
  font-family: inherit;
  font-size: 10.5px;
  letter-spacing: 1px;
  color: #9aa3b1;
  background: transparent;
  border: 1px solid rgba(230, 223, 209, 0.22);
  border-radius: 2px;
  cursor: pointer;
  transition: 0.18s;
}

.mon-close:hover {
  color: #14161a;
  background: #20d9a2;
  border-color: #20d9a2;
}

.mon-add {
  position: absolute;
  top: 19px;
  right: 74px;
  padding: 4px 10px;
  font-family: inherit;
  font-size: 11px;
  letter-spacing: 0.8px;
  color: #14161a;
  background: #20d9a2;
  border: 1px solid #20d9a2;
  border-radius: 2px;
  cursor: pointer;
  transition: 0.18s;
}

.mon-add:hover {
  color: #e6dfd1;
  background: transparent;
}

.mon-eyebrow {
  margin: 0 0 10px;
  font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
  font-size: 10px;
  letter-spacing: 2.2px;
  color: #20d9a2;
  opacity: 0.8;
}

.mon-head h2 {
  margin: 0;
  font-family: 'Songti SC', 'STSong', 'Noto Serif SC', 'Source Han Serif SC', 'SimSun', serif;
  font-size: 23px;
  font-weight: 600;
  letter-spacing: 2px;
}

.mon-meta {
  display: flex;
  gap: 14px;
  margin-top: 10px;
  font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
  font-size: 11px;
  letter-spacing: 0.8px;
  color: #8e97a5;
}

.mon-legend {
  display: flex;
  gap: 16px;
  margin-top: 12px;
  font-size: 11px;
  letter-spacing: 0.5px;
  color: #b9b2a4;
}

.mon-actions {
  display: flex;
  gap: 6px;
  margin-top: 12px;
}

.mon-save {
  margin: 10px 0 0;
  font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
  font-size: 10px;
  line-height: 1.5;
  letter-spacing: 0.4px;
  color: #79828f;
  word-break: break-all;
}

.mon-save.is-saving {
  color: #d9c27e;
}

.mon-save.is-saved {
  color: #20d9a2;
}

.mon-save.is-local {
  color: #d98b6a;
}

.mon-act {
  padding: 4px 9px;
  font-family: inherit;
  font-size: 10.5px;
  letter-spacing: 0.6px;
  color: #c9d2df;
  background: transparent;
  border: 1px solid rgba(230, 223, 209, 0.24);
  border-radius: 2px;
  cursor: pointer;
  transition: 0.18s;
}

.mon-act:hover,
.mon-act.on {
  color: #14161a;
  background: #20d9a2;
  border-color: #20d9a2;
}

.mon-install {
  display: none;
}

.pick-hint {
  position: absolute;
  left: 26px;
  bottom: 74px;
  z-index: 40;
  padding: 7px 12px;
  font-size: 11px;
  letter-spacing: 0.5px;
  color: #f7f2e7;
  background: rgba(20, 22, 26, 0.9);
  border: 1px solid rgba(32, 217, 162, 0.5);
  border-radius: 2px;
  pointer-events: none;
}

.map.pick-on {
  cursor: crosshair;
}

.map.pick-on :deep(.leaflet-camPane-pane) {
  pointer-events: none;
}

.dot {
  display: inline-block;
  width: 7px;
  height: 7px;
  margin-right: 6px;
  border-radius: 50%;
}

.dot.traffic {
  background: #e8452c;
}

.dot.ptz {
  background: #0f9d8f;
}

.mon-list {
  flex: 1;
  min-height: 0;
  margin: 0;
  padding: 6px 0 18px;
  overflow-y: auto;
  list-style: none;
  scrollbar-width: thin;
  scrollbar-color: rgba(230, 223, 209, 0.2) transparent;
}

.mon-list::-webkit-scrollbar {
  width: 3px;
}

.mon-list::-webkit-scrollbar-thumb {
  background: rgba(230, 223, 209, 0.2);
}

.mon-list > li {
  border-bottom: 1px solid rgba(230, 223, 209, 0.07);
}

.mon-list > li.on {
  background: rgba(32, 217, 162, 0.07);
}

.mon-row {
  display: grid;
  grid-template-columns: 20px 1fr auto;
  grid-template-areas:
    'no name count'
    'no road count';
  align-items: center;
  gap: 3px 8px;
  box-sizing: border-box;
  width: 100%;
  padding: 10px 20px 10px 18px;
  font-family: inherit;
  text-align: left;
  color: inherit;
  background: none;
  border: 0;
  border-left: 2px solid transparent;
  cursor: pointer;
  transition: background 0.18s, border-color 0.18s;
}

.mon-row:hover {
  background: rgba(255, 255, 255, 0.04);
}

.mon-list > li.on .mon-row {
  border-left-color: #20d9a2;
}

.mon-no {
  grid-area: no;
  font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
  font-size: 10px;
  color: #6d7683;
}

.mon-name {
  grid-area: name;
  font-size: 13.5px;
  letter-spacing: 0.6px;
}

.mon-list > li.on .mon-name {
  color: #20d9a2;
}

.mon-road {
  grid-area: road;
  font-size: 10.5px;
  letter-spacing: 0.3px;
  color: #7f8894;
}

.mon-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 20px;
  height: 20px;
  padding: 0 5px;
  font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
  font-size: 11px;
  color: #d9d2c4;
  border: 1px solid rgba(230, 223, 209, 0.22);
  border-radius: 2px;
}

.mon-tools {
  grid-area: count;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.mon-edit {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 22px;
  padding: 0;
  font-size: 12px;
  line-height: 1;
  color: #8e97a5;
  background: transparent;
  border: 1px solid rgba(230, 223, 209, 0.2);
  border-radius: 2px;
  cursor: pointer;
  transition: 0.18s;
}

.mon-edit:hover {
  color: #14161a;
  background: #20d9a2;
  border-color: #20d9a2;
}

.mon-del {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 22px;
  padding: 0;
  font-size: 12px;
  line-height: 1;
  color: #8e97a5;
  background: transparent;
  border: 1px solid rgba(230, 223, 209, 0.2);
  border-radius: 2px;
  cursor: pointer;
  transition: 0.18s;
}

.mon-del:hover {
  color: #14161a;
  background: #e8452c;
  border-color: #e8452c;
}

.cam-list {
  margin: 0 0 10px;
  padding: 0 20px 2px 40px;
  list-style: none;
}

.cam-list li {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 5px 0;
  font-size: 11.5px;
  color: #aab2be;
  border-top: 1px dashed rgba(230, 223, 209, 0.08);
}

.cam-dot {
  flex: none;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  transform: translateY(-2px);
}

.cam-dot.traffic {
  background: #e8452c;
}

.cam-dot.ptz {
  background: #0f9d8f;
}

.cam-scene {
  flex: 1;
  line-height: 1.5;
  letter-spacing: 0.3px;
}

.cam-dir {
  flex: none;
  font-size: 11px;
  font-weight: 500;
  color: #e6dfd1;
}

.rail-open,
.mon-toggle {
  position: absolute;
  top: 26px;
  z-index: 45;
  display: inline-flex;
  align-items: center;
  padding: 6px 12px;
  font-family: inherit;
  font-size: 10.5px;
  letter-spacing: 1px;
  color: var(--ink);
  background: rgba(249, 245, 237, 0.94);
  border: 1px solid rgba(52, 40, 28, 0.25);
  border-radius: 2px;
  cursor: pointer;
  box-shadow: 0 2px 10px rgba(52, 40, 28, 0.1);
}

.rail-open {
  left: 26px;
}

.mon-toggle {
  right: 74px;
}

/* ---------- 监控点位标记 ---------- */
:deep(.cam-point) {
  background: transparent;
  border: 0;
}

:deep(.cam-point svg) {
  display: block;
  overflow: visible;
}

:deep(.cam-ring) {
  transform-origin: 32px 32px;
  animation: cam-pulse 2.2s ease-out infinite;
}

@keyframes cam-pulse {
  0% {
    opacity: 0.9;
    transform: scale(0.86);
  }
  70% {
    opacity: 0;
    transform: scale(1.3);
  }
  100% {
    opacity: 0;
  }
}

:deep(.cam-tip) {
  padding: 3px 7px;
  font-size: 11px;
  letter-spacing: 0.5px;
  color: #e6dfd1;
  background: rgba(20, 22, 26, 0.94);
  border: 1px solid rgba(32, 217, 162, 0.35);
  border-radius: 2px;
  box-shadow: 0 3px 12px rgba(0, 0, 0, 0.25);
}

:deep(.cam-tip::before) {
  border-top-color: rgba(32, 217, 162, 0.35);
}

/* ---------- 点位上方白色信息卡 ---------- */
:deep(.point-card-popup .leaflet-popup-content-wrapper) {
  padding: 0;
  color: #241f1a;
  background: #fffefb;
  border: 1px solid rgba(52, 40, 28, 0.2);
  border-radius: 3px;
  box-shadow:
    0 16px 38px rgba(36, 31, 26, 0.24),
    0 2px 6px rgba(36, 31, 26, 0.1);
}

:deep(.point-card-popup .leaflet-popup-content) {
  margin: 0;
  width: auto !important;
  line-height: 1.5;
}

:deep(.point-card-popup .leaflet-popup-tip) {
  background: #fffefb;
  box-shadow: none;
}

:deep(.point-card) {
  position: relative;
  min-width: 240px;
  max-width: 320px;
  padding: 14px 16px 12px;
  text-align: left;
}

:deep(.pc-close) {
  position: absolute;
  top: 7px;
  right: 7px;
  width: 22px;
  height: 22px;
  padding: 0;
  font-size: 16px;
  line-height: 1;
  color: #9a9082;
  background: transparent;
  border: 0;
  cursor: pointer;
}

:deep(.pc-close:hover) {
  color: #b23a2f;
}

:deep(.pc-kicker) {
  margin: 0 0 6px;
  font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
  font-size: 9px;
  letter-spacing: 1.6px;
  color: #0f9d8f;
}

:deep(.pc-title) {
  margin: 0;
  font-family: 'Songti SC', 'STSong', 'Noto Serif SC', 'Source Han Serif SC', 'SimSun', serif;
  font-size: 19px;
  font-weight: 600;
  letter-spacing: 1px;
  color: #241f1a;
}

:deep(.pc-road) {
  margin: 4px 0 0;
  font-size: 11px;
  letter-spacing: 0.3px;
  color: #6b5f51;
}

:deep(.pc-list) {
  max-height: 216px;
  margin: 10px 0 0;
  padding: 7px 0 0;
  overflow-y: auto;
  list-style: none;
  border-top: 1px solid rgba(52, 40, 28, 0.14);
}

:deep(.pc-cam) {
  display: flex;
  gap: 8px;
  padding: 7px 0;
  border-bottom: 1px dashed rgba(52, 40, 28, 0.1);
}

:deep(.pc-cam:last-child) {
  padding-bottom: 0;
  border-bottom: 0;
}

:deep(.pc-dot) {
  flex: none;
  width: 7px;
  height: 7px;
  margin-top: 5px;
  border-radius: 50%;
}

:deep(.pc-dot.traffic) {
  background: #e8452c;
}

:deep(.pc-dot.ptz) {
  background: #0f9d8f;
}

:deep(.pc-cam-main) {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

:deep(.pc-scene) {
  font-size: 11.5px;
  color: #2f2921;
  word-break: break-all;
}

:deep(.pc-meta) {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
  font-size: 9.5px;
  letter-spacing: 0.4px;
  color: #8a8072;
}

:deep(.pc-bearing) {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  color: #23475e;
}

:deep(.pc-arrow) {
  display: inline-block;
  flex: none;
}

@media (max-width: 1180px) {
  .monitor {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    z-index: 40;
    width: 300px;
    transform: translateX(100%);
    transition: transform 0.32s ease;
    box-shadow: -10px 0 30px rgba(20, 22, 26, 0.22);
  }

  .monitor.open {
    transform: none;
  }

  .monitor.is-closed {
    margin-right: 0;
  }
}

@media (max-width: 768px) {
  .atlas {
    height: 100%;
    height: 100dvh;
    flex-direction: row;
  }

  /* 图鉴改为左侧抽屉，不再压占地图高度 */
  .rail {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    z-index: 60;
    width: min(86vw, 340px);
    height: 100%;
    flex-shrink: 0;
    padding: 20px 18px 16px;
    overflow: hidden;
    border-right: 1px solid var(--hairline);
    border-bottom: 0;
    background: linear-gradient(180deg, rgba(255, 252, 245, 0.985), rgba(236, 229, 216, 0.985));
    box-shadow: 20px 0 44px rgba(36, 31, 26, 0.26);
    transform: translateX(0);
    transition: transform 0.3s ease;
  }

  .rail.is-closed {
    display: flex;
    margin-left: 0;
    transform: translateX(-104%);
    pointer-events: none;
  }

  .rail-scrim {
    display: block;
    position: absolute;
    inset: 0;
    z-index: 55;
    background: rgba(20, 22, 26, 0.4);
    backdrop-filter: blur(1.5px);
  }

  .rail-close {
    top: 14px;
    right: 16px;
    height: 34px;
    padding: 0 12px;
    font-size: 11.5px;
  }

  .rail-head {
    padding-bottom: 14px;
  }

  .title {
    font-size: 34px;
  }

  .subtitle {
    margin-top: 8px;
    letter-spacing: 3px;
  }

  .stats {
    padding: 14px 0 12px;
  }

  .stat b {
    font-size: 28px;
  }

  .index {
    display: block;
    padding-top: 14px;
    overscroll-behavior: contain;
    -webkit-overflow-scrolling: touch;
  }

  .rail-foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding-top: 12px;
  }

  .switch {
    margin-bottom: 0;
  }

  .foot-actions {
    flex: 1;
    min-width: 0;
  }

  .foot-actions > span {
    display: none;
  }

  .foot-buttons {
    margin-left: auto;
  }

  .stage {
    flex: 1;
    min-width: 0;
    min-height: 0;
  }

  /* 顶部一行：图鉴按钮 | 紧凑搜索框 | 点位清单按钮 */
  .rail-open,
  .mon-toggle {
    top: 10px;
    bottom: auto;
    z-index: 52;
    height: 40px;
    padding: 0 12px;
    font-size: 12px;
    letter-spacing: 0.5px;
  }

  .rail-open {
    right: auto;
    left: 10px;
  }

  .mon-toggle {
    right: 10px;
    left: auto;
  }

  .search {
    top: 10px;
    right: 90px;
    left: 64px;
    z-index: 51;
    width: auto;
    transform: none;
  }

  .search-box {
    height: 40px;
    padding: 0 10px;
    gap: 7px;
  }

  .search-box input {
    font-size: 16px;
  }

  .search-clear {
    width: 26px;
    height: 26px;
    font-size: 17px;
  }

  .search-results {
    right: -84px;
    left: -58px;
    max-height: 46dvh;
  }

  .search-item {
    min-height: 50px;
  }

  :deep(.leaflet-top.leaflet-right) {
    top: 60px;
    right: 8px;
  }

  :deep(.leaflet-control-zoom a) {
    width: 36px;
    height: 36px;
    line-height: 35px;
    font-size: 18px;
  }

  /* 点位清单改为底部抽屉 */
  .monitor {
    position: absolute;
    top: auto;
    right: 0;
    bottom: 0;
    left: 0;
    z-index: 46;
    width: auto;
    height: 62vh;
    height: 62dvh;
    max-height: calc(100% - 64px);
    border-top: 1px solid rgba(0, 0, 0, 0.5);
    border-left: 0;
    border-radius: 12px 12px 0 0;
    box-shadow: 0 -16px 40px rgba(20, 22, 26, 0.36);
    transform: translateY(105%);
    transition: transform 0.3s ease;
  }

  .monitor.open {
    transform: translateY(0);
  }

  .monitor.is-closed {
    margin-right: 0;
  }

  .mon-head {
    padding: 18px 16px 10px;
  }

  .mon-head::before {
    content: '';
    position: absolute;
    top: 6px;
    left: 50%;
    width: 42px;
    height: 4px;
    margin-left: -21px;
    border-radius: 99px;
    background: rgba(230, 223, 209, 0.28);
  }

  .mon-eyebrow {
    margin-bottom: 4px;
    font-size: 9px;
  }

  .mon-head h2 {
    font-size: 19px;
    letter-spacing: 1.2px;
  }

  .mon-add {
    top: 14px;
    right: 70px;
    height: 34px;
    padding: 0 12px;
    font-size: 11.5px;
  }

  .mon-close {
    top: 14px;
    right: 14px;
    height: 34px;
    padding: 0 11px;
    font-size: 11px;
  }

  .mon-meta {
    gap: 10px;
    margin-top: 5px;
    font-size: 10px;
  }

  .mon-legend {
    gap: 12px;
    margin-top: 4px;
    font-size: 10px;
  }

  .mon-actions {
    margin-top: 8px;
    gap: 6px;
    overflow-x: auto;
    scrollbar-width: none;
  }

  .mon-act {
    flex: none;
    height: 36px;
    padding: 0 13px;
    font-size: 12px;
  }

  .mon-install {
    display: inline-flex;
    align-items: center;
  }

  .mon-save {
    margin-top: 6px;
    overflow: hidden;
    font-size: 9.5px;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .mon-list {
    padding: 4px 0 12px;
    overscroll-behavior: contain;
    -webkit-overflow-scrolling: touch;
  }

  .mon-row {
    min-height: 50px;
    padding: 10px 14px 10px 16px;
  }

  .mon-name {
    font-size: 14px;
  }

  .mon-road {
    font-size: 10.5px;
  }

  .mon-edit,
  .mon-del {
    width: 34px;
    height: 34px;
    font-size: 14px;
  }

  .cam-list {
    padding: 0 14px 4px 36px;
  }

  .cam-list li {
    padding: 7px 0;
    font-size: 12px;
  }

  /* 点位上方白卡 */
  :deep(.point-card) {
    width: min(76vw, 300px);
    min-width: 0;
    max-width: none;
    padding: 13px 14px 10px;
  }

  :deep(.pc-list) {
    max-height: 32dvh;
  }

  :deep(.pc-close) {
    top: 3px;
    right: 3px;
    width: 32px;
    height: 32px;
    font-size: 19px;
  }

  :deep(.pc-title) {
    font-size: 18px;
  }

  .pick-hint {
    right: 12px;
    bottom: 68px;
    left: 12px;
    font-size: 10.5px;
    line-height: 1.5;
  }

  .edition,
  .compass {
    display: none;
  }
}
</style>
