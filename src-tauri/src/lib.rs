//! RiskFiveRuler — Rust 外壳。
//!
//! 分层（依赖只允许向下）：
//!   commands（funcall 边界）
//!     → rfr-core::layer2_*（funcHANDLE：工程 / 导出 / 应用动作）
//!       → rfr-core::layer1_*（dbio：文件 IO、目录解析）
//!
//! layer1/layer2 在 `crates/rfr-core` 里，不依赖 Tauri，可以单独 `cargo test`。
//! 前端（WebView）只负责渲染与调用命令，不持有文件句柄；
//! 所有 IO 缓冲区在本进程内创建并释放。

mod commands;

// 发布版必须把前端资源编进二进制。少了这个 feature，Tauri 会回落到
// devUrl（http://127.0.0.1:1420），双击 exe 只会得到一个白屏窗口。
#[cfg(all(not(debug_assertions), not(feature = "custom-protocol")))]
compile_error!(
    "发布构建必须启用 custom-protocol：\n\
     bash scripts/cargo.sh build --profile dist --features custom-protocol --target x86_64-pc-windows-gnu\n\
     或直接 npm run tauri:build。"
);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            commands::project_save,
            commands::project_load,
            commands::write_text_file,
            commands::read_text_file,
            commands::write_tree,
            commands::open_url,
            commands::app_info,
            commands::config_read,
            commands::config_write,
            commands::file_read_at,
            commands::file_write_at,
            commands::recent_load,
            commands::recent_push,
            commands::recent_drop,
            commands::recent_clear,
            commands::resize_window,
        ])
        .run(tauri::generate_context!())
        .expect("启动 RiskFiveRuler 失败");
}
