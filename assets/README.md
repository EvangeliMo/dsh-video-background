# assets — 把背景视频放到这里

把视频文件命名为 `background.mp4` 放在本目录，然后执行：

```powershell
npm run build:client
```

构建脚本会把视频 **base64 内嵌** 进 `lib/client.js`（作为 data URL），
之后删除这个源文件（或移动它）都不影响插件使用。

## 视频建议

- 格式：H.264 MP4（浏览器兼容性最好；WebM 也可，但文件名需同步改 build-client.mjs 里的 ASSET/MIME）
- 时长：5–20 秒的**无缝循环**（首尾画面接近，循环更自然）
- 分辨率：≤ 1080p；640–1080px 宽即可，背景视频被 UI 遮挡，不需要 4K
- 体积：**≤ 3 MB 最佳 ≤ 1.5 MB**。base64 会让包体膨胀约 33%（1.5MB 视频 → 约 2MB 的 client.js）
- 压缩建议：ffmpeg 示例（把码率压到 ~1Mbps、30fps、无音轨）：

```powershell
ffmpeg -i input.mp4 -c:v libx264 -crf 30 -preset slow -an -vf "scale=-2:720" -t 15 -movflags +faststart background.mp4
```

## 没有视频时

`assets/background.mp4` 不存在时构建**不附带任何媒体**：插件首次使用时背景保持
关闭（显示默认 Harness 背景），直到用户在弹层里添加图片/视频。
放进视频后重新构建即可作为列表中的普通一项出现。
