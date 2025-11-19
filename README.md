# CastToTV Media Hub Extension

## 功能概述
- 自动在所有 http/https 标签页注入 content script，追踪 `<audio>` / `<video>` 元素的播放状态、标题、封面、作者等。
- Background service worker 维护跨标签「媒体会话」列表，向 popup 推送增量更新。
- Popup 以卡片列表形式呈现最近播放的媒体，包含封面、站点信息、标题、作者、播放状态、可拖动进度条、10 秒快进/快退以及播放/暂停按钮。
- 点击右上角按钮可一键切换到来源标签页。

## 开发与调试
1. 在 Chrome 中打开 `chrome://extensions`，开启「开发者模式」。
2. 点击「加载已解压的扩展程序」，选择 `extension/` 目录。
3. 打开任意包含音频或视频的页面，开始播放后点击工具栏中的扩展图标即可看到媒体卡片列表。
4. 如果改动了代码，可在 `chrome://extensions` 中点击「重新加载」。

### 结构
```
extension/
├── manifest.json                # MV3 配置
├── background.js                # service worker，维护媒体列表并转发命令
├── content/mediaTracker.js      # 注入页面的媒体探测脚本
├── popup/                       # popup 页面 (HTML/CSS/JS)
├── utils/messageTypes.js        # 消息 & 命令常量
└── assets/                      # 图标 & 封面占位图
```

## 测试建议
- 在多个站点（如 YouTube、Bilibili、网易云）同时播放音频/视频，确认 popup 可列出多条卡片，并能跳转正确标签页。
- 操作快进/快退/播放按钮应立即反馈，并同步更新进度与播放状态。
- 拖动进度条验证拖拽结束时页面内媒体同步跳转。
- 关闭标签页或停止媒体后，卡片应从列表移除。

> **注意**：popup 中的站点图标会回退到 Google favicon 服务（`https://www.google.com/s2/favicons`），如需完全离线可替换为本地方案。
