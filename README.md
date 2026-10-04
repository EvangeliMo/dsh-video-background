# dsh-video-background

DeepSeek Harness Web（DSH Web）的视频背景插件：一段**内嵌视频**循环播放作为整个应用的背景。

## 效果

- 全窗口视频背景（`object-fit: cover`），位于所有 UI 面板**下层**
- 侧边栏区域显示**略微放大 + 模糊**的视频副本（背景层，会话列表文字清晰）
- 消息气泡、输入框等自带不透明填充，聊天文字始终可读
- **对话区左上角**悬浮一个背景开关按钮（挂在 `shell.overlay`，锚定
  `[data-conversation-scroll]` 页头下方的滚动区左上角）：
  - **跟随侧边栏尺寸变化和收放**自动移动（锚点实时测量）
  - 点击按钮：开启/关闭背景（关闭时恢复原生界面背景）
  - 悬停弹层：开关 + **暗化强度滑块**（0–80%，默认 35%）
- 视频以 **base64 内嵌**在 `lib/client.js` 里——**删除/移动源视频文件永远不会影响插件**

## 视频来源（重要）

1. 把你的循环视频命名为 `background.mp4`，放到 `assets/` 目录
2. 运行 `npm run build:client`（构建脚本自动 base64 内嵌；`prepublishOnly` 也会自动构建）
3. 硬刷新页面（Ctrl+Shift+R）即可看到视频

`assets/background.mp4` 不存在时构建为**演示模式**（CSS 动态渐变），便于先验证安装与开关联动。
建议：H.264 MP4、5–20 秒无缝循环、≤1080p、**≤ 3 MB**（base64 膨胀约 33%）。压缩示例：

```powershell
ffmpeg -i input.mp4 -c:v libx264 -crf 30 -preset slow -an -vf "scale=-2:720" -t 15 -movflags +faststart background.mp4
```

## 安装（本地开发）

```powershell
dsh plugin --profile web add D:\path\to\dsh-video-background
# 重启 dsh web，然后硬刷新页面
```

## 开发循环

```powershell
node scripts/build-client.mjs   # 改 src/client/index.jsx 后重建 lib/client.js
dsh plugin --profile web remove dsh-video-background   # 卸载
```

## 结构

```
dsh-video-background/
├── package.json          # name/version/dsh 声明/exports/scripts
├── cordis.patch.yml      # bundle 行（空宿主 apply 挂进 Loader）
├── lib/
│   ├── index.js          # 宿主侧空 apply（纯客户端插件）
│   └── client.js         # 客户端 bundle（构建产物，必须提交！）
├── src/client/index.jsx  # 客户端源码（背景引擎 + 侧边栏控件）
├── scripts/build-client.mjs  # esbuild 打包器（含视频内嵌）
└── assets/               # background.mp4 放这里（可选）
```

## 说明

- 纯客户端插件：无宿主服务、无 RPC。背景通过注入固定定位层（`z-index: -1`）+ 覆盖
  `--dsw-alias-bg-base` / `--dsw-specific-sidebar-fill` 两个别名 token（body 内联 `!important`）
  实现，关闭/卸载时恢复。
- 主题或 dsh 升级后若别名 token 改名，需同步 `src/client/index.jsx` 里的 `TOKENS` 数组。
