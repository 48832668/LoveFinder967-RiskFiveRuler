//! Layer 1 — 宿主环境（目录解析）。
//!
//! 只回答「数据放哪里」，不做业务判断。不引入 `dirs` 之类的额外 crate，
//! 保持用户机器零额外依赖。

use std::path::PathBuf;

/// 本应用的用户数据目录。
///
/// Windows: `%APPDATA%\RiskFiveRuler`
/// macOS:   `~/Library/Application Support/RiskFiveRuler`
/// Linux:   `$XDG_CONFIG_HOME/riskfiveruler` 或 `~/.config/riskfiveruler`
pub fn app_data_dir() -> Result<PathBuf, String> {
    let base = if cfg!(target_os = "windows") {
        std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("USERPROFILE").map(|h| PathBuf::from(h).join("AppData/Roaming")))
    } else if cfg!(target_os = "macos") {
        std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Library/Application Support"))
    } else {
        std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))
    };

    let base = base.ok_or_else(|| "无法定位用户数据目录".to_string())?;
    let dir = base.join("RiskFiveRuler");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建数据目录失败: {e}"))?;
    Ok(dir)
}

/// 某个数据文件在当前用户下的绝对路径。
pub fn data_file(name: &str) -> Result<PathBuf, String> {
    Ok(app_data_dir()?.join(name))
}

/// 程序自身所在目录（便携版 = 仓库根目录）。
///
/// `config.json` 放在这里而不是 AppData：用户要求「在本目录用 config.json
/// 作为保存和读取的对象」，可以直接复制/覆盖 JSON 换配置。
pub fn exe_dir() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| format!("无法定位可执行文件: {e}"))?;
    exe.parent()
        .map(|p| p.to_path_buf())
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| "无法定位程序目录".to_string())
}
