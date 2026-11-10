//! RiskFiveRuler 纯 Rust 核心。
//!
//! 这里没有 Tauri、没有 WebView、没有窗口 —— 因此可以 `cargo test -p rfr-core`
//! 在无 GUI 的环境里跑完 layer1 / layer2 的全部单测。
//!
//! 分层：
//!   layer1_fsio / layer1_env          dbio：文件、路径、目录
//!   layer2_project / export / app     funcHANDLE：工程、导出、应用动作

pub mod layer1_env;
pub mod layer1_fsio;
pub mod layer2_app;
pub mod layer2_export;
pub mod layer2_project;
