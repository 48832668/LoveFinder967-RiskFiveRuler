//! Layer 3 的「funcall」边界 —— 只做 IPC 转发。
//!
//! 每个命令都只把参数交给 layer2，然后原样返回结果。
//! 这里不写业务规则、不直接碰 `std::fs`，方便单测与替换前端。

use rfr_core::layer2_app;
use rfr_core::layer2_export;
use rfr_core::layer2_project;

#[derive(serde::Deserialize)]
pub struct FileEntry {
    pub path: String,
    pub content: String,
}

/// 保存 .rfr 工程（带结构校验 + 原子写）。
#[tauri::command]
pub fn project_save(path: String, content: String) -> Result<(), String> {
    layer2_project::save(std::path::Path::new(&path), &content)
}

/// 读取 .rfr 工程（带结构校验）。
#[tauri::command]
pub fn project_load(path: String) -> Result<String, String> {
    layer2_project::load(std::path::Path::new(&path))
}

/// 兼容旧前端：语义等同 `project_save`，但更严格（必须是工程文档）。
#[tauri::command]
pub fn write_text_file(path: String, content: String) -> Result<(), String> {
    layer2_project::save(std::path::Path::new(&path), &content)
}

/// 兼容旧前端：语义等同 `project_load`。
#[tauri::command]
pub fn read_text_file(path: String) -> Result<String, String> {
    layer2_project::load(std::path::Path::new(&path))
}

/// 导出生成的文件树（路径穿越与体积由 layer1 兜底）。
#[tauri::command]
pub fn write_tree(root: String, files: Vec<FileEntry>) -> Result<usize, String> {
    let entries = files
        .into_iter()
        .map(|f| (f.path, f.content))
        .collect::<Vec<_>>();
    layer2_export::export_tree(&root, entries)
}

#[tauri::command]
pub fn open_url(url: String) -> Result<(), String> {
    layer2_app::open_url(&url)
}

#[tauri::command]
pub fn app_info() -> Result<layer2_app::AppInfo, String> {
    layer2_app::app_info()
}

/// 读取界面偏好（exe 同目录 config.json）；不存在返回 null。
#[tauri::command]
pub fn config_read() -> Result<Option<String>, String> {
    layer2_app::config_read()
}

/// 保存界面偏好（JSON 校验 + 原子写）。
#[tauri::command]
pub fn config_write(content: String) -> Result<(), String> {
    layer2_app::config_write(&content)
}

/// 按路径读文本（设置导入）。只做大小/编码限制，不校验工程结构。
#[tauri::command]
pub fn file_read_at(path: String) -> Result<String, String> {
    layer2_app::read_text_at(std::path::Path::new(&path))
}

/// 按路径写文本（设置导出）。
#[tauri::command]
pub fn file_write_at(path: String, content: String) -> Result<(), String> {
    layer2_app::write_text_at(std::path::Path::new(&path), &content)
}

#[tauri::command]
pub fn recent_load() -> Vec<layer2_project::RecentEntry> {
    layer2_project::recent_load()
}

#[tauri::command]
pub fn recent_push(entry: layer2_project::RecentInput) -> Result<Vec<layer2_project::RecentEntry>, String> {
    layer2_project::recent_push(entry)
}

#[tauri::command]
pub fn recent_drop(path: String) -> Result<Vec<layer2_project::RecentEntry>, String> {
    layer2_project::recent_drop(&path)
}

#[tauri::command]
pub fn recent_clear() -> Result<(), String> {
    layer2_project::recent_clear()
}
