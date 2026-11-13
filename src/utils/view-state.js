// 地图页 / 表单页之间的视图约定
// 表单点「确认」保存后返回地图：图鉴收起、点位清单展开
let pendingAfterSave = false

export function markSavedFromForm() {
  pendingAfterSave = true
}

// 读取并清空标记，保证只生效一次
export function consumeSavedFromForm() {
  const value = pendingAfterSave
  pendingAfterSave = false
  return value
}
