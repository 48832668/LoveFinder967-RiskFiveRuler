//! Layer 2 — 代码导出（funcHANDLE）。
//!
//! 把「相对路径 + 内容」的列表安全地写到用户选的目录。
//! 路径穿越与体积上限由 layer1 兜底。

use std::path::Path;

use crate::layer1_fsio;

pub fn export_tree(root: &str, files: Vec<(String, String)>) -> Result<usize, String> {
    layer1_fsio::write_tree(Path::new(root), &files)
}
