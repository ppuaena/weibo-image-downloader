// ==UserScript==
// @name         微博原图下载器
// @namespace    https://github.com/sun27/weibo-image-downloader
// @version      5.1.0
// @description  在微博网页版选中特定贴文，一键下载其原图（支持长文展开、滚动自动发现）
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
  var scrollObserver = null;
  var overlayIndex = 0;

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

  function findPostContainer(img) {
    var article = img.closest('article');
    if (article) return article;
    var el = img.closest('[class*="Feed_body"], [class*="card-feed"], [class*="wbpro-feed"], [class*="WB_feed"], [class*="detail_wbtext"]');
    if (el) return el;
    var fallback = img.parentElement;
    for (var i = 0; i < 4 && fallback && fallback !== document.body; i++) {
      fallback = fallback.parentElement;
    }
    return fallback || img.parentElement;
  }

  // ---- 长贴文展开 ----
  function expandPost(container) {
    // 查找"展开全文"按钮（多种可能的文案）
    var expandSelectors = [
      '[class*="expand"]', '[class*="unfold"]', '[class*="fold"]',
      '[class*="full_text"]', '[class*="fulltext"]',
      '[class*="_expand"]', '[class*="_unfold"]',
      'a[action-type="fl_unfold"]', 'a[action-type="fl_fold"]',
    ];

    var clicked = 0;
    for (var s = 0; s < expandSelectors.length; s++) {
      var btns = container.querySelectorAll(expandSelectors[s]);
      for (var b = 0; b < btns.length; b++) {
        var btn = btns[b];
        // 只点"展开"，不点"收起"
        var text = (btn.textContent || '').trim();
        if (text.indexOf('收起') !== -1) continue;
        if (text.indexOf('展开') !== -1 || text.indexOf('全文') !== -1 || text.indexOf('更多') !== -1) {
          try { btn.click(); clicked++; } catch (e) {}
        } else if (btn.offsetParent !== null && btn.offsetWidth > 0) {
          // 可见的展开按钮，文案可能不同，尝试点击
          try { btn.click(); clicked++; } catch (e) {}
        }
      }
    }

    return clicked;
  }

  // 从容器中提取所有图片信息
  function extractImages(container) {
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
    return images;
  }

  // ---- 获取贴文分组 ----
  var containerIdCounter = 0;

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
      var cid = container.getAttribute('data-wbdl-cid');
      if (!cid) {
        cid = 'c' + (++containerIdCounter);
        container.setAttribute('data-wbdl-cid', cid);
      }

      if (!containerMap.has(cid)) {
        containerMap.set(cid, { container: container, images: [] });
      }
      containerMap.get(cid).images.push({
        original: toOriginalUrl(src),
        fileName: getFileName(src),
      });
    }

    return Array.from(containerMap.values());
  }

  // 获取单个 container 的信息（不去重全页）
  function getPostGroupFor(container) {
    var cid = container.getAttribute('data-wbdl-cid');
    if (!cid) {
      cid = 'c' + (++containerIdCounter);
      container.setAttribute('data-wbdl-cid', cid);
    }
    return { container: container, images: extractImages(container) };
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
      log('  ' + images[j].original.substring(0, 90));
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

  // 下载单条贴文（先展开长文）
  async function downloadPost(container) {
    exitSelectionMode();
    logLines = [];
    log('===== 下载选中贴文 =====');

    // 展开长贴文
    var expanded = expandPost(container);
    if (expanded > 0) {
      log('已展开 ' + expanded + ' 处折叠内容，等待图片加载...');
      await sleep(1500); // 等懒加载图片渲染
    }

    var images = extractImages(container);

    if (images.length === 0) {
      log('该贴文未找到图片', 'error');
      return;
    }

    log('该贴文共 ' + images.length + ' 张图片');
    var result = await downloadImages(images);
    log('===== 完成! 成功 ' + result.success + ' / 失败 ' + result.fail + ' =====',
      result.success === images.length ? 'success' : 'info');
  }

  // ---- 滚动自动发现 ----
  function startScrollObserver() {
    if (scrollObserver) return;

    // 找到虚拟滚动的容器
    var scroller = document.querySelector('#scroller') || document.querySelector('[class*="scroller"]') || document.querySelector('main') || document.body;

    scrollObserver = new MutationObserver(function (mutations) {
      var newArticles = [];
      mutations.forEach(function (m) {
        m.addedNodes.forEach(function (node) {
          if (node.nodeType !== 1) return;
          // 新增的 article 或其内部的 article
          if (node.tagName === 'ARTICLE') {
            newArticles.push(node);
          } else if (node.querySelectorAll) {
            var articles = node.querySelectorAll('article');
            for (var a = 0; a < articles.length; a++) {
              newArticles.push(articles[a]);
            }
          }
        });
      });

      if (newArticles.length > 0) {
        // 去重
        var uniqueArticles = [];
        var seenIds = new Set();
        newArticles.forEach(function (art) {
          var cid = art.getAttribute('data-wbdl-cid') || '';
          if (cid && seenIds.has(cid)) return;
          if (cid) seenIds.add(cid);
          uniqueArticles.push(art);
        });

        uniqueArticles.forEach(function (art) {
          // 检查是否已有 overlay
          if (art.querySelector('.wbdl-post-overlay')) return;
          var group = getPostGroupFor(art);
          if (group.images.length === 0) return;
          var overlay = createPostOverlay(group);
          postOverlays.push(overlay);
          log('  发现新贴文: ' + group.images.length + '图');
        });
      }
    });

    scrollObserver.observe(scroller, { childList: true, subtree: true });
    log('滚动监听已开启，新贴文将自动添加下载按钮');
  }

  function stopScrollObserver() {
    if (scrollObserver) {
      scrollObserver.disconnect();
      scrollObserver = null;
    }
  }

  // ---- 选择模式 UI ----
  function enterSelectionMode() {
    if (selectionMode) return;
    selectionMode = true;
    updateSelectBtn();

    var groups = getPostGroups();
    log('选择模式: 检测到 ' + groups.length + ' 条贴文', 'highlight');
    groups.forEach(function (g, i) {
      var tag = g.container.tagName ? g.container.tagName.toLowerCase() : '';
      var cls = g.container.className ? (typeof g.container.className === 'string' ? g.container.className.substring(0, 60) : '') : '';
      log('  贴文' + (i + 1) + ': <' + tag + (cls ? ' class="' + cls + '"' : '') + '> ' + g.images.length + '图');
    });
    log('点击贴文右上角的下载按钮下载该贴文图片');
    log('按 Esc 或再次点击"选择贴文"退出');

    groups.forEach(function (group) {
      var overlay = createPostOverlay(group);
      postOverlays.push(overlay);
    });

    document.addEventListener('keydown', onKeyDown);

    // 启动滚动监听
    startScrollObserver();
  }

  function exitSelectionMode() {
    selectionMode = false;
    updateSelectBtn();
    stopScrollObserver();

    postOverlays.forEach(function (o) {
      if (o && o.parentNode) {
        o.parentNode.style.outline = '';
        o.parentNode.style.outlineOffset = '';
        o.parentNode.removeChild(o);
      }
    });
    postOverlays = [];

    var marked = document.querySelectorAll('[data-wbdl-cid]');
    for (var i = 0; i < marked.length; i++) {
      marked[i].removeAttribute('data-wbdl-cid');
    }

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

  function createPostOverlay(group) {
    var container = group.container;
    var count = group.images.length;

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
    log('微博原图下载器 v5.1.0 已加载');
    log('「下载全部」: 下载页面所有贴文图片');
    log('「选择贴文」: 进入选择模式，滚动自动发现新贴文');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
