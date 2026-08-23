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

- 服务端根据用户恢复进度只代理当前播放章节的 `.strm` 目标，不预取固定数量的其他章节；远程请求透传 Range，本地目标直接读取容器内文件。
- 如果书籍存在缺少真实时长、编码或声道信息的 STRM 音轨，播放响应返回后会在后台执行整本书完整扫描：本地目标使用真实路径，远程目标使用内存 Buffer 通过 `ffprobe` 标准输入探测，不阻塞首个播放响应。
- 播放触发的后台补全按请求先后顺序跨书籍串行执行，每本书固定使用 2.0 QPS；一本书扫描完成后暂停 3 分钟再处理队列中的下一本书。已有完整音轨信息的目标不会重复请求。手动补全和计划任务使用各自定义的限速策略，不再按本书文件数量动态分档。
- 扫描成功后把真实 `duration`、编码、码率、声道、标签和内嵌章节持久化到书籍音轨，重建书籍章节及总时长，并推送书籍更新事件使当前页面刷新。
- 远程 URL 的完整响应体只在完整扫描期间暂存于内存，不写入磁盘。对于 `?` 后携带显示文件名的 HTTP 地址，程序按 URL pathname 的真实扩展名推断音频 MIME 类型，并保留完整查询字符串。
- STRM URL 直接使用 RFC 1918 私有 IPv4、回环地址、链路本地地址或 IPv6 私有地址时，会仅在 STRM 请求链路中绕过 SSRF 过滤器，因此 `http://10.0.0.31:...` 无需额外环境变量即可访问。域名和公网 IP 仍使用项目原有 SSRF 防护。
- 扫描阶段不会访问或回写真实目标；完整扫描成功后，才会更新数据库中的音轨元数据、章节排序和全书总时长。失败的单个目标保留占位数据，不影响当前播放。
- 后台完整扫描任务按书籍 ID 去重，同一本书同时被多个客户端播放时不会重复请求全部目标。
- 当所有 STRM 音轨和书籍聚合元数据均完整时，后续播放不会再次执行完整扫描；如果仅聚合章节或总时长缺失，则只从已保存音轨重建，不访问目标。
- 本地目标默认必须位于当前媒体所属库配置的库目录内，并且必须是普通文件，防止 `.strm` 被利用为任意文件读取入口。
- 如果 `.strm` 指向媒体库目录之外但仍属于同一网盘挂载，例如媒体库是 `/NetDisk/115-Strm`、目标是 `/NetDisk/CloudNAS/...`，程序会自动将固定容器根目录 `/NetDisk` 纳入允许范围；该目录必须在容器内真实挂载，并且 `.strm` 中的路径必须使用容器内路径。
- 当前播放章节的代理失败不会阻断扫描任务；单个完整扫描目标失败会保留占位数据并记录具体原因。
- `.strm` 指针解析结果按文件的 `mtimeMs` 缓存，文件更新后会自动重新读取。

## 扫描机制

扫描和播放是两个阶段，职责不能混用：

1. 扫描器递归读取媒体库目录，收集文件名、扩展名、相对路径、大小、时间戳和 inode 等文件系统信息。
2. `.strm` 被注册为音频扩展，但扫描器遇到 `.strm` 时只创建零时长占位音轨，不读取文件内容，也不调用 `ffprobe`。
3. 普通音频文件仍按原有流程调用 `ffprobe`，写入真实时长、编码、码率、声道、标签和内嵌章节。
4. 有声书扫描使用媒体库根目录下一层作为书籍边界，子目录中的音频文件归入对应书籍并保留相对路径。
5. 用户请求播放含 `.strm` 的有声书时，播放接口立即返回；后台检查书籍完整性，仅当存在缺少时长、编码或声道信息的音轨时才按 QPS 完整扫描。成功结果写入书籍数据库和 metadata 文件，完整书籍后续播放不会再次请求目标。
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

## 本地新增与修改功能

### 1. 有声书书名匹配边界

- 有声书媒体库只使用媒体库根目录下的直接子目录名作为书名匹配输入。
- 例如 `/Read/有声读物/A/A1/...` 只匹配 `A`，不会把 `A1`、更深层目录名或卷目录名拼入综合书名；`A`、`B`、`C` 分别是三本书。
- `A/A1`、`A/A2` 仍属于同一本书，音频文件相对路径保留卷目录层级。

### 2. 详情页补全元数据

