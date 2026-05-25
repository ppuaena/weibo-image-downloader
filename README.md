# 微博原图下载器

Tampermonkey 用户脚本，在微博网页版按贴文选下载原图，支持动图、长文展开、失败重试。

## 安装

1. 安装 [Tampermonkey](https://www.tampermonkey.net/)
2. 新建脚本 → 粘贴 `weibo-image-downloader.user.js` → Ctrl+S
3. 打开 `weibo.com`，右下角出现下载面板

## 使用

| 按钮 | 功能 |
|------|------|
| **下载全部** | 全页已加载贴文的原图（先展开长文/折图/动图） |
| **选择贴文** | 每条贴文右上角出现下载按钮，点选下载单条，滚动自动发现新贴文 |
| **清空** | 清空日志面板 |
| **Esc** | 退出选择模式 |

下载文件按 `日期/序号_文件名` 格式命名，同一天图片自然归入同一文件夹。

## 功能清单

- [x] 按贴文选下载（`closest('article')` + data属性去重）
- [x] 滚动自动发现新贴文（MutationObserver）
- [x] 长文展开（点击"展开全文"按钮）
- [x] 折叠图片展开（点击 `_picNum` 计数标签）
- [x] 动图下载（`_customPoster` + video poster 提取）
- [x] 视频缩略图过滤（3层范围检测 videobox/videotime/播放图标）
- [x] 下载失败自动重试（4级回退：original → large → mw690 → 页面原始URL）
- [x] 按发布日期命名文件
- [x] `organize.py` 下载后按日期自动分子文件夹
- [ ] zip 打包下载
- [ ] 多页自动翻页下载

## 文件结构

```
weibo-image-downloader/
├── weibo-image-downloader.user.js  # 主脚本（Tampermonkey）
├── organize.py                     # 下载后按日期分子文件夹
└── README.md
```

## 架构说明

### 图片提取流程

```
用户点击下载
  → expandPost() 展开长文
  → expandFoldedImages() 点击 _picNum 展开折叠图
  → activateGifs() 点击动图播放按钮
  → sleep() 等待渲染
  → extractImages() 扫描 <img> + <video poster>
      → isVideoThumbnail() 过滤视频封面
      → isValidImage() 过滤头像/小图/UI素材
  → downloadImages() 下载+重试
```

### 关键 DOM 结构（微博新版 weibo-pro-next）

```
article                    ← 贴文容器 (closest)
└── div._body_m3n8j_63
    ├── header             ← 头像/用户名/时间
    └── div.wbpro-feed-content
        ├── div._wbtext    ← 正文
        └── div.picture._row_a3hty_13  ← 图片区
            └── div.woo-box-item-inlineBlock._item_a3hty_47
                └── div.woo-picture-main._pic_a3hty_16
                    ├── img.woo-picture-img       ← 视频封面（过滤）
                    └── div.woo-picture-slot
                        ├── img._customPoster_a3hty_132  ← 动图
                        ├── img._focusImg_a3hty_23       ← 普通图片
                        └── video._vertVideoImage_a3hty_114  ← 动图mp4
                            └── poster="xxx.gif"  ← 提取此URL
```

### 已知微博图片 CDN 尺寸标识

`original` > `large` > `mw2000` > `mw1024` > `mw690` > `orj360`

回退链优先尝试高画质，最后兜底用页面已加载的原始 URL。

### 日期提取

从 `<a class="_time_1tpft_33" title="2026-05-24 18:40">` 的 `title` 属性取 `YYYY-MM-DD`。

## 开发注意事项

1. 微博使用 `vue-recycle-scroller` 虚拟滚动，`article` 元素会被复用。用 `data-wbdl-cid` 属性做唯一标识，不要用 DOM 路径签名。
2. 超过 9 张的图片通过 `_picNum` 标签点击展开（会进入查看器模式），展开后需等待足够时间让图片加载。
3. 动图有两种形态：`img._customPoster` 和 `video._vertVideoImage`（poster 才是 GIF URL）。
4. 视频缩略图检测要限定在 3 层父级内，避免误判。

## 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| v5.6.4 | 2026-05-25 | 去掉 expandFoldedImages 文本 fallback |
| v5.6.3 | 2026-05-25 | 收紧 isVideoThumbnail，每次标注原因 |
| v5.6.2 | 2026-05-25 | 详细调试日志 |
| v5.6.1 | 2026-05-25 | 视频缩略图过滤增强 |
| v5.6.0 | 2026-05-25 | _picNum 选择器 + video poster + 延长等待 |
| v5.5.1 | 2026-05-25 | 回退链加入页面原始 URL |
| v5.5.0 | 2026-05-25 | 展开 9+ 折叠图 + 视频缩略图过滤 |
| v5.4.1 | 2026-05-25 | 跳过视频转存 + 文件夹整理 |
| v5.4.0 | 2026-05-25 | 动图激活性 + 多属性 URL |
| v5.3.0 | 2026-05-25 | 自动重试 original→large→mw690 |
| v5.2.0 | 2026-05-25 | 发布日期命名 |
| v5.1.0 | 2026-05-24 | 长文展开 + MutationObserver 滚动 |
| v5.0.0 | 2026-05-24 | 选择贴文模式 |
