<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useMonitorStore } from '@/stores/monitor'
import { geocodeAddress } from '@/utils/geocode'
import { markSavedFromForm } from '@/utils/view-state'

const route = useRoute()
const router = useRouter()
const store = useMonitorStore()

const editingId = computed(() => (Array.isArray(route.params.id) ? route.params.id[0] : route.params.id))
const isEditing = computed(() => Boolean(editingId.value))

const DIR_OPTIONS = [
  { label: '东', bearing: 90 },
  { label: '南', bearing: 180 },
  { label: '西', bearing: 270 },
  { label: '北', bearing: 0 },
  { label: '东北', bearing: 45 },
  { label: '东南', bearing: 135 },
  { label: '西南', bearing: 225 },
  { label: '西北', bearing: 315 },
]

const form = reactive({
  name: '',
  roads: '',
  lat: '',
  lng: '',
  cameras: [{ scene: '', dir: '东', type: 'traffic', bearing: 90 }],
})

const error = ref('')
const geoStatus = ref('')
const coordsTouched = ref(false)
let geoTimer = null
let autoReady = false

function directionValue(dir) {
  const label = String(dir || '').replace(/向$/, '')
  return DIR_OPTIONS.some((item) => item.label === label) ? label : '东'
}

function bearingFor(dir) {
  const label = directionValue(dir)
  return DIR_OPTIONS.find((item) => item.label === label)?.bearing ?? 90
}

function dirWithSuffix(dir) {
  const label = directionValue(dir)
  return `${label}向`
}

const clampBearing = (bearing) => (((Number(bearing) || 0) % 360) + 360) % 360

// 弧度角度按正北为 0°，顺时针递增
function bearingToDir(bearing) {
  const labels = ['北', '东北', '东', '东南', '南', '西南', '西', '西北']
  return labels[Math.round(clampBearing(bearing) / 45) % 8]
}

function syncBearing(cam) {
  cam.bearing = bearingFor(cam.dir)
}

function updateBearingFromPointer(event, cam) {
  const rect = event.currentTarget.getBoundingClientRect()
  const dx = event.clientX - (rect.left + rect.width / 2)
  const dy = event.clientY - (rect.top + rect.height / 2)
  if (!dx && !dy) return
  cam.bearing = Math.round(clampBearing((Math.atan2(dx, -dy) * 180) / Math.PI))
  cam.dir = bearingToDir(cam.bearing)
}

function startDirDrag(event, cam) {
  event.preventDefault()
  event.currentTarget.setPointerCapture(event.pointerId)
  updateBearingFromPointer(event, cam)
}

function moveDirDrag(event, cam) {
  if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
  updateBearingFromPointer(event, cam)
}

function loadEditingPoint() {
  const point = store.points.find((item) => item.id === editingId.value)
  if (!point) {
    router.replace('/')
    return
  }
  form.name = point.name
  form.roads = point.roads
  form.lat = String(point.lat)
  form.lng = String(point.lng)
  form.cameras = point.cameras.map((cam) => {
    const bearing = Number.isFinite(Number(cam.bearing)) ? clampBearing(cam.bearing) : bearingFor(cam.dir)
    return {
      scene: cam.scene,
      dir: bearingToDir(bearing),
      type: cam.type || 'traffic',
      bearing,
    }
  })
  coordsTouched.value = true
}

function applyQueryPrefill() {
  const { lat, lng, name, roads } = route.query
  if (Number.isFinite(Number(lat)) && lat !== '') form.lat = String(lat)
  if (Number.isFinite(Number(lng)) && lng !== '') form.lng = String(lng)
  if (typeof name === 'string') form.name = name
  if (typeof roads === 'string') form.roads = roads
  if (form.lat && form.lng) coordsTouched.value = true
}

function addCameraRow() {
  form.cameras.push({ scene: '', dir: '东', type: 'traffic', bearing: 90 })
}

function removeCameraRow(index) {
  if (form.cameras.length === 1) {
    form.cameras[0] = { scene: '', dir: '东', type: 'traffic', bearing: 90 }
    return
  }
  form.cameras.splice(index, 1)
}

function markCoordsTouched() {
  coordsTouched.value = true
}

function geocodeQuery() {
  return form.roads.trim() || form.name.trim()
}

async function resolveGeocode(force = false) {
  const query = geocodeQuery()
  if (!query) {
    geoStatus.value = ''
    return
  }
  if (coordsTouched.value && !force) return

  geoStatus.value = '识别中…'
  const result = await geocodeAddress(query)
  if (!result) {
    geoStatus.value = '未识别到坐标，请检查地址或手动填写'
    return
  }
  form.lat = String(result.lat.toFixed(6))
  form.lng = String(result.lng.toFixed(6))
  geoStatus.value = `已识别坐标：${form.lat}, ${form.lng}`
}