- 有声书详情页三点菜单在“下载”附近提供“补全元数据”。
- 单本手动补全固定使用 2.0 QPS；每累计扫描 3000 个文件暂停 5 分钟。暂停计数通过该次任务的 `throttleState` 传入扫描核心，避免只配置请求间隔而遗漏批量暂停。
- 选择多本书籍补全时固定使用 1.5 QPS，并在选中书籍之间共享同一个 `throttleState`；跨书累计每 3000 个文件暂停 5 分钟。媒体库级手动补全按多本规则处理。
- 手动补全接口立即返回 HTTP 202，实际扫描在后台异步执行；任务 Socket 事件反馈运行进度、当前书名和完成/失败状态。

### 3. 大量音轨按需渲染

- 音轨展开不再一次创建全部表格行，首次只渲染 100 条。
- 在音轨区域滚动接近底部时，每次追加 100 条，直到全部加载；不改变服务端音轨数据、排序或播放行为。

### 4. 计划任务：补全元数据与清理丢失项目

- 设置页面的用户下方新增“计划任务”入口，页面适配项目现有主题变量。
- 页面提供“补全元数据”和“清理丢失项目”两条紧凑横条；每条依次显示大字功能标题、已运行后的上次运行摘要和小字描述，右侧显示立即执行、运行中的普通停止图标与竖三点图标。停止图标不使用背景填充、高亮或额外描边框，点击热区仍保持足够大小；停止按钮调用对应停止 API，服务端协作式取消后才结束任务。
- 两项任务接口立即返回 HTTP 202，任务 Socket 事件负责反馈运行状态和完成结果。页面按 `task.data.scheduledTask` 区分计划任务与普通手动补全，避免误显示停止按钮；任务完成后在浏览器本地记录上次运行摘要。
- 补全元数据只处理总时长为 `0 sec` 的有声书；每本符合条件的书会将全部 STRM 音轨交给真实目标探测和元数据扫描流程，已有总时长的书籍跳过。
- 补全元数据支持 cron 表达式和单次最长执行时间，时间限制使用可直接输入的数字步进框，最小 0.5 小时、步长 0.5 小时；服务端校验 cron 和步长。计划任务 QPS 设置字段为 `strmMetadataCompletionQps`，默认 1.0，范围 0.1 至 10.0、步长 0.1。计划任务批量暂停设置字段为 `strmMetadataCompletionBatchSize`，默认 5000、最小 500、步长 500；达到配置阈值后暂停 5 分钟，并受单次小时数截止时间限制。
- 清理丢失项目支持独立 cron 表达式和立即执行；只清理扫描后标记 `isMissing` 的项目，不处理仅标记 `isInvalid` 的项目。
- 清理丢失项目复用项目删除的数据库关联清理流程，删除播放进度、播放列表关联、RSS、缓存、metadata 数据和项目记录，但不删除文件系统文件；完成后刷新问题统计并发送项目移除事件。任务结果在 `task.data.result.removed` 返回实际清理数量，页面第二行显示“清理了 N 项”，即使 N 为 `0` 也明确显示 `0`。
- 两项计划任务均有运行中防重入保护和协作式取消：停止入口分别为 `/api/strm-metadata-completion/stop` 与 `/api/missing-items-cleanup/stop`。STRM 任务在当前探测完成后于下一首音轨或下一本书边界退出，批量暂停等待可被轮询取消；清理任务在每个媒体库和项目边界检查取消状态，已完成删除的数量保留在结果中。配置保存在服务端设置中，cron 变更后立即重建对应定时任务。

### 5. 主题

- `浩瀚星空` 回退为静态深邃藏蓝、墨紫和炭黑底色，保留少量错落的银白、浅蓝、淡金和浅紫星点；不使用漂移、缩放或闪烁动画，背景层不阻挡页面交互。
- 新增 `暗色主题`，采用炭黑、冷灰和低饱和蓝灰配色，适合作为低干扰的纯暗色界面。

## 代码锚点

### 后端 STRM

