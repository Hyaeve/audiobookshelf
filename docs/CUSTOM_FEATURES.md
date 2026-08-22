# AudioBookShelf 额外功能维护说明

本文记录本地定制功能，方便后续同步上游 AudioBookShelf 更新。定制功能分为 STRM 支持、扫描机制、书籍匹配与章节排序、主题切换四部分。

## 功能清单

### 1. STRM 文件支持

支持 `.strm` 作为音频章节文件。`.strm` 文件内容可以是：

- `http://` 远程媒体地址
- `https://` 远程媒体地址
- 本地绝对路径，例如 `/NetDisk/CloudNAS/CloudDrive/.../chapter.flac`
- 相对 `.strm` 文件所在目录的本地路径，例如 `./chapter.flac`

扫库时只读取 `.strm` 文件自身的文件系统元数据，不读取指针内容，不执行 `ffprobe`，也不请求远程网盘。

播放阶段的真实目标访问规则：

- 服务端根据用户恢复进度定位当前章节，从该章节开始按音轨顺序预取最多 10 个 `.strm`。
- 播放响应返回后，会在后台为当前有声书的全部 `.strm` 音轨执行一次完整探测：本地目标使用真实路径，远程目标使用内存 Buffer 通过 `ffprobe` 标准输入探测，不阻塞首个播放响应。前十章复用播放窗口已经下载的 Buffer，其余章节以最多 3 路并发请求；完成后推送书籍更新事件，使当前页面刷新时长、音轨和章节信息。
- 播放窗口中的目标优先探测并用于当前会话；后台完整探测成功后才把真实 `duration`、编码、码率、声道、标签和内嵌章节持久化到书籍音轨。已有真实时长、编码和声道信息的 STRM 音轨会跳过重复探测。
- 远程 URL 发起真实 HTTP(S) 请求，完整响应体仅缓存在当前播放会话内存中，不写入磁盘；播放请求支持 Range，并从内存缓存切片返回。对于 `?` 后携带显示文件名的 HTTP 地址，程序按 URL pathname 的真实扩展名推断音频 MIME 类型，并保留完整查询字符串。
- STRM URL 直接使用 RFC 1918 私有 IPv4、回环地址、链路本地地址或 IPv6 私有地址时，会仅在 STRM 请求链路中绕过 SSRF 过滤器，因此 `http://10.0.0.31:...` 无需额外环境变量即可访问。域名和公网 IP 仍使用项目原有 SSRF 防护。
- 本地路径在会话创建时打开文件句柄并缓存文件 `stat` 元数据；播放请求从该句柄读取并支持 Range，不重复打开文件。
- 扫描阶段不会访问或回写真实目标；播放响应返回后的后台完整探测成功后，才会更新数据库中的音轨元数据、章节排序和全书总时长。失败的单个目标保留占位数据，不影响当前播放。
- 后台补全任务按书籍 ID 去重，同一本书同时被多个客户端播放时不会重复请求全部目标。
- 播放请求进入当前窗口之外的章节时，会释放旧窗口并从该章节重新预取最多 10 个目标。
- 本地目标默认必须位于当前媒体所属库配置的库目录内，并且必须是普通文件，防止 `.strm` 被利用为任意文件读取入口。
- 如果 `.strm` 指向媒体库目录之外但仍属于同一网盘挂载，例如媒体库是 `/NetDisk/115-Strm`、目标是 `/NetDisk/CloudNAS/...`，程序会自动将固定容器根目录 `/NetDisk` 纳入允许范围；该目录必须在容器内真实挂载，并且 `.strm` 中的路径必须使用容器内路径。
- 预取窗口中的单个目标失败不会阻断会话，该章节播放请求会回退到普通代理流程。
- 会话关闭、删除或过期时释放所有本地文件句柄并清空远程响应 Buffer。
- 指针解析结果按 `.strm` 文件的 `mtimeMs` 缓存，文件更新后会自动重新读取。

## 扫描机制

扫描和播放是两个阶段，职责不能混用：

