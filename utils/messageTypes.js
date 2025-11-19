(() => {
  // MESSAGE_TYPES 统一管理 background 与 content popup 间的消息类型，避免硬编码字符串
  const MESSAGE_TYPES = Object.freeze({
    MEDIA_UPDATE: 'MEDIA_UPDATE', // content script -> background：媒体状态更新
    MEDIA_REMOVED: 'MEDIA_REMOVED', // content script -> background：播放器节点被移除
    MEDIA_COMMAND: 'MEDIA_COMMAND', // popup -> background -> content：媒体控制命令
    SESSIONS_UPDATED: 'SESSIONS_UPDATED' // background -> popup：媒体会话列表刷新
  });

  // MEDIA_COMMANDS 枚举 popup 可以下发的控制指令
  const MEDIA_COMMANDS = Object.freeze({
    TOGGLE_PLAY: 'toggle-play', // 切换播放 / 暂停
    SEEK_RELATIVE: 'seek-relative', // 相对跳转（快进 / 回退）
    SEEK_ABSOLUTE: 'seek-absolute' // 绝对定位到指定时间
  });

  // PORT_NAMES 记录不同长连接端口的名称，当前仅用于 popup 面板
  const PORT_NAMES = Object.freeze({
    POPUP: 'popup-panel'
  });

  const Shared = { MESSAGE_TYPES, MEDIA_COMMANDS, PORT_NAMES };

  // 浏览器环境下（background / content）挂载到全局 self，方便直接引用
  if (typeof self !== 'undefined') {
    Object.assign(self, Shared);
  }

  // CommonJS 环境（例如单测或构建脚本）通过 require 引入
  if (typeof module !== 'undefined') {
    module.exports = Shared;
  }
})();
