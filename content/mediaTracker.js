/**
 * CastToTV Media Hub - Content Script (媒体追踪器)
 *
 * 这个脚本被注入到每个网页中，负责：
 * 1. 检测页面中的所有 <audio> 和 <video> 元素
 * 2. 监听媒体元素的状态变化（播放、暂停、进度等）
 * 3. 提取媒体元数据（标题、艺术家、封面等）
 * 4. 将状态更新发送给 background service worker
 * 5. 接收并执行来自 popup 的控制命令
 *
 * 使用 IIFE（立即执行函数表达式）模式：
 * - 创建独立的作用域，避免污染全局命名空间
 * - 防止与页面原有脚本产生变量冲突
 * - 'use strict' 启用严格模式，提高代码质量
 */
(() => {
  'use strict';

  /**
   * 环境检查：确保 Chrome 扩展 API 可用
   *
   * 在某些特殊页面（如 chrome:// 页面、PDF 查看器等）
   * chrome.runtime 可能不可用，此时无法进行通信
   */
  if (typeof chrome === 'undefined' || !chrome.runtime) {
    console.warn('[CastToTV] chrome.runtime is unavailable in this context.');
    return;
  }

  /**
   * 从全局作用域获取消息类型常量
   *
   * 这些常量由 utils/messageTypes.js 定义，
   * 通过 manifest.json 的 content_scripts 配置先于本文件加载
   * 使用 self 而不是 window 是为了兼容 Service Worker 环境
   */
  const MESSAGE_TYPES = self?.MESSAGE_TYPES;
  const MEDIA_COMMANDS = self?.MEDIA_COMMANDS;

  // 验证必要的常量已加载
  if (!MESSAGE_TYPES || !MEDIA_COMMANDS) {
    console.warn('[CastToTV] message constants are missing.');
    return;
  }

  /**
   * CSS 选择器：匹配所有音频和视频元素
   * 这是 DOM 查询的核心选择器
   */
  const MEDIA_QUERY = 'audio, video';

  /**
   * 需要监听的媒体事件列表
   *
   * 每个事件对应不同的状态变化：
   * - play/pause: 播放状态切换
   * - timeupdate: 播放进度更新（高频事件，需要节流）
   * - durationchange: 媒体时长变化（首次加载或切换源）
   * - volumechange: 音量或静音状态变化
   * - ratechange: 播放速率变化
   * - ended: 播放结束
   * - loadeddata/loadedmetadata: 元数据和数据加载完成
   * - seeked: 用户跳转到新位置
   * - enterpictureinpicture/leavepictureinpicture: 画中画模式切换
   */
  const MEDIA_EVENTS = [
    'play',
    'pause',
    'timeupdate',
    'durationchange',
    'volumechange',
    'ratechange',
    'ended',
    'loadeddata',
    'loadedmetadata',
    'seeked',
    'enterpictureinpicture',
    'leavepictureinpicture'
  ];

  /**
   * 已追踪的媒体元素映射表
   *
   * 键：elementId（UUID 格式）
   * 值：{ element: HTMLMediaElement, listener: Function }
   *
   * 存储元素引用和事件监听器，用于：
   * - 防止重复注册同一元素
   * - 在元素移除时正确清理事件监听器
   * - 快速查找目标元素执行命令
   */
  const trackedElements = new Map(); // elementId -> { element, listener }

  /**
   * 待处理更新的映射表
   *
   * 键：elementId
   * 值：requestAnimationFrame 返回的 ID
   *
   * 用于防抖（debounce）高频的 timeupdate 事件
   * 避免消息泛滥影响性能
   */
  const pendingUpdates = new Map(); // elementId -> rafId

  /**
   * 当前激活的媒体元素 ID
   * 
   * 策略：每个页面只追踪一个"活跃"的媒体元素。
   * - 这是一个互斥锁，确保 popup 只显示一个媒体控制卡片
   * - 当用户播放新视频时，会自动切换到新视频
   * - 页面滚动自动播放场景下，焦点会自动跟随
   */
  let activeMediaId = null;

  /**
   * 站点名称，按优先级尝试获取：
   * 1. Open Graph 元数据（社交媒体标准）
   * 2. 页面标题
   * 3. 域名（最后的回退）
   */
  const siteName =
    document.querySelector("meta[property='og:site_name']")?.content ||
    document.title ||
    location.hostname;

  /**
   * 安全地发送消息到 background service worker
   *
   * 封装 chrome.runtime.sendMessage 以处理各种异常：
   * - 扩展被禁用或卸载
   * - Service Worker 未激活
   * - 连接超时
   *
   * 重要：必须检查 runtime.lastError 来消除 Chrome 的未检查错误警告
   *
   * @param {Object} message - 要发送的消息对象
   */
  const safeSendMessage = (message) => {
    try {
      chrome.runtime.sendMessage(message, () => {
        // Access runtime.lastError to silence unchecked errors.
        // 访问 lastError 属性以消除未检查错误的警告
        if (chrome.runtime.lastError) {
          return;
        }
      });
    } catch (error) {
      console.warn('[CastToTV] Failed to send message', error);
    }
  };

  /**
   * 确保媒体元素有唯一标识符
   *
   * 为每个媒体元素分配一个 UUID，存储在 data-cast-to-tv-media-id 属性中
   * 这个 ID 在元素的整个生命周期内保持不变
   *
   * UUID 生成策略：
   * 1. 优先使用 crypto.randomUUID()（安全且标准）
   * 2. 回退到时间戳 + 随机数（兼容旧浏览器）
   *
   * @param {HTMLMediaElement} element - 媒体元素
   * @returns {string} 元素的唯一标识符
   */
  const ensureElementId = (element) => {
    if (!element.dataset.castToTvMediaId) {
      const uuid =
        (typeof crypto !== 'undefined' && crypto.randomUUID
          ? crypto.randomUUID()
          : `media-${Date.now()}-${Math.random().toString(16).slice(2)}`);
      element.dataset.castToTvMediaId = uuid;
    }
    return element.dataset.castToTvMediaId;
  };

  /**
   * 将相对 URL 转换为绝对 URL
   *
   * 媒体源 URL 可能是相对路径，需要转换为完整的绝对路径
   * 以便在 popup 中正确显示和识别
   *
   * @param {string} value - 可能是相对或绝对的 URL
   * @returns {string|null} 绝对 URL，解析失败返回 null
   */
  const toAbsoluteUrl = (value) => {
    if (!value) return null;
    try {
      // 使用 document.baseURI 作为基准，处理 <base> 标签的情况
      return new URL(value, document.baseURI).href;
    } catch {
      return null;
    }
  };

  /**
   * 获取媒体封面图片
   *
   * 按优先级尝试多个来源：
   * 1. Media Session API 的 artwork（现代网页播放器的标准）
   * 2. video 元素的 poster 属性
   * 3. 附近 DOM 结构中的缩略图（figure、.thumbnail、.cover 容器内的 img）
   *
   * 这种多重回退策略确保尽可能获取到封面图
   *
   * @param {HTMLMediaElement} element - 媒体元素
   * @returns {string|null} 封面图片的绝对 URL，未找到返回 null
   */
  const pickArtwork = (element) => {
    // 优先检查 Media Session API（许多现代播放器使用此 API）
    const sessionMeta = navigator.mediaSession?.metadata;
    if (sessionMeta?.artwork?.length) {
      const src = sessionMeta.artwork.find((item) => item.src)?.src;
      if (src) return toAbsoluteUrl(src);
    }

    // 检查 video 元素的 poster 属性
    if (element.poster) return toAbsoluteUrl(element.poster);

    // 尝试从附近的 DOM 结构中查找封面图
    // 许多播放器将缩略图放在 figure 或特定类名的容器中
    const img = element.closest('figure, .thumbnail, .cover')?.querySelector('img');
    if (img?.src) return toAbsoluteUrl(img.src);

    return null;
  };

  /**
   * 生成回退的媒体标题
   *
   * 当无法从元数据获取标题时，尝试从媒体 URL 提取文件名
   * 这确保每个媒体至少有一个可读的标识
   *
   * @param {HTMLMediaElement} element - 媒体元素
   * @returns {string} 从 URL 提取的标题，或页面标题/域名作为最后回退
   */
  const fallbackTitle = (element) => {
    const src = element.currentSrc || element.src;
    if (!src) return document.title || location.hostname;
    try {
      const url = new URL(src, location.href);
      // 提取 URL 路径的最后一部分作为文件名
      // filter(Boolean) 移除空字符串，pop() 获取最后一项
      // decodeURIComponent 解码 URL 编码的字符
      return decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() || url.host);
    } catch {
      return src;
    }
  };

  /**
   * 读取媒体标题
   *
   * 按优先级尝试多个来源：
   * 1. Media Session API 的 title（最准确）
   * 2. aria-label 属性（无障碍标签）
   * 3. title 属性
   * 4. data-title 自定义属性
   * 5. 从 URL 提取的文件名（回退）
   *
   * @param {HTMLMediaElement} element - 媒体元素
   * @returns {string} 媒体标题
   */
  const readMediaTitle = (element) => {
    const sessionMeta = navigator.mediaSession?.metadata;
    if (sessionMeta?.title) return sessionMeta.title;
    if (element.getAttribute('aria-label')) return element.getAttribute('aria-label');
    if (element.getAttribute('title')) return element.getAttribute('title');
    if (element.dataset.title) return element.dataset.title;
    return fallbackTitle(element);
  };

  /**
   * 读取媒体艺术家/作者信息
   *
   * 按优先级尝试：
   * 1. Media Session API 的 artist
   * 2. Media Session API 的 album（作为替代）
   * 3. data-artist 自定义属性
   * 4. 空字符串（表示未知）
   *
   * @param {HTMLMediaElement} element - 媒体元素
   * @returns {string} 艺术家名称，未找到返回空字符串
   */
  const readMediaArtist = (element) => {
    const sessionMeta = navigator.mediaSession?.metadata;
    if (sessionMeta?.artist) return sessionMeta.artist;
    if (sessionMeta?.album) return sessionMeta.album;
    if (element.dataset.artist) return element.dataset.artist;
    return '';
  };

  /**
   * 查找页面图标（favicon）
   *
   * 搜索 <link rel="icon"> 或 <link rel="shortcut icon"> 元素
   * 使用 i 修饰符进行大小写不敏感匹配
   *
   * @returns {string|null} favicon 的绝对 URL，未找到返回 null
   */
  function findPageIcon() {
    const iconLink = document.querySelector('link[rel~=\"icon\" i]');
    if (iconLink?.href) {
      return toAbsoluteUrl(iconLink.href);
    }
    return null;
  }

  /**
   * 页面图标（favicon）
   * 在脚本初始化时获取一次，作为会话的站点标识
   */
  const pageIcon = findPageIcon();

  /**
   * 序列化媒体元素状态
   *
   * 将 HTMLMediaElement 的当前状态提取为纯 JavaScript 对象
   * 这个对象包含 popup 展示所需的所有信息
   *
   * 数据验证：
   * - 使用 Number.isFinite() 确保数值有效
   * - 处理特殊情况（如直播流没有 duration）
   *
   * @param {HTMLMediaElement} element - 媒体元素
   * @returns {Object} 包含所有媒体状态的快照对象
   */
  const serializeElement = (element) => {
    const elementId = ensureElementId(element);

    // 验证 duration 是否为有效的有限数值
    // 直播流或未加载的媒体可能没有 duration
    const duration =
      Number.isFinite(element.duration) && element.duration > 0 ? element.duration : null;

    // 验证 currentTime，确保非负
    const currentTime =
      Number.isFinite(element.currentTime) && element.currentTime >= 0 ? element.currentTime : 0;

    // 确定媒体源 URL，回退到当前页面 URL
    const sourceUrl = toAbsoluteUrl(element.currentSrc || element.src || location.href);

    return {
      elementId,                                    // 唯一标识符
      title: readMediaTitle(element),               // 媒体标题
      artist: readMediaArtist(element),             // 艺术家/作者
      artwork: pickArtwork(element),                // 封面图片 URL
      origin: location.hostname,                    // 站点域名
      siteName,                                     // 站点名称
      pageTitle: document.title,                    // 页面标题
      favIcon: pageIcon,                            // 站点图标
      mediaKind: element.tagName.toLowerCase(),     // 媒体类型：'audio' 或 'video'
      sourceUrl,                                    // 媒体源 URL
      isPlaying: !element.paused && !element.ended, // 是否正在播放
      isEnded: element.ended || false,              // 是否已结束
      muted: element.muted,                         // 是否静音
      volume: Number.isFinite(element.volume) ? element.volume : 1,  // 音量（0-1）
      duration,                                     // 总时长（秒）
      currentTime,                                  // 当前播放位置（秒）
      playbackRate: element.playbackRate,           // 播放速率
      pipActive: document.pictureInPictureElement === element,  // 是否处于画中画模式
      canPlay: element.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA  // 是否可以播放
    };
  };

  /**
   * 立即发送媒体状态更新
   *
   * 序列化当前状态并发送给 background service worker
   *
   * @param {HTMLMediaElement} element - 媒体元素
   */
  const flushUpdate = (element) => {
    const elementId = ensureElementId(element);

    // 只有当前激活的元素才允许发送更新
    if (elementId !== activeMediaId) {
      return;
    }

    const payload = serializeElement(element);
    safeSendMessage({ type: MESSAGE_TYPES.MEDIA_UPDATE, payload });
  };

  /**
   * 调度媒体状态更新
   *
   * 使用 requestAnimationFrame 来批量处理更新，这样做的好处：
   * 1. 避免 timeupdate 事件（约 4 次/秒）导致的消息泛滥
   * 2. 与浏览器渲染周期同步，减少资源消耗
   * 3. 自动合并短时间内的多次更新
   *
   * @param {HTMLMediaElement} element - 媒体元素
   * @param {boolean} immediate - 是否立即发送（用于重要状态变化如 play/pause）
   */
  const scheduleUpdate = (element, immediate = false) => {
    const elementId = ensureElementId(element);

    // 立即模式：取消待处理的更新，直接发送
    // 用于播放/暂停等重要状态变化，需要即时反馈
    if (immediate) {
      if (pendingUpdates.has(elementId)) {
        cancelAnimationFrame(pendingUpdates.get(elementId));
        pendingUpdates.delete(elementId);
      }
      flushUpdate(element);
      return;
    }

    // 延迟模式：如果已有待处理的更新，跳过本次
    // 防止重复调度
    if (pendingUpdates.has(elementId)) {
      return;
    }

    // 使用 requestAnimationFrame 延迟到下一个渲染帧
    const rafId = requestAnimationFrame(() => {
      pendingUpdates.delete(elementId);
      flushUpdate(element);
    });

    pendingUpdates.set(elementId, rafId);
    pendingUpdates.set(elementId, rafId);
  };

  /**
   * 设置当前激活的媒体元素
   * 
   * 切换焦点逻辑：
   * 1. 如果有旧的激活元素，通知 background 移除它
   * 2. 更新 activeMediaId
   * 3. 立即发送新元素的状态
   * 
   * @param {HTMLMediaElement} element - 新的激活元素
   */
  const setActiveElement = (element) => {
    const newId = ensureElementId(element);

    // 如果已经是当前激活元素，不做任何操作
    if (activeMediaId === newId) {
      return;
    }

    // 1. 清理旧的激活元素
    if (activeMediaId) {
      // 取消旧元素的任何待处理更新
      if (pendingUpdates.has(activeMediaId)) {
        cancelAnimationFrame(pendingUpdates.get(activeMediaId));
        pendingUpdates.delete(activeMediaId);
      }
      // 通知 background 移除旧元素
      safeSendMessage({ type: MESSAGE_TYPES.MEDIA_REMOVED, payload: { elementId: activeMediaId } });
    }

    // 2. 设置新元素为激活状态
    activeMediaId = newId;

    // 3. 立即发送新元素状态
    scheduleUpdate(element, true);
  };

  /**
   * 注册媒体元素进行追踪
   *
   * 为新发现的媒体元素：
   * 1. 分配唯一 ID
   * 2. 添加所有必要的事件监听器
   * 3. 保存到追踪列表
   * 4. 立即发送初始状态
   *
   * @param {HTMLMediaElement} element - 要注册的媒体元素
   */
  const registerElement = (element) => {
    // 类型检查：确保是真正的媒体元素
    if (!(element instanceof HTMLMediaElement)) {
      return;
    }

    const elementId = ensureElementId(element);

    // 防止重复注册
    if (trackedElements.has(elementId)) {
      return;
    }

    /**
     * 统一的事件监听器
     *
     * 根据事件类型决定是立即发送还是延迟发送
     * timeupdate 是高频事件，使用延迟模式避免性能问题
     * 其他事件（如 play/pause）使用立即模式确保及时响应
     */
    const listener = (event) => {
      // 核心策略：播放事件触发焦点切换
      // 当用户点击播放，或页面自动播放新视频时，该视频成为新的激活元素
      if (event.type === 'play') {
        setActiveElement(element);
      }

      const isImmediate = event.type !== 'timeupdate';
      scheduleUpdate(element, isImmediate);
    };

    // 为所有相关事件添加监听器
    // 使用 capture 阶段（第三个参数为 true）确保能捕获到事件
    MEDIA_EVENTS.forEach((event) => element.addEventListener(event, listener, true));

    // 保存追踪信息
    trackedElements.set(elementId, { element, listener });

    // 初始激活策略：
    // 1. 如果当前没有激活元素，直接激活这个新元素
    // 2. 如果新元素正在播放，强制抢占激活权（处理自动播放场景）
    if (!activeMediaId || (!element.paused && !element.ended)) {
      setActiveElement(element);
    }
  };

  /**
   * 取消注册媒体元素
   *
   * 当媒体元素从 DOM 中移除时：
   * 1. 移除所有事件监听器（防止内存泄漏）
   * 2. 取消待处理的更新
   * 3. 从追踪列表中删除
   * 4. 清理元素上的自定义属性
   * 5. 通知 background 该媒体已移除
   *
   * @param {HTMLMediaElement} element - 要取消注册的媒体元素
   */
  const unregisterElement = (element) => {
    const elementId = element?.dataset?.castToTvMediaId;
    if (!elementId) return;

    const tracked = trackedElements.get(elementId);
    if (!tracked) return;

    // 移除所有事件监听器，防止内存泄漏
    MEDIA_EVENTS.forEach((event) =>
      tracked.element.removeEventListener(event, tracked.listener, true)
    );

    // 取消任何待处理的更新
    if (pendingUpdates.has(elementId)) {
      cancelAnimationFrame(pendingUpdates.get(elementId));
      pendingUpdates.delete(elementId);
    }

    // 从追踪列表中移除
    trackedElements.delete(elementId);

    // 清理元素上的自定义属性
    element.removeAttribute('data-cast-to-tv-media-id');

    // 如果移除的是当前激活元素，清理 activeMediaId
    if (activeMediaId === elementId) {
      activeMediaId = null;
      safeSendMessage({ type: MESSAGE_TYPES.MEDIA_REMOVED, payload: { elementId } });
    }
  };

  /**
   * 处理可能包含媒体元素的 DOM 节点
   *
   * 递归检查节点及其后代，对所有媒体元素执行指定操作
   * 用于处理 MutationObserver 检测到的 DOM 变化
   *
   * @param {Node} node - 要检查的 DOM 节点
   * @param {Function} action - 对媒体元素执行的操作（registerElement 或 unregisterElement）
   */
  const handlePossibleMediaNode = (node, action) => {
    // 只处理 Element 节点，忽略文本节点等
    if (!(node instanceof Element)) return;

    // 检查节点本身是否是媒体元素
    if (node.matches(MEDIA_QUERY)) {
      action(node);
    }

    // 递归检查所有后代元素
    node.querySelectorAll?.(MEDIA_QUERY)?.forEach(action);
  };

  /**
   * DOM 变化观察器
   *
   * 使用 MutationObserver API 监听 DOM 结构变化
   * 自动检测新添加或移除的媒体元素
   *
   * 这对于 SPA（单页应用）特别重要：
   * - 路由切换时新组件可能包含媒体
   * - 动态加载的内容可能添加媒体元素
   * - 页面更新可能移除旧的媒体元素
   */
  const mutationObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      // 处理新添加的节点：注册媒体元素
      mutation.addedNodes.forEach((node) => handlePossibleMediaNode(node, registerElement));
      // 处理移除的节点：取消注册媒体元素
      mutation.removedNodes.forEach((node) => handlePossibleMediaNode(node, unregisterElement));
    }
  });

  /**
   * 启动 DOM 观察
   *
   * 观察整个文档的子树变化
   * 优先使用 documentElement，回退到 body
   */
  const observerTarget = document.documentElement || document.body;
  if (observerTarget) {
    mutationObserver.observe(observerTarget, {
      childList: true,  // 监听子节点的添加和移除
      subtree: true     // 监听整个子树（包括所有后代）
    });
  }

  /**
   * 初始扫描：注册页面上已存在的所有媒体元素
   * 这处理了脚本注入时页面上已经存在的媒体
   */
  document.querySelectorAll(MEDIA_QUERY).forEach(registerElement);

  /**
   * 页面卸载清理
   *
   * 当页面即将卸载时（导航离开、关闭标签页等），
   * 取消注册所有媒体元素，确保：
   * - background 收到移除通知
   * - 没有悬挂的事件监听器
   * - 数据一致性
   *
   * 使用 pagehide 而不是 beforeunload：
   * - pagehide 更可靠，支持 BFCache
   * - beforeunload 可能被用户取消
   * - once: true 确保只执行一次
   */
  window.addEventListener(
    'pagehide',
    () => {
      const snapshot = Array.from(trackedElements.values());
      snapshot.forEach(({ element }) => unregisterElement(element));
    },
    { once: true }
  );

  /**
   * 媒体命令处理器映射
   *
   * 定义 popup 可以发送的所有控制命令
   * 每个命令对应一个处理函数
   */
  const commandHandlers = {
    /**
     * 切换播放/暂停状态
     *
     * 异步函数：element.play() 返回 Promise
     * 捕获错误以处理浏览器自动播放策略限制
     */
    [MEDIA_COMMANDS.TOGGLE_PLAY]: async (element) => {
      if (element.paused || element.ended) {
        // 播放可能因自动播放策略失败，静默处理错误
        await element.play().catch(() => { });
      } else {
        element.pause();
      }
    },

    /**
     * 相对跳转
     *
     * 基于当前位置前进或后退指定秒数
     * delta > 0 为快进，delta < 0 为快退
     */
    [MEDIA_COMMANDS.SEEK_RELATIVE]: (element, { delta = 0 }) => {
      if (!Number.isFinite(delta)) return;
      const target = element.currentTime + delta;
      seekTo(element, target);
    },

    /**
     * 绝对跳转
     *
     * 直接跳转到指定的时间点
     * 通常用于进度条拖动
     */
    [MEDIA_COMMANDS.SEEK_ABSOLUTE]: (element, { time = 0 }) => {
      if (!Number.isFinite(time)) return;
      seekTo(element, time);
    }
  };

  /**
   * 安全地设置播放位置
   *
   * 确保目标时间在有效范围内：
   * - 不小于 0
   * - 不超过总时长（如果已知）
   *
   * @param {HTMLMediaElement} element - 媒体元素
   * @param {number} targetTime - 目标时间（秒）
   */
  function seekTo(element, targetTime) {
    const duration =
      Number.isFinite(element.duration) && element.duration > 0 ? element.duration : null;

    let nextTime = targetTime;

    // 如果知道总时长，限制在有效范围内
    if (duration !== null) {
      nextTime = Math.min(Math.max(0, targetTime), duration);
    } else if (nextTime < 0) {
      // 至少确保不为负数
      nextTime = 0;
    }

    // 设置新的播放位置
    element.currentTime = nextTime;
  }

  /**
   * 监听来自 background 的控制命令
   *
   * 这是 content script 的入站消息处理器
   * 当用户在 popup 中操作时，命令通过以下路径到达：
   * Popup -> Background -> Content Script（这里）
   *
   * 命令格式：
   * {
   *   type: MESSAGE_TYPES.MEDIA_COMMAND,
   *   elementId: string,  // 目标媒体元素
   *   command: string,    // 命令类型
   *   delta?: number,     // 相对跳转秒数
   *   time?: number       // 绝对时间点
   * }
   */
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // 只处理媒体命令类型的消息
    if (message?.type !== MESSAGE_TYPES.MEDIA_COMMAND) {
      return;
    }

    const { elementId, command } = message;

    // 查找目标元素
    const tracked = trackedElements.get(elementId);

    // 验证元素存在且命令有效
    if (!tracked || !commandHandlers[command]) {
      sendResponse?.({ ok: false, error: 'unknown-element' });
      return;
    }

    // 执行命令，可能返回 Promise（如 play()）
    const maybePromise = commandHandlers[command](tracked.element, message);

    /**
     * 完成响应的辅助函数
     *
     * 发送响应并触发状态更新
     * 包装在 try-catch 中防止端口关闭错误
     */
    const finalize = (ok, error) => {
      try {
        sendResponse?.({ ok, error });
      } catch {
        // 忽略发送响应时的错误（端口可能已关闭）
      }
      // 命令执行后立即更新状态，确保 UI 同步
      scheduleUpdate(tracked.element, true);
    };

    // 处理异步命令（如 play()）
    if (maybePromise && typeof maybePromise.then === 'function') {
      maybePromise.then(() => finalize(true)).catch((err) => finalize(false, err?.message));
      // 返回 true 表示我们将异步发送响应
      return true;
    }

    // 同步命令直接完成
    finalize(true);
    // 返回 false 表示已同步发送响应
    return false;
  });
})();