1. 扫描器递归读取媒体库目录，收集文件名、扩展名、相对路径、大小、时间戳和 inode 等文件系统信息。
2. `.strm` 被注册为音频扩展，但扫描器遇到 `.strm` 时只创建零时长占位音轨，不读取文件内容，也不调用 `ffprobe`。
3. 普通音频文件仍按原有流程调用 `ffprobe`，写入真实时长、编码、码率、声道、标签和内嵌章节。
4. 有声书扫描使用媒体库根目录下一层作为书籍边界，子目录中的音频文件归入对应书籍并保留相对路径。
5. 用户首次播放含 `.strm` 的有声书后，播放接口立即返回；随后后台逐个探测整本书的真实目标，成功结果写入书籍数据库和 metadata 文件。已有完整时长、编码和声道信息的音轨不会再次请求目标。
6. 后台补全按书籍 ID 去重，单个目标失败不会中断其他目标。扫描任务本身仍不会因播放而读取 `.strm` 指针。

## 有声书目录匹配与章节排序

有声书媒体库使用媒体库根目录下一层文件夹作为一本书的边界。例如媒体库是 `/Read/有声读物/` 时：

- `/Read/有声读物/A`、`B`、`C` 分别识别为三本书，文件夹名用于匹配书名。
- `/Read/有声读物/A/A1` 和 `/Read/有声读物/A/A2` 不会拆成两本书；它们的媒体文件都归入 `A`，扫描时保留 `A1/...`、`A2/...` 的相对路径。
- 该规则适用于书籍媒体库；播客继续使用原有的播客分组逻辑。
- 扫描只读取文件系统目录和文件元数据，不读取 `.strm` 指针内容，也不访问指针目标。

章节排序规则如下：

1. 先取书籍目录下的第一层卷目录进行自然排序，数字按数值比较。因此 `A1` 在 `A2` 前，`A10` 在 `A2` 后。
2. 每个卷目录内部继续使用原项目的智能排序：优先使用完整且连续的碟号；碟号相同后比较曲目号；文件名曲目号和媒体标签曲目号中信息更完整的一方优先。
3. 若曲目号相同或缺失，以文件相对路径自然排序作为稳定兜底。
4. 所有卷按上述顺序拼接后重新生成连续的全书曲目编号，从 1 开始。示例中 `A1/七玄门风云-01...` 到 `A1/七玄门风云-42...` 会先排列，之后才是 `A2/初踏修仙路-01...` 到 `A2/初踏修仙路-36...`。

因此，当前实现不会把两个卷目录中的 `01` 简单地混在一起比较；卷目录是一级排序键，卷内曲目号是二级排序键。

## 代码锚点

### 后端 STRM

- [`server/utils/globals.js`](../server/utils/globals.js:1)：将 `strm` 注册到音频扩展列表。
- [`server/objects/files/AudioFile.js`](../server/objects/files/AudioFile.js:112)：创建不依赖远程探测的占位音频对象。
- [`server/scanner/AudioFileScanner.js`](../server/scanner/AudioFileScanner.js:157)：扫描时识别 `.strm` 并跳过 `ffprobe`。
- [`server/utils/strmUtils.js`](../server/utils/strmUtils.js:1)：指针解析、URL/本地目标判定、安全校验、十章预取、后台探测和媒体代理。
- [`server/utils/scandir.js`](../server/utils/scandir.js:48)：书籍媒体库按根目录下一层文件夹聚合文件。
- [`server/scanner/AudioFileScanner.js`](../server/scanner/AudioFileScanner.js:52)：按卷目录自然排序，再使用原有碟号/曲目号排序。
- [`server/managers/PlaybackSessionManager.js`](../server/managers/PlaybackSessionManager.js:373)：播放阶段生成真实/估算时间轴和临时章节。
- [`server/controllers/LibraryItemController.js`](../server/controllers/LibraryItemController.js:986)：实际章节播放入口，传入当前库目录白名单。
- [`server/models/Book.js`](../server/models/Book.js:278)：含 `.strm` 时允许后端代理直播放。
- [`server/models/Podcast.js`](../server/models/Podcast.js:302)：播客 `.strm` 章节允许后端代理直播放。

### 前端主题

