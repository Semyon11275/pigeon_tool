# Pigeon · pigeon_tool

**一款仍在测试中的设计资源收集与管理软件，可完全离线运行。**

Pigeon 用来收集、浏览和整理图片、视频、字体等设计素材，支持文件夹、标签、评分、搜索，以及可选的本地 AI 识图。当前版本为 **v0.8.0 demo（fix3）**，主要面向 Windows x64。

> 项目仍在测试和完善中，可能存在功能缺陷。建议先使用少量素材试用，并为重要资料库保留备份。

## 下载测试版

前往 [GitHub Releases](https://github.com/Semyon11275/pigeon_tool/releases/tag/v0.8.0-demo-fix3) 下载 Windows x64 便携版，解压整个文件夹后运行 `pigeon.exe`：

- **含模型版**：`Pigeon-v0.8.0-demo-fix3-win-x64.zip`，包含本地识图模型。
- **轻量版**：`Pigeon-v0.8.0-demo-fix3-win-x64-lite.zip`，不含模型，适合仅使用普通素材管理功能。
- `SHA256SUMS.txt` 提供文件校验值。

发布包不包含个人资料库、用户配置、缓存或日志。当前发布设为 Latest，软件仍在测试中。

## 离线运行

本地素材的导入、浏览、整理、搜索，以及配置好模型后的 AI 识图与语义搜索，都在本机完成，不依赖云端 AI 服务或在线账户，可完全离线使用。

网页图片采集、URL 导入和内置浏览器访问网络资源时需要联网；从源码首次安装依赖也通常需要联网。它们不影响已有本地素材的离线管理。

## 主要功能

| 功能 | 说明 |
| --- | --- |
| 素材收集 | 文件导入、拖放导入、剪贴板导入；可选的网页图片采集 |
| 资料库 | 多资料库切换，支持导入 Eagle `.library` 资料库 |
| 分类整理 | 嵌套文件夹、标签、评分、注释、星标、智能文件夹 |
| 浏览预览 | 瀑布流、网格、列表；图片预览、视频播放、字体预览 |
| 搜索筛选 | 关键词与拼音搜索，按格式、颜色、日期、评分等筛选 |
| 批量处理 | 批量重命名、批量标签、重复文件扫描、相似图片查找 |
| 导出 | 导出素材到文件夹，导出 CSV |
| 本地 AI（可选） | Chinese-CLIP ONNX 模型支持的识图、自动打标和语义搜索 |
| 实验功能 | 截图收集、自动导入文件夹监听、全局快捷键 |

## 空间不够？可以删除识图模型

**识图模型是可选组件。如果软件占用空间过大，且暂时不需要 AI 功能，可以自行删除模型文件。**

1. 在设置中关闭 AI 功能，然后退出 Pigeon。
2. 在便携版程序目录下找到 `data/models/`，删除其中的 `visual.onnx` 和 `text.onnx`。如果还保留了 `clip_cn_rn50.pt` 原始权重，也可以删除。
3. 重新启动软件，继续使用普通素材管理功能。

删除模型后，AI 识图、自动打标和语义搜索将不可用；本地导入、浏览、文件夹、已有标签、评分和普通关键词搜索仍可使用。需要恢复 AI 功能时，将相应模型文件放回原目录，再启用 AI。

**请只删除模型，不要删除 `data/libraries/` 中的个人资料库。** 源码运行时，模型通常位于 Electron 用户数据目录的 `models/` 子目录；代码还兼容桌面 `Pigeon/data/models/` 路径。

本仓库不包含模型权重。

## Windows 便携版

已有 Windows 成品时，双击 `pigeon.exe` 启动，无需安装 Node.js。

```text
Pigeon/
├── pigeon.exe
├── resources/
└── data/
    ├── userdata/     # 用户配置和缓存
    ├── libraries/    # 个人资料库
    └── models/       # 可选的本地 AI 模型
```

整体移动便携版文件夹即可迁移程序和数据；更新程序时请保留 `data/`。仓库保存源码，Windows 成品请从 Releases 下载；两者均不包含个人素材、配置或缓存。

## 从源码运行

准备 Node.js 和 npm，然后执行：

```bash
git clone https://github.com/Semyon11275/pigeon_tool.git
cd pigeon_tool
npm install
npm start
```

技术栈：Electron 33、原生 HTML / CSS / JavaScript、JSON 资料库存储、ONNX Runtime。

Eagle 资料库可通过界面导入，也可使用命令行：

```bash
node scripts/migrate-eagle.js "E:/素材/原始.library" "E:/素材/新资料库.pigeon"
```

迁移采用复制方式，保留原始资料库。

## 开发与打包

```text
main.js                     Electron 主进程、窗口、协议与 IPC
preload.js                  渲染器 API 桥接
lib/library.js              资料库管理
lib/ai.js                   本地 AI 推理
renderer/                   界面、样式和静态资源
scripts/migrate-eagle.js     Eagle 资料库迁移
scripts/make-icon.js         图标生成
scripts/build.sh             原始 asar 打包脚本
scripts/assemble-release.sh  原始 Windows 发行目录组装脚本
```

打包脚本使用 Git Bash，依赖已安装的依赖、准备好的 Electron 发行目录及本地模型路径。组装脚本保留了开发时的机器路径，运行前需要调整，不是开箱即用的构建流程。

PowerShell 下运行截图自检：

```powershell
$env:PIGEON_SHOT='1'
npm start
```

`npm run shot` 当前依赖尚未声明的 `cross-env`，可使用上述命令替代。

## 版本与测试状态

- 保留原始 Git 历史，并同步了 2026-09-20 Windows 成品中 v0.8.0 demo fix3 的首次启动建库修复。
- 本次源码整理已通过 JavaScript 语法检查，尚未执行完整 GUI 回归或重新打包验证。
- [AUDIT.md](AUDIT.md)、[ROADMAP.md](ROADMAP.md) 和 `docs/` 保留早期开发记录，其中的版本与完成状态可能落后于当前代码。
- PSD / AI / Office 等专业格式预览、浏览器扩展等功能仍待完善。