function scheduleGeocode() {
  if (!autoReady) return
  clearTimeout(geoTimer)
  geoTimer = setTimeout(() => resolveGeocode(false), 650)
}

function manualGeocode() {
  resolveGeocode(true)
}

function goBack() {
  router.push('/')
}

function submit() {
  error.value = ''
  if (!form.name.trim()) {
    error.value = '请填写路口名称'
    return
  }
  if (form.cameras.some((cam) => !cam.scene.trim())) {
    error.value = '请完整填写每台相机的名称'
    return
  }
  const lat = Number(form.lat)
  const lng = Number(form.lng)
  if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180) {
    error.value = '请填写有效的地图坐标'
    return
  }

  const cameras = form.cameras.map((cam) => ({
    scene: cam.scene.trim(),
    type: cam.type || 'traffic',
    dir: dirWithSuffix(bearingToDir(cam.bearing)),
    bearing: Math.round(clampBearing(cam.bearing)),
  }))

  if (isEditing.value) {
    store.updatePoint(editingId.value, {
      name: form.name.trim(),
      roads: form.roads.trim() || form.name.trim(),
      lat,
      lng,
      cameras,
    })
  } else {
    store.addPoint({
      name: form.name.trim(),
      roads: form.roads.trim() || form.name.trim(),
      lat,
      lng,
      cameras,
    })
  }

  // 回到地图时保持：图鉴收起、点位清单展开
  markSavedFromForm()
  router.push('/')
}

onMounted(() => {
  if (isEditing.value) loadEditingPoint()
  else applyQueryPrefill()
  setTimeout(() => {
    autoReady = true
  }, 0)
})

watch(
  () => [form.name, form.roads],
  () => scheduleGeocode(),
)

onBeforeUnmount(() => {
  clearTimeout(geoTimer)
})
</script>

<template>
  <div class="form-page">
    <header class="form-head">
      <button type="button" class="back" @click="goBack">← 返回点位图</button>
      <div>
        <p class="eyebrow">TRAFFIC CAM · MONITOR POINT</p>
        <h1>{{ isEditing ? '修改监控点位' : '添加监控点位' }}</h1>
      </div>
    </header>

    <form class="form-card" @submit.prevent="submit">
      <section class="field-group">
        <h2>点位信息</h2>
        <div class="grid two">
          <label class="field">
            <span>路口</span>
            <input v-model="form.name" type="text" placeholder="如：示例路口 A" />
          </label>
          <label class="field">
            <span>道路交叉</span>
            <input v-model="form.roads" type="text" placeholder="如：泉秀街 × 刺桐路" />
          </label>
        </div>
        <div class="grid two">
          <label class="field">
            <span>纬度</span>
            <input v-model="form.lat" type="number" step="0.00001" placeholder="24.89014" @input="markCoordsTouched" />
          </label>
          <label class="field">
            <span>经度</span>
            <input v-model="form.lng" type="number" step="0.00001" placeholder="118.60084" @input="markCoordsTouched" />
          </label>
        </div>
        <div class="geo-row">
          <button type="button" class="geo-btn" @click="manualGeocode">识别坐标</button>
          <span v-if="geoStatus" class="geo-status" :class="{ ok: geoStatus.startsWith('已识别') }">{{ geoStatus }}</span>
        </div>
      </section>

      <section class="field-group">
        <div class="group-head">
          <h2>相机信息</h2>
          <button type="button" class="ghost" @click="addCameraRow">+ 添加相机</button>
        </div>

        <div v-for="(cam, index) in form.cameras" :key="index" class="cam-row">
          <label class="field cam-scene-field">
            <span>相机名称</span>
            <input v-model="cam.scene" type="text" placeholder="如：泉秀街刺桐路交通" />
          </label>
          <label class="field cam-dir-field">
            <span>方位</span>
            <select v-model="cam.dir" @change="syncBearing(cam)">
              <option v-for="option in DIR_OPTIONS" :key="option.label" :value="option.label">
                {{ option.label }}向
              </option>
            </select>
          </label>
          <div
            class="compass"
            title="拖动指针调整朝向"
            @pointerdown="startDirDrag($event, cam)"
            @pointermove="moveDirDrag($event, cam)"
          >
            <svg viewBox="0 0 80 80" aria-hidden="true">
              <circle cx="40" cy="40" r="31" fill="none" stroke="rgba(52, 40, 28, 0.28)" stroke-width="1" />
              <circle cx="40" cy="40" r="24" fill="none" stroke="rgba(52, 40, 28, 0.14)" stroke-width="1" />
              <text x="40" y="10" text-anchor="middle">N</text>
              <g :style="{ transform: `rotate(${cam.bearing}deg)`, transformOrigin: '40px 40px' }">
                <line x1="40" y1="66" x2="40" y2="24" stroke="#b23a2f" stroke-width="2.4" stroke-linecap="round" />
                <path d="M40 14 L46 27 L34 27 Z" fill="#b23a2f" />
              </g>
              <circle cx="40" cy="40" r="4" fill="#241f1a" />
            </svg>
            <span class="compass-val">{{ Math.round(cam.bearing) }}°</span>
          </div>
          <button
            type="button"
            class="remove-cam"
            :disabled="form.cameras.length === 1"
            title="删除相机"
            @click="removeCameraRow(index)"
          >
            ×
          </button>
        </div>
      </section>

      <p v-if="error" class="error">{{ error }}</p>

      <footer class="form-actions">
        <button type="button" class="cancel" @click="goBack">取消</button>
        <button type="submit" class="submit">{{ isEditing ? '保存修改' : '确认添加' }}</button>
      </footer>
    </form>
  </div>
