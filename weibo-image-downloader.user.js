// ==UserScript==
// @name         微博原图下载器
// @namespace    https://github.com/sun27/weibo-image-downloader
// @version      5.6.0
// @description  微博原图下载：按贴文/日期整理，自动展开长文折图动图，下载失败自动重试
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

  // ---- 提取贴文发布日期 ----
  function getPostDate(container) {
    // 查找时间元素：<a class="*time*" title="2026-05-24 18:40">
    var timeEl = container.querySelector('a[class*="time"][title], a[class*="_time"][title], time[datetime]');
    if (!timeEl) {
      // 备用：查找任何带日期格式 title 的元素
      var allWithTitle = container.querySelectorAll('[title]');
      for (var i = 0; i < allWithTitle.length; i++) {
        var t = allWithTitle[i].getAttribute('title');
        if (t && /^\d{4}-\d{2}-\d{2}/.test(t)) {
          timeEl = allWithTitle[i];
          break;
        }
      }
    }
    if (!timeEl) return '';

    var dateStr = timeEl.getAttribute('title') || timeEl.getAttribute('datetime') || '';
    var match = dateStr.match(/^(\d{4}-\d{2}-\d{2})/);
    return match ? match[1] : '';
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

  // 展开被折叠的图片（超过 9 张时微博只显示前 9 张）
  function expandFoldedImages(container) {
    var clicked = 0;
    // 查找"+N"展开元素（_picNum 是微博新版的折叠计数标签）
    var expandBtns = container.querySelectorAll(
      '[class*="picNum"], [class*="pic_num"], ' +
      '[class*="photo_more"], [class*="img_more"], [class*="pic_more"], ' +
      '[class*="fold_"], [class*="expand_pic"], [class*="show_all"], ' +
      '[action-type="fl_pics"]'
    );
    for (var i = 0; i < expandBtns.length; i++) {
      if (expandBtns[i].offsetParent !== null) {
        try { expandBtns[i].click(); clicked++; } catch (e) {}
      }
    }
    // 同时通过文本内容查找"+N"元素（不限于 first round）
    var allSpans = container.querySelectorAll('span, div');
    for (var j = 0; j < allSpans.length; j++) {
      var t = (allSpans[j].textContent || '').trim();
      if (t && /^\+?\d+$/.test(t) && allSpans[j].offsetParent !== null) {
        try { allSpans[j].click(); clicked++; } catch (e) {}
      }
    }
    return clicked;
  }

  // 判断是否为视频缩略图
  function isVideoThumbnail(img) {
    // 图片本身有播放相关 class
    if (img.className && typeof img.className === 'string') {
      if (/video|play|player/i.test(img.className)) return true;
    }
    // 父级或祖先有视频/播放相关标记
    var parent = img.closest('[class*="video"], [class*="Video"], [class*="play_wrap"], [class*="play-wrap"]');
    if (parent) return true;
    // 兄弟元素有播放图标
    var wrapper = img.parentElement;
    if (wrapper) {
      var playIcon = wrapper.querySelector('i[class*="play"], span[class*="play"], [class*="play_icon"], [class*="playIcon"], [class*="video_icon"]');
      if (playIcon && playIcon.offsetParent !== null) return true;
    }
    // img 自身 src 包含 video 关键字
    var src = img.src || '';
    if (/video|Video|VIDEO/i.test(src)) return true;
    return false;
  }

  // 从容器中提取所有图片/动图信息
  function extractImages(container) {
    var images = [];
    var seen = new Set();

    // 扫描 img 标签：检查 src + 所有可能存 GIF URL 的属性
    var imgs = container.querySelectorAll('img');
    for (var i = 0; i < imgs.length; i++) {
      var img = imgs[i];

      // 跳过视频缩略图
      if (isVideoThumbnail(img)) continue;

      // 尝试多个属性获取最佳 URL
      var candidateUrls = [
        img.getAttribute('data-gifsrc'),
        img.getAttribute('gifsrc'),
        img.getAttribute('data-gif'),
        img.getAttribute('data-original'),
        img.getAttribute('data-src'),
        img.src,
      ];
      var bestUrl = '';
      for (var u = 0; u < candidateUrls.length; u++) {
        var uu = candidateUrls[u];
        if (uu && uu.indexOf('sinaimg.cn') !== -1) {
          bestUrl = uu;
          // 优先用 .gif 的 URL
          if (uu.toLowerCase().indexOf('.gif') !== -1) break;
        }
      }

      if (!bestUrl || seen.has(bestUrl)) continue;
      if (bestUrl.indexOf('h5.sinaimg.cn') !== -1 || bestUrl.indexOf('a.sinaimg.cn') !== -1) continue;

      // 放宽尺寸限制：动图缩略图可能较小
      var w = img.naturalWidth || img.width || 0;
      var h = img.naturalHeight || img.height || 0;
      var isGif = bestUrl.toLowerCase().indexOf('.gif') !== -1;
      if (!isGif && w > 0 && h > 0 && (w < 120 || h < 120)) continue;
      if (img.closest('[class*="avatar"], [class*="Avatar"], [class*="emoji"], [class*="Emoji"]')) continue;

      seen.add(bestUrl);
      images.push({
        original: toOriginalUrl(bestUrl),
        pageSrc: bestUrl,
        fileName: getFileName(bestUrl),
      });
    }

    // 2. 扫描 video 标签（微博将 GIF 转 mp4，poster 是原始 GIF）
    var videos = container.querySelectorAll('video[class*="vertVideoImage"], video[poster*="sinaimg.cn"]');
    for (var v = 0; v < videos.length; v++) {
      var poster = videos[v].getAttribute('poster');
      if (!poster || seen.has(poster)) continue;
      if (poster.indexOf('sinaimg.cn') === -1) continue;

      seen.add(poster);
      images.push({
        original: toOriginalUrl(poster),
        pageSrc: poster,
        fileName: getFileName(poster),
      });
    }

    return images;
  }

  // 激活容器内的动图（点击播放按钮）
  function activateGifs(container) {
    var clicked = 0;
    // 微博动图播放按钮常见 class / 属性
    var triggers = container.querySelectorAll(
      '[class*="play_gif"], [class*="playGif"], [class*="gif_play"], ' +
      '[class*="video_play"], [class*="gif-play"], [class*="GIF"],' +
      '[action-type="fl_gif"], [action-type="feed_list_gif"], ' +
      'i[class*="play"]'
    );
    for (var i = 0; i < triggers.length; i++) {
      var t = triggers[i];
      if (t.offsetParent !== null && t.offsetWidth > 0) {
        try { t.click(); clicked++; } catch (e) {}
      }
    }
    return clicked;
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
        pageSrc: src,
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

  // 生成回退 URL（原图 → large → mw690 → 页面原始尺寸）
  function getFallbackUrls(originalUrl, pageSrc) {
    var urls = [originalUrl];
    var re = /^(https?:\/\/[^/]+\.sinaimg\.cn\/)([^/]+)(\/[^?]+)/i;
    var m = originalUrl.match(re);
    if (!m) {
      if (pageSrc && pageSrc !== originalUrl) urls.push(pageSrc);
      return urls;
    }
    var currentSize = m[2];
    var fallbacks = ['large', 'mw690'];
    for (var f = 0; f < fallbacks.length; f++) {
      if (currentSize !== fallbacks[f]) {
        urls.push(m[1] + fallbacks[f] + m[3]);
      }
    }
    // 最后兜底：页面上的原始 URL（已知可访问）
    if (pageSrc && pageSrc !== originalUrl) {
      urls.push(pageSrc);
    }
    return urls;
  }

  function downloadWithGM(imgInfo) {
    return new Promise(function (resolve) {
      var url = imgInfo.url || imgInfo.original;
      GM_xmlhttpRequest({
        method: 'GET',
        url: url,
        responseType: 'blob',
        timeout: 20000,
        headers: { 'Referer': 'https://weibo.com/' },
        onload: function (r) {
          if (r.status === 200 && r.response && r.response.size > 500) {
            var prefix = String(imgInfo.index).padStart(String(imgInfo.total).length, '0');
            var folder = imgInfo.date ? imgInfo.date + '/' : '';
            var name = folder + prefix + '_' + imgInfo.fileName;
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
    var MAX_ROUNDS = 3;
    var pending = images.slice(); // 复制一份，后续会修改
    var success = 0;
    var fail = 0;
    var globalIndex = 0;

    // 为每张图片初始化回退 URL 列表
    pending.forEach(function (img) {
      img.fallbackUrls = getFallbackUrls(img.original, img.pageSrc);
      img.fallbackIdx = 0;
      img.url = img.fallbackUrls[0];
      img.retryCount = 0;
    });

    for (var round = 1; round <= MAX_ROUNDS; round++) {
      if (pending.length === 0) break;

      if (round === 1) {
        log('===== 第 1 轮下载 (' + pending.length + ' 张) =====');
      } else {
        log('===== 第 ' + round + ' 轮重试 (' + pending.length + ' 张，降低画质) =====', 'highlight');
      }

      var stillPending = [];
      for (var j = 0; j < pending.length; j++) {
        var img = pending[j];
        globalIndex++;
        img.index = globalIndex;
        img.total = images.length;
        img.retryCount++;

        var qualityLabel = ['original', 'large', 'mw690', 'page'][img.fallbackIdx] || 'fallback';
        log('--- [' + img.index + '/' + img.total + ']' + (img.retryCount > 1 ? ' 重试#' + img.retryCount + ' [' + qualityLabel + ']' : ''));
        log('  ' + img.url.substring(0, 90));

        var result = await downloadWithGM(img);
        if (result === 'success') {
          success++;
          log('  下载成功 [' + qualityLabel + ']', 'success');
        } else {
          // 尝试下一个回退 URL
          img.fallbackIdx++;
          if (img.fallbackIdx < img.fallbackUrls.length) {
            img.url = img.fallbackUrls[img.fallbackIdx];
            stillPending.push(img);
            var nextLabel = ['large', 'mw690', 'page'][img.fallbackIdx - 1] || 'fallback';
            log('  失败，将用 [' + nextLabel + '] 重试', 'error');
          } else {
            fail++;
            log('  最终失败 — 所有画质级别均不可用', 'error');
          }
        }
        await sleep(600);
      }

      pending = stillPending;
      if (pending.length > 0 && round < MAX_ROUNDS) {
        log('等待 2 秒后开始下一轮重试...');
        await sleep(2000);
      }
    }

    if (fail > 0) {
      log(fail + ' 张图片下载失败（已尝试 original/large/mw690）', 'error');
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

    for (var g = 0; g < groups.length; g++) {
      var container = groups[g].container;
      expandPost(container);
      expandFoldedImages(container);
      var gifClicked = activateGifs(container);
      if (gifClicked > 0) { log('  激活 ' + gifClicked + ' 个动图'); }
    }

    // 图片展开/激活后等待加载
    await sleep(3500);

    // 重新扫描（此时动图 URL 已就绪）
    allImages = [];
    for (var g2 = 0; g2 < groups.length; g2++) {
      var date = getPostDate(groups[g2].container);
      var imgs = extractImages(groups[g2].container);
      imgs.forEach(function (img) { img.date = date; allImages.push(img); });
    }

    if (allImages.length === 0) {
      log('未找到图片', 'error');
      return;
    }

    log('共 ' + groups.length + ' 条贴文，' + allImages.length + ' 张图片');
    var result = await downloadImages(allImages);
    log('===== 完成! 成功 ' + result.success + ' / 失败 ' + result.fail + ' =====',
      result.success === allImages.length ? 'success' : 'info');
  }

  // 下载单条贴文（先展开长文、激活动图）
  async function downloadPost(container) {
    logLines = [];
    log('===== 下载选中贴文 =====');

    // 展开长贴文
    var expanded = expandPost(container);
    if (expanded > 0) { log('已展开 ' + expanded + ' 处折叠内容'); }

    // 展开被折叠的图片（超过9张）
    var imgExpanded = expandFoldedImages(container);
    if (imgExpanded > 0) { log('已展开 ' + imgExpanded + ' 组折叠图片'); }

    // 激活动图
    var gifClicked = activateGifs(container);
    if (gifClicked > 0) { log('已激活 ' + gifClicked + ' 个动图'); }

    // 等待图片和动图加载
    if (expanded > 0 || imgExpanded > 0 || gifClicked > 0) {
      var waitTime = imgExpanded > 0 ? 4000 : 2500;
      log('等待图片加载... (' + waitTime/1000 + 's)');
      await sleep(waitTime);
    }

    var date = getPostDate(container);
    var images = extractImages(container);
    images.forEach(function (img) { img.date = date; });

    if (images.length === 0) {
      log('该贴文未找到图片', 'error');
      return;
    }

    log('发布日期: ' + (date || '未知') + '，共 ' + images.length + ' 张图片');
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
    log('微博原图下载器 v5.6.0 已加载');
    log('「下载全部」: 全页贴文原图，自动展开长文/折图/动图');
    log('「选择贴文」: 点选单条下载，滚动自动发现新贴文');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
