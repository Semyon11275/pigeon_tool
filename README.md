# Pigeon 🕊️

一个为自己打造的素材收集与管理工具，复刻 [Eagle](https://eagle.cool) 的核心体验。
**兼容 Eagle 资料库格式**，可以直接导入现有的 `.library` 继续用。

> 这是给作者本人评估用的第一版原型（v0.1），目标是先跑通"浏览 → 整理 → 查找"的核心循环。

![技术栈](https://img.shields.io/badge/Electron-33-blue) ![平台](https://img.shields.io/badge/Windows-x64-green)

## 便携版（绿色版）

桌面的 `Pigeon` 文件夹即为便携版，结构：

```
Pigeon\                       ← 整个文件夹可随意移动 / 拷进 U 盘
├── pigeon.exe                ← 双击运行，无任何外部依赖
└── data\                    ← 全部数据都在这里
    ├── userdata\            # 配置与缓存（不再写入 C:\Users\...\AppData）
    └── libraries\
        └── 素材.pigeon       # 你的资料库（相对路径引用）
```

- **移动即迁移**：库路径以相对形式（`libraries/素材.pigeon`）记录，把整个文件夹拷到别的电脑、别的盘符，双击即用，素材、标签、评分全部跟走
- **更新方式**：用新版文件覆盖 pigeon.exe 和 `resources\`，**保留 `data\` 文件夹**即可
- 开发/源码模式不启用便携逻辑（`app.isPackaged` 判定），行为不变

## 运行

```bash
npm install     # 首次
npm start       # 启动
```

开发自检（自动截图到 shots/）：

```bash
PIGEON_SHOT=1 npx electron .
```

图标：`build/icon-source.png` → `node scripts/make-icon.js` 生成 `build/pigeon.ico`（16-256 七档尺寸、透明圆角）和 `renderer/pigeon-icon.png`（应用内品牌图），打包时 `--icon=build/pigeon.ico` 写入 exe。

把 Eagle 库迁移成 Pigeon 库（命令行方式，应用内也可以）：

```bash
node scripts/migrate-eagle.js "E:\eagel资源库\素材.library" "C:\Users\MECH\Documents\Pigeon\素材.pigeon"
```

## 已复刻的功能

| 模块 | 内容 |
|---|---|
| 资料库 | `.pigeon` 开放格式（与 Eagle `.library` 同构）、**多库切换**（点标题栏库名）、Eagle 库一键导入（复制模式，不碰原库） |
| 组织 | 文件夹树（嵌套、增删改名）、**文件与文件夹多对多**、标签、评分、注释、来源 URL、星标、**智能文件夹**（保存筛选条件） |
| **网络收集** | **URL 导入**（粘贴网页链接 → 提取全部图片 → 勾选批量入库，自动滚动加载懒加载图）、**从浏览器拖图进窗口**、**粘贴链接直接抓取**（Ctrl+V 识别 URL/HTML）、**内置浏览器**（右键「保存此图片到 Pigeon」） |
| 视图 | 瀑布流 / 网格 / 列表、缩放滑杆、全部/未分类/未标签/最近添加/随机/回收站、**灰度模式** |
| 浏览 | 悬停文件名、视频悬停播放、双击大图预览（缩放/平移/切换）、**幻灯片放映**、**字体文件预览**（ttf/otf 真实渲染字样） |
| 搜索 | 关键词（名称/标签/注释/URL）+ **拼音全拼/首字母搜索** |
| 筛选 | 格式、形状、评分、日期、标签、**颜色**（调色板色距匹配）；条件可保存为智能文件夹 |
| 整理 | 多选、拖拽归档、批量标签/评分、**批量重命名**（{name}/{n}/{date} 变量）、**重复文件扫描**（MD5 相同 + pHash 相似，元数据合并后移入回收站）、**库内以图找图**（pHash 汉明距离） |
| 导入 | 拖放、对话框、剪贴板图片 |
| Inspector | 缩略图、重命名（磁盘文件同步改名）、评分、标签、文件夹归属、注释、尺寸/大小/日期、来源链接、调色板、**EXIF 拍摄参数**（相机/焦距/光圈/快门/ISO） |
| 导出 | **导出到文件夹**、**导出 CSV**（带 BOM，Excel 直开）、复制路径/文件名/链接 |
| 快捷键 | Ctrl+F 搜索 / Ctrl+V 粘贴导入 / Ctrl+U URL 导入 / Ctrl+T 标签 / Delete 删除 / F2 重命名 / F5 刷新 / 空格预览 / Esc 关闭 / Alt+1~3 布局 |
| 其它 | 深色主题（#1F2023）、无边框窗口、自定义右键菜单 |

## 与 Eagle 相比还没有的

见 [AUDIT.md](AUDIT.md) —— 完整的逐项排查表（约 60 项功能，v0.2 覆盖约 70%）。剩余主要差距：

- **浏览器扩展**（整页勾选抓取）：需要单独开发 Chrome 扩展，下一阶段最优先
- **截图收集**（区域框选）：需要框选 UI
- **PSD/AI/Office 专业格式预览**：需要各格式解析库
- **AI 语义搜索**：需要本地 CLIP 或在线 API，单独立项
- 动作（Actions 宏）、标签群组 UI、自动导入文件夹监听

## 架构（给后续开发）

```
Pigeon/
├── main.js            # Electron 主进程：窗口、Pigeon:// 协议（带 Range 的视频流）、IPC
├── preload.js         # contextBridge 安全暴露 API（window.pigeon）
├── lib/library.js     # 资料库核心（纯 Node，可脱离 Electron 测试）
├── scripts/migrate-eagle.js  # Eagle → Pigeon 迁移
└── renderer/          # 原生 HTML/CSS/JS，无框架无构建步骤
```

数据格式（与 Eagle 同构，条目多对多挂在文件夹上）：

```
<库名>.pigeon/
├── metadata.json          # folders 树 / smartFolders / tagsGroups
└── images/<12位ID>.info/
    ├── metadata.json      # id/name/ext/size/tags/folders/rating/annotation/url/palettes...
    ├── 原文件
    └── thumbnail.png      # 统一缩略图名（Eagle 是 <name>_thumbnail.png）
```

设计决定：
- **缩略图协议**：`Pigeon://item/<id>/<file>` 自定义协议流式返回，支持 HTTP Range（视频可拖进度条）
- **纯 JSON 存储**：与 Eagle 一致，几百条以内性能足够；上万条时再换 SQLite（接口已隔离在 lib/library.js）
- **导入即复制**：绝不写用户的 Eagle 原库，避免双开软件时互相覆盖元数据
- **无框架**：当前规模 vanilla JS 足够，UI 复杂到一定程度再考虑引入

## 评估清单（给作者本人）

打开后建议按这个顺序玩：

1. 左侧栏切换 全部 / 未分类 / 回收站，感受文件夹计数
2. 缩放滑杆拖一拖，切换 瀑布流 / 网格 / 列表（Alt+1/2/3）
3. 点选条目 → 右侧 Inspector 改名、加标签、评分
4. 双击大图 → 滚轮缩放、左右箭头切换、底部评分
5. 拖一个条目到左侧「书籍排版」文件夹上 → 归档
6. 拖几张新图进窗口 → 自动导入 + 生成缩略图和调色板
7. Ctrl+V 截个图试试剪贴板导入
8. 搜索框输入关键词、点「筛选」按格式/形状/日期过滤
9. Delete 删几个 → 去回收站还原
