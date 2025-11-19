/**
 * CastToTV Media Hub - Background Service Worker
 *
 * 这是扩展的核心后台脚本，作为 Service Worker 运行在独立的上下文中。
 * 主要职责：
 * 1. 维护所有媒体会话的中央状态存储（内存缓存）
 * 2. 作为消息中转站，协调 content script 和 popup 之间的通信
 * 3. 管理与 popup 的持久连接，实时推送状态更新
 * 4. 处理标签页生命周期事件，自动清理失效会话
 */

// 导入共享的消息类型常量，确保各组件使用统一的消息协议
importScripts('utils/messageTypes.js');

/**
 * 媒体会话缓存 - 核心数据结构
 *
 * 使用 Map 存储所有活跃的媒体会话，键为 sessionId（格式：tabId:elementId）
 * 每个会话包含完整的媒体状态快照：播放状态、进度、元数据等
 *
 * 为什么使用 Map：
 * - O(1) 的查找、插入、删除性能
 * - 键可以是任意类型（这里用字符串）
 * - 保持插入顺序，便于遍历
 * - 内置 has/get/set/delete 方法，语义清晰
 */
const mediaSessions = new Map(); // sessionId -> session snapshot

/**
 * Popup 端口集合 - 管理所有活跃的 popup 连接
 *
 * 使用 Set 存储当前已连接的 popup 端口引用
 * 支持多个 popup 同时打开的场景（虽然 Chrome 通常只允许一个）
 *
 * 为什么使用 Set：
 * - 自动去重，防止同一端口被重复添加
 * - O(1) 的添加和删除操作
 * - 便于遍历广播消息
 */
const popupPorts = new Set();

/**
 * 监听来自 content script 的一次性消息
 *
 * content script 使用 chrome.runtime.sendMessage() 发送状态更新
 * 这是单向通信，不需要回复，适合频繁的状态同步场景
 *
 * 支持的消息类型：
 * - MEDIA_UPDATE: 媒体状态变化（播放/暂停/进度/音量等）
 * - MEDIA_REMOVED: 媒体元素从 DOM 中移除
 *
 * @param {Object} message - 消息对象，包含 type 和 payload
 * @param {Object} sender - 发送者信息，包含 tab.id、url 等
 */
chrome.runtime.onMessage.addListener((message, sender) => {
  // 防御性检查：确保消息格式正确
  if (!message || !message.type) {
    return;
  }

  switch (message.type) {
    case MESSAGE_TYPES.MEDIA_UPDATE:
      // 处理媒体状态更新：更新缓存并广播给所有 popup
      handleMediaUpdate(message.payload, sender);
      break;
    case MESSAGE_TYPES.MEDIA_REMOVED:
      // 处理媒体移除：清理缓存并通知 popup 刷新列表
      handleMediaRemoved(message.payload, sender);
      break;
    default:
      // 忽略未知消息类型，保持向前兼容
      break;
  }
});

/**
 * 监听 popup 建立的持久连接
 *
 * popup 使用 chrome.runtime.connect() 建立长连接，用于：
 * 1. 接收实时的会话列表更新（background -> popup）
 * 2. 发送用户的媒体控制命令（popup -> background -> content script）
 *
 * 持久连接的优势：
 * - 避免频繁建立/断开连接的开销
 * - 支持双向实时通信
 * - 自动检测连接断开（popup 关闭）
 *
 * @param {chrome.runtime.Port} port - 连接端口对象
 */
chrome.runtime.onConnect.addListener((port) => {
  // 验证端口名称，确保是来自 popup 的连接
  // 这是一种简单的连接类型识别机制
  if (port.name !== PORT_NAMES.POPUP) {
    return;
  }

  // 将新端口加入集合，用于后续广播
  popupPorts.add(port);

  /**
   * 监听端口断开事件
   *
   * 当 popup 关闭或刷新时，端口会自动断开
   * 必须及时清理，否则会导致：
   * - 内存泄漏（端口对象无法被 GC）
   * - 广播时出错（向已断开的端口发消息会抛异常）
   */
  port.onDisconnect.addListener(() => {
    popupPorts.delete(port);
  });

  /**
   * 监听来自 popup 的控制命令
   *
   * 用户在 popup 中点击按钮或拖动进度条时，
   * popup 会发送 MEDIA_COMMAND 消息，包含：
   * - sessionId: 目标媒体会话
   * - command: 操作类型（toggle-play/seek-relative/seek-absolute）
   * - delta/time: 操作参数
   *
   * background 负责将命令路由到正确的 tab
   */
  port.onMessage.addListener((message) => {
    if (message?.type === MESSAGE_TYPES.MEDIA_COMMAND) {
      // 异步分发命令，使用 catch 处理可能的错误
      dispatchMediaCommand(message).catch((error) => {
        console.warn('[CastToTV] Failed to dispatch command', error);
      });
    }
  });

  /**
   * 立即发送当前会话列表
   *
   * popup 刚打开时需要立即看到所有媒体
   * 不需要等待下一次状态变化
   * 这提供了即时的用户体验
   */
  port.postMessage({
    type: MESSAGE_TYPES.SESSIONS_UPDATED,
    sessions: serializeSessions()
  });
});

