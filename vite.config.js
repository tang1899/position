import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, URL } from 'node:url'

import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import vueJsx from '@vitejs/plugin-vue-jsx'
import vueDevTools from 'vite-plugin-vue-devtools'

const DATA_FILE = fileURLToPath(new URL('./src/assets/geo/monitor-points.json', import.meta.url))
const TMP_DIR = fileURLToPath(new URL('./node_modules/.cache/monitor-data', import.meta.url))
const API_ROUTE = '/api/monitor-points'
const MAX_BODY_BYTES = 5 * 1024 * 1024

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体超过 5MB'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

// 只接受约定的字段，避免把任意内容写进数据文件
function normalizePoints(input) {
  if (!Array.isArray(input)) throw new Error('points 必须是数组')
  return input.map((item, index) => {
    const lng = Number(item?.lng)
    const lat = Number(item?.lat)
    if (
      typeof item?.name !== 'string' ||
      !item.name.trim() ||
      !Number.isFinite(lng) ||
      !Number.isFinite(lat) ||
      !Array.isArray(item.cameras)
    ) {
      throw new Error(`第 ${index + 1} 个点位格式不正确`)
    }
    return {
      id: String(item.id || `${item.name}-${index + 1}`),
      name: item.name,
      roads: typeof item.roads === 'string' ? item.roads : '',
      lng,
      lat,
      cameras: item.cameras.map((cam) => ({
        scene: typeof cam?.scene === 'string' ? cam.scene : '',
        type: cam?.type === 'ptz' ? 'ptz' : 'traffic',
        dir: typeof cam?.dir === 'string' ? cam.dir : '东向',
        bearing: Number.isFinite(Number(cam?.bearing)) ? Number(cam.bearing) : 0,
      })),
    }
  })
}

// 开发期把页面上的增删改写回 src/assets/geo/monitor-points.json
function monitorDataPersistPlugin() {
  return {
    name: 'monitor-data-persist',
    apply: 'serve',
    // 写回数据文件不应触发 HMR / 整页刷新，前端状态已在内存和 localStorage 中
    handleHotUpdate({ file }) {
      if (path.resolve(file) === path.resolve(DATA_FILE)) return []
    },
    configureServer(server) {
      server.middlewares.use(API_ROUTE, async (req, res) => {
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.setHeader('Cache-Control', 'no-store')

        if (req.method === 'GET') {
          try {
            res.end(await fs.readFile(DATA_FILE, 'utf8'))
          } catch (error) {
            res.statusCode = 500
            res.end(JSON.stringify({ ok: false, message: error.message }))
          }
          return
        }

        if (req.method !== 'POST') {
          res.statusCode = 405
          res.setHeader('Allow', 'GET, POST')
          res.end(JSON.stringify({ ok: false, message: '只支持 GET / POST' }))
          return
        }

        try {
          const body = await readJsonBody(req)
          const points = normalizePoints(body.points)

          let current = {}
          try {
            current = JSON.parse(await fs.readFile(DATA_FILE, 'utf8'))
          } catch {
            current = {}
          }

          const savedAt = new Date().toISOString()
          const next = {
            source: typeof current.source === 'string' ? current.source : '道路监控点位清单.xlsx',
            updatedAt: savedAt,
            total: {
              intersections: points.length,
              cameras: points.reduce((sum, item) => sum + item.cameras.length, 0),
            },
            intersections: points,
          }

          // 先写临时文件再重命名，避免写到一半中断把原文件弄坏
          await fs.mkdir(TMP_DIR, { recursive: true })
          const tmpFile = path.join(TMP_DIR, 'monitor-points.json')
          await fs.writeFile(tmpFile, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
          await fs.rename(tmpFile, DATA_FILE)

          server.config.logger.info(
            `[monitor-data] 已写入 ${path.relative(server.config.root, DATA_FILE)}（${points.length} 个路口）`,
          )
          res.end(
            JSON.stringify({
              ok: true,
              savedAt,
              file: 'src/assets/geo/monitor-points.json',
              total: next.total,
            }),
          )
        } catch (error) {
          res.statusCode = 400
          res.end(JSON.stringify({ ok: false, message: error.message }))
        }
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  base: process.env.VITE_BASE || '/',
  plugins: [
    vue(),
    vueJsx(),
    vueDevTools(),
    monitorDataPersistPlugin(),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
})