- [`client/components/app/ThemeSwitcher.vue`](../client/components/app/ThemeSwitcher.vue:1)：主题按钮、下拉选项、键盘 Escape 关闭、`localStorage` 持久化。
- [`client/components/app/Appbar.vue`](../client/components/app/Appbar.vue:15)：主题按钮的上游耦合点，位于顶部搜索框右侧工具区。
- [`client/assets/themes.css`](../client/assets/themes.css:1)：经典主题和星空主题的 CSS 变量及覆盖规则。
- [`client/assets/app.css`](../client/assets/app.css:1)：加载主题覆盖样式。
- [`client/static/themes/theme-switch.png`](../client/static/themes/theme-switch.png)：主题切换调色盘图标。

## 两套主题

- `classic`：原版 Audiobookshelf 配色，不主动改变上游视觉变量。
- `cosmos`：深蓝黑星空夜间模式，使用星点背景、金色/紫色强调和低亮度表面。

当前主题保存在浏览器的 `absCustomTheme` 键中，用户刷新页面后保持。

## 上游同步流程

建议使用上游分支或上游工作树完成升级，然后再重新应用本地功能：

1. 先同步上游原始改动并解决上游自身冲突。
2. 保留或重新应用后端 STRM 文件：
   - 先检查 `server/utils/globals.js` 的 `SupportedAudioTypes` 是否仍存在。
   - 在新的音频扫描入口加入 `strm` 特判，确保不会进入 `ffprobe`。
   - 将 `server/utils/strmUtils.js` 重新接到新的文件播放接口和播放会话生命周期。
   - 如果上游调整了库模型查询，重新确认播放会话和播放接口能够获得当前库的 `libraryFolders`。
   - Docker 部署时确认 `.strm` 目标路径已挂载到容器内相同路径；跨库目标使用固定容器根目录 `/NetDisk`，不需要额外环境变量，但不能只挂载宿主机目录而不映射容器路径。
   - 保留会话启动时的十章真实预取、播放阶段时长探测、播放响应后的整书后台补全、内存响应缓存、本地句柄缓存和关闭释放逻辑。
   - 保留章节请求超出当前窗口时的滚动预取，并同步维护当前会话的 `duration` 与 `startOffset`。
   - 保留播放响应后的整书后台补全：只有后台探测成功后才回写书籍数据库和 metadata 文件，扫描阶段仍不得访问 `.strm` 指针目标。
   - 不要把 `.strm` 真实目标直接交给 FFmpeg，除非另行实现目标解析后的转码输入。
3. 保留或重新应用主题功能：
   - 保留独立文件 `client/components/app/ThemeSwitcher.vue` 和 `client/assets/themes.css`。
   - 在新的全局 CSS 入口重新导入 `themes.css`。
   - 在新的顶部导航组件中，将 `<app-theme-switcher />` 插入搜索区右侧工具区域。
   - 如果上游重命名 Appbar 组件，只需要重新定位顶部工具栏，不需要改主题组件内部逻辑。
4. 运行后端测试和前端构建。
5. 手工验证三件事：
   - 扫描含 `.strm` 的目录时不会触发远程请求或访问真实本地目标。
   - 有声书库使用根目录下一层文件夹作为书籍边界，并验证 `A/A1`、`A/A2` 被聚合为同一本书且按卷目录顺序排列。
   - 播放会话启动时从当前章节起对最多十个目标产生真实访问，并验证远程内存缓存、本地句柄缓存、播放阶段时长探测及关闭释放。
   - 播放响应返回后验证后台会继续探测整本书，成功后数据库中的 STRM 音轨时长、音轨元数据、章节和总时长均被补全；重复播放不会重复提交同一本书的补全任务。
   - 播放第 11 章及之后的章节时验证窗口滚动、章节切换、恢复进度、拖动进度条和总时长校正。
   - 容器内执行 `ls /NetDisk/...` 能看到 `.strm` 指向的目标文件；不需要配置额外环境变量。
   - 播放远程 URL、本地 POSIX 路径和 Windows 路径目标均正常。
   - 两个主题切换、刷新持久化和夜间主题文本对比度正常。

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

若上游升级 Tailwind 或 Nuxt，首先检查 `client/assets/tailwind.css` 的颜色变量命名是否变化，再调整 `themes.css` 中的经典/星空主题变量覆盖。不要重新添加已移除的 AppleTV 主题或主题描述小字。
