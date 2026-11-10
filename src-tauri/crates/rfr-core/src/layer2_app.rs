//! Layer 2 — 应用级动作（funcHANDLE）。
//!
//! 打开外部链接、返回应用元信息。只依赖 layer1。

use serde::Serialize;

use crate::layer1_env;
use crate::layer1_fsio;

/// 界面偏好文件（主题色 / 模式 / 引脚图图例配色），放在 exe 同目录。
pub fn config_path() -> Result<std::path::PathBuf, String> {
    Ok(layer1_env::exe_dir()?.join("config.json"))
}

/// 读取界面偏好；文件不存在时返回 None（首次启动）。
pub fn config_read() -> Result<Option<String>, String> {
    let path = config_path()?;
    if !path.exists() {
        return Ok(None);
    }
    Ok(Some(layer1_fsio::read_text(&path)?))
}

/// 写界面偏好。写入前先校验 JSON —— 这个文件用户手改得动，坏了宁可报错。
pub fn config_write(content: &str) -> Result<(), String> {
    serde_json::from_str::<serde_json::Value>(content)
        .map_err(|e| format!("config.json 不是合法 JSON: {e}"))?;
    layer1_fsio::write_text_atomic(&config_path()?, content)
}

/// 通用「按路径读文本」（设置导入用）。不做工程校验 —— 这里不是工程文档。
pub fn read_text_at(path: &std::path::Path) -> Result<String, String> {
    layer1_fsio::read_text(path)
}

/// 通用「按路径写文本」（设置导出用）。原子写，失败不留半个文件。
pub fn write_text_at(path: &std::path::Path, content: &str) -> Result<(), String> {
    layer1_fsio::write_text_atomic(path, content)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub name: String,
    pub version: String,
    pub identifier: String,
    pub data_dir: String,
}

pub fn app_info() -> Result<AppInfo, String> {
    let data_dir = layer1_env::app_data_dir()?;
    Ok(AppInfo {
        name: "RiskFiveRuler".into(),
        version: env!("CARGO_PKG_VERSION").into(),
        identifier: "com.lovefinder.riskfiveruler".into(),
        data_dir: data_dir.to_string_lossy().into_owned(),
    })
}

/// 用系统默认方式打开链接。
///
/// 只接受 http/https；拒绝控制字符与引号，避免被 cmd/sh 解释成额外命令。
pub fn open_url(url: &str) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err(format!("只允许打开 http/https 链接: {url}"));
    }
    if url.len() > 2048
        || url
            .chars()
            .any(|c| c.is_control() || c == '"' || c == '\'' || c == '\n' || c == '\r')
    {
        return Err("链接包含非法字符".into());
    }

    #[cfg(target_os = "windows")]
    {
        // 空字符串是 start 的窗口标题位，否则含空格/引号的 URL 会被当成标题
        std::process::Command::new("cmd")
            .args(["/C", "start", "", url])
            .spawn()
            .map_err(|e| format!("打开链接失败: {e}"))?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(url)
            .spawn()
            .map_err(|e| format!("打开链接失败: {e}"))?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(url)
            .spawn()
            .map_err(|e| format!("打开链接失败: {e}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_url_rejects_non_http() {
        assert!(open_url("file:///C:/Windows/System32/cmd.exe").is_err());
        assert!(open_url("javascript:alert(1)").is_err());
        assert!(open_url("https://example.com\" & calc").is_err());
    }
}