- [`server/utils/globals.js`](../server/utils/globals.js:1)：将 `strm` 注册到音频扩展列表。
- [`server/objects/files/AudioFile.js`](../server/objects/files/AudioFile.js:112)：创建不依赖远程探测的占位音频对象。
- [`server/scanner/AudioFileScanner.js`](../server/scanner/AudioFileScanner.js:157)：扫描时识别 `.strm` 并跳过 `ffprobe`。
- [`server/utils/strmUtils.js`](../server/utils/strmUtils.js:1)：指针解析、URL/本地目标判定、安全校验、完整扫描探测和当前章节媒体代理。
- [`server/utils/scandir.js`](../server/utils/scandir.js:48)：书籍媒体库按根目录下一层文件夹聚合文件，并仅使用首层目录进行书名解析。
- [`client/components/tables/TracksTable.vue`](../client/components/tables/TracksTable.vue:18)：大量音轨展开时按 100 条增量渲染。
- [`client/pages/item/_id/index.vue`](../client/pages/item/_id/index.vue:406)：详情页三点菜单的补全元数据入口。
- [`client/pages/config/scheduled-tasks.vue`](../client/pages/config/scheduled-tasks.vue:1)：计划任务页面、补全元数据和清理丢失项目任务条。
- [`client/components/app/ConfigSideNav.vue`](../client/components/app/ConfigSideNav.vue:57)：设置页面用户下方的计划任务入口。
- [`server/managers/CronManager.js`](../server/managers/CronManager.js:123)：计划任务生命周期、cron 调度、统一任务事件和取消状态。
- [`client/components/tables/TracksTable.vue`](../client/components/tables/TracksTable.vue:18)：大量音轨使用固定行高、上下占位和 requestAnimationFrame 滚动节流的窗口化渲染，避免一次性保留全部音轨行。
- [`server/managers/PlaybackSessionManager.js`](../server/managers/PlaybackSessionManager.js:516)：STRM 目标探测、串行请求间隔及 `throttleState` 批量暂停核心。
- [`server/managers/PlaybackSessionManager.js`](../server/managers/PlaybackSessionManager.js:665)：单本手动补全固定 2.0 QPS、每 3000 文件暂停 5 分钟；多本和媒体库级入口固定 1.5 QPS 并共享计数。
- [`server/managers/PlaybackSessionManager.js`](../server/managers/PlaybackSessionManager.js:689)：计划任务读取服务端 QPS/批量设置，反馈当前书名和进度，并按时限运行。
- [`server/objects/settings/ServerSettings.js`](../server/objects/settings/ServerSettings.js:49)：计划任务 QPS 和批量阈值的默认值、兼容旧配置及序列化。
- [`server/controllers/MiscController.js`](../server/controllers/MiscController.js:637)：计划任务运行/停止 API 和管理员权限校验；计划任务设置的 cron、QPS 范围和步长校验位于同文件的设置更新逻辑。
- [`server/routers/ApiRouter.js`](../server/routers/ApiRouter.js:354)：计划任务运行/停止路由和清理 `removed` 数量、取消检查。
- [`server/scanner/AudioFileScanner.js`](../server/scanner/AudioFileScanner.js:52)：按卷目录自然排序，再使用原有碟号/曲目号排序。
- [`server/managers/PlaybackSessionManager.js`](../server/managers/PlaybackSessionManager.js:373)：播放阶段生成真实/估算时间轴和临时章节。
- [`server/controllers/LibraryItemController.js`](../server/controllers/LibraryItemController.js:986)：实际章节播放入口，传入当前库目录白名单。
- [`server/models/Book.js`](../server/models/Book.js:278)：含 `.strm` 时允许后端代理直播放。
- [`server/models/Podcast.js`](../server/models/Podcast.js:302)：播客 `.strm` 章节允许后端代理直播放。

### 前端主题

- [`client/components/app/ThemeSwitcher.vue`](../client/components/app/ThemeSwitcher.vue:1)：主题按钮、下拉选项、键盘 Escape 关闭、`localStorage` 持久化。
- [`client/components/app/Appbar.vue`](../client/components/app/Appbar.vue:15)：主题按钮的上游耦合点，位于顶部搜索框右侧工具区。
- [`client/assets/themes.css`](../client/assets/themes.css:1)：经典、暗色和浩瀚星空主题的 CSS 变量及覆盖规则。
- [`client/assets/app.css`](../client/assets/app.css:1)：加载主题覆盖样式。
- [`client/static/themes/theme-switch.png`](../client/static/themes/theme-switch.png)：主题切换调色盘图标。

## 三套主题

