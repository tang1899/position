# 泉州路口监控 PWA

基于 Vue 3、Vite 和 Leaflet 的路网与路口监控点位管理应用，适配桌面端和手机端，可作为 PWA 安装到 Android / iPhone 主屏幕并离线使用。

> 本仓库只包含示例点位数据，不包含真实监控点位。真实数据请放在私有仓库或私有部署环境中。

## 在线演示

https://tang1899.github.io/position/

演示站点使用示例数据，页面上的修改只保存在当前浏览器的 `localStorage` 中。

## 功能

- 鲤城区 / 丰泽区主干道路网展示，横向、纵向道路分色，路名自动避让
- 路口监控点位搜索、定位、道路筛选与复位
- 点位增删改：表单录入、地图点选、地址坐标识别、相机朝向拖动
- 点位清单与图鉴栏，桌面端左右分栏，手机端左侧抽屉 + 底部抽屉
- 点击点位后在点位上方的白色信息卡中展示相机名称、类型、朝向和方位角
- 点位数据导入 / 导出 JSON
- PWA：可安装到主屏幕、离线打开、独立窗口运行

## 技术栈

- Vue 3.5 + Vite 8
- Vue Router 5 + Pinia 4
- Leaflet 1.9
- 原生 CSS（无 UI 框架）
- PWA：手写 Service Worker + Web App Manifest

## 本地运行

要求 Node `^22.18.0 || >=24.12.0`。

```sh
npm install
npm run dev
```

浏览器打开终端提示的地址，默认 `http://localhost:5173/`。

## 构建与预览

```sh
npm run build
npm run preview
```

构建产物在 `dist/`。

## PWA 与手机安装

PWA 安装要求 HTTPS（`localhost` 除外）。

- **Android Chrome**：打开 HTTPS 地址，浏览器菜单选择“安装应用”。
- **iPhone Safari**：打开 HTTPS 地址，点击分享按钮，选择“添加到主屏幕”。

仓库内置 GitHub Pages 工作流 `.github/workflows/deploy-pages.yml`，推送到 `main` 后自动构建并部署。项目部署在 `https://<用户名>.github.io/<仓库名>/` 时，构建会自动使用 `VITE_BASE=/position/`。

自建服务器部署时，需要为 SPA 路由配置回退，并让 `sw.js` 不被长期缓存：

```nginx
location / { try_files $uri $uri/ /index.html; }
location = /sw.js { add_header Cache-Control "no-cache"; }
location /assets/ { add_header Cache-Control "public, max-age=31536000, immutable"; }
```

## 数据说明

- 点位数据文件：`src/assets/geo/monitor-points.json`
- 开发模式下，页面上的增删改会通过 Vite 中间件写回该文件（`/api/monitor-points`），方便把数据修改随代码一起提交。
- 生产构建是纯静态站点，不包含写文件接口，修改会保存在浏览器 `localStorage` 中。
- 如果需要多设备共享或长期保存，请自行接入后端接口与数据库。
- 开源仓库请使用示例数据；真实监控点位、坐标和相机信息不要提交到公开仓库。

## 目录结构

```text
src/
  assets/geo/          行政区、路网、点位 JSON
  router/              路由
  stores/              点位状态与持久化
  utils/               地址解析、页面间状态标记
  views/
    MapHome.vue        地图主页（桌面/手机布局）
    MonitorForm.vue    点位新增/编辑表单
public/
  manifest.webmanifest PWA 清单
  sw.js                Service Worker
  icons/               PWA 图标
```

## License

[Apache License 2.0](./LICENSE)
