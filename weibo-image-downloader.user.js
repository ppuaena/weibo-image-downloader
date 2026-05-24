// ==UserScript==
// @name         微博原图下载器
// @namespace    https://github.com/sun27/weibo-image-downloader
// @version      5.0.0
// @description  在微博网页版选中特定贴文，一键下载其原图
// @author       You
// @match        https://weibo.com/*
// @match        https://www.weibo.com/*
// @grant        GM_xmlhttpRequest
// @connect      *
// ==/UserScript==

(function () {
  'use strict';

  var selectionMode = false;
  var postOverlays = [];
  var logLines = [];

  // ---- 日志 ----
  function log(msg, type) {
    type = type || 'info';
    var time = new Date().toLocaleTimeString();
    logLines.push({ time: time, msg: msg, type: type });
    if (logLines.length > 50) logLines.shift();
    console.log('[WB_DL] ' + msg);
    renderLog();
  }

  function renderLog() {
    var el = document.getElementById('wbdl-log');
    if (!el) return;
    el.innerHTML = logLines.map(function (l) {
      var color = l.type === 'error' ? '#e74c3c' : l.type === 'success' ? '#27ae60' : l.type === 'highlight' ? '#e67e22' : '#333';
      return '<div style="color:' + color + ';font-size:11px;line-height:1.5">[' + l.time + '] ' + l.msg + '</div>';
    }).join('');
    el.scrollTop = el.scrollHeight;
  }

  // ---- 图片查找 ----
  function isValidImage(img) {
    var src = img.src || img.getAttribute('data-src') || img.getAttribute('data-original') || '';
    if (!src || src.indexOf('sinaimg.cn') === -1) return false;
    if (src.indexOf('h5.sinaimg.cn') !== -1) return false;
    if (src.indexOf('a.sinaimg.cn') !== -1) return false;
    var w = img.naturalWidth || img.width || 0;
    var h = img.naturalHeight || img.height || 0;
    if (w > 0 && h > 0 && (w < 120 || h < 120)) return false;
    if (img.closest('[class*="avatar"], [class*="Avatar"], [class*="emoji"], [class*="Emoji"]')) return false;
    return true;
  }

  function toOriginalUrl(url) {
    var re = /^(https?:\/\/[^/]+\.sinaimg\.cn\/)([^/]+)(\/[^?]+)/i;
    var m = url.match(re);
    if (!m) return url;
    return m[1] + 'original' + m[3];
  }

  function getFileName(url) {
    try {
      var path = new URL(url).pathname;
      var name = path.split('/').pop();
      if (name && name.match(/\.[a-z0-9]+$/i)) return name;
      return (name || 'image') + '.jpg';
    } catch (e) {
      return 'image.jpg';
    }
  }

  // 找到 img 所属的贴文容器节点
  function findPostContainer(img) {
    var el = img.parentElement;
    var depth = 0;
    while (el && el !== document.body && depth < 12) {
      var tag = el.tagName ? el.tagName.toLowerCase() : '';
      var cls = el.className ? (typeof el.className === 'string' ? el.className : '') : '';

      // article 标签几乎就是一条贴文
      if (tag === 'article') return el;

      // 匹配常见的贴文容器 class
      if (cls && (
        cls.indexOf('Feed_body') !== -1 ||
        cls.indexOf('card-feed') !== -1 ||
        cls.indexOf('card-wrap') !== -1 ||
        cls.indexOf('WB_feed') !== -1 ||
        cls.indexOf('feed_content') !== -1 ||
        cls.indexOf('detail_wbtext') !== -1 ||
        cls.indexOf('mwb-detail') !== -1 ||
        cls.indexOf('woo-box') !== -1
      )) {
        return el;
      }

      el = el.parentElement;
      depth++;
    }
    // 兜底：返回 img 的曾祖父元素
    var fallback = img.parentElement;
    for (var i = 0; i < 4 && fallback && fallback !== document.body; i++) {
      fallback = fallback.parentElement;
    }
    return fallback || img.parentElement;
  }

  // 获取所有贴文容器及其包含的图片
  function getPostGroups() {
    var allImgs = document.querySelectorAll('img');
    var containerMap = new Map();
    var seen = new Set();

    for (var i = 0; i < allImgs.length; i++) {
      var img = allImgs[i];
      if (!isValidImage(img)) continue;
      var src = img.src || img.getAttribute('data-src') || '';
      if (seen.has(src)) continue;
      seen.add(src);

      var container = findPostContainer(img);
      var key = getElementSignature(container);

      if (!containerMap.has(key)) {
        containerMap.set(key, { container: container, images: [] });
      }
      containerMap.get(key).images.push({
        original: toOriginalUrl(src),
        fileName: getFileName(src),
      });
    }

    return Array.from(containerMap.values());
  }

  // 生成元素的唯一标识（用于去重）
  function getElementSignature(el) {
    var parts = [];
    var maxDepth = 3;
    while (el && el !== document.body && maxDepth > 0) {
      var tag = el.tagName ? el.tagName.toLowerCase() : '';
      var cls = '';
      if (el.classList && el.classList.length > 0) {
        cls = '.' + Array.from(el.classList).slice(0, 3).join('.');
      }
      var id = el.id ? '#' + el.id : '';
      parts.push(tag + id + cls);
      el = el.parentElement;
      maxDepth--;
    }
    return parts.join('>');
  }

  // ---- 下载逻辑 ----
  function downloadWithGM(imgInfo) {
    return new Promise(function (resolve) {
      var url = imgInfo.original;
      GM_xmlhttpRequest({
        method: 'GET',
        url: url,
        responseType: 'blob',
        timeout: 20000,
        headers: { 'Referer': 'https://weibo.com/' },
        onload: function (r) {
          if (r.status === 200 && r.response && r.response.size > 500) {
            var name = String(imgInfo.index).padStart(String(imgInfo.total).length, '0') + '_' + imgInfo.fileName;
            triggerBlobDownload(r.response, name);
            resolve('success');
          } else {
            resolve('fail');
          }
        },
        onerror: function () { resolve('fail'); },
        ontimeout: function () { resolve('fail'); },
      });
    });
  }

  function triggerBlobDownload(blob, name) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 2000);
    log('  已下载: ' + name, 'success');
  }

  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  async function downloadImages(images) {
    var success = 0;
    var fail = 0;
    for (var j = 0; j < images.length; j++) {
      images[j].index = j + 1;
      images[j].total = images.length;
      log('--- [' + (j + 1) + '/' + images.length + '] ---');
      var url = images[j].original;
      log('  ' + url.substring(0, 90));
      var result = await downloadWithGM(images[j]);
      if (result === 'success') success++;
      else fail++;
      await sleep(800);
    }
    return { success: success, fail: fail };
  }

  // 下载全部贴文
  async function downloadAll() {
    exitSelectionMode();
    logLines = [];
    log('===== 下载全部贴文 =====');

    var groups = getPostGroups();
    var allImages = [];
    groups.forEach(function (g) {
      g.images.forEach(function (img) { allImages.push(img); });
    });

    if (allImages.length === 0) {
      log('未找到图片', 'error');
      return;
    }

    log('共 ' + groups.length + ' 条贴文，' + allImages.length + ' 张图片');
    var result = await downloadImages(allImages);
    log('===== 完成! 成功 ' + result.success + ' / 失败 ' + result.fail + ' =====',
      result.success === allImages.length ? 'success' : 'info');
  }

  // 下载单条贴文
  async function downloadPost(container) {
    exitSelectionMode();
    logLines = [];
    log('===== 下载选中贴文 =====');

    var images = [];
    var imgs = container.querySelectorAll('img');
    var seen = new Set();

    for (var i = 0; i < imgs.length; i++) {
      if (!isValidImage(imgs[i])) continue;
      var src = imgs[i].src || imgs[i].getAttribute('data-src') || '';
      if (seen.has(src)) continue;
      seen.add(src);
      images.push({
        original: toOriginalUrl(src),
        fileName: getFileName(src),
      });
    }

    if (images.length === 0) {
      log('该贴文未找到图片', 'error');
      return;
    }

    log('该贴文共 ' + images.length + ' 张图片');
    var result = await downloadImages(images);
    log('===== 完成! 成功 ' + result.success + ' / 失败 ' + result.fail + ' =====',
      result.success === images.length ? 'success' : 'info');
  }

  // ---- 选择模式 UI ----
  function enterSelectionMode() {
    if (selectionMode) return;
    selectionMode = true;
    updateSelectBtn();

    var groups = getPostGroups();
    log('选择模式: 检测到 ' + groups.length + ' 条贴文', 'highlight');
    log('点击贴文右上角的下载按钮下载该贴文图片');
    log('按 Esc 或再次点击"选择贴文"退出');

    groups.forEach(function (group, idx) {
      var overlay = createPostOverlay(group, idx);
      postOverlays.push(overlay);
    });

    document.addEventListener('keydown', onKeyDown);
  }

  function exitSelectionMode() {
    selectionMode = false;
    updateSelectBtn();

    postOverlays.forEach(function (o) {
      if (o && o.parentNode) o.parentNode.removeChild(o);
    });
    postOverlays = [];

    document.removeEventListener('keydown', onKeyDown);
  }

  function toggleSelectionMode() {
    if (selectionMode) {
      exitSelectionMode();
      log('已退出选择模式');
    } else {
      enterSelectionMode();
    }
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') {
      exitSelectionMode();
      log('已退出选择模式 (Esc)');
    }
  }

  function createPostOverlay(group, idx) {
    var container = group.container;
    var count = group.images.length;

    // 让容器成为定位参考
    var origPosition = container.style.position;
    if (!origPosition || origPosition === 'static') {
      container.style.position = 'relative';
    }

    var overlay = document.createElement('div');
    overlay.className = 'wbdl-post-overlay';
    overlay.style.cssText =
      'position:absolute;top:0;right:0;z-index:9999;pointer-events:none;';

    var btn = document.createElement('button');
    btn.textContent = '下载 (' + count + '图)';
    btn.style.cssText =
      'pointer-events:auto;padding:5px 10px;border:none;border-radius:0 0 0 8px;' +
      'cursor:pointer;font-size:12px;font-weight:600;background:#ff8200;color:#fff;' +
      'opacity:0.88;transition:opacity 0.15s;white-space:nowrap;';
    btn.addEventListener('mouseenter', function () { btn.style.opacity = '1'; });
    btn.addEventListener('mouseleave', function () { btn.style.opacity = '0.88'; });
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      e.preventDefault();
      downloadPost(container);
    });

    overlay.appendChild(btn);
    container.appendChild(overlay);

    // 鼠标悬停时高亮容器边框
    container.addEventListener('mouseenter', function () {
      container.style.outline = '2px dashed #ff8200';
      container.style.outlineOffset = '-2px';
    });
    container.addEventListener('mouseleave', function () {
      container.style.outline = '';
      container.style.outlineOffset = '';
    });

    return overlay;
  }

  // ---- 面板 ----
  function updateSelectBtn() {
    var btn = document.getElementById('wbdl-btn-select');
    if (!btn) return;
    if (selectionMode) {
      btn.textContent = '退出选择';
      btn.style.background = '#e74c3c';
    } else {
      btn.textContent = '选择贴文';
      btn.style.background = '#5865f2';
    }
  }

  function createPanel() {
    var panel = document.createElement('div');
    panel.id = 'wbdl-panel';
    panel.innerHTML =
      '<div style="display:flex;gap:6px;margin-bottom:8px;flex-wrap:wrap">' +
        '<button id="wbdl-btn-dl" style="flex:1;min-width:70px;padding:8px;border:none;border-radius:6px;cursor:pointer;font-size:13px;font-weight:600;background:#ff8200;color:#fff">下载全部</button>' +
        '<button id="wbdl-btn-select" style="flex:1;min-width:70px;padding:8px;border:none;border-radius:6px;cursor:pointer;font-size:13px;font-weight:600;background:#5865f2;color:#fff">选择贴文</button>' +
        '<button id="wbdl-btn-clear" style="padding:8px 10px;border:none;border-radius:6px;cursor:pointer;font-size:12px;background:#eee;color:#666">清空</button>' +
      '</div>' +
      '<div id="wbdl-log" style="max-height:300px;overflow-y:auto;background:#f8f8f8;border-radius:6px;padding:8px;font-family:Consolas,monospace;font-size:11px"></div>';

    panel.style.cssText =
      'position:fixed;bottom:60px;right:16px;z-index:99999;width:440px;max-height:400px;' +
      'background:#fff;border:1px solid #ddd;border-radius:10px;padding:10px;' +
      'box-shadow:0 4px 20px rgba(0,0,0,0.15);font-family:-apple-system,BlinkMacSystemFont,sans-serif;';

    document.body.appendChild(panel);

    document.getElementById('wbdl-btn-dl').addEventListener('click', downloadAll);
    document.getElementById('wbdl-btn-select').addEventListener('click', toggleSelectionMode);
    document.getElementById('wbdl-btn-clear').addEventListener('click', function () {
      logLines = [];
      renderLog();
    });
  }

  // ---- 初始化 ----
  function init() {
    createPanel();
    log('微博原图下载器 v5.0.0 已加载');
    log('「下载全部」: 下载页面所有贴文图片');
    log('「选择贴文」: 进入选择模式，点击贴文上的按钮下载单条');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