- `classic`：原版 Audiobookshelf 配色，不主动改变上游视觉变量。
- `dark`：炭黑、冷灰和蓝灰配色的低干扰暗色主题。
- `cosmos`：静态深蓝黑星空主题，使用少量星点、金色/紫色强调和低亮度表面。

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
   - 保留当前章节的 STRM 代理播放和播放响应后的整书后台补全；不要重新引入固定数量预取或会话级完整文件缓存。
   - 保留四类补全入口的限速边界：播放自动补全按请求顺序逐本串行，2.0 QPS，每本完成后暂停 3 分钟；单本手动补全 2.0 QPS；多本和媒体库级手动补全 1.5 QPS，且手动入口跨书共享每 3000 文件暂停 5 分钟；计划任务读取 `strmMetadataCompletionQps` 和 `strmMetadataCompletionBatchSize` 设置。
   - 保留播放响应后的整书后台补全：只有后台探测成功后才回写书籍数据库和 metadata 文件，扫描阶段仍不得访问 `.strm` 指针目标。
   - 计划任务页面需要重新接入运行态播放/停止按钮、`task.data.scheduledTask` 过滤和 `task_finished` 结果处理；后端需要重新接入 [`server/managers/CronManager.js`](../server/managers/CronManager.js:155)、[`server/controllers/MiscController.js`](../server/controllers/MiscController.js:637) 与 [`server/routers/ApiRouter.js`](../server/routers/ApiRouter.js:354) 的停止 API。清理摘要依赖 `task.data.result.removed`，不能恢复为耗时显示，也不能把 `0` 项隐藏。
   - 大量音轨页面需要保留 [`client/components/tables/TracksTable.vue`](../client/components/tables/TracksTable.vue:18) 的窗口化渲染：不要恢复为按 100 条不断累积 DOM；保留固定行高、上下占位和滚动帧合并逻辑。
   - 不要把 `.strm` 真实目标直接交给 FFmpeg，除非另行实现目标解析后的转码输入。
3. 保留或重新应用主题功能：
   - 保留独立文件 `client/components/app/ThemeSwitcher.vue` 和 `client/assets/themes.css`。
   - 在新的全局 CSS 入口重新导入 `themes.css`。
   - 在新的顶部导航组件中，将 `<app-theme-switcher />` 插入搜索区右侧工具区域。
   - 如果上游重命名 Appbar 组件，只需要重新定位顶部工具栏，不需要改主题组件内部逻辑。
4. 运行后端测试和前端构建。
5. 手工验证三件事：
   - 扫描含 `.strm` 的目录时不会触发远程请求或访问真实本地目标。
   - 验证 `A/A1`、`A/A2` 的书名匹配查询只使用 `A`，不会使用 `A1` 或 `A2`。
   - 展开包含上千音轨的书籍，确认首屏只渲染首批音轨，滚动到底部后继续追加且页面保持响应。
   - 在计划任务页面验证手动执行、cron 校验、0.5 小时步长和管理员权限；确认 QPS 输入范围为 0.1 至 10.0、步长 0.1，默认 1.0，批量阈值默认 5000 且步长 500；已有总时长的书被跳过，任务按设置休息并在时限到达后停止。
   - 有声书库使用根目录下一层文件夹作为书籍边界，并验证 `A/A1`、`A/A2` 被聚合为同一本书且按卷目录顺序排列。
   - 播放时验证只访问当前章节目标，章节切换和恢复进度不会额外预取其他章节。
   - 播放响应返回后验证后台按请求顺序逐本以 2.0 QPS 执行完整扫描，每本完成后暂停 3 分钟；成功后数据库中的 STRM 音轨时长、音轨元数据、章节和总时长均被补全；重复播放不会重复请求已完整书籍。
   - 分别验证详情页单本补全使用 2.0 QPS 且每 3000 文件暂停 5 分钟，选择多本和媒体库级补全使用 1.5 QPS 且跨书累计每 3000 文件暂停 5 分钟。
   - 在设置侧栏用户下方验证计划任务入口；分别手动执行两条任务，确认清理任务只删除 `isMissing` 数据库项目，不删除文件，也不删除仅 `isInvalid` 的项目。
   - 验证总时长显示为 `0 sec` 的有声书会被补全任务选中，并对该书全部 STRM 音轨执行真实扫描；确认页面显示的是整个扫描任务的服务端总耗时，而不是接口响应耗时。
   - 切换浩瀚星空主题，确认藏蓝/墨紫/炭黑背景及不同颜色和大小的静态星点在桌面和移动端可见且不遮挡交互；切换暗色主题，确认冷灰暗色界面正常显示。
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