/**
 * 监听标签页关闭事件
 *
 * 当用户关闭标签页时，该标签页内的所有媒体会话都应该被清理
 * 这确保了：
 * - 内存不会无限增长
 * - popup 不会显示已失效的媒体卡片
 * - 数据一致性得到保证
 *
 * @param {number} tabId - 被关闭的标签页 ID
 */
chrome.tabs.onRemoved.addListener((tabId) => {
  let hasChanges = false;

  // 遍历所有会话，找出属于该标签页的
  for (const [sessionId, session] of mediaSessions.entries()) {
    if (session.tabId === tabId) {
      mediaSessions.delete(sessionId);
      hasChanges = true;
    }
  }

  // 只有在确实删除了会话时才广播更新
  // 避免不必要的消息发送
  if (hasChanges) {
    broadcastSessions();
  }
});

/**
 * 构建唯一的会话标识符
 *
 * sessionId 的格式为 "tabId:elementId"
 * 这种设计确保了：
 * - 同一标签页内的多个媒体元素可以被区分
 * - 不同标签页的媒体不会冲突
 * - 字符串格式便于序列化和调试
 *
 * @param {number} tabId - Chrome 标签页 ID
 * @param {string} elementId - 媒体元素的唯一标识（UUID）
 * @returns {string} 格式为 "tabId:elementId" 的唯一标识符
 */
function buildSessionId(tabId, elementId) {
  return `${tabId}:${elementId}`;
}

/**
 * 处理媒体状态更新
 *
 * 当 content script 检测到媒体状态变化时调用：
 * - 播放/暂停状态改变
 * - 播放进度更新（timeupdate）
 * - 音量变化
 * - 元数据加载完成
 *
 * 此函数将新状态合并到缓存中，并通知所有 popup
 *
 * @param {Object} payload - 媒体状态数据，包含 elementId、isPlaying、currentTime 等
 * @param {Object} sender - 消息发送者信息，用于获取 tabId 和页面 URL
 */
function handleMediaUpdate(payload = {}, sender) {
  // 从 sender 中提取标签页 ID
  const tabId = sender?.tab?.id;

  // 验证必要参数：没有 tabId 或 elementId 则无法唯一标识会话
  if (!tabId || !payload.elementId) {
    return;
  }

  // 生成唯一的会话标识符
  const sessionId = buildSessionId(tabId, payload.elementId);

  // 标准化数据：补充缺失字段，确保数据完整性
  const normalized = normalizePayload(payload, sender);

  // 更新或创建会话记录
  // 使用对象展开运算符合并数据，后面的属性会覆盖前面的
  mediaSessions.set(sessionId, {
    ...normalized,           // 标准化后的媒体数据
    tabId,                   // 标签页 ID
    sessionId,               // 唯一会话标识
    elementId: payload.elementId,  // 元素 ID
    lastUpdated: Date.now()  // 最后更新时间戳，用于排序
  });

  // 通知所有已连接的 popup 更新 UI
  broadcastSessions();
}

/**
 * 处理媒体元素移除事件
 *
 * 当 content script 检测到媒体元素从 DOM 中被移除时调用
 * 可能的触发场景：
 * - 用户导航到新页面
 * - SPA 路由切换，旧组件卸载
 * - 页面动态移除媒体元素
 *
 * @param {Object} payload - 包含被移除元素的 elementId
 * @param {Object} sender - 消息发送者信息
 */
function handleMediaRemoved(payload = {}, sender) {
  const tabId = sender?.tab?.id;

  // 验证必要参数
  if (!tabId || !payload.elementId) {
    return;
  }

  const sessionId = buildSessionId(tabId, payload.elementId);

  // Map.delete() 返回布尔值表示是否成功删除
  // 只有确实删除了会话才需要广播
  if (mediaSessions.delete(sessionId)) {
    broadcastSessions();
  }
}

/**
 * 标准化 payload 数据
 *
 * content script 发送的数据可能不完整（如某些网站不提供元数据）
 * 此函数负责：
 * 1. 填充缺失的 sourceUrl（媒体源地址）
 * 2. 解析并补充 origin（站点域名）
 * 3. 生成 siteName（站点显示名称）
 *
 * 这确保了即使数据不完整，UI 也能正常显示
 *
 * @param {Object} payload - 原始媒体数据
 * @param {Object} sender - 消息发送者，包含页面 URL 等信息
 * @returns {Object} 标准化后的数据对象
 */
