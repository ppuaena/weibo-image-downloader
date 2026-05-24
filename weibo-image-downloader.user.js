// ==UserScript==
// @name         微博原图下载器
// @namespace    https://github.com/sun27/weibo-image-downloader
// @version      3.1.0
// @description  在微博网页版一键下载所有可见贴文的原图
// @author       You
// @match        https://weibo.com/*
// @match        https://www.weibo.com/*
// @grant        GM_xmlhttpRequest
// @connect      *
// ==/UserScript==

(function () {
  'use strict';

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
      var color = l.type === 'error' ? '#e74c3c' : l.type === 'success' ? '#27ae60' : '#333';
      return '<div style="color:' + color + ';font-size:11px;line-height:1.5">[' + l.time + '] ' + l.msg + '</div>';
    }).join('');
    el.scrollTop = el.scrollHeight;
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
        original: toOriginalUrl(src),
        fileName: getFileName(src),
      });
    }

    log('其中微博贴文图片 ' + result.length + ' 张');
    return result;
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

  // ---- 下载逻辑 ----
  function downloadWithGM(imgInfo) {
    return new Promise(function (resolve) {
      var url = imgInfo.original;
      log('请求: ' + url.substring(0, 100));

      GM_xmlhttpRequest({
        method: 'GET',
        url: url,
        responseType: 'blob',
        timeout: 20000,
        headers: { 'Referer': 'https://weibo.com/' },
        onload: function (r) {
          log('  状态: ' + r.status + ', 大小: ' + (r.response ? r.response.size : 'null'));

          if (r.status === 200 && r.response && r.response.size > 500) {
            var name = String(imgInfo.index).padStart(String(imgInfo.total).length, '0') + '_' + imgInfo.fileName;
            triggerBlobDownload(r.response, name);
            resolve('success');
          } else if (r.status === 200 && r.response && r.response.size <= 500) {
            log('  文件太小，跳过', 'error');
            resolve('toosmall');
          } else {
            log('  HTTP ' + r.status + ' 或空响应', 'error');
            resolve('fail');
          }
        },
        onerror: function () {
          log('  网络错误', 'error');
          resolve('fail');
        },
        ontimeout: function () {
          log('  请求超时', 'error');
          resolve('fail');
        },
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
    log('  已触发浏览器下载: ' + name, 'success');
  }

  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  async function downloadAll() {
    logLines = [];
    log('===== 开始下载 =====');

    var images = getPostImages();

    if (images.length === 0) {
      log('ERROR: 未找到微博图片！', 'error');
      return;
    }

    for (var i = 0; i < images.length; i++) {
      log('  图片 ' + (i + 1) + ': ' + images[i].original.substring(0, 80));
    }

    var success = 0;
    var fail = 0;

    for (var j = 0; j < images.length; j++) {
      images[j].index = j + 1;
      images[j].total = images.length;
      log('--- [' + (j + 1) + '/' + images.length + '] ---');
      var result = await downloadWithGM(images[j]);
      if (result === 'success') {
        success++;
      } else {
        fail++;
      }
      await sleep(800);
    }

    log('===== 完成! 成功 ' + success + ' / 失败 ' + fail + ' =====', success === images.length ? 'success' : 'info');
  }

  // ---- UI ----
  function createPanel() {
    var panel = document.createElement('div');
    panel.id = 'wbdl-panel';
    panel.innerHTML =
      '<div style="display:flex;gap:6px;margin-bottom:8px">' +
        '<button id="wbdl-btn-dl" style="flex:1;padding:8px;border:none;border-radius:6px;cursor:pointer;font-size:13px;font-weight:600;background:#ff8200;color:#fff">下载原图</button>' +
        '<button id="wbdl-btn-clear" style="padding:8px 10px;border:none;border-radius:6px;cursor:pointer;font-size:12px;background:#eee;color:#666">清空</button>' +
      '</div>' +
      '<div id="wbdl-log" style="max-height:300px;overflow-y:auto;background:#f8f8f8;border-radius:6px;padding:8px;font-family:Consolas,monospace;font-size:11px"></div>';

    panel.style.cssText =
      'position:fixed;bottom:60px;right:16px;z-index:99999;width:420px;max-height:380px;' +
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
    log('微博原图下载器 v3.1.0 已加载');
    log('当前页面: ' + window.location.href);
    log('点击"下载原图"按钮开始');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
