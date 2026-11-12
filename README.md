# RiskFiveRuler — Release

这个分支**只存放可直接使用的发布包**，不含源码。源码、开发说明与构建方式见 `main` 分支。

## 当前版本

| 文件 | 版本 | 平台 | 日期 |
| --- | --- | --- | --- |
| `RiskFiveRuler-0.1.0-Windows-x64-Portable.zip` | 0.1.0 | Windows x64 便携版 | 2026-11-12 |

- 适用：Windows 10 1803+ / Windows 11（64 位），需系统已装 Microsoft Edge WebView2 Runtime。
- 构建号：`26.11.12.1`（「关于」对话框与包内 `BUILD-INFO.txt` 显示，规则为年月日 + 当日编译次数）。
- 本次构建含：`config.json` 首次启动自动创建、I2C 面板移除失效的实时计算板块与 Disable 档、主机模式开放 7/10 位寻址设定。
- 包内：`RiskFiveRuler.exe`、`WebView2Loader.dll`、`README-Windows.txt`、`BUILD-INFO.txt`。
- `WebView2Loader.dll` 是 exe 的静态导入依赖，**必须与 exe 同目录**，所以不能只发单个 exe。
- `config.json` **不随包分发**：首次启动由程序用默认值自动创建并初始化（放到只读目录时自动降级为内存默认值）。
- 免安装、不写注册表，解压到可写目录后双击即用；卸载直接删目录。
- 完整性校验见 `SHA256SUMS.txt`：

  ```bash
  sha256sum -c SHA256SUMS.txt
  ```

## 命名规则

```
RiskFiveRuler-<版本>-<平台>-<架构>-Portable.zip
```

目前只有 Windows x64。以后新增 macOS / Linux 或 x86 / ARM64 构建时沿用同一规则，
从文件名就能区分平台与架构，不要再用 `RiskFiveRuler.zip` 这类无平台信息的名字。

## 取用方式

建议直接在仓库网页下载 zip，或用 `git archive` 导出：

```bash
git archive releases | tar -x -C <目标目录>
```

该分支与 `main` **没有共同历史**（孤立分支），不用于开发；本地 checkout 会移除
`main` 的工作区源码文件，回到 `main` 即可恢复。
