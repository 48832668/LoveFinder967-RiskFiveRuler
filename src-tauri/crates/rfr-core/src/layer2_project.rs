//! Layer 2 — 工程文档处理（funcHANDLE）。
//!
//! 校验、保存、读取 .rfr 工程，以及本机「最近打开」列表。
//! 只调用 layer1，不碰 UI / IPC 细节。

use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::layer1_env;
use crate::layer1_fsio;

const RECENT_LIMIT: usize = 8;
const RECENT_FILE: &str = "recent.json";

/// 校验工程 JSON。返回解析后的 Value，调用方不用再 parse 一次。
///
/// 这里只校验「结构边界」：deviceId / configs / settings 的类型。
/// 外设参数的业务校验仍在语义层（前端 + 器件包），避免两套规则漂移。
pub fn validate(json: &str) -> Result<Value, String> {
    if json.len() as u64 > layer1_fsio::MAX_PROJECT_BYTES {
        return Err("工程文件过大".into());
    }
    let value: Value =
        serde_json::from_str(json).map_err(|e| format!("工程文件不是合法 JSON: {e}"))?;
    let obj = value
        .as_object()
        .ok_or_else(|| "工程文件根节点必须是对象".to_string())?;

    let device = obj
        .get("deviceId")
        .and_then(Value::as_str)
        .ok_or_else(|| "工程缺少 deviceId".to_string())?;
    if device.is_empty()
        || device.len() > 64
        || !device
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err(format!("非法 deviceId: {device}"));
    }

    if !obj.get("configs").map(Value::is_object).unwrap_or(false) {
        return Err("工程缺少 configs 对象".into());
    }
    if !obj.get("settings").map(Value::is_object).unwrap_or(false) {
        return Err("工程缺少 settings 对象".into());
    }
    if let Some(gpio) = obj.get("gpio") {
        if !gpio.is_object() {
            return Err("gpio 必须是对象".into());
        }
    }
    if let Some(clock) = obj.get("clock") {
        if !clock.is_object() {
            return Err("clock 必须是对象".into());
        }
    }
    Ok(value)
}

pub fn save(path: &Path, json: &str) -> Result<(), String> {
    validate(json)?;
    layer1_fsio::write_text_atomic(path, json)
}

pub fn load(path: &Path) -> Result<String, String> {
    let text = layer1_fsio::read_text(path)?;
    validate(&text)?;
    Ok(text)
}

// ───────────────────────── 最近打开 ─────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentEntry {
    pub path: String,
    pub name: String,
    pub device_id: String,
    pub at: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentInput {
    pub path: String,
    pub name: String,
    pub device_id: String,
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn recent_file() -> Result<std::path::PathBuf, String> {
    layer1_env::data_file(RECENT_FILE)
}

fn read_recent() -> Vec<RecentEntry> {
    let Ok(path) = recent_file() else {
        return Vec::new();
    };
    let Ok(text) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let mut list: Vec<RecentEntry> = serde_json::from_str(&text).unwrap_or_default();
    list.retain(|e| !e.path.trim().is_empty() && !e.name.trim().is_empty());
    list.sort_by(|a, b| b.at.cmp(&a.at));
    list.truncate(RECENT_LIMIT);
    list
}

fn write_recent(list: &[RecentEntry]) -> Result<(), String> {
    let path = recent_file()?;
    let text = serde_json::to_string_pretty(list).map_err(|e| format!("序列化失败: {e}"))?;
    layer1_fsio::write_text_atomic(&path, &text)
}

pub fn recent_load() -> Vec<RecentEntry> {
    read_recent()
}

pub fn recent_push(entry: RecentInput) -> Result<Vec<RecentEntry>, String> {
    let mut list = read_recent();
    list.retain(|e| e.path != entry.path);
    list.insert(
        0,
        RecentEntry {
            path: entry.path,
            name: entry.name,
            device_id: entry.device_id,
            at: now_millis(),
        },
    );
    list.truncate(RECENT_LIMIT);
    write_recent(&list)?;
    Ok(list)
}

pub fn recent_drop(path: &str) -> Result<Vec<RecentEntry>, String> {
    let mut list = read_recent();
    list.retain(|e| e.path != path);
    write_recent(&list)?;
    Ok(list)
}

pub fn recent_clear() -> Result<(), String> {
    let path = recent_file()?;
    if path.exists() {
        std::fs::remove_file(path).map_err(|e| format!("清除最近列表失败: {e}"))?;
    }
    Ok(())
}