</template>

<style scoped>
.form-page {
  min-height: 100%;
  padding: 28px clamp(20px, 5vw, 64px) 48px;
  background-color: #f1ebdf;
  background-image:
    radial-gradient(circle at 12% 8%, rgba(178, 58, 47, 0.06), transparent 42%),
    radial-gradient(circle at 90% 90%, rgba(35, 71, 94, 0.08), transparent 46%),
    url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.04'/%3E%3C/svg%3E");
  color: #241f1a;
  font-family: 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif;
}

.form-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 20px;
  max-width: 760px;
  margin: 0 auto 24px;
}

.back {
  padding: 7px 12px;
  font-family: inherit;
  font-size: 11px;
  letter-spacing: 1px;
  color: #6b5f51;
  background: rgba(255, 252, 245, 0.65);
  border: 1px solid rgba(52, 40, 28, 0.24);
  border-radius: 2px;
  cursor: pointer;
  white-space: nowrap;
  transition: 0.18s;
}

.back:hover {
  color: #f1ebdf;
  background: #241f1a;
  border-color: #241f1a;
}

.eyebrow {
  margin: 0 0 8px;
  font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
  font-size: 9px;
  letter-spacing: 2.4px;
  color: #b23a2f;
  text-align: right;
}

.form-head h1 {
  margin: 0;
  font-family: 'Songti SC', 'STSong', 'Noto Serif SC', 'Source Han Serif SC', 'SimSun', serif;
  font-size: 28px;
  letter-spacing: 2px;
}

.form-card {
  max-width: 760px;
  margin: 0 auto;
  padding: 26px 28px 28px;
  background: rgba(255, 252, 245, 0.72);
  border: 1px solid rgba(52, 40, 28, 0.18);
  box-shadow: 0 8px 30px rgba(52, 40, 28, 0.08);
}

.field-group + .field-group {
  margin-top: 26px;
  padding-top: 24px;
  border-top: 1px solid rgba(52, 40, 28, 0.16);
}

.field-group h2,
.group-head h2 {
  margin: 0 0 14px;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 2px;
  color: #3c3229;
}

.group-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.group-head h2 {
  margin-bottom: 0;
}

.grid {
  display: grid;
  gap: 14px;
}

.grid.two {
  grid-template-columns: 1fr 1fr;
}

.grid.two + .grid.two {
  margin-top: 14px;
}

.geo-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 12px;
  min-height: 28px;
}

.geo-btn {
  padding: 6px 12px;
  font-family: inherit;
  font-size: 10.5px;
  letter-spacing: 1px;
  color: #23475e;
  background: transparent;
  border: 1px solid rgba(35, 71, 94, 0.45);
  border-radius: 2px;
  cursor: pointer;
  white-space: nowrap;
  transition: 0.18s;
}

.geo-btn:hover {
  color: #f1ebdf;
  background: #23475e;
}

.geo-status {
  flex: 1;
  min-width: 0;
  font-size: 10.5px;
  line-height: 1.5;
  color: #6b5f51;
}

.geo-status.ok {
  color: #0f7d68;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 7px;
  min-width: 0;
}

.field > span {
  font-size: 11px;
  letter-spacing: 1px;
  color: #6b5f51;
}

.field input,
.field select {
  height: 38px;
  padding: 0 10px;
  font-family: inherit;
  font-size: 13px;
  color: #241f1a;
  background: rgba(241, 235, 223, 0.85);
  border: 1px solid rgba(52, 40, 28, 0.26);
  border-radius: 2px;
  outline: none;
  transition: 0.18s;
}

.field input:focus,
.field select:focus {
  border-color: #b23a2f;
  background: #fffdf7;
  box-shadow: 0 0 0 2px rgba(178, 58, 47, 0.1);
}

