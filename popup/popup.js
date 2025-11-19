/**
 * CastToTV Popup 控制器
 *
 * 该模块负责管理扩展弹出窗口的所有功能，包括：
 * - 与后台服务建立持久连接
 * - 渲染媒体会话卡片列表
 * - 处理用户交互（播放/暂停、进度跳转等）
 * - 发送媒体控制命令到后台服务
 */
(() => {
  'use strict';

  // ========================================
  // 初始化与依赖检查
  // ========================================

  // 从全局作用域获取共享常量
  // MESSAGE_TYPES: 消息类型枚举
  // MEDIA_COMMANDS: 媒体控制命令枚举
  // PORT_NAMES: 端口名称枚举
  const { MESSAGE_TYPES, MEDIA_COMMANDS, PORT_NAMES } = self;

  // 检查必要的依赖是否存在
  // 如果 Chrome 运行时 API 或常量缺失，则无法正常工作
  if (!chrome?.runtime || !MESSAGE_TYPES || !PORT_NAMES) {
    console.error('[CastToTV] Popup failed to initialize (missing runtime or constants)');
    return;
  }

  // ========================================
  // DOM 元素引用缓存
  // ========================================

  // 缓存常用 DOM 元素的引用，避免重复查询
  const refs = {
    list: document.getElementById('media-list'),           // 媒体列表容器
    empty: document.getElementById('empty-state'),         // 空状态提示元素
    template: document.getElementById('media-card-template') // 媒体卡片模板
  };

  // ========================================
  // 状态管理
  // ========================================

  // 存储当前所有媒体会话的 Map
  // 键: sessionId (格式: "tabId:elementId")
  // 值: 会话数据对象
  const sessionMap = new Map();

  // 与后台服务的持久连接端口
  let port = null;

  // ========================================
  // 应用入口
  // ========================================

  // 初始化应用
  init();

  /**
   * 初始化函数
   * 建立与后台的连接并设置事件监听器
   */
  function init() {
    // 建立与后台服务的持久连接
    connectPort();

    // 使用事件委托处理列表内的所有点击事件
    refs.list.addEventListener('click', onListClick);

    // 监听进度条滑动输入（实时更新时间显示）
    refs.list.addEventListener('input', onSliderInput);

    // 监听进度条值改变完成（触发跳转命令）
    refs.list.addEventListener('change', onSliderCommit);
  }

  // ========================================
  // 通信层：与后台服务的消息传递
  // ========================================

  /**
   * 建立与后台服务的持久端口连接
   *
   * 使用持久连接（而非一次性消息）的优势：
   * - 后台可以主动推送会话更新
   * - 减少消息开销
   * - 连接断开时自动重连
   */
  function connectPort() {
    try {
      // 使用指定的端口名称建立连接
      port = chrome.runtime.connect({ name: PORT_NAMES.POPUP });
    } catch (error) {
      console.error('[CastToTV] Unable to open runtime port', error);
      return;
    }

    // 监听来自后台的消息
    port.onMessage.addListener(handlePortMessage);

    // 监听连接断开事件
    // 当 Service Worker 休眠或重启时会触发
    port.onDisconnect.addListener(() => {
      port = null;
      // 600ms 后尝试重新连接
      setTimeout(connectPort, 600);
    });
  }

  /**
   * 处理从后台服务接收的消息
   * @param {Object} message - 消息对象
   */
  function handlePortMessage(message) {
    // 仅处理会话更新类型的消息
    if (message?.type === MESSAGE_TYPES.SESSIONS_UPDATED) {
      updateSessions(message.sessions || []);
    }
  }

  // ========================================
  // 会话数据管理
  // ========================================

  /**
   * 更新本地会话数据并重新渲染 UI
   * @param {Array} sessions - 会话数据数组
   */
  function updateSessions(sessions) {
    // 清空旧数据
    sessionMap.clear();

    // 将新数据存入 Map，便于快速查找
    sessions.forEach((session) => sessionMap.set(session.sessionId, session));

    // 重新渲染界面
    renderSessions(sessions);
  }

  // ========================================
  // UI 渲染层
  // ========================================

  /**
   * 渲染所有媒体会话卡片
   * @param {Array} sessions - 会话数据数组
   */
  function renderSessions(sessions) {
    // 根据会话数量控制空状态提示的显示
    refs.empty.hidden = sessions.length > 0;

    // 如果没有会话，清空列表并返回
    if (!sessions.length) {
      refs.list.innerHTML = '';
      return;
    }

    // 使用 DocumentFragment 批量构建 DOM，提高性能
    const fragment = document.createDocumentFragment();
    sessions.forEach((session) => fragment.appendChild(buildCard(session)));

    // 一次性替换所有子元素
    refs.list.replaceChildren(fragment);
  }

  /**
   * 构建单个媒体会话卡片
   * @param {Object} session - 会话数据
   * @returns {HTMLElement} 构建好的卡片元素
   */
  function buildCard(session) {
    // 从模板克隆一个新的卡片节点
    const node = refs.template.content.firstElementChild.cloneNode(true);

    // 设置卡片的会话 ID（用于后续识别）
    node.dataset.sessionId = session.sessionId;

    // 根据播放状态切换样式类
    node.classList.toggle('media-card--inactive', !session.isPlaying);

    // ---- 封面图片 ----
    const artworkImg = node.querySelector('.media-card__artwork-img');
    // 优先使用会话提供的封面，否则使用占位图
    artworkImg.src = session.artwork || chrome.runtime.getURL('assets/artwork-placeholder.svg');
    artworkImg.alt = session.title || '媒体封面';

    // ---- 来源信息 ----
    const originText = node.querySelector('.media-card__origin-text');
    // 按优先级获取来源：origin > 从 URL 提取的主机名 > 站点名称 > 默认值
    const origin = session.origin || extractHost(session.sourceUrl) || session.siteName || '未知来源';
    originText.textContent = origin;

    // ---- 网站图标 ----
    const favicon = node.querySelector('.media-card__favicon');
    favicon.src = resolveFavicon(session);
    favicon.alt = origin;

    // ---- 标题 ----
    const titleEl = node.querySelector('.media-card__title');
    titleEl.textContent = session.title || '未命名媒体';
    titleEl.title = session.title || ''; // 鼠标悬停显示完整标题

    // ---- 艺术家/作者 ----
    const artistEl = node.querySelector('.media-card__artist');
    if (session.artist) {
      artistEl.textContent = session.artist;
      artistEl.title = session.artist;
      artistEl.hidden = false;
    } else {
      // 没有艺术家信息时隐藏该元素
      artistEl.hidden = true;
    }

    // ---- 播放状态 ----
    const statusEl = node.querySelector('.media-card__status');
    // 根据是否有时长和播放状态显示不同文本
    statusEl.textContent = session.duration
      ? session.isPlaying
        ? '播放中'
        : '已暂停'
      : '直播'; // 无时长表示直播流

    // ---- 播放/暂停按钮 ----
    const playButton = node.querySelector('.media-card__play');
    const playIcon = node.querySelector('.media-card__play-icon');
    // 根据播放状态显示不同图标
    playIcon.textContent = session.isPlaying ? '❚❚' : '▶';
    playButton.classList.toggle('is-paused', !session.isPlaying);

    // ---- 进度滑块和时间显示 ----
    const slider = node.querySelector('.media-card__slider');
    const elapsedEl = node.querySelector('.media-card__time--elapsed');
    const totalEl = node.querySelector('.media-card__time--total');

    // 检查是否有有效的时长
    const hasDuration = Number.isFinite(session.duration) && session.duration > 0;

    // 直播流禁用进度条
    slider.disabled = !hasDuration;

    if (hasDuration) {
      // 设置滑块的最大值和当前值
      slider.max = session.duration;
      slider.value = session.currentTime;
    } else {
      slider.value = 0;
    }

    // 显示已播放时间
    elapsedEl.textContent = formatTime(session.currentTime);
    // 显示总时长或"直播"标识
    totalEl.textContent = hasDuration ? formatTime(session.duration) : '直播';

    return node;
  }

  // ========================================
  // 工具函数
  // ========================================

  /**
   * 从 URL 中提取主机名
   * @param {string} url - 完整 URL
   * @returns {string} 主机名，失败时返回空字符串
   */
  function extractHost(url) {
    if (!url) return '';
    try {
      return new URL(url).hostname;
    } catch {
      // URL 解析失败时返回空字符串
      return '';
    }
  }

  /**
   * 解析网站图标 URL
   * @param {Object} session - 会话数据
   * @returns {string} 图标 URL
   */
  function resolveFavicon(session) {
    // 优先使用会话中提供的图标
    if (session.favIcon) return session.favIcon;

    // 尝试使用 Google 的 favicon 服务
    const domain = session.origin || extractHost(session.sourceUrl);
    if (domain) {
      return `https://www.google.com/s2/favicons?domain=${domain}&sz=64`;
    }

    // 回退到占位图标
    return chrome.runtime.getURL('assets/artwork-placeholder.svg');
  }

  /**
   * 将秒数格式化为可读的时间字符串
   * @param {number} seconds - 秒数
   * @returns {string} 格式化的时间字符串 (如 "1:23:45" 或 "3:45")
   */
  function formatTime(seconds) {
    // 处理无效输入
    if (!Number.isFinite(seconds) || seconds < 0) return '0:00';

    const totalSeconds = Math.floor(seconds);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const secs = totalSeconds % 60;

    // 如果有小时数，分钟数需要补零
    const mm = hours ? String(minutes).padStart(2, '0') : String(minutes);
    // 小时数前缀（如果存在）
    const prefix = hours ? `${hours}:` : '';

    // 秒数始终补零到两位
    return `${prefix}${mm}:${String(secs).padStart(2, '0')}`;
  }

  // ========================================
  // 事件处理器
  // ========================================

  /**
   * 处理列表内的点击事件（事件委托）
   * @param {Event} event - 点击事件对象
   */
  function onListClick(event) {
    // 查找被点击的按钮
    const button = event.target.closest('button');
    if (!button) return;

    // 查找按钮所属的媒体卡片
    const card = button.closest('.media-card');
    if (!card) return;

    // 获取会话 ID 并验证其有效性
    const sessionId = card.dataset.sessionId;
    if (!sessionMap.has(sessionId)) return;

    // 处理"打开标签页"按钮
    if (button.dataset.action === 'open-tab') {
      focusSessionTab(sessionId);
      return;
    }

    // 处理媒体控制按钮
    const command = button.dataset.command;
    if (!command) return;

    // 构建命令负载
    const payload = { command };

    // 如果是相对跳转命令，添加偏移量参数
    if (command === MEDIA_COMMANDS.SEEK_RELATIVE) {
      payload.delta = Number(button.dataset.delta) || 0;
    }

    // 发送命令到后台
    sendCommand(sessionId, payload);
  }

  /**
   * 处理进度条滑动输入事件（实时更新时间显示）
   * @param {Event} event - 输入事件对象
   */
  function onSliderInput(event) {
    // 确保事件来自进度条
    if (!event.target.classList.contains('media-card__slider')) return;

    // 查找对应的时间显示元素
    const card = event.target.closest('.media-card');
    const elapsedEl = card?.querySelector('.media-card__time--elapsed');
    if (!elapsedEl) return;

    // 实时更新已播放时间显示
    elapsedEl.textContent = formatTime(Number(event.target.value));
  }

  /**
   * 处理进度条值改变完成事件（触发跳转）
   * @param {Event} event - 改变事件对象
   */
  function onSliderCommit(event) {
    // 确保事件来自进度条
    if (!event.target.classList.contains('media-card__slider')) return;

    // 禁用状态的滑块不处理（如直播流）
    if (event.target.disabled) return;

    // 获取会话 ID 并验证
    const card = event.target.closest('.media-card');
    const sessionId = card?.dataset.sessionId;
    if (!sessionMap.has(sessionId)) return;

    // 获取目标时间并发送绝对跳转命令
    const time = Number(event.target.value);
    sendCommand(sessionId, { command: MEDIA_COMMANDS.SEEK_ABSOLUTE, time });
  }

  // ========================================
  // 命令发送
  // ========================================

  /**
   * 向后台服务发送媒体控制命令
   * @param {string} sessionId - 会话 ID
   * @param {Object} payload - 命令负载（包含 command 和其他参数）
   */
  function sendCommand(sessionId, payload) {
    // 检查连接状态和会话有效性
    if (!port || !sessionMap.has(sessionId)) return;

    // 通过端口发送消息
    port.postMessage({
      type: MESSAGE_TYPES.MEDIA_COMMAND,
      sessionId,
      ...payload
    });
  }

  // ========================================
  // 标签页操作
  // ========================================

  /**
   * 聚焦到指定会话所在的标签页
   * @param {string} sessionId - 会话 ID
   */
  async function focusSessionTab(sessionId) {
    const session = sessionMap.get(sessionId);
    if (!session) return;

    try {
      // 激活目标标签页
      await chrome.tabs.update(session.tabId, { active: true });

      // 获取标签页详情以确定其所属窗口
      const tab = await chrome.tabs.get(session.tabId);

      // 如果标签页在其他窗口，聚焦该窗口
      if (tab?.windowId !== undefined) {
        await chrome.windows.update(tab.windowId, { focused: true });
      }

      // 关闭弹出窗口
      window.close();
    } catch (error) {
      console.warn('[CastToTV] 无法切换到标签页', error);
    }
  }
})();
