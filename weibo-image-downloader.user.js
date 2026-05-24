// ==UserScript==
// @name         微博原图下载器
// @namespace    https://github.com/sun27/weibo-image-downloader
// @version      4.0.1
// @description  在微博网页版一键下载所有可见贴文的原图（多级回退保证最高画质）
// @author       You
// @match        https://weibo.com/*
// @match        https://www.weibo.com/*
// @grant        GM_xmlhttpRequest
// @connect      *
// ==/UserScript==

(function () {
  'use strict';

  // ---- 画质级别：从高到低依次尝试（均为微博 CDN 实际支持的尺寸标识） ----
  var QUALITY_LEVELS = ['original', 'large', 'mw2000', 'mw1024', 'mw690'];

  // ---- 日志面板 ----
  var logLines = [];

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

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
  }

  // ---- 图片查找 ----
  function getPostImages() {
    var allImgs = document.querySelectorAll('img');
    log('页面共有 ' + allImgs.length + ' 个 img 标签');
    var seen = new Set();
    var result = [];

    for (var i = 0; i < allImgs.length; i++) {
      var img = allImgs[i];
      var src = img.src || img.getAttribute('data-src') || img.getAttribute('data-original') || '';

      if (!src || seen.has(src)) continue;
      if (src.indexOf('sinaimg.cn') === -1) continue;

      // 跳过 UI 素材域名
      if (src.indexOf('h5.sinaimg.cn') !== -1) continue;
      if (src.indexOf('a.sinaimg.cn') !== -1) continue;

      var w = img.naturalWidth || img.width || 0;
      var h = img.naturalHeight || img.height || 0;
      if ((w > 0 && h > 0 && w < 120 && h < 120)) continue;
      if (img.closest('[class*="avatar"], [class*="Avatar"], [class*="emoji"], [class*="Emoji"]')) continue;

      seen.add(src);

      result.push({
        baseUrl: src,
        fileName: getFileName(src),
      });
    }

    log('其中微博贴文图片 ' + result.length + ' 张');
    return result;
  }

  // 生成各种画质级别的 URL
  function buildQualityUrls(baseUrl) {
    var re = /^(https?:\/\/[^/]+\.sinaimg\.cn\/)([^/]+)(\/[^?]+)/i;
    var m = baseUrl.match(re);
    if (!m) return [baseUrl];
    return QUALITY_LEVELS.map(function (level) {
      return m[1] + level + m[3];
    });
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

  // ---- 下载逻辑 ----

  // 尝试获取某个 URL 的图片，返回 { blob, size, url, level }
  function tryFetch(url, level) {
    return new Promise(function (resolve) {
      GM_xmlhttpRequest({
        method: 'GET',
        url: url,
        responseType: 'blob',
        timeout: 8000,
        headers: { 'Referer': 'https://weibo.com/' },
        onload: function (r) {
          if (r.status === 200 && r.response && r.response.size > 500) {
            resolve({ blob: r.response, size: r.response.size, url: url, level: level });
          } else {
            resolve(null);
          }
        },
        onerror: function () { resolve(null); },
        ontimeout: function () { resolve(null); },
      });
    });
  }

  // 对单张图片：按画质从高到低尝试下载
  function downloadBestQuality(baseUrl) {
    return new Promise(function (resolve) {
      var urls = buildQualityUrls(baseUrl);
      var idx = 0;

      function tryNext() {
        if (idx >= urls.length) {
          resolve(null);
          return;
        }
        var url = urls[idx];
        var level = QUALITY_LEVELS[idx];
        tryFetch(url, level).then(function (result) {
          if (result) {
            resolve(result);
          } else {
            idx++;
            tryNext();
          }
        });
      }

      tryNext();
    });
  }

  // 对比：对第一张图测试所有画质级别
  async function compareQuality(baseUrl) {
    log('===== 画质对比测试 =====', 'highlight');
    var urls = buildQualityUrls(baseUrl);
    var results = [];

    for (var i = 0; i < QUALITY_LEVELS.length; i++) {
      var result = await tryFetch(urls[i], QUALITY_LEVELS[i]);
      if (result) {
        results.push(result);
        log('  [' + result.level + '] ✓ 可用 — ' + formatSize(result.size), 'success');
      } else {
        log('  [' + QUALITY_LEVELS[i] + '] ✗ 不可用 (404 或太小)', 'error');
      }
    }

    if (results.length > 0) {
      results.sort(function (a, b) { return b.size - a.size; });
      var best = results[0];
      log('>>> 最佳画质: [' + best.level + '] ' + formatSize(best.size), 'highlight');
    }
    log('===== 对比测试结束 =====', 'highlight');
    return results;
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
  }

  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  // ---- 主流程 ----

  async function downloadAll() {
    logLines = [];
    log('===== 开始下载（多级回退模式） =====');

    var images = getPostImages();

    if (images.length === 0) {
      log('ERROR: 未找到微博图片！', 'error');
      return;
    }

    // 先对第一张图做画质对比测试
    await compareQuality(images[0].baseUrl);
    await sleep(300);

    log('===== 批量下载开始 =====');
    var success = 0;
    var fail = 0;
    var usedLevels = {};

    for (var j = 0; j < images.length; j++) {
      var num = j + 1;
      log('--- [' + num + '/' + images.length + '] ---');

      var result = await downloadBestQuality(images[j].baseUrl);

      if (result) {
        usedLevels[result.level] = (usedLevels[result.level] || 0) + 1;
        var prefix = String(num).padStart(String(images.length).length, '0');
        triggerBlobDownload(result.blob, prefix + '_' + images[j].fileName);
        log('  下载成功 [' + result.level + '] ' + formatSize(result.size), 'success');
        success++;
      } else {
        log('  下载失败 — 所有画质级别均不可用', 'error');
        fail++;
      }
      await sleep(800);
    }

    // 汇总
    log('===== 完成! 成功 ' + success + ' / 失败 ' + fail + ' =====', success === images.length ? 'success' : 'info');
    var levelSummary = Object.keys(usedLevels).map(function (k) {
      return '[' + k + ']×' + usedLevels[k];
    }).join(' ');
    log('实际使用的画质级别: ' + levelSummary);
  }

  // ---- UI ----
  function createPanel() {
    var panel = document.createElement('div');
    panel.id = 'wbdl-panel';
    panel.innerHTML =
      '<div style="display:flex;gap:6px;margin-bottom:8px;flex-wrap:wrap">' +
        '<button id="wbdl-btn-dl" style="flex:1;min-width:80px;padding:8px;border:none;border-radius:6px;cursor:pointer;font-size:13px;font-weight:600;background:#ff8200;color:#fff">下载原图</button>' +
        '<button id="wbdl-btn-clear" style="padding:8px 10px;border:none;border-radius:6px;cursor:pointer;font-size:12px;background:#eee;color:#666">清空</button>' +
      '</div>' +
      '<div id="wbdl-log" style="max-height:300px;overflow-y:auto;background:#f8f8f8;border-radius:6px;padding:8px;font-family:Consolas,monospace;font-size:11px"></div>';

    panel.style.cssText =
      'position:fixed;bottom:60px;right:16px;z-index:99999;width:440px;max-height:400px;' +
      'background:#fff;border:1px solid #ddd;border-radius:10px;padding:10px;' +
      'box-shadow:0 4px 20px rgba(0,0,0,0.15);font-family:-apple-system,BlinkMacSystemFont,sans-serif;';

    document.body.appendChild(panel);

    document.getElementById('wbdl-btn-dl').addEventListener('click', downloadAll);
    document.getElementById('wbdl-btn-clear').addEventListener('click', function () {
      logLines = [];
      renderLog();
    });
  }

  // ---- 初始化 ----
  function init() {
    createPanel();
    log('微博原图下载器 v4.0.1 已加载');
    log('画质回退链: ' + QUALITY_LEVELS.join(' → '));
    log('点击"下载原图"开始（会先做画质对比测试）');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
