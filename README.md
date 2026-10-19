# Pigeon 🕊️

收集图片、整理灵感

Pigeon 是一款 Windows 素材管理工具，支持导入 Eagle 资料库。当前版本 **0.9.4**，浏览器扩展 **0.2.0**。软件还在持续完善，重要素材请备份。

## 下载和使用

到 [Releases](https://github.com/Semyon11275/pigeon_tool/releases) 下载：

- **Pigeon-0.9.4-win-x64.zip**：Windows x64 便携版。完整解压后打开 `Pigeon.exe`
- **Pigeon-extension-0.2.0.zip**：Chrome / Edge 扩展，单独安装。解压后进入浏览器扩展管理页，打开开发者模式，选择“加载已解压的扩展程序”。还没有上架扩展商店，得自行安装orz。
- **SHA256SUMS.txt**：下载文件校验值。

第一次使用可以直接新建资料库，位置是程序目录下的 `data/libraries`。桌面快捷方式可按需创建。更新程序时请保留整个 `data` 文件夹。

```text
Pigeon/
├── Pigeon.exe
├── resources/
├── extension/
└── data/                 # 首次使用时创建，不随安装包分发
    ├── libraries/        # 你的素材
    ├── userdata/         # 设置与缓存
    └── models/           # 可选 AI 模型
```

## 这版能做什么

- 导入本地文件、剪贴板图片和网页图片，按文件夹、标签、评分整理。
- 瀑布流、网格和列表浏览；关键词、拼音和条件筛选；智能文件夹。
- 批量改名、标签管理、撤销重做、转换导出、重复素材检查。
- 图片、视频、音频和字体预览；部分专业格式仍需要外部软件。
- 浏览器批量采集、持续收集与筛选，支持 Pinterest、Behance、站酷页面识别；抓取效果会受网页改版和访问权限影响。
- 自定义快捷键、自动导入，以及 GitHub 正式版本更新检查。

本地素材管理可以离线使用。网页采集、URL 导入、检查更新需要联网。

## AI 是可选的

AI 识图和语义搜索使用本地模型。本安装包和源码都不带模型权重，也不需要登录云端 AI 账户。

如果已有模型，可放在 `data/models` 并在设置中启用。不需要 AI 时，关闭设置后移走模型即可，不影响普通搜索和已有标签。不要误删 `data/libraries`。

## 更新说明

软件检查本仓库的正式 Release，只接受符合名称、大小及 SHA-256 校验的更新包。历史 demo 标签会跳过，不再弹版本格式错误。下载完成后由你选择重启安装。

早期 0.8 版没有这个更新入口，需要首次手动换到新版。0.9.1 / 0.9.2 本地试用版跨到本版也请手动更新程序文件并保留 `data`。后续更新以发布页说明为准，大约是能自动更新了🐊。

## 从源码运行与构建

Windows x64，Node.js 22.12 或以上：

```powershell
npm ci
npm start
npm run build:win -- --output E:\builds\Pigeon-0.9.4
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/package-update.ps1 -SourceDir E:\builds\Pigeon-0.9.4\dist -OutputDir E:\packages\Pigeon-0.9.4 -Version 0.9.4
```

构建输出必须是新目录。发行包不带个人资料库、配置、缓存和模型。Electron 固定为 44.9.0，构建会写入鸽子图标和应用版本。

运行 `npm run test:ext`、`npm run test:capture`、`npm run test:concurrency` 可执行相应回归。`test:features`、`test:setup` 和 `test:github` 需先设置 `PIGEON_TEST_TMP` 为独立临时目录；`test:github` 会联网下载公开包作校验，但不会安装它。

## 还在完善的地方

浏览器扩展尚未上架商店；HEIC 等部分格式使用占位预览。不同网站登录状态、系统拖放目标和 DPI 下仍需继续积累反馈。更新器支持文件替换失败回滚，尚未实现“新版启动异常自动退回旧版”。

本次依赖审计为0 项告警，但这不代表软件不存在安全问题。发现问题欢迎提交 Issue，附上复现步骤即可，别把自己的素材和配置上传了。
