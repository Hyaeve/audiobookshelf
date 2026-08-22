# AudioBookShelf 额外功能维护说明

本文记录本地定制功能，方便后续同步上游 AudioBookShelf 更新。定制功能分为 `strm` 媒体支持、惰性扫描/播放策略和前端主题切换三部分。

## 功能清单

### 1. STRM 文件支持

支持 `.strm` 作为音频章节文件。`.strm` 文件内容可以是：

- `http://` 远程媒体地址
- `https://` 远程媒体地址
- 本地绝对路径，例如 `/NetDisk/CloudNAS/CloudDrive/.../chapter.flac`
- 相对 `.strm` 文件所在目录的本地路径，例如 `./chapter.flac`

扫库时只读取 `.strm` 文件自身的文件系统元数据，不读取指针内容，不执行 `ffprobe`，也不请求远程网盘。

播放会话创建时才读取指针并访问真实目标：

- 服务端根据用户恢复进度定位当前章节，从该章节开始按音轨顺序预取最多 10 个 `.strm`。
- 远程 URL 发起真实 HTTP(S) 请求，完整响应体仅缓存在当前播放会话内存中，不写入磁盘；播放请求支持 Range，并从内存缓存切片返回。
- 本地路径在会话创建时打开文件句柄并缓存文件 `stat` 元数据；播放请求从该句柄读取并支持 Range，不重复打开文件。
- 本地目标必须位于当前媒体所属库配置的库目录内，并且必须是普通文件，防止 `.strm` 被利用为任意文件读取入口。
- 预取窗口中的单个目标失败不会阻断会话，该章节播放请求会回退到普通代理流程。
- 会话关闭、删除或过期时释放所有本地文件句柄并清空远程响应 Buffer。
- 指针解析结果按 `.strm` 文件的 `mtimeMs` 缓存，文件更新后会自动重新读取。

## 代码锚点

### 后端 STRM

- [`server/utils/globals.js`](../server/utils/globals.js:1)：将 `strm` 注册到音频扩展列表。
- [`server/objects/files/AudioFile.js`](../server/objects/files/AudioFile.js:112)：创建不依赖远程探测的占位音频对象。
- [`server/scanner/AudioFileScanner.js`](../server/scanner/AudioFileScanner.js:157)：扫描时识别 `.strm` 并跳过 `ffprobe`。
- [`server/utils/strmUtils.js`](../server/utils/strmUtils.js:1)：指针解析、URL/本地目标判定、安全校验、十章预取和媒体代理。
- [`server/controllers/LibraryItemController.js`](../server/controllers/LibraryItemController.js:986)：实际章节播放入口，传入当前库目录白名单。
- [`server/models/Book.js`](../server/models/Book.js:278)：含 `.strm` 时允许后端代理直播放。
- [`server/models/Podcast.js`](../server/models/Podcast.js:302)：播客 `.strm` 章节允许后端代理直播放。

### 前端主题

- [`client/components/app/ThemeSwitcher.vue`](../client/components/app/ThemeSwitcher.vue:1)：主题按钮、下拉选项、键盘 Escape 关闭、`localStorage` 持久化。
- [`client/components/app/Appbar.vue`](../client/components/app/Appbar.vue:15)：主题按钮的上游耦合点，位于顶部搜索框右侧工具区。
- [`client/assets/themes.css`](../client/assets/themes.css:1)：三套主题的 CSS 变量和覆盖规则。
- [`client/assets/app.css`](../client/assets/app.css:1)：加载主题覆盖样式。
- [`client/static/themes/theme-switch.png`](../client/static/themes/theme-switch.png)：主题切换调色盘图标。

## 三套主题

- `classic`：原版 Audiobookshelf 配色，不主动改变上游视觉变量。
- `cosmos`：深蓝黑星空夜间模式，使用星点背景、金色/紫色强调和低亮度表面。
- `appletv`：冰蓝灰浅色 Apple TV 风格，使用深色文字、绿色强调和浅色控件。

当前主题保存在浏览器的 `absCustomTheme` 键中，用户刷新页面后保持。

## 上游同步流程

建议使用上游分支或上游工作树完成升级，然后再重新应用本地功能：

1. 先同步上游原始改动并解决上游自身冲突。
2. 保留或重新应用后端 STRM 文件：
   - 先检查 `server/utils/globals.js` 的 `SupportedAudioTypes` 是否仍存在。
   - 在新的音频扫描入口加入 `strm` 特判，确保不会进入 `ffprobe`。
   - 将 `server/utils/strmUtils.js` 重新接到新的文件播放接口和播放会话生命周期。
   - 如果上游调整了库模型查询，重新确认播放会话和播放接口能够获得当前库的 `libraryFolders`。
   - 保留会话启动时的十章真实预取、内存响应缓存、本地句柄缓存和关闭释放逻辑。
   - 不要把 `.strm` 真实目标直接交给 FFmpeg，除非另行实现目标解析后的转码输入。
3. 保留或重新应用主题功能：
   - 保留独立文件 `client/components/app/ThemeSwitcher.vue` 和 `client/assets/themes.css`。
   - 在新的全局 CSS 入口重新导入 `themes.css`。
   - 在新的顶部导航组件中，将 `<app-theme-switcher />` 插入搜索区右侧工具区域。
   - 如果上游重命名 Appbar 组件，只需要重新定位顶部工具栏，不需要改主题组件内部逻辑。
4. 运行后端测试和前端构建。
5. 手工验证三件事：
   - 扫描含 `.strm` 的目录时不会触发远程请求或访问真实本地目标。
   - 播放会话启动时从当前章节起对最多十个目标产生真实访问，并验证远程内存缓存、本地句柄缓存及关闭释放。
   - 播放远程 URL、本地 POSIX 路径和 Windows 路径目标均正常。
   - 三个主题切换、刷新持久化、浅色主题文本对比度正常。

## 冲突处理原则

- `server/utils/strmUtils.js` 和 `client/components/app/ThemeSwitcher.vue` 是定制功能的主要独立文件，优先保留本地版本，再适配上游接口。
- `Appbar.vue`、`app.css`、`AudioFileScanner.js`、`LibraryItemController.js` 属于上游高频变化文件，升级时不要整文件覆盖本地版本，只重新应用标记位置的少量耦合代码。
- 不要把主题颜色散落到业务组件中；主题颜色统一放在 `themes.css` 的变量和主题选择器内。
- 不要修改数据库结构保存主题；当前主题属于浏览器用户界面偏好，使用 `localStorage` 可以避免迁移和上游数据库冲突。

## 验证命令

后端测试：

```text
npm test
```

当前已验证后端完整测试通过，包含 STRM 分组和本地路径安全校验测试。前端构建可使用项目已有命令：

```text
cd client
npm run generate
```

若上游升级 Tailwind 或 Nuxt，首先检查 `client/assets/tailwind.css` 的颜色变量命名是否变化，再调整 `themes.css` 中的变量覆盖。
