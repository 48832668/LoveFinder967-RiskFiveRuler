//! Layer 1 — 文件 IO（dbio）。
//!
//! 这一层只做「字节进、字节出」：大小上限、路径规范化、原子写。
//! 它不认识工程、外设、UI，也不调用 layer2 的任何东西。
//! 所有文件句柄与缓冲区都在 Rust 里创建并释放 —— 前端只传字符串，
//! 不持有 OS 资源，这是「避免其它语言侧内存泄漏」的边界。

use std::io::Write;
use std::path::{Component, Path, PathBuf};

/// 单个工程文件上限：正常工程 < 1 MB；8 MB 足够容纳异常大的器件包内联。
pub const MAX_PROJECT_BYTES: u64 = 8 * 1024 * 1024;
/// 一次导出最多多少个文件（MRS 工程约 20 个）。
pub const MAX_EXPORT_FILES: usize = 4096;
/// 一次导出的总字节上限。
pub const MAX_EXPORT_BYTES: u64 = 64 * 1024 * 1024;

/// 读取文本文件，并拒绝异常大的文件。
pub fn read_text(path: &Path) -> Result<String, String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("读取失败: {e}"))?;
    if !meta.is_file() {
        return Err(format!("不是文件: {}", path.display()));
    }
    if meta.len() > MAX_PROJECT_BYTES {
        return Err(format!(
            "文件过大（{} 字节，上限 {} 字节）",
            meta.len(),
            MAX_PROJECT_BYTES
        ));
    }
    std::fs::read_to_string(path).map_err(|e| format!("读取失败: {e}"))
}

/// 原子写：先写同目录临时文件，fsync 后再 rename 覆盖目标。
///
/// 直接 `fs::write` 在写入中途崩溃会把原工程截断；rename 是原子替换，
/// 最坏情况也只是留下一个 `.tmp` 文件。
pub fn write_text_atomic(path: &Path, content: &str) -> Result<(), String> {
    if content.len() as u64 > MAX_PROJECT_BYTES {
        return Err(format!(
            "内容过大（{} 字节，上限 {} 字节）",
            content.len(),
            MAX_PROJECT_BYTES
        ));
    }
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| format!("非法目标路径: {}", path.display()))?;
    std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;

    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| format!("非法文件名: {}", path.display()))?;
    let tmp = path.with_file_name(format!(".{name}.tmp-{}", std::process::id()));

    {
        let mut f = std::fs::File::create(&tmp).map_err(|e| format!("创建临时文件失败: {e}"))?;
        f.write_all(content.as_bytes())
            .map_err(|e| format!("写入失败: {e}"))?;
        f.sync_all().map_err(|e| format!("刷盘失败: {e}"))?;
    }

    if let Err(e) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("替换目标文件失败: {e}"));
    }
    Ok(())
}

/// 规范化导出用的相对路径：只允许普通路径段，拒绝 `..`、绝对路径、盘符。
pub fn sanitize_relative(rel: &str) -> Result<PathBuf, String> {
    if rel.trim().is_empty() {
        return Err("导出路径为空".into());
    }
    if rel.len() > 512 {
        return Err(format!("导出路径过长: {rel}"));
    }
    let path = Path::new(rel);
    let mut out = PathBuf::new();
    for comp in path.components() {
        match comp {
            Component::Normal(seg) => out.push(seg),
            _ => return Err(format!("非法导出路径: {rel}")),
        }
    }
    if out.as_os_str().is_empty() {
        return Err(format!("非法导出路径: {rel}"));
    }
    Ok(out)
}

/// 把文件树写到指定目录。每个相对路径都必须通过 `sanitize_relative`。
pub fn write_tree(root: &Path, entries: &[(String, String)]) -> Result<usize, String> {
    if !root.is_dir() {
        return Err(format!("目标不是目录: {}", root.display()));
    }
    if entries.len() > MAX_EXPORT_FILES {
        return Err(format!(
            "文件数过多（{}，上限 {}）",
            entries.len(),
            MAX_EXPORT_FILES
        ));
    }

    let mut total: u64 = 0;
    let mut seen = std::collections::HashSet::new();
    for (rel, content) in entries {
        let safe = sanitize_relative(rel)?;
        if !seen.insert(safe.clone()) {
            return Err(format!("导出路径重复: {rel}"));
        }
        total = total.saturating_add(content.len() as u64);
        if total > MAX_EXPORT_BYTES {
            return Err(format!("导出内容过大（上限 {} 字节）", MAX_EXPORT_BYTES));
        }
        let target = root.join(&safe);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
        }
        std::fs::write(&target, content).map_err(|e| format!("写入 {} 失败: {e}", rel))?;
    }
    Ok(entries.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_traversal_and_absolute_paths() {
        assert!(sanitize_relative("../evil.c").is_err());
        assert!(sanitize_relative("a/../../evil.c").is_err());
        assert!(sanitize_relative("/etc/passwd").is_err());
        assert!(sanitize_relative("C:\\Windows\\evil.c").is_err());
        assert!(sanitize_relative("").is_err());
        assert!(sanitize_relative("User/rfr_init.c").is_ok());
        assert!(sanitize_relative("User\\rfr_init.c").is_ok());
    }

    #[test]
    fn atomic_write_roundtrip() {
        let dir = std::env::temp_dir().join(format!("rfr-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let file = dir.join("a.rfr");
        write_text_atomic(&file, "{\"x\":1}").unwrap();
        assert_eq!(read_text(&file).unwrap(), "{\"x\":1}");
        // 覆盖写也必须成功
        write_text_atomic(&file, "{\"x\":2}").unwrap();
        assert_eq!(read_text(&file).unwrap(), "{\"x\":2}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_tree_blocks_escape() {
        let dir = std::env::temp_dir().join(format!("rfr-tree-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        assert!(write_tree(&dir, &[("../x.c".into(), "x".into())]).is_err());
        let n = write_tree(&dir, &[("User/a.c".into(), "x".into())]).unwrap();
        assert_eq!(n, 1);
        assert!(dir.join("User/a.c").is_file());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