function normalizePayload(payload, sender) {
  // 确定媒体源 URL，按优先级尝试多个来源
  const sourceUrl = payload.sourceUrl || sender?.url || sender?.tab?.url || null;

  // 解析站点域名（origin）
  let origin = payload.origin;
  const originSource = sourceUrl || sender?.tab?.url;

  // 如果 payload 中没有 origin，尝试从 URL 中解析
  if (!origin && originSource) {
    try {
      // 使用 URL API 安全地解析域名
      origin = new URL(originSource).hostname;
    } catch {
      // URL 解析失败（格式错误），保持 undefined
      origin = undefined;
    }
  }

  // 返回增强后的数据
  return {
    ...payload,  // 保留原始数据
    sourceUrl,   // 确保有媒体源 URL
    origin: origin || null,  // 确保有域名，无则为 null
    // siteName 的回退链：payload > 页面标题 > 域名 > 默认值
    siteName: payload.siteName || sender?.tab?.title || origin || 'Unknown site'
  };
}

/**
 * 序列化会话列表（用于发送给 popup）
 *
 * 将 Map 转换为排序后的数组，排序规则：
 * 1. 正在播放的媒体优先显示（用户最可能想控制的）
 * 2. 同状态下，最近更新的排在前面（活跃度高）
 *
 * 这种排序策略提供了最佳的用户体验：
 * - 当前正在播放的媒体总是在最上面
 * - 最近互动过的媒体更容易找到
 *
 * @returns {Array} 排序后的会话数组
 */
function serializeSessions() {
  return Array.from(mediaSessions.values()).sort((a, b) => {
    // 首先按播放状态排序：正在播放的优先
    if (a.isPlaying !== b.isPlaying) {
      return a.isPlaying ? -1 : 1;
    }
    // 相同状态下，按最后更新时间降序（最新的在前）
    return b.lastUpdated - a.lastUpdated;
  });
}

/**
 * 向所有已连接的 popup 广播会话列表
 *
 * 每当会话状态发生变化时调用：
 * - 新媒体被检测到
 * - 媒体状态更新
 * - 媒体被移除
 * - 标签页关闭
 *
 * 这确保了所有打开的 popup 都能实时看到最新状态
 */
function broadcastSessions() {
  // 构造标准化的消息格式
  const payload = {
    type: MESSAGE_TYPES.SESSIONS_UPDATED,
    sessions: serializeSessions()
  };

  // 遍历所有已连接的 popup 端口
  popupPorts.forEach((port) => {
    try {
      // 发送消息到该端口
      port.postMessage(payload);
    } catch (error) {
      // 发送失败通常是因为端口已断开
      // 记录警告但不中断执行
      console.warn('[CastToTV] Failed to notify popup', error);
    }
  });
}

/**
 * 分发媒体控制命令到目标标签页
 *
 * popup 发送的控制命令需要路由到正确的 content script
 * 此函数负责：
 * 1. 验证目标会话存在
 * 2. 查找对应的标签页 ID
 * 3. 使用 chrome.tabs.sendMessage 发送命令
 *
 * 支持的命令类型：
 * - toggle-play: 切换播放/暂停状态
 * - seek-relative: 相对跳转（快进/快退 N 秒）
 * - seek-absolute: 绝对跳转（跳到指定时间点）
 *
 * @param {Object} message - 控制命令消息
 * @param {string} message.sessionId - 目标会话 ID
 * @param {string} message.command - 命令类型
 * @param {number} [message.delta] - 相对跳转的秒数（用于 seek-relative）
 * @param {number} [message.time] - 绝对时间点（用于 seek-absolute）
 */
async function dispatchMediaCommand(message) {
  const { sessionId } = message;

  // 验证 sessionId 存在且对应的会话在缓存中
  if (!sessionId || !mediaSessions.has(sessionId)) {
    return;
  }

  // 获取会话信息，主要需要 tabId 来路由消息
  const session = mediaSessions.get(sessionId);

  try {
    // 向目标标签页的 content script 发送命令
    await chrome.tabs.sendMessage(session.tabId, {
      type: MESSAGE_TYPES.MEDIA_COMMAND,
      elementId: session.elementId,  // 指定哪个媒体元素
      command: message.command,       // 操作类型
      delta: message.delta,           // 相对跳转参数
      time: message.time              // 绝对跳转参数
    });
  } catch (error) {
    // 错误处理：可能是标签页已关闭、content script 未加载等
    if (chrome.runtime.lastError) {
      console.warn('[CastToTV] Error sending command', chrome.runtime.lastError.message);
    } else {
      console.warn('[CastToTV] Error sending command', error);
    }
  }
}