.cam-row {
  display: grid;
  grid-template-columns: 1fr 120px 92px 34px;
  align-items: end;
  gap: 12px;
  padding: 12px 0;
  border-bottom: 1px dashed rgba(52, 40, 28, 0.16);
}

.compass {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-end;
  height: 54px;
  cursor: grab;
  touch-action: none;
  user-select: none;
}

.compass:active {
  cursor: grabbing;
}

.compass svg {
  width: 56px;
  height: 56px;
  margin-bottom: -10px;
}

.compass text {
  font-size: 8px;
  letter-spacing: 0.5px;
  fill: rgba(52, 40, 28, 0.5);
}

.compass-val {
  position: relative;
  z-index: 1;
  font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
  font-size: 9px;
  color: #6b5f51;
}

.cam-row:first-of-type {
  padding-top: 0;
}

.ghost {
  padding: 5px 10px;
  font-family: inherit;
  font-size: 10.5px;
  letter-spacing: 0.5px;
  color: #b23a2f;
  background: transparent;
  border: 1px solid rgba(178, 58, 47, 0.5);
  border-radius: 2px;
  cursor: pointer;
  transition: 0.18s;
}

.ghost:hover {
  color: #f1ebdf;
  background: #b23a2f;
}

.remove-cam {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 38px;
  font-size: 18px;
  color: #6b5f51;
  background: transparent;
  border: 1px solid rgba(52, 40, 28, 0.2);
  border-radius: 2px;
  cursor: pointer;
  transition: 0.18s;
}

.remove-cam:hover:not(:disabled) {
  color: #f1ebdf;
  background: #b23a2f;
  border-color: #b23a2f;
}

.remove-cam:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

.error {
  margin: 20px 0 0;
  font-size: 11px;
  color: #b23a2f;
}

.form-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 26px;
}

.cancel,
.submit {
  padding: 9px 18px;
  font-family: inherit;
  font-size: 12px;
  letter-spacing: 1px;
  border-radius: 2px;
  cursor: pointer;
  transition: 0.18s;
}

.cancel {
  color: #6b5f51;
  background: transparent;
  border: 1px solid rgba(52, 40, 28, 0.3);
}

.cancel:hover {
  color: #241f1a;
  border-color: #241f1a;
}

.submit {
  color: #f1ebdf;
  background: #b23a2f;
  border: 1px solid #b23a2f;
}

.submit:hover {
  background: #8f2e26;
  border-color: #8f2e26;
}

@media (max-width: 640px) {
  .form-page {
    min-height: 100%;
    min-height: 100dvh;
    padding: 18px 14px 28px;
  }

  .form-head {
    align-items: flex-start;
    flex-direction: column;
    gap: 14px;
    margin-bottom: 16px;
  }

  .back {
    min-height: 40px;
    padding: 8px 14px;
    font-size: 12px;
  }

  .eyebrow {
    text-align: left;
  }

  .form-head h1 {
    font-size: 24px;
  }

  .form-card {
    padding: 18px 14px 20px;
  }

  .grid.two {
    grid-template-columns: 1fr;
  }

  .field input,
  .field select {
    height: 46px;
    padding: 0 12px;
    font-size: 16px;
  }

  .field > span {
    font-size: 12px;
  }

  .geo-btn {
    min-height: 40px;
    padding: 0 14px;
    font-size: 12px;
  }

  .geo-row {
    flex-wrap: wrap;
  }

  .cam-row {
    grid-template-columns: minmax(0, 1fr) 92px;
    grid-template-areas:
      'scene scene'
      'dir compass'
      'remove remove';
    gap: 10px 12px;
    padding: 14px 0;
  }

  .cam-scene-field {
    grid-area: scene;
  }

  .cam-dir-field {
    grid-area: dir;
  }

  .compass {
    grid-area: compass;
    flex-direction: row;
    align-items: center;
    justify-content: flex-start;
    gap: 10px;
    height: 84px;
  }

  .compass svg {
    width: 68px;
    height: 68px;
    margin-bottom: 0;
  }

  .compass-val {
    font-size: 11px;
  }

  .remove-cam {
    grid-area: remove;
    width: 100%;
    height: 44px;
    font-size: 20px;
  }

  .ghost {
    min-height: 38px;
    padding: 0 12px;
  }

  .form-actions {
    position: sticky;
    bottom: 0;
    z-index: 5;
    margin-top: 20px;
    padding: 12px 0 6px;
    background: linear-gradient(180deg, rgba(250, 246, 238, 0), rgba(250, 246, 238, 0.96) 28%);
  }

  .cancel,
  .submit {
    flex: 1;
    min-height: 46px;
    font-size: 14px;
  }
}
</style>
