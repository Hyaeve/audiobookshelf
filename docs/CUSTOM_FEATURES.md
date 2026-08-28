# AudioBookShelf 额外功能维护说明

本文记录本地定制功能，方便后续同步上游 AudioBookShelf 更新。定制功能分为 STRM 支持、全局补全队列、扫描机制、书籍匹配与章节排序、计划任务、主题切换六部分。

## 功能清单

### 1. STRM 文件支持

支持 `.strm` 作为音频章节文件。`.strm` 文件内容可以是：

- `http://` 远程媒体地址
- `https://` 远程媒体地址
- 本地绝对路径，例如 `/NetDisk/CloudNAS/CloudDrive/.../chapter.flac`
- 相对 `.strm` 文件所在目录的本地路径，例如 `./chapter.flac`

扫库时只读取 `.strm` 文件自身的文件系统元数据，不读取指针内容，不执行 `ffprobe`，也不请求远程网盘。

播放阶段的真实目标访问规则：

- 服务端根据用户恢复进度只代理当前播放章节的 `.strm` 目标，不预取固定数量的其他章节；客户端播放请求保留客户端自身的 `User-Agent`（例如 Emby），并透传 Range；只有客户端未提供标头时才回退为 `User-Agent: AudioBookShelf`，本地目标直接读取容器内文件。
- 如果书籍存在缺少真实时长、编码或声道信息的 STRM 音轨，播放响应返回后会在后台执行整本书媒体预读：本地目标使用真实路径，远程目标使用内存 Buffer 通过 `ffprobe` 标准输入探测，不阻塞首个播放响应。
- 所有 STRM 媒体预读入口共用一个全局书籍队列，同时最多预读一本书。队列按“播放触发 > 手动执行 > 计划任务”优先级选择下一本书；同一优先级内按请求进入队列的先后顺序处理。当前正在预读的书不会被抢占，完成后才重新选择高优先级队列。播放触发的后台预读和所有手动预读共用所属媒体库设置中的“媒体预读 QPS”（`strmMetadataQps`，默认 2.0），并统一在每预读 3000 个文件后暂停 3 分钟；计划任务媒体预读仍使用服务端设置中的独立 QPS 与批量阈值。已有完整音轨信息的目标不会重复请求。
- 已完成媒体预读的 STRM 书籍在播放预读、单本手动、多本手动、媒体库手动和计划任务入口中都会直接跳过；部分完成的书籍只预读缺失时长、编码或声道信息的 STRM 音轨。
- 扫描成功后把真实 `duration`、编码、码率、声道、标签和内嵌章节持久化到书籍音轨，重建书籍章节及总时长，并推送书籍更新事件使当前页面刷新。
- 远程 URL 的完整响应体只在完整扫描期间暂存于内存，不写入磁盘。对于 `?` 后携带显示文件名的 HTTP 地址，程序按 URL pathname 的真实扩展名推断音频 MIME 类型，并保留完整查询字符串。
- STRM URL 直接使用 RFC 1918 私有 IPv4、回环地址、链路本地地址或 IPv6 私有地址时，会仅在 STRM 请求链路中绕过 SSRF 过滤器，因此 `http://10.0.0.31:...` 无需额外环境变量即可访问。域名和公网 IP 仍使用项目原有 SSRF 防护。
- 扫描阶段不会访问或回写真实目标；完整扫描成功后，才会更新数据库中的音轨元数据、章节排序和全书总时长。失败的单个目标保留占位数据，不影响当前播放。
- 后台完整扫描任务按书籍 ID 去重，同一本书同时被多个客户端播放时不会重复请求全部目标。
- 当所有 STRM 音轨和书籍聚合元数据均完整时，后续播放不会再次执行完整扫描；如果仅聚合章节或总时长缺失，则只从已保存音轨重建，不访问目标。
- 本地目标默认必须位于当前媒体所属库配置的库目录内，并且必须是普通文件，防止 `.strm` 被利用为任意文件读取入口。
- 如果 `.strm` 指向媒体库目录之外但仍属于同一网盘挂载，例如媒体库是 `/NetDisk/115-Strm`、目标是 `/NetDisk/CloudNAS/...`，程序会自动将固定容器根目录 `/NetDisk` 纳入允许范围；该目录必须在容器内真实挂载，并且 `.strm` 中的路径必须使用容器内路径。
- 当前播放章节的代理失败不会阻断扫描任务；单个完整扫描目标失败会保留占位数据并记录具体原因。媒体预读等服务端后台操作通过 FFprobe 的 `-user_agent` 参数固定使用精确值 `AudioBookShelf`；播放代理则保留客户端软件名称，不强制改成 AudioBookShelf。
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

有声书媒体库默认使用原项目规则，按音频文件所在的父级目录作为一本书的边界。在创建或编辑书籍媒体库的“设置”栏目开启“顶层书籍锚点”后，才使用媒体库根目录下一层文件夹作为一本书的边界。例如媒体库是 `/Read/有声读物/` 时：

- `/Read/有声读物/A`、`B`、`C` 分别识别为三本书，文件夹名用于匹配书名。
- `/Read/有声读物/A/A1` 和 `/Read/有声读物/A/A2` 不会拆成两本书；它们的媒体文件都归入 `A`，扫描时保留 `A1/...`、`A2/...` 的相对路径。
- 该规则适用于书籍媒体库；播客继续使用原有的播客分组逻辑。
- 扫描只读取文件系统目录和文件元数据，不读取 `.strm` 指针内容，也不访问指针目标。

序列识别与排序规则如下，按以下六类信息依次判断，不能把不同层级的数字直接混排：

1. **卷目录/分卷序号**：读取书籍目录下第一层卷目录名（如 `A1`、`A2`、`Vol. 1`、`第2卷`），提取卷序并自然排序；这是全书的一级序列。
2. **碟片/光盘序号**：在同一卷内识别目录名或文件名中的 `CD`、`Disc`、`Disk` 等碟号；碟号完整且连续时优先使用它。
3. **章节/曲目序号**：识别文件名中的章节号、曲目号或连续数字区间，数字按数值而非字符串比较。
4. **媒体标签序号**：读取音频标签中的 disc number、track number 等序号；文件名和标签同时存在时，采用信息更完整、连续性更好的来源。
5. **层级目录顺序**：对无法可靠提取序号或序号相同的文件，按相对路径的目录层级和自然排序稳定排列，不能因不同卷中都存在 `01` 就跨卷合并。
6. **文件名自然排序兜底**：前述信息均缺失或完全相同时，按完整相对文件名自然排序，确保结果稳定可复现。

章节排序规则如下：

1. 先取书籍目录下的第一层卷目录进行自然排序，数字按数值比较。因此 `A1` 在 `A2` 前，`A10` 在 `A2` 后。
2. 每个卷目录内部继续使用原项目的智能排序：优先使用完整且连续的碟号；碟号相同后比较曲目号；文件名曲目号和媒体标签曲目号中信息更完整的一方优先。
3. 若曲目号相同或缺失，以文件相对路径自然排序作为稳定兜底。
4. 所有卷按上述顺序拼接后重新生成连续的全书曲目编号，从 1 开始。示例中 `A1/七玄门风云-01...` 到 `A1/七玄门风云-42...` 会先排列，之后才是 `A2/初踏修仙路-01...` 到 `A2/初踏修仙路-36...`。

因此，当前实现不会把两个卷目录中的 `01` 简单地混在一起比较；卷目录是一级排序键，卷内曲目号是二级排序键。

## 本地新增与修改功能

### 1. 有声书书名匹配边界

- 媒体库设置新增 `topLevelBookAnchor`（界面名称“顶层书籍锚点”），仅书籍媒体库显示，默认关闭；该字段保存在媒体库 JSON `settings` 中，不新增数据库列。
- 关闭时恢复原项目行为：按音频文件所在的父级目录分组并使用末级目录名匹配书名；标准 `CD`/`Disc` 目录仍按原项目规则向上合并。例如 `作者/A1/...`、`作者/A2/...` 分别识别为书籍 `A1` 和 `A2`，适合第一层为作者集合包的结构。
- 开启时应用本地定制的顶层锚点规则：只使用媒体库根目录下的直接子目录名作为书名匹配输入。例如 `/Read/有声读物/A/A1/...` 只匹配 `A`，不会把 `A1`、更深层目录名或卷目录名拼入综合书名；`A/A1`、`A/A2` 属于同一本书，音频文件相对路径保留卷目录层级。
- 完整扫描与 watcher 增量扫描均读取同一个设置，避免两种扫描入口产生不同的书籍边界。已有媒体库未保存该字段时按默认关闭处理。

### 2. 媒体库媒体预读 QPS 与详情页媒体预读

- 媒体库设置新增 `strmMetadataQps`（界面名称“媒体预读 QPS”），仅书籍媒体库显示，默认 `2.0`、范围 `0.1`–`10.0`、步长 `0.1`；该字段保存在媒体库 JSON `settings` 中，不新增数据库列。前端位置在“编辑媒体库 → 设置”栏，位于播客搜索区域配置之前。
- 该 QPS 统管所属媒体库的“播放后触发的媒体预读”和全部“手动执行的媒体预读”（详情页单本、批量多本、媒体库级）。这四个入口原先各自硬编码 QPS（播放 2.0、单本 2.0、多本 1.5、媒体库级 1.5），现已合并为同一个可自定义值。
- 四个入口统一固定“每预读 3000 个文件后暂停 3 分钟”。播放触发预读**不再有**每本书完成后额外固定暂停 3 分钟的冷却，节流完全由 QPS 与 3000 文件批量暂停控制。
- 计划任务媒体预读**不受**该字段影响，仍使用服务端设置 `strmMetadataCompletionQps` 与 `strmMetadataCompletionBatchSize`（详见第 5 节）。播客媒体库不写入该字段。
- 前端保存前会把输入值 clamp 到 `0.1`–`10.0` 并取整到 `0.1`；服务端在创建和更新媒体库时同样校验范围与 `0.1` 步长，非法值返回 400。已有媒体库未保存该字段时按默认 `2.0` 处理。注意 `ui-text-input` 组件不支持 `max` prop，上限只能依靠前端 computed clamp 与服务端校验，不要在模板上直接写 `max`。
- 有声书详情页三点菜单在“下载”附近提供“媒体预读”。
- 单本手动媒体预读的暂停计数通过该次任务的 `throttleState` 传入扫描核心，避免只配置请求间隔而遗漏批量暂停。手动请求进入全局预读队列后按请求先后顺序处理。
- 选择多本书籍媒体预读时在选中书籍之间共享同一个 `throttleState`，跨书累计每 3000 个文件暂停 3 分钟；媒体库级手动预读在整个媒体库范围内累计计数。多本书籍会按提交顺序依次进入全局预读队列，不会并发扫描。
- 手动媒体预读接口立即返回 HTTP 202，实际扫描在后台异步执行；任务 Socket 事件反馈运行进度、当前书名和完成/失败状态。已完成媒体预读的书籍直接跳过，部分完成的书籍只扫描尚未预读的 STRM 音轨。

### 3. 大量音轨、章节和媒体库文件按需渲染

- 音轨展开不再一次创建全部表格行，首次只渲染可视区及少量缓冲行。
- 详情页章节展开复用音轨表的虚拟窗口策略，不再一次创建全部章节 DOM；首次只渲染可视区和少量缓冲行。
- 音轨和章节区域滚动时均使用固定行高、上下占位和 `requestAnimationFrame` 节流，只保留窗口范围内的行，维持完整滚动高度并降低大量数据展开时的主线程和 DOM 压力。
- 章节原有的时间点击播放、展开/收起、编辑入口和章节数量显示均保留；虚拟化只改变渲染方式，不改变章节数据、排序或播放行为。
- 详情页媒体库文件展开使用完整文件行的普通文档流，不再动态替换虚拟窗口行或设置独立内部滚动容器，避免表格占位行变化触发浏览器滚动锚定并导致连续向上或向下自动滑动。
- 文件列表支持完整路径切换、音频文件详情、下载和删除操作；文件路径保持单行省略，文件操作、关联音频文件和排序行为不变。

### 4. 全局单书补全队列（播放 > 手动 > 计划，级内 FIFO）

- 所有 STRM 媒体预读入口（播放触发、单本手动、多本手动、媒体库手动、计划任务）共用一个全局书籍队列，同时最多预读一本书。
- 队列按优先级“播放触发 > 手动执行 > 计划任务”选择下一本书；同一优先级内按请求进入队列的先后顺序 FIFO 处理。当前正在媒体预读的书不会被抢占，完成后才重新选择高优先级队列。
- 队列初始化于 [`server/managers/PlaybackSessionManager.js`](../server/managers/PlaybackSessionManager.js:40)：`strmCompletionQueues = { playback: [], manual: [], scheduled: [] }` 三个队列、`strmCompletionQueueRunning` 运行锁与 `strmCompletionQueuedIds` 去重集合。
- 入队与调度核心位于 [`enqueueStrmBookCompletion`](../server/managers/PlaybackSessionManager.js:490) 与 [`processStrmCompletionQueue`](../server/managers/PlaybackSessionManager.js:500)：每次轮询按优先级顺序取第一个非空队列，级内 `shift()` 保持 FIFO；取出作业后串行执行，当前作业完成或失败后才重新选择高优先级队列。循环结束后若发现新入队作业会再次触发调度，避免竞态遗漏。
- 单书作业统一走 [`queueStrmBookById`](../server/managers/PlaybackSessionManager.js:528)：加载书籍后先用 [`isCompleteStrmBookMetadata`](../server/managers/PlaybackSessionManager.js:580) 判断整书是否已完成（存在 strm 文件且所有 strm 音轨完整），已完成直接跳过；否则只取缺失时长/编码/声道的 strm 音轨交给 [`completeStrmBook`](../server/managers/PlaybackSessionManager.js:732) 进行媒体预读探测。
- 播放触发的媒体预读通过 [`completeStrmBookAfterPlayback`](../server/managers/PlaybackSessionManager.js:666) 以 `playback` 优先级入队，走 `useLibraryQps: true` 读取所属媒体库的 `strmMetadataQps`，每 3000 文件暂停 3 分钟，并用 `strmCompletionQueuedIds` 按书籍 ID 去重。
- 手动入口以 `manual` 优先级入队，全部使用 `useLibraryQps: true`：单本 [`completeStrmItem`](../server/managers/PlaybackSessionManager.js:951)、多本 [`completeStrmItems`](../server/managers/PlaybackSessionManager.js:1098)（共享 `throttleState`）、媒体库级 [`completeStrmLibrary`](../server/managers/PlaybackSessionManager.js:883) 与 [`_completeStrmLibrary`](../server/managers/PlaybackSessionManager.js:893)。手动入口通过 `strmManualEnqueueChain` 串行准备作业，避免并发重复提交。
- QPS 与批量参数集中在文件顶部常量 `DEFAULT_STRM_METADATA_QPS = 2.0`、`STRM_METADATA_BATCH_SIZE = 3000`、`STRM_METADATA_PAUSE_MINUTES = 3`（[`PlaybackSessionManager.js:24`](../server/managers/PlaybackSessionManager.js:24)），媒体库取值统一走 [`getLibraryStrmQps`](../server/managers/PlaybackSessionManager.js:591)（越界或非法回落默认 2.0）。[`completeStrmBook`](../server/managers/PlaybackSessionManager.js:732) 在 `options.useLibraryQps` 为真时按媒体库取 QPS，否则回落 `options.qps`，并把实际 `requestIntervalMs` 回写到共享的 `throttleState`。
- 计划任务以 `scheduled` 优先级入队，见 [`completeScheduledStrmMetadata`](../server/managers/PlaybackSessionManager.js:994)，其 QPS 与批量阈值仍来自服务端设置，不使用媒体库 `strmMetadataQps`。

### 5. 计划任务：媒体库扫描、书籍匹配、元数据补全、媒体预读与清理丢失项目

- 设置页面的用户下方新增“计划任务”入口，页面适配项目现有主题变量。
- 计划任务和相关操作的用户可见名称统一为“媒体预读”，内部 API action `strm-metadata-completion` 保持不变以兼容既有调用。
- 书籍、媒体库、批量和计划任务相关的操作选项、任务标题、提示消息及日志均使用“媒体预读”名称，内部 API action `strm-metadata-completion` 保持不变以兼容既有调用。
- 本地新增的第二项“书籍匹配”横条使用 `ai-book-match` 任务动作。它支持 cron、图书媒体库多选、默认关闭的“全局匹配”、默认关闭的“入库匹配”和 0.5 小时步长的时间限制；设置窗口为左右双栏，左侧是任务参数，右侧是 OpenAI 兼容接口地址、API 密钥、模型和自动应用最低置信度。“全局匹配”和“入库匹配”两个复选项固定排在左栏最底部同一行左右对齐（左栏 `section` 使用 `flex flex-col`，复选项容器用 `mt-auto` 压到底），功能说明不再用小字段落，而是与媒体库编辑窗口设置栏一致的 `ui-tooltip` + `material-symbols` 感叹号图标悬浮显示。全局匹配关闭时只处理未匹配图书；开启后所选媒体库中的全部有效图书都会重新经过书籍匹配，并以覆盖模式应用匹配元数据。入库匹配开启后由本任务的匹配逻辑接管新书籍扫描入库后的匹配操作。横条第二行在手动或计划任务完成后均显示上次执行时间、耗时和成功匹配的图书数量。AI 接口未配置时任务仍可运行，只使用本地提取规则和全称兜底。
- 本地新增的“补全元数据”横条使用 `book-metadata-completion` 任务动作，支持 cron、图书媒体库多选和 0.5 小时步长的时间限制。该任务与 AI 书籍匹配严格分离：按照每本书所属媒体库的默认 `library.provider` 逐本请求 [`BookFinder.search()`](../server/finders/BookFinder.js:374)，找到候选后调用 [`Scanner.quickMatchLibraryItem()`](../server/scanner/Scanner.js:59)；始终关闭覆盖封面和覆盖详情，只补充缺失字段。停止时 provider 搜索等待可被协作式取消抢先结束，取消后不继续写入或处理下一本书。每本书的日志只显示书名、提供商和实际补全的字段类别（如标题、作者、流派、出版商、系列、封面），不输出元数据具体内容；自定义提供商显示设置中配置的名称，不显示 `custom-UUID`，内置提供商显示规范可读名称。AI 书籍匹配仍只处理 [`getUnmatchedCandidates()`](../server/managers/AiBookMatchManager.js:85) 判定为未完成匹配的书籍，对已匹配书籍不执行 AI 请求、provider 搜索或写入。
- 书籍支持不新增数据库列的计划任务元数据锁，锁状态存储在 `LibraryItem.extraData.metadataLocks`，结构为 `{ all, fields }`。单书详情页右下角三点菜单和书籍卡片菜单在“媒体预读”下面显示“锁定元数据/解锁元数据”；媒体库批量选择后的右上角三点菜单提供批量锁定与解锁。总锁只阻止书籍匹配和补全元数据计划任务，手动快速匹配、手动匹配和手动编辑仍可更新。
- 编辑书籍详情页在“删节版”右侧显示“锁定”总开关；成人内容、删节版和总锁三个复选项底部对齐，成人内容与删节版不提供逐字段锁。普通元数据锁图标位于输入控件内部右侧；描述锁图标位于描述输入框内部右上角，富文本工具栏保持原始高度和按钮布局，编辑器右下角保留浏览器原生尺寸拖拽手柄。锁图标默认是暗灰色开锁，点击后成为带主题自适应高亮背景的白色闭锁。逐字段锁即使字段为空也禁止计划任务补全该字段；总锁未开启时，其他未锁字段仍可补全。封面也纳入字段锁。前端图标使用 [`MetadataLockButton.vue`](../client/components/widgets/MetadataLockButton.vue:1)，原始闭锁图资源保留为 [`metadata-lock.png`](../client/static/metadata-lock.png)。
- [`AiBookMatchManager`](../server/managers/AiBookMatchManager.js:27) 以书籍的 `media.title`（该字段就是原始文件夹名）为输入。只有本地提取规则都不适用时，才把该名称发送给 OpenAI 兼容接口 `/chat/completions` 提取书名、作者和演播者；作者与演播者去重合并后分别作为既有 [`BookFinder.search`](../server/finders/BookFinder.js:374) 的标题和作者参数，再获取最多 8 个候选。随后 AI 只能返回本次候选数组中的序号、0 至 1 置信度和理由；服务端拒绝越界序号、非法 JSON 与非法置信度，禁止 AI 自由生成并直接写入元数据。
- 达到 `aiBookMatchConfidence` 阈值后，任务调用 [`Scanner.applyBookMatch`](../server/scanner/Scanner.js:159)，与原快速匹配共用封面、作者、系列、元数据文件和 Socket 更新流程。
- 书名提取按固定优先级逐级尝试，任一级搜索并确认匹配成功即结束，不再执行后续级别（[`buildMatchAttempts`](../server/managers/AiBookMatchManager.js:197)、[`matchLibraryItem`](../server/managers/AiBookMatchManager.js:386)）：
  1. 本地书名号：原名称含 `《》`、`「」` 或 `『』` 时直接取括号内文本作为书名，优先级最高，此时不请求 AI。
  2. 本地符号分隔：无书名号时按 `丨`、`|`、`｜`、`.`、`．`、`-`、`－`、`—`、`–` 定位第一个符号，取符号之前的片段作为书名，此时同样不请求 AI。
  3. AI 书名 + 人物：无任何本地符号标识且已配置 AI 时，由 AI 分别提取书名和作者/演播者，作为搜索栏的书名与作者名一起搜索。
  4. AI 仅书名：第三级搜索无候选或候选未达置信度阈值时，删除作者名条件，仅用 AI 提取的书名再搜索一次。
  5. 全称兜底：以上都未匹配，或未配置 AI、AI 提取失败而跳过第三/第四级时，直接把完整原名称放入书名栏搜索。
- 本地规则（第一、二级）提取到书名后不再调用 AI 提取接口；AI 只在没有任何本地符号标识时参与书名/人物提取。未配置 AI 时整条链路只保留本地规则和全称兜底，候选判断退化为直接采用 provider 的首个候选，审计状态记为 `matched-local`。
- 已配置 AI 时每一级仍由 AI 候选判断把关，达到 `aiBookMatchConfidence` 阈值才写入元数据；未达阈值的级别继续尝试下一级，全部失败后按最后一次失败原因写入 `unmatched` 或 `needs-review` 审计。
- 匹配审计新增 `rule` 字段记录命中的提取规则，日志额外输出中文规则名称（书名号、符号分隔、AI 书名+人物、AI 仅书名、全称）。
- “入库匹配”是书籍匹配设置中的可选项，配置字段 `aiBookMatchOnScan`，默认关闭。勾选后本项目扫描到新书籍入库时不再依赖原扫描期匹配流程，而是由 [`enqueueScanMatch`](../server/managers/AiBookMatchManager.js:486) 把新书交给上述书籍匹配逻辑：入队后串行处理，一次只匹配一本书，按书籍 ID 去重；只处理书籍媒体库中的新项目，并在书籍匹配设置里选择了媒体库时仅处理所选媒体库（未选择媒体库时不限制）。完整扫描与 watcher 增量扫描共用同一入口 [`scanNewLibraryItem`](../server/scanner/LibraryItemScanner.js:186)，因此两种扫描方式行为一致。
- 入库匹配的队列作业会先等待创建该书的媒体库扫描结束（轮询 [`LibraryScanner.isLibraryScanning`](../server/scanner/LibraryScanner.js:33)），避免扫描写入与匹配写入相互干扰；扫描完成后再逐本匹配。匹配以覆盖封面和详情模式应用结果，但继续遵守元数据锁；每本书都写入与计划任务相同的 `extraData.aiBookMatch` 审计，因此后续计划任务不会重复匹配已成功的书。
- 本地规则命中时不请求 AI 提取接口，只用本地书名搜索；AI 提取超时或失败时直接跳到全称兜底级别，不阻断整本书的匹配。未配置 AI 时 [`runAiBookMatch`](../server/managers/CronManager.js:262) 不再抛出“未配置”错误，任务可以只跑本地规则。
- 计划任务停止通过 [`AbortController`](../server/managers/CronManager.js:273) 中断当前 AI HTTP 请求，并由 [`throwIfAborted`](../server/managers/AiBookMatchManager.js:316) 在每一级 provider 搜索和候选判断前后检查停止状态；取消不会写入 `needs-review` 审计，也不会继续处理下一级或下一本书。
- 计划任务每批读取书籍后先调用 [`getUnmatchedCandidates`](../server/managers/AiBookMatchManager.js:85) 预过滤，只有“除标题、描述和扫描基础信息外，所有扩展元数据均为空”的历史书籍才进入逐本匹配。持续时间、文件大小、音轨、章节、文件路径和 `libraryFiles` 属于扫描基础信息，不影响候选资格。
- ISBN、ASIN、副标题、出版日期/年份、出版社、语言、作者、演播者、系列、标签、类型或 `matched-ai`/`matched-local` 成功审计任一存在，即视为已有匹配信息并在批次层排除，不执行 AI 提取、provider 搜索或候选判断；书籍封面可有可无，不参与匹配状态判断。`unmatched` 和 `needs-review` 审计仍允许后续计划任务重试。
- [`matchLibraryItem`](../server/managers/AiBookMatchManager.js:386) 仍保留同一候选判断作为防御性保护，防止其他调用入口绕过计划任务批次预过滤。
- 每次失败、低置信度或成功判断都持久化到已有 `LibraryItem.extraData.aiBookMatch`，记录 `status`、`source`、`model`、`rule`、`confidence`、`candidate`、`updatedAt`、`reason` 等审计信息，不新增数据库表或列。AI 提取失败会记录具体原因并标记待复核；没有 provider 候选的 `unmatched` 会保留实际搜索标题和作者，便于后续排查。
- 四类计划任务都会写入可读的执行日志：媒体库扫描记录目标媒体库和扫描开始/完成；书籍匹配记录媒体库、原名称、命中的提取规则、搜索标题和作者、匹配结果及候选书名，结果状态使用“匹配成功”“未找到匹配”“待复核”“已跳过”等中文文案，不直接显示内部状态码；媒体预读记录书名、待预读音轨数和成功/失败结果；清理丢失项目记录媒体库名称和被清理项目名称。日志正文不重复写时间，也不使用媒体库 ID，时间由日志系统自动标注。书籍匹配选择多个媒体库时按设置顺序逐个处理，单个媒体库内按书籍顺序逐本处理，不并行执行；媒体预读通过媒体库 ID 到名称的映射输出媒体库名称。入库匹配的日志前缀为 `[AiBookMatchManager] 入库匹配`，同样输出媒体库名称、原名称和提取规则。
- 配置字段为 `aiBookMatchCronExpression`、`aiBookMatchLibraryIds`、`aiBookMatchGlobal`、`aiBookMatchOnScan`、`aiBookMatchMaxHours`、`aiBookMatchApiUrl`、`aiBookMatchApiKey`、`aiBookMatchModel` 和 `aiBookMatchConfidence`，其中 `aiBookMatchGlobal` 与 `aiBookMatchOnScan` 默认 `false`。密钥只对管理员通过 [`getAiBookMatchSettings()`](../server/controllers/MiscController.js:132) 按需读取，普通浏览器设置仍不会返回密钥；页面打开书籍匹配设置时加载已保存密钥，输入框默认以密码形式显示，右侧按钮可切换明文显示与密码隐藏状态，关闭并重新打开设置时恢复隐藏。留空时不覆盖已保存值。最后一次执行摘要持久化在 `aiBookMatchLastRun`，因此即使 cron 在浏览器未打开时运行，下次进入页面仍能显示上次执行时间、耗时和匹配数量。
- 补全元数据配置字段为 `bookMetadataCompletionCronExpression`、`bookMetadataCompletionLibraryIds`、`bookMetadataCompletionMaxHours` 和 `bookMetadataCompletionLastRun`，运行/停止接口为 `/api/book-metadata-completion/run` 与 `/api/book-metadata-completion/stop`。任务结果包含处理数、更新数、未找到候选数和跳过数；停止接口设置取消标志后，当前搜索最多等待取消轮询间隔即可退出。
- 页面提供“媒体库扫描”“媒体预读”“清理丢失项目”等紧凑横条，媒体库扫描排在第一位；每条依次显示大字功能标题、已运行后的上次运行摘要和小字描述，右侧显示立即执行、运行中的普通停止图标与竖三点图标。停止图标不使用背景填充、高亮或额外描边框，点击热区仍保持足够大小；停止按钮调用对应停止 API，服务端立即设置取消标志，provider 搜索等待通过取消竞速及时退出，扫描/媒体预读/清理任务在当前安全边界结束后停止。
- 三条横条均支持 cron 表达式；不设置 cron 表达式即为不开启，默认不开启。保存时空字符串与纯空格会被规范化为 `null`（前端 [`saveSettings`](../client/pages/config/scheduled-tasks.vue:239) 与服务端 [`updateServerSettings`](../server/controllers/MiscController.js:146) 双重处理），服务端 cron 合法性校验必须使用**规范化之后**的 `settingsUpdate[key]`（不能使用规范化前的局部变量，否则空串会被判为非法 cron 而返回 400），cron 变更后立即重建对应定时任务（[`updateStrmMetadataCron`](../server/managers/CronManager.js:191)、[`updateMissingItemsCleanupCron`](../server/managers/CronManager.js:232)、[`updateScheduledLibraryScanCron`](../server/managers/CronManager.js:463)，表达式为空时停止并清空定时任务）。
- 三项任务接口立即返回 HTTP 202，任务 Socket 事件负责反馈运行状态和完成结果。页面按任务 action 查找未完成任务，手动执行和 cron 执行均显示运行状态与停止按钮；全局布局收到 `task_finished` 后先写入任务 store，再通过 `$eventBus` 转发完成事件，计划任务页优先读取 `task.data.result` 中的服务端摘要并按完成时间去重，同步浏览器本地记录，书籍匹配横条显示“上次执行：时间，耗时 时长，匹配了 N 本图书”（清理任务额外显示清理了 N 项）。
- 媒体库扫描（`scheduled-library-scan`）支持选择要扫描的媒体库（多选，不选则不扫描任何库）和时间限制（界面标签“时间限制（h）”，最小 0.5 小时、步长 0.5 小时，服务端校验）；执行时按选定顺序串行扫描，同时只扫描一个媒体库，受截止时间限制，超时或停止后立即结束并只在完成数中统计真正扫描完的库；停止入口为 `/api/scheduled-library-scan/stop`。配置字段为 `scheduledLibraryScanCronExpression`、`scheduledLibraryScanLibraryIds`、`scheduledLibraryScanMaxHours`，保存在服务端设置中（[`ServerSettings.js`](../server/objects/settings/ServerSettings.js:70)）。日志正文使用媒体库名称，不重复输出日志系统已经提供的时间戳。
- 媒体预读跳过已完成的 STRM 书籍；计划任务只处理媒体信息不完整的书籍，部分完成的书籍仅将缺失信息的 STRM 音轨交给真实目标探测和扫描流程。计划任务进入全局预读队列的优先级低于播放触发和手动预读；停止计划任务时，尚未开始的排队书籍会在轮到时跳过，当前音轨探测完成后协作式退出。
- 媒体预读支持 cron 表达式、图书媒体库多选和时间限制，未选择媒体库时不处理任何书籍；时间限制使用可直接输入的数字步进框，界面标签统一为“时间限制（h）”，最小 0.5 小时、步长 0.5 小时；服务端校验 cron、媒体库 ID 和步长。媒体库选择设置字段为 `strmMetadataCompletionLibraryIds`。计划任务 QPS 设置字段为 `strmMetadataCompletionQps`，默认 1.0，范围 0.1 至 10.0、步长 0.1。计划任务批量暂停设置字段为 `strmMetadataCompletionBatchSize`，默认 5000、最小 500、步长 500；达到配置阈值后暂停 5 分钟，并受单次小时数截止时间限制。计划任务的 QPS 与批量阈值与媒体库设置中的 `strmMetadataQps` 完全独立，后者只作用于播放触发预读和手动预读。
- 清理丢失项目支持独立 cron 表达式、媒体库多选和立即执行；配置字段为 `missingItemsCleanupLibraryIds`，未选择媒体库时不清理任何项目。任务只清理所选媒体库中扫描后标记 `isMissing` 的项目，不处理仅标记 `isInvalid` 的项目。
- 清理丢失项目复用项目删除的数据库关联清理流程，删除播放进度、播放列表关联、RSS、缓存、metadata 数据和项目记录，但不删除文件系统文件；完成后刷新问题统计并发送项目移除事件。任务结果在 `task.data.result.removed` 返回实际清理数量，页面第二行显示“清理了 N 项”，即使 N 为 `0` 也明确显示 `0`。
- 三项计划任务均有运行中防重入保护和协作式取消：停止入口分别为 `/api/scheduled-library-scan/stop`、`/api/strm-metadata-completion/stop` 与 `/api/missing-items-cleanup/stop`。STRM 任务在当前探测完成后于下一首音轨或下一本书边界退出，批量暂停等待可被轮询取消；清理任务在每个媒体库和项目边界检查取消状态，已完成删除的数量保留在结果中；扫描任务在每库边界检查取消并设置库级取消标记（[`LibraryScanner.setCancelLibraryScan`](../server/scanner/LibraryScanner.js:41)）。配置保存在服务端设置中，cron 变更后立即重建对应定时任务。
- 所有计划任务横条的设置窗口把执行时长输入框的标签统一为“时间限制（h）”（原为“单次最长执行时间（小时）”），共三处模板文案：书籍匹配左栏、扫描/补全/预读共用块、`hasMaxHours` 兜底块；[`validateDrafts`](../client/pages/config/scheduled-tasks.vue:217) 的校验提示文案也同步为“时间限制（h）必须是不小于 0.5 且为 0.5 倍数的数值”，保持提示与标签一致。
- 计划任务页面标题使用 `:header-text` 而非 `:title`：`app-settings-content` 组件只声明 `headerText`/`description`/`note` props（[`SettingsContent.vue`](../client/components/app/SettingsContent.vue:18)），未声明的 `title` 会被 Vue 作为原生 HTML 属性渲染到内容根 div 上，产生浏览器原生“计划任务”悬浮提示框；改为 `:header-text` 后标题仅作为文字渲染，不再出现原生悬浮提示（[`scheduled-tasks.vue`](../client/pages/config/scheduled-tasks.vue:2)）。
- 五条横条的设置窗口保存前先做前端数值校验并始终给出提示，避免出现“点保存没反应”的静默失败。[`validateDrafts`](../client/pages/config/scheduled-tasks.vue:217) 依次校验时间限制（h）（≥0.5、0.5 倍数）、扫描 QPS（0.1–10、0.1 倍数）、暂停阈值（≥500、500 倍数整数）和自动应用最低置信度（0.5–1）；任一不合法就用 `$toast.error` 提示中文原因并直接返回，不发起 PATCH。数值转换走 [`draftNumber`](../client/pages/config/scheduled-tasks.vue:210)（`v-model.number` 在输入框被清空时会得到 `null`/`""`），步长判定走 [`isStepMultiple`](../client/pages/config/scheduled-tasks.vue:214) 的 1e-9 容差比较，避免 `2.5`、`0.3` 一类小数被浮点误差误判。
- [`saveSettings`](../client/pages/config/scheduled-tasks.vue:239) 的 `catch` 必须把服务端返回的错误文本（`error.response.data`）通过 `$toast.error` 显示出来，没有文本时退回“保存设置失败”；成功时显示“<任务名>设置已保存”。不能只 `console.error`，否则保存失败在界面上只表现为“弹窗不关闭”。同时 `draftAiUrl`/`draftAiModel`/`draftAiKey` 一律用 `(this.draftAiX || '').trim()` 取值，防止 draft 为 `null` 时 `TypeError` 被 `catch` 吞掉造成静默失败。

### 6. STRM 书内断点接续与未完成标注

- 这是本地新增功能，不新增数据库字段。音轨是否完成仍以 `duration > 0`、存在 `codec` 且 `channels > 0` 为事实来源；整书完成只要求存在的 STRM 音轨全部完成，不再额外依赖书籍聚合 `media.duration`，避免已完成音轨因聚合时长异常为 0 而重复补全。
- [`getStrmBookMetadataStatus`](../server/managers/PlaybackSessionManager.js:566) 动态计算 STRM 音轨总数、已完成数、未完成数、百分比和整书完成状态。由于状态由已保存音轨实时推导，扫描新增或删除 `.strm` 文件后，重新扫描媒体库即可自动纳入或移除统计，不会留下过期状态字段。
- [`completeStrmBook`](../server/managers/PlaybackSessionManager.js:732) 在每成功探测一个音轨后累积待保存数量；每 50 个成功音轨执行一次局部持久化，并在取消、时间限制、循环结束时强制 flush。持久化会先重建当前已知的音轨排序、章节和总时长，再调用 `media.save()` 与 `saveMetadataFile()`，随后发送 `item_updated` 事件。
- 取消或超时只会停止后续探测，不回滚已经成功且已保存的音轨。下次入口重新读取书籍后，`queueStrmBookById` 只把不完整音轨传给探测器，因此可以从上次保存位置继续；已经完成的音轨不会重复请求。当前小批次阈值是内部常量 50，与计划任务的 3000/5000 音轨暂停阈值相互独立。
- [`LibraryItemDetails.vue`](../client/components/content/LibraryItemDetails.vue:72) 在有声书详情页根据 `media.audioFiles` 动态判断补全状态。书籍已经补全出部分有效总时长、但仍有未完成 STRM 音轨时，在“持续时间”值右侧显示小型沙漏“待完成”标识；总时长仍为 `0 sec`、尚未开始有效补全时不显示，全部音轨完成后自动消失。该标识不与 `isMissing`、`isInvalid` 或用户播放进度混用。
- 数据库保存成功但 metadata 文件写入失败时会记录错误，数据库中的进度仍可供下一次断点接续；下一次成功 flush 会再次写 metadata 文件。该策略避免为了 metadata 文件失败而丢弃已经持久化的音轨事实。

### 7. 主题

- `浩瀚星空` 回退为静态深邃藏蓝、墨紫和炭黑底色，保留少量错落的银白、浅蓝、淡金和浅紫星点；不使用漂移、缩放或闪烁动画，背景层不阻挡页面交互。
- 新增 `暗色主题`，采用炭黑、冷灰和低饱和蓝灰配色，适合作为低干扰的纯暗色界面。

### 8. 媒体预读在「活动」中显示当前书名

- 五个媒体预读入口全部会在客户端右上角「活动」下拉里出现一条任务，并显示**当前正在预读的书名**：播放触发、单本手动、多本批量手动、媒体库级手动、计划任务。改动前只有媒体库级手动和计划任务两个入口建任务，另外三个入口只写日志，界面上完全看不到预读在跑。
- 统一由三个辅助方法承载，避免每个入口各写一套任务代码：[`createStrmPreloadTask`](../server/managers/PlaybackSessionManager.js:616) 建任务、[`updateStrmPreloadTaskBook`](../server/managers/PlaybackSessionManager.js:637) 更新当前书名与进度、[`finishStrmPreloadTask`](../server/managers/PlaybackSessionManager.js:653) 收尾。书名统一取自 [`getStrmBookDisplayTitle`](../server/managers/PlaybackSessionManager.js:603)（`media.title` → `libraryItem.title` → `id`）。
- 任务标题即当前书名：任务刚建立时标题为「媒体预读排队中」（`MessageTaskCompletingStrmMetadataQueued`），真正开始某本书时切换为「正在媒体预读：<书名>」（`MessageTaskCompletingStrmMetadata`，`titleSubs = [书名]`）。批量、媒体库和计划任务在每切换一本书时都会重新写入书名，所以下拉里始终显示的是**正在预读的那一本**，不是任务发起时的那一本。
- 任务描述固定标注预读来源，便于在活动列表中区分同名书籍的不同入口：`MessageTaskStrmPreloadSourcePlayback`（播放触发媒体预读）、`MessageTaskStrmPreloadSourceManual`（手动媒体预读）、`MessageTaskStrmPreloadSourceBatch`（手动批量媒体预读（N 本））、`MessageTaskStrmPreloadSourceLibrary`（手动媒体预读：<媒体库名>）、`MessageTaskStrmPreloadSourceScheduled`（计划任务媒体预读）。描述在任务结束后需要保留，因此 `finishStrmPreloadTask` 调用的是 `setFinished()` 而**不是** `setFinished(null, true)`（后者会清空描述）。
- 播放触发的预读任务在**入队时**就创建，因此书籍在全局队列中等待期间活动里已经可见（显示书名 + 「播放触发媒体预读」），轮到执行时再刷新音轨总数与进度。为了不给无需预读的书建空任务，[`completeStrmBookAfterPlayback`](../server/managers/PlaybackSessionManager.js:666) 在入队前先加载书籍判断是否存在未完成 STRM 音轨；由于该查询会让出事件循环，紧接着必须再检查一次 `strmCompletionQueuedIds` 去重集合，否则同一本书并发触发两次播放会建出两条任务。
- 进度沿用各入口原有的 `throttleState.onTrackScanned` 回调累计已扫描音轨数，换算成 0–100 的百分比通过 `task_progress` 事件推送。单本、批量与播放三个入口原先没有 `onTrackScanned` 回调，本次补上。
- 前端 [`ItemTaskRunningCard.vue`](../client/components/cards/ItemTaskRunningCard.vue:107) 为 `strm-metadata-completion` 动作增加 `strmPreloadProgress` 计算属性，在书名与来源描述之下多显示一行「已扫描/总数」音轨计数（`totalTracks` 为 0 时不显示，任务结束后不显示）；同时把该动作的图标从默认 `settings` 改为 `graphic_eq`。
- 失败状态统一使用新键 `MessageTaskStrmPreloadFailed`（「媒体预读失败：{0}」），替换原先计划任务使用的、实际并不存在于翻译文件中的 `MessageTaskCompletingStrmMetadataFailed`（缺键会导致 `$getString` 返回空串，界面上看不到任何失败原因）。
- 依赖两处本地已有改造：服务端 [`TaskManager.updateTaskProgress`](../server/managers/TaskManager.js:39) 在 `task_progress` 事件里附带 `taskId`/`action`/`data`/`title`/`titleKey`/`titleSubs`；前端 [`tasks.js` 的 `updateTaskProgress`](../client/store/tasks.js:45) 在 payload 带 `taskId` 时更新对应任务对象（上游原版只写 `state.taskProgress[libraryItemId]`，不会刷新标题）。这两处缺一，书名就不会随当前书籍变化。
- 「活动」下拉只显示未结束任务，以及结束后 60 秒内的失败或 `showSuccess` 任务（[`NotificationWidget.vue`](../client/components/widgets/NotificationWidget.vue:62)），所有预读任务均以 `showSuccess = true` 创建，因此完成后会短暂保留一条成功记录。

### 9. STRM 指针解析取消 mtime 缓存

- [`resolveStrmTarget`](../server/utils/strmUtils.js:60) 原本以 `<指针路径>|<mtimeMs>|<允许的根目录>` 为键缓存解析结果（`strmUrlCache`），现已完全移除该缓存，每次调用都重新 `readFile` 指针内容。
- 移除原因（实测确认，不是理论风险）：文件系统 mtime 分辨率很粗。在 Windows 上连续改写同一个 `.strm` 文件 400 次只产生 128 个不同的 `mtimeMs`，相邻写入间隔中位数约 1ms。两次改写落在同一刻度时缓存键完全相同，于是命中旧缓存并返回**改写前**的旧目标。更严重的是「目标必须位于媒体库目录或 `/NetDisk` 之内」的越界校验和目标 `stat()` 检查原本写在缓存回调内部，命中缓存时这两项检查**被整体跳过**。实测 200 次改写中 mtime 相同 42 次、越界校验未抛错 42 次，两组完全重合。
- 该缓存也是 `test/server/utils/scandir.test.js` 里 `should resolve local STRM targets without probing the target during scanning` 偶发失败（20 次约 2–3 次）的根因；移除后连续 30 次 0 失败。注意干净树上同样会失败，属于本地既有缺陷而非上游问题。
- 性能代价可忽略：实测 `readFile` 单次约 0.1526ms，原缓存命中路径约 0.0362ms，即每次多约 0.12ms。按 10 QPS 预读 3000 个文件总共多约 0.36 秒。
- 回归测试 [`re-reads STRM pointer contents even when the mtime is unchanged`](../test/server/utils/scandir.test.js:211)：用 `fs.utimes` 把每次改写后的 mtime **钉死到同一个固定值**，断言改写后能解析出新目标、mtime 确实未变、改写为库外路径后仍抛 `outside configured library folders`。写该测试时注意 `stat().mtimeMs` 带小数，必须在 pin 之后重新读一次取基准值再比较，直接和 pin 之前的值比会失败。

### 10. 书籍匹配的 AI 请求重试与本地降级

- 现象：日志出现 `[CronManager] 书籍匹配：…提取规则：-，搜索标题 "-"，搜索作者 "-"，结果：待复核，原因：Request failed with status code 503` 与 `[AiBookMatchManager] 入库匹配失败：…原因：Request failed with status code 503`，看上去像“入库匹配没生效”“未匹配书籍也没生效”。
- 根因不在提取规则，而在 AI 请求的异常处理。以 `恶魔法则.演播一种侃侃.跳舞.2023` 为例：名称含 `.`，本地符号分隔规则正常命中并提取出 `恶魔法则`，provider 也返回了候选；随后 [`chooseCandidate`](../server/managers/AiBookMatchManager.js:273) 请求 AI 接口拿到 `503`，`axios` 抛出的异常一路冒泡出 [`matchLibraryItem`](../server/managers/AiBookMatchManager.js:386)，被 [`CronManager`](../server/managers/CronManager.js:307) 的 `catch` 兜住后统一写成 `needs-review`。该 `catch` 构造的 `matchResult` 只有 `status` 和 `reason`，没有 `rule`/`searchTitle`/`searchAuthor`，所以日志把这三项打成 `-`，造成“规则没生效”的误判。入库匹配走 [`processScanMatchQueue`](../server/managers/AiBookMatchManager.js:499) 的 `catch`，表现为“入库匹配失败”。
- 修复一：AI 请求统一走带重试的 [`postAiRequest`](../server/managers/AiBookMatchManager.js:351)。`408`、`429`、`5xx` 和网络层错误（无 `response`）最多重试 3 次；有 `Retry-After` 头时按该值等待（上限 30 秒），否则按 2 秒、4 秒递增。`401`、`403`、`400` 一类确定性错误立即失败，不做无意义重试。等待走 [`wait`](../server/managers/AiBookMatchManager.js:330)，可被停止信号打断。
- 修复二：AI 失败不再让整本书失败。[`buildMatchAttempts`](../server/managers/AiBookMatchManager.js:197) 的书名提取失败原本已经降级，本次补上候选判定：`matchLibraryItem` 内的 `chooseCandidate` 失败后只把本书剩余级别的 `aiUsable` 置为 `false`，直接采用 provider 首个候选并把审计写成 `matched-local` / `source: local`，而不是抛出异常。审计里的 `status`/`source`/`model` 改为依据实际是否用到 AI 的 `usedAi` 变量，而不是“是否配置了 AI”的 `aiConfigured`，避免降级后仍被标成 `matched-ai`。
- 修复三：新增软熔断。连续 `AI_FAILURE_STREAK_LIMIT = 3` 次 AI 传输失败后，[`noteAiFailure`](../server/managers/AiBookMatchManager.js:66) 把 `aiUnavailableUntil` 推后 `AI_COOLDOWN_MS = 5` 分钟，期间 [`isAiUsable`](../server/managers/AiBookMatchManager.js:51) 返回 `false`，整批书籍跳过 AI 步骤、只用本地规则继续匹配，不会每本书都白等三次重试超时。任一次 AI 成功即由 [`noteAiSuccess`](../server/managers/AiBookMatchManager.js:55) 清零。熔断状态只存在于 `AiBookMatchManager` 实例字段，不落库、不影响 `isConfigured` 的语义。
- 取消判定集中到 [`isCancelledError`](../server/managers/AiBookMatchManager.js:320)（检查 `options.signal.aborted`、`ERR_CANCELED`、`CanceledError`），停止计划任务时仍立即中断且不写失败审计、不触发熔断计数以外的重试。
- 修复四：兜底日志不再丢信息。[`CronManager`](../server/managers/CronManager.js:307) 的 `catch` 和 [`processScanMatchQueue`](../server/managers/AiBookMatchManager.js:499) 的 `catch` 都会重新用 `extractLocalTitleWithRule` 算出规则与书名后再写审计和日志，因此即便出现未预料的异常，日志也会显示真实的提取规则和搜索标题，而不是三个 `-`。
- 效果对比：修复前 AI 侧一次 `503` 会让该书直接进入 `needs-review` 且日志丢失规则信息；修复后先重试，仍失败则用本地规则 + provider 首个候选完成匹配（审计 `matched-local`），日志正常显示 `提取规则：符号分隔，搜索标题 "恶魔法则"`。若 provider 本身没有候选，结果仍是 `unmatched`，这属于正常语义。

## 代码锚点

### 后端 STRM 与补全队列

- [`server/utils/globals.js`](../server/utils/globals.js:1)：将 `strm` 注册到音频扩展列表。
- [`server/objects/files/AudioFile.js`](../server/objects/files/AudioFile.js:112)：创建不依赖远程探测的占位音频对象。
- [`server/scanner/AudioFileScanner.js`](../server/scanner/AudioFileScanner.js:157)：扫描时识别 `.strm` 并跳过 `ffprobe`。
- [`server/utils/strmUtils.js`](../server/utils/strmUtils.js:1)：指针解析、URL/本地目标判定、安全校验、完整扫描探测和当前章节媒体代理。
- [`server/utils/strmUtils.js`](../server/utils/strmUtils.js:60)：`resolveStrmTarget` 每次调用都重新读取指针内容，不再有 mtime 缓存；越界校验与目标 `stat()` 无条件执行。
- [`server/managers/PlaybackSessionManager.js`](../server/managers/PlaybackSessionManager.js:603)：`getStrmBookDisplayTitle` 活动列表书名取值。
- [`server/managers/PlaybackSessionManager.js`](../server/managers/PlaybackSessionManager.js:616)：`createStrmPreloadTask` 创建媒体预读活动任务（`showSuccess = true`，描述记录预读来源）。
- [`server/managers/PlaybackSessionManager.js`](../server/managers/PlaybackSessionManager.js:637)：`updateStrmPreloadTaskBook` 把当前书名写入 `titleKey`/`titleSubs` 并推送进度。
- [`server/managers/PlaybackSessionManager.js`](../server/managers/PlaybackSessionManager.js:653)：`finishStrmPreloadTask` 收尾（保留描述，未真正预读时把标题回落为「媒体预读」）。
- [`server/managers/TaskManager.js`](../server/managers/TaskManager.js:39)：`updateTaskProgress` 在 `task_progress` 事件中附带 `taskId`/`action`/`data`/`title`/`titleKey`/`titleSubs`。
- [`server/utils/scandir.js`](../server/utils/scandir.js:48)：默认保留原项目父级目录分组和末级目录书名解析；启用 `topLevelBookAnchor` 时按根目录下一层文件夹聚合文件，并仅使用首层目录进行书名解析。
- [`server/managers/PlaybackSessionManager.js`](../server/managers/PlaybackSessionManager.js:40)：全局三级补全队列初始化（playback/manual/scheduled 三个 FIFO 队列 + 运行锁 + 书籍去重）。
- [`server/managers/PlaybackSessionManager.js`](../server/managers/PlaybackSessionManager.js:490)：`enqueueStrmBookCompletion` 入队与 `processStrmCompletionQueue` 优先级调度核心。
- [`server/managers/PlaybackSessionManager.js`](../server/managers/PlaybackSessionManager.js:528)：`queueStrmBookById` 单书作业：过滤已完成书籍、只取缺失元数据的 strm 音轨。
- [`server/managers/PlaybackSessionManager.js`](../server/managers/PlaybackSessionManager.js:560)：`isCompleteStrmAudioFile`（duration/codec/channels 完整性判断）。
- [`server/managers/PlaybackSessionManager.js`](../server/managers/PlaybackSessionManager.js:580)：`isCompleteStrmBookMetadata`（整书是否已补全）。
- [`server/managers/PlaybackSessionManager.js`](../server/managers/PlaybackSessionManager.js:732)：`completeStrmBook` 完整扫描核心：探测、QPS/批量暂停/截止时间控制、书内断点保存、结束后重建章节与总时长并保存。
- [`server/managers/PlaybackSessionManager.js`](../server/managers/PlaybackSessionManager.js:566)：`getStrmBookMetadataStatus` 动态计算音轨完成比例；持久化批次和取消前 flush 逻辑位于 `completeStrmBook` 内部，未引入新的数据库状态列。
- [`server/managers/PlaybackSessionManager.js`](../server/managers/PlaybackSessionManager.js:24)：媒体预读节流常量 `DEFAULT_STRM_METADATA_QPS = 2.0`、`STRM_METADATA_BATCH_SIZE = 3000`、`STRM_METADATA_PAUSE_MINUTES = 3`。
- [`server/managers/PlaybackSessionManager.js`](../server/managers/PlaybackSessionManager.js:591)：`getLibraryStrmQps` 读取媒体库 `settings.strmMetadataQps`，非法或越界回落 2.0。
- [`server/managers/PlaybackSessionManager.js`](../server/managers/PlaybackSessionManager.js:666)：播放触发补全（playback 优先级、`useLibraryQps`、每 3000 文件暂停 3 分钟、书籍 ID 去重；无每本完成后固定冷却）。
- [`server/managers/PlaybackSessionManager.js`](../server/managers/PlaybackSessionManager.js:951)：单本手动媒体预读（manual 优先级、`useLibraryQps`、每 3000 文件暂停 3 分钟）。
- [`server/managers/PlaybackSessionManager.js`](../server/managers/PlaybackSessionManager.js:1098)：多本手动媒体预读（manual 优先级、`useLibraryQps`、跨书共享每 3000 文件暂停 3 分钟）。
- [`server/managers/PlaybackSessionManager.js`](../server/managers/PlaybackSessionManager.js:893)：媒体库级手动媒体预读（manual 优先级、`useLibraryQps`、累计 3000 文件暂停 3 分钟）。
- [`server/managers/PlaybackSessionManager.js`](../server/managers/PlaybackSessionManager.js:994)：计划任务媒体预读（scheduled 优先级、读取服务端 QPS/批量设置、按时限运行）。
- [`server/models/Library.js`](../server/models/Library.js:18)：`LibrarySettingsObject` typedef 中的 `strmMetadataQps`；[`getDefaultLibrarySettingsForMediaType`](../server/models/Library.js:83) 只在 book 分支写入默认 `2.0`。
- [`server/controllers/LibraryController.js`](../server/controllers/LibraryController.js:113)：创建媒体库时校验 `strmMetadataQps`（有限数、0.1–10、0.1 步长，取整到 0.1）。
- [`server/controllers/LibraryController.js`](../server/controllers/LibraryController.js:363)：更新媒体库时的同一套校验，含 `hasUpdates` 与调试日志。
- [`server/objects/settings/ServerSettings.js`](../server/objects/settings/ServerSettings.js:49)：计划任务设置字段默认值：cron 默认 `null`（不开启）、`strmMetadataCompletionLibraryIds` 默认空数组（不处理任何媒体库）、`strmMetadataCompletionQps` 默认 1.0、`strmMetadataCompletionBatchSize` 默认 5000。
- [`server/objects/settings/ServerSettings.js`](../server/objects/settings/ServerSettings.js:70)：媒体库扫描设置字段：`scheduledLibraryScanCronExpression`（默认 null）、`scheduledLibraryScanLibraryIds`（默认空数组）、`scheduledLibraryScanMaxHours`（默认 1）。
- [`server/controllers/MiscController.js`](../server/controllers/MiscController.js:146)：cron 表达式 trim + 空转 `null` + 合法性校验；QPS、批量、时间步长、媒体库 ID 校验。
- [`server/controllers/MiscController.js`](../server/controllers/MiscController.js:721)：运行/停止 API 和管理员权限校验（`runMissingItemsCleanup`、`stopMissingItemsCleanup`、`runStrmMetadataCompletion`、`stopStrmMetadataCompletion`、`runScheduledLibraryScan`、`stopScheduledLibraryScan`）。
- [`server/managers/CronManager.js`](../server/managers/CronManager.js:191)：媒体预读 cron 生命周期（表达式为空时停止注册）。
- [`server/managers/CronManager.js`](../server/managers/CronManager.js:232)：清理丢失项目 cron 生命周期。
- [`server/managers/CronManager.js`](../server/managers/CronManager.js:463)：媒体库扫描 cron 生命周期与 [`runScheduledLibraryScan`](../server/managers/CronManager.js:479) 串行扫描执行（按选定顺序、截止时间、库级取消）。
- [`server/managers/CronManager.js`](../server/managers/CronManager.js:531)：`cancelScheduledLibraryScan` 协作式取消；计划扫描启动日志将选中的媒体库 ID 映射为名称后输出。
- [`server/scanner/LibraryScanner.js`](../server/scanner/LibraryScanner.js:41)：`setCancelLibraryScan` 库级取消标记；[`scan`](../server/scanner/LibraryScanner.js:51) 为实际扫描入口。
- [`server/routers/ApiRouter.js`](../server/routers/ApiRouter.js:361)：计划任务运行/停止路由和清理 `removed` 数量、取消检查。

### 书籍匹配提取规则链与入库匹配

这一组锚点对应“书名提取五级优先级 + 入库匹配”功能，是上游同步时需要逐个确认的位置。除 `LibraryItemScanner.js` 的一行调用外，其余逻辑都集中在本地新增文件 `AiBookMatchManager.js` 内。

- [`server/managers/AiBookMatchManager.js`](../server/managers/AiBookMatchManager.js:11)：`MATCHED_AUDIT_STATUSES` 把 `matched-ai` 与本地匹配成功状态 `matched-local` 一并视为已匹配，供 [`isUnmatchedCandidate`](../server/managers/AiBookMatchManager.js:95) 判断。
- [`server/managers/AiBookMatchManager.js`](../server/managers/AiBookMatchManager.js:13)：`TITLE_SEPARATOR_REGEX` 定义第二级本地规则识别的分隔符 `丨 | ｜ . ． - － — –`。
- [`server/managers/AiBookMatchManager.js`](../server/managers/AiBookMatchManager.js:19)：`MATCH_RULE_LABELS` 提取规则的中文日志名称（书名号、符号分隔、AI 书名+人物、AI 仅书名、全称）。
- [`server/managers/AiBookMatchManager.js`](../server/managers/AiBookMatchManager.js:28)：构造函数中的 `apiRouterCtx`、`scanMatchQueue`、`scanMatchQueuedIds`、`scanMatchRunning` 四个入库匹配队列字段，全部只存在于内存，不落库。
- [`extractLocalTitle`](../server/managers/AiBookMatchManager.js:151)：第一级书名号提取，保持原有实现不变。
- [`extractSeparatorTitle`](../server/managers/AiBookMatchManager.js:156)：第二级符号分隔提取，取第一个分隔符之前的非空片段；整名没有分隔符或首段等于原名时返回空串。
- [`extractLocalTitleWithRule`](../server/managers/AiBookMatchManager.js:176)：把两条本地规则合并为 `{ title, rule }`，书名号优先于符号分隔。
- [`getMatchRuleLabel`](../server/managers/AiBookMatchManager.js:184)：规则英文键到中文标签的映射，供日志使用。
- [`buildMatchAttempts`](../server/managers/AiBookMatchManager.js:197)：生成有序尝试列表。本地规则命中即只产出该级 + 全称兜底，不调用 AI；本地规则都不命中且已配置 AI 时才调用 [`extractSearchMetadata`](../server/managers/AiBookMatchManager.js:227)，产出 `ai-title-author`、`ai-title` 两级；最后无条件追加 `full-name`，并按“标题+作者”去重。
- [`postAiRequest`](../server/managers/AiBookMatchManager.js:351)：所有 AI 请求的唯一出口，重试 408/429/5xx 与网络错误（最多 3 次，遵守 `Retry-After`），确定性错误立即失败。
- [`isCancelledError`](../server/managers/AiBookMatchManager.js:320) 与 [`wait`](../server/managers/AiBookMatchManager.js:330)：统一的取消判定和可打断退避等待。
- [`isAiUsable`](../server/managers/AiBookMatchManager.js:51) / [`noteAiSuccess`](../server/managers/AiBookMatchManager.js:55) / [`noteAiFailure`](../server/managers/AiBookMatchManager.js:66)：AI 软熔断（连续 3 次传输失败后暂停 5 分钟，只用本地规则），常量 `AI_FAILURE_STREAK_LIMIT`、`AI_COOLDOWN_MS` 位于文件顶部。
- [`throwIfAborted`](../server/managers/AiBookMatchManager.js:316)：统一的停止信号检查点，替代原来散落的多处 `options.signal?.aborted` 判断。
- [`matchLibraryItem`](../server/managers/AiBookMatchManager.js:386)：逐级执行尝试列表。每级先 provider 搜索，无候选就进入下一级；已配置 AI 时由 [`chooseCandidate`](../server/managers/AiBookMatchManager.js:273) 把关且未达阈值继续下一级，未配置 AI 时直接取首个候选。成功后写 `matched-ai`/`matched-local` 审计并返回 `rule`、`ruleLabel`；全部失败按最后一次失败原因写 `unmatched`/`needs-review`。
- [`enqueueScanMatch`](../server/managers/AiBookMatchManager.js:486)：入库匹配入队。校验 `aiBookMatchOnScan`、`mediaType === 'book'`、`aiBookMatchLibraryIds`（为空表示不限制）与书籍 ID 去重，任一不满足直接返回 `false`，因此关闭该选项时对上游扫描流程零影响。
- [`processScanMatchQueue`](../server/managers/AiBookMatchManager.js:499)：串行处理队列，一次只匹配一本书；先轮询 [`LibraryScanner.isLibraryScanning`](../server/scanner/LibraryScanner.js:33) 等待所属媒体库扫描结束，再用 `getExpandedById` 重新读取书籍并调用 `matchLibraryItem`，单本失败只记警告不中断队列。
- [`setApiRouterContext`](../server/managers/AiBookMatchManager.js:534)：接收 `ApiRouter` 实例，供入库匹配复用 `checkRemoveAuthorsWithNoBooks` 与 `checkRemoveEmptySeries`。
- [`server/scanner/LibraryItemScanner.js`](../server/scanner/LibraryItemScanner.js:197)：**唯一的上游耦合点**。在 `scanNewLibraryItem` 创建成功日志之后增加一行 `require('../managers/AiBookMatchManager').enqueueScanMatch(newLibraryItem)`。必须使用懒加载 `require`，因为 `AiBookMatchManager` → `Scanner` → `LibraryScanner` → `LibraryItemScanner` 构成循环依赖；改为顶部 `require` 会得到空对象。完整扫描与 watcher 增量扫描都经过该方法，所以两条扫描路径行为一致。
- [`server/objects/settings/ServerSettings.js`](../server/objects/settings/ServerSettings.js:58)：`aiBookMatchOnScan` 默认值 `false`；[反序列化](../server/objects/settings/ServerSettings.js:153) 使用 `=== true` 严格布尔；[`toJSON`](../server/objects/settings/ServerSettings.js:290) 输出该字段（浏览器序列化无需额外处理，只有 API 密钥仍被删除）。
- [`server/controllers/MiscController.js`](../server/controllers/MiscController.js:205)：`aiBookMatchOnScan` 的布尔类型校验，紧邻既有 `aiBookMatchGlobal` 校验。该字段不影响 cron，无需触发 `updateAiBookMatchCron`。
- [`server/routers/ApiRouter.js`](../server/routers/ApiRouter.js:14)：新增 `AiBookMatchManager` 顶部引入；[构造函数末尾](../server/routers/ApiRouter.js:67) 调用 `AiBookMatchManager.setApiRouterContext(this)`，与既有 `cronManager?.setApiRouterContext?.(this)` 并列。
- [`server/managers/CronManager.js`](../server/managers/CronManager.js:262)：`runAiBookMatch` 删除了“未配置 AI 直接抛错”的前置判断；[启动日志](../server/managers/CronManager.js:285) 增加 AI 配置状态，[逐本日志](../server/managers/CronManager.js:320) 增加 `提取规则` 字段，日志前缀由“AI书籍匹配”统一改为“书籍匹配”。
- [`client/pages/config/scheduled-tasks.vue`](../client/pages/config/scheduled-tasks.vue:36)：书籍匹配设置左栏底部的 `book-match-toggles` 容器，“全局匹配”与“入库匹配”在同一行左右对齐，各自用 `ui-tooltip` 包裹 `<label>` + `info` 图标提供悬浮说明；容器靠 `mt-auto` 贴到左栏底部，左栏 `section` 需保留 `flex flex-col`，`.book-match-settings-grid` 需保留 `align-items: stretch` 才能让两栏等高、`mt-auto` 生效；[`data`](../client/pages/config/scheduled-tasks.vue:108) 新增 `draftAiOnScan`，[`openSettings`](../client/pages/config/scheduled-tasks.vue:160) 读取 `aiBookMatchOnScan`，[`saveSettings`](../client/pages/config/scheduled-tasks.vue:239) 把它并入 `bookMatch` 的 PATCH 载荷。
- [`test/server/managers/AiBookMatchManager.test.js`](../test/server/managers/AiBookMatchManager.test.js:75)：分隔符提取、规则优先级、尝试链构建（含“本地命中不调 AI”“未配置 AI 只剩全称”）与无 AI 逐级回退用例。另有四个 AI 容错用例：[`retries a 503`](../test/server/managers/AiBookMatchManager.test.js:137)、[`does not retry a 401`](../test/server/managers/AiBookMatchManager.test.js:153)、[`opens the AI circuit breaker`](../test/server/managers/AiBookMatchManager.test.js:165)、[`falls back to the first provider candidate when the AI candidate decision fails`](../test/server/managers/AiBookMatchManager.test.js:182)。该测试文件在 `beforeEach` 里 stub 掉 `wait` 并调用 `noteAiSuccess()` 重置熔断，否则重试退避会让用例超时、熔断状态会在用例之间串味。

### 前端计划任务与主题

- [`client/pages/config/scheduled-tasks.vue`](../client/pages/config/scheduled-tasks.vue:2)：计划任务页面四条任务横条，第二项为书籍匹配；标题使用 `:header-text`（无原生 title 悬浮提示）；cron 空值规范化为 `null`。书籍匹配设置使用左右双栏，管理员打开设置时按需读取已保存密钥。
- [`server/managers/AiBookMatchManager.js`](../server/managers/AiBookMatchManager.js:1)：AI 候选白名单、OpenAI 协议调用、严格结果校验、“仅标题/描述和扫描基础信息”的未匹配筛选（封面不参与判断）及 `extraData.aiBookMatch` 审计持久化；计划任务确认匹配后以覆盖封面和详情模式应用候选结果，同时继续遵守元数据锁。
- [`server/managers/CronManager.js`](../server/managers/CronManager.js:262)：普通书籍匹配按 50 本分页读取后先批量过滤，只有未匹配候选进入逐本匹配流程，已匹配项直接计入 `skipped`；开启 `aiBookMatchGlobal` 后不执行该预过滤，全部有效书籍都会重新匹配。确认匹配后使用覆盖封面和详情模式写入，但总锁和字段锁继续生效。运行中通过 `AbortController` 取消 AI 请求，停止后不再写入失败审计；启动和结束日志使用媒体库名称并注明 AI 是否已配置，多个媒体库和书籍均按顺序串行处理。
- [`server/managers/PlaybackSessionManager.js`](../server/managers/PlaybackSessionManager.js:994)：STRM 计划媒体预读按 `strmMetadataCompletionLibraryIds` 筛选图书媒体库，建立媒体库 ID 到名称的映射，开始、完成和失败日志均输出媒体库名称，不输出媒体库 ID；计划媒体预读仍通过全局队列逐书调度。
- [`server/scanner/Scanner.js`](../server/scanner/Scanner.js:159)：`applyBookMatch` 是普通快速匹配与 AI 匹配共用的候选应用入口。
- [`client/components/app/SettingsContent.vue`](../client/components/app/SettingsContent.vue:18)：只声明 `headerText`/`description`/`note` props，未声明 `title`。
- [`client/layouts/default.vue`](../client/layouts/default.vue:256)：全局处理 `task_finished` 后更新任务 store，并通过 `$eventBus` 转发任务完成事件，保证计划任务页面能收到手动任务结果。
- [`client/components/cards/ItemTaskRunningCard.vue`](../client/components/cards/ItemTaskRunningCard.vue:107)：`strmPreloadProgress` 显示媒体预读任务的「已扫描/总数」音轨计数；[`actionIcon`](../client/components/cards/ItemTaskRunningCard.vue:88) 为 `strm-metadata-completion` 使用 `graphic_eq` 图标。
- [`client/store/tasks.js`](../client/store/tasks.js:45)：`updateTaskProgress` 在 payload 带 `taskId` 时刷新任务对象的 `data`/`title`/`titleKey`/`titleSubs`，是活动列表书名能随当前书籍变化的前提。
- [`client/components/widgets/NotificationWidget.vue`](../client/components/widgets/NotificationWidget.vue:62)：「活动」下拉的显示条件（未结束任务 + 结束 60 秒内的失败或 `showSuccess` 任务）。
- [`client/components/app/ConfigSideNav.vue`](../client/components/app/ConfigSideNav.vue:75)：设置页面用户下方的计划任务入口。
- [`client/components/tables/TracksTable.vue`](../client/components/tables/TracksTable.vue:18)：大量音轨展开时使用固定行高、可视窗口和上下占位进行虚拟渲染。
- [`client/components/tables/ChaptersTable.vue`](../client/components/tables/ChaptersTable.vue:13)：详情页大量章节展开时复用音轨表的虚拟窗口渲染，保留章节播放跳转和编辑入口。
- [`client/components/tables/LibraryFilesTable.vue`](../client/components/tables/LibraryFilesTable.vue:15)：详情页媒体库文件使用普通文档流完整渲染，移除虚拟窗口和内部滚动容器，避免动态替换表格行引起持续自动滚动；保留长路径单行截断、稳定文件键和文件操作入口。
- [`client/pages/item/_id/index.vue`](../client/pages/item/_id/index.vue:406)：详情页三点菜单在下载项下增加书籍“匹配”入口，复用媒体库书籍菜单的编辑窗口并直接打开 Match 标签。
- [`client/components/modals/libraries/LibrarySettings.vue`](../client/components/modals/libraries/LibrarySettings.vue:84)：媒体库“设置”栏的“媒体预读 QPS”输入框（仅书籍媒体库），配套 `data.strmMetadataQps`、[`normalizedStrmMetadataQps`](../client/components/modals/libraries/LibrarySettings.vue:160) clamp 与 `getLibraryData()` / `init()` 的读写。
- [`client/components/modals/libraries/EditModal.vue`](../client/components/modals/libraries/EditModal.vue:131)：`getNewLibraryData()` 为新建媒体库写入 `strmMetadataQps: 2.0` 默认值。
- [`client/strings/en-us.json`](../client/strings/en-us.json:629) 与 [`client/strings/zh-cn.json`](../client/strings/zh-cn.json:629)：`LabelSettingsStrmMetadataQps` 与 `LabelSettingsStrmMetadataQpsHelp` 文案。
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
   - 保留全局单书补全队列：三个优先级队列（播放 > 手动 > 计划）级内 FIFO、非抢占；初始化、入队、调度和去重分别位于 `PlaybackSessionManager.js` 的 `strmCompletionQueues`、`enqueueStrmBookCompletion`、`processStrmCompletionQueue`、`queueStrmBookById`。播放补全与三个手动入口（单本 / 多本 / 媒体库级）必须继续共用媒体库设置字段 `strmMetadataQps`（`useLibraryQps: true` + [`getLibraryStrmQps`](../server/managers/PlaybackSessionManager.js:591)），并统一使用顶部常量 `STRM_METADATA_BATCH_SIZE = 3000`、`STRM_METADATA_PAUSE_MINUTES = 3`；不要恢复上游或早期版本的分散硬编码 QPS（2.0 / 2.0 / 1.5 / 1.5、5000 文件阈值、5 分钟暂停），也不要恢复播放补全每本完成后固定 `setTimeout(3 * 60 * 1000)` 的冷却。计划任务媒体预读继续独立读取 `strmMetadataCompletionQps` 和 `strmMetadataCompletionBatchSize` 设置。所有入口都直接跳过已完成元数据的 STRM 书籍，仅扫描部分完成书籍中仍缺失的音轨元数据。
   - 保留播放响应后的整书后台补全：只有后台探测成功后才回写书籍数据库和 metadata 文件，扫描阶段仍不得访问 `.strm` 指针目标。
   - 计划任务页面需要重新接入运行态播放/停止按钮、任务 action 过滤和 `task_finished` 结果处理；后端需要重新接入 `CronManager.js`、`MiscController.js` 与 `ApiRouter.js` 的停止 API。清理摘要依赖 `task.data.result.removed`，不能恢复为耗时显示，也不能把 `0` 项隐藏。媒体库扫描横条依赖 `scheduledLibraryScanCronExpression`、`scheduledLibraryScanLibraryIds`、`scheduledLibraryScanMaxHours` 三个设置字段，执行时按选定顺序串行扫描，不能并发扫描多个媒体库；书籍匹配手动和 cron 执行都必须保留服务端完成摘要和运行状态。
   - 保留媒体库级 `strmMetadataQps`：`server/models/Library.js` 的 typedef 与 book 默认值、`server/controllers/LibraryController.js` 创建与更新两处 0.1 步长校验、`client/components/modals/libraries/LibrarySettings.vue` 的输入框与 clamp、`EditModal.vue` 新建默认值、两个 `client/strings/*.json` 文案。上游若重写媒体库设置表单，重新插入书籍媒体库专属的 QPS 块，并且不要给 `ui-text-input` 加 `max` prop（该组件未声明该 prop，上限靠 clamp 与服务端校验）。
   - 保留计划任务 cron 默认不开启语义：所有 cron 字段默认 `null`，空字符串保存时规范化为 `null`，CronManager 在表达式为空时不注册定时任务。
   - 保留计划任务设置窗口的保存反馈链路：前端 `validateDrafts` 数值预校验 + `saveSettings` 的 `catch` 中 `$toast.error(error.response.data)`；服务端 cron 校验使用规范化后的值。三者缺一都会让保存失败退化为“弹窗不关闭、无任何提示”。
   - 书籍匹配升级时优先保留独立文件 `AiBookMatchManager.js`；若上游调整 `BookFinder.search` 返回结构，只修改候选摘要映射。若上游调整快速匹配写入逻辑，继续让普通快速匹配和书籍匹配共同调用 `Scanner.applyBookMatch`，不要复制两套作者、系列和封面保存逻辑。
   - 保留书名提取五级优先级链：`extractLocalTitle`（书名号）→ `extractSeparatorTitle`（第一个 `丨 | ｜ . ． - － — –` 之前的片段）→ AI 书名+人物 → AI 仅书名 → 全称兜底，入口是 `buildMatchAttempts` 与 `matchLibraryItem` 的逐级循环。本地规则命中时绝不调用 AI 提取接口；未配置 AI 时不能恢复“未配置直接抛错”的前置判断，本地规则与全称兜底必须仍可运行，且候选判断退化为直接采用 provider 首个候选并写入 `matched-local`。`MATCHED_AUDIT_STATUSES` 必须同时包含 `matched-ai` 和 `matched-local`，否则本地匹配成功的书会被计划任务反复重匹配。
   - 保留入库匹配：唯一耦合点是 `LibraryItemScanner.scanNewLibraryItem` 中对 `enqueueScanMatch` 的一行懒加载 `require` 调用。上游重写该方法时重新插入这一行，并保持懒加载形式（顶部 `require` 会因 `AiBookMatchManager` → `Scanner` → `LibraryScanner` → `LibraryItemScanner` 循环依赖拿到空对象）。同时确认 `ApiRouter` 构造函数仍调用 `AiBookMatchManager.setApiRouterContext(this)`，否则作者/系列清理会因缺少上下文失败。队列状态全在实例字段中，不需要迁移数据。
   - 保留 AI 安全边界：模型只能选择 provider 已返回的候选序号，服务端必须校验序号和置信度；`aiBookMatchApiKey` 不得出现在 `toJSONForBrowser`、Socket 任务数据或日志中。审计继续写入 `LibraryItem.extraData.aiBookMatch`（含 `rule` 字段），不要写入用户可编辑的标签、描述或 metadata 文件。
   - 大量音轨页面需要保留 `client/components/tables/TracksTable.vue` 的窗口化渲染：不要恢复为按 100 条不断累积 DOM；保留固定行高、上下占位和滚动帧合并逻辑。
   - 保留 `getStrmBookMetadataStatus` 的事实计算、`completeStrmBook` 内部每 50 条成功音轨的增量保存，以及取消/截止时间/循环结束前的强制 flush。上游若重写 `completeStrmBook`，先把音轨探测结果写回对象，再重新接入局部重建、`media.save()`、`saveMetadataFile()` 和 `item_updated` 通知；不要只恢复整本书结束时的一次保存，否则会丢失断点接续能力。
   - 保留 `client/components/content/LibraryItemDetails.vue` 的 STRM 状态计算和持续时间右侧沙漏标识。若上游改变详情组件结构，将标识继续放在持续时间值旁，并保留“总时长大于 0 且仍有不完整 STRM 音轨”的显示条件；不要恢复详情页顶部大横幅，也不要把状态写成数据库列或永久 metadata 字段。
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
   - 展开包含上千章节或媒体库文件的书籍，确认首屏仅渲染可视区及缓冲行，快速上下滑动时不会跳到顶部或底部，文件路径过长时保持单行截断。
   - 在计划任务页面验证手动执行、cron 校验、0.5 小时步长和管理员权限；确认 QPS 输入范围为 0.1 至 10.0、步长 0.1，默认 1.0，批量阈值默认 5000 且步长 500；已有总时长的书被跳过，任务按设置休息并在时限到达后停止。
   - 验证媒体库扫描横条排在第一位、不设置 cron 时显示“未启用计划执行”、默认不开启；选择多个媒体库后按选定顺序串行执行且同时只扫描一个库；第二行显示上次执行时间和耗时；超时或停止后正确结束，只在完成数中统计真正扫描完的库。
   - 验证书籍详情页三点菜单中“匹配”位于“下载”下方，点击后打开与媒体库书籍三点菜单相同的 Match 编辑功能。
   - 验证书籍匹配手动执行完成后，横条立即更新上次执行时间、耗时和匹配数量；选择多个媒体库时日志显示媒体库名称而非 ID，并按选择顺序逐个处理，每个媒体库内逐本串行匹配。
   - 验证媒体库扫描和媒体预读的开始、完成、失败日志均显示媒体库名称而非 ID；展开媒体库文件列表后持续上下滑动，不发生自动跳顶、跳底或自动连续滚动。点击“完整路径”后，每行立即切换为绝对路径全文并支持横向滚动，再次点击恢复相对路径省略显示。
   - 验证三个 cron 字段保存空字符串或纯空格后变为 `null`（不开启），页面不再出现原生“计划任务”悬浮提示框。
   - 打开书籍匹配设置窗口，确认“全局匹配”和“入库匹配”排在左栏最底部同一行并左右对齐（与右栏底部大致齐平），两者不再显示小字段落说明；把鼠标悬停到各自的感叹号图标上，确认弹出对应功能描述且勾选状态可正常保存。
   - 依次打开五条横条的设置窗口，确认执行时长输入框的标签都是“时间限制（h）”，清空后保存提示“时间限制（h）必须是不小于 0.5 且为 0.5 倍数的数值”。
   - 依次打开五条横条的设置窗口并点击保存，确认都出现“<任务名>设置已保存”提示且弹窗关闭；把“时间限制（h）”“扫描 QPS”“每隔多少个文件暂停 5 分钟”“自动应用最低置信度”分别清空后保存，确认出现对应中文校验提示、弹窗保持打开且不发起请求；在 cron 框输入非法表达式保存，确认提示服务端返回的错误文本；输入纯空格保存，确认成功并视为不开启。
   - 验证“顶层书籍锚点”默认关闭：`作者/A1`、`作者/A2` 按原项目父级目录逻辑识别为两本书；开启后验证 `A/A1`、`A/A2` 被聚合为同一本书 `A`，且按卷目录顺序排列。完整扫描和 watcher 增量扫描结果应一致。
   - 播放时验证只访问当前章节目标，章节切换和恢复进度不会额外预取其他章节；远程服务端看到的播放代理请求应保持客户端软件的 User-Agent，媒体预读请求则应为精确值 `AudioBookShelf`。
   - 在“编辑媒体库 → 设置”验证书籍媒体库出现“媒体预读 QPS”输入框、默认 2.0、步长 0.1、最小 0.1，保存成功；输入 `0`、`10.5` 或 `2.05` 时被 clamp 或被服务端 400 拒绝；播客媒体库不显示该项。
   - 播放响应返回后验证后台按请求顺序逐本以媒体库配置的 QPS 执行完整扫描，每预读 3000 个文件暂停 3 分钟，且每本完成后不再额外固定暂停 3 分钟；成功后数据库中的 STRM 音轨时长、音轨元数据、章节和总时长均被补全；重复播放不会重复请求已完整书籍。
   - 分别验证详情页单本补全、选择多本补全（跨书共享暂停计数）和媒体库三点菜单补全都使用同一个媒体库 QPS 且每 3000 文件暂停 3 分钟，并能在任务通知中显示当前书名和进度；修改媒体库 QPS 后新发起的预读立即按新值限速。
   - 验证全局单书队列互斥与优先级：播放补全执行中发起手动补全会排队，手动补全执行中发起计划任务会排队；同一优先级内先请求的先执行；当前书完成后才切换到更高优先级队列。
   - 在设置侧栏用户下方验证计划任务入口；分别手动执行四条任务，确认清理任务只删除 `isMissing` 数据库项目，不删除文件，也不删除仅 `isInvalid` 的项目。
   - 验证书名提取五级优先级：`《书名》…` 由本地书名号规则直接确定书名且不请求 AI；`书名丨作者丨主播` 与 `书名.演播…`、`书名-作者` 由本地符号分隔规则取第一个符号之前的片段且同样不请求 AI；无书名号与符号标识时先由 AI 提取书名+人物搜索，无结果或未达置信度时删除作者名仅用书名搜索；全部失败或未配置 AI 时用完整原名称搜索。停止计划任务时当前 AI 请求立即取消且不写入取消失败审计。
   - 开启“入库匹配”后向所选图书媒体库放入新书，确认扫描入库后自动进入书籍匹配逻辑、串行逐本处理，日志输出命中的提取规则；关闭该选项后新书入库不再触发书籍匹配。
   - 为书籍匹配配置测试用 OpenAI 兼容接口、一个图书媒体库和高置信度阈值；确认第二项横条、左右双栏设置、运行/停止、手动执行完成后的上次执行摘要及“匹配了 N 本图书”正常。确认只有标题、描述、持续时间、文件大小、音轨、章节和路径等扫描基础信息的书进入 AI 流程；确认 ISBN、ASIN、副标题、出版信息、语言、作者、演播者、系列、标签、类型或 `matched-ai` 审计任一存在时在批次层排除，不提取、不搜索、不请求 AI；确认有无实际封面均不影响判断。确认带 `《书名》` 的原名称由本地确定书名、AI 提取作者/演播者；无书名号时由 AI 提取书名和人物；“书名+人物”无结果时自动回退到“仅书名”搜索。确认停止按钮可立即中断当前 AI 请求，不写入取消失败审计；确认 `unmatched`/`needs-review` 可重试，低置信度写入 `needs-review`，越界候选不会写入元数据，API 密钥不会返回浏览器。
   - 验证已完成元数据的 STRM 书籍在播放补全、单本手动、多本手动、媒体库手动和计划任务中均被直接跳过；即使书籍聚合 `media.duration` 为 0，只要所有 STRM 音轨的时长、编码和声道均完整，也不得再次补全。验证部分完成的书籍只扫描缺失元数据的音轨，确认页面显示的是整个扫描任务的服务端总耗时，而不是接口响应耗时。
   - 手工制造一本包含大量 `.strm` 音轨的书，在补全完成一部分后停止或触发时间限制；确认已成功音轨在数据库中保留，重新执行时只请求剩余音轨，详情页显示完成数量/剩余数量，全部完成后提示消失。
   - 打开右上角「活动」下拉，逐个验证五个媒体预读入口都会出现任务并显示**当前正在预读的书名**：播放一本未预读的 STRM 书（排队期间即应显示书名 + 「播放触发媒体预读」）、详情页单本媒体预读、勾选多本批量媒体预读、媒体库三点菜单媒体预读、计划任务媒体预读。批量/媒体库/计划任务在切换到下一本书时标题应随之更新，任务卡片第三行显示「已扫描/总数」音轨计数。失败时应显示「媒体预读失败：<原因>」而不是空白。
   - 验证不需要预读的书（全部 STRM 音轨已完整、或非 book 媒体类型）播放时**不会**在活动里产生空任务；同一本书并发触发两次播放只产生一条任务。
   - 改写一个 `.strm` 指针文件后立刻再次播放或预读，确认读到的是新目标而不是旧目标；把指针改成媒体库和 `/NetDisk` 之外的路径后，确认立即报「outside configured library folders」而不是因缓存命中被放行。
   - 断开或阻断 AI 接口（或用返回 503 的假接口），确认书籍匹配和入库匹配仍能用本地规则完成：日志显示 `提取规则：符号分隔` 与真实的搜索标题，审计写 `matched-local`，而不是全部变成 `提取规则：-，搜索标题 "-"，结果：待复核`。确认连续失败 3 次后出现“暂停 AI 辅助 5 分钟”的日志且后续书籍不再等待 AI 重试。
   - 用返回 401 的假接口确认不做重试、立即失败；用首次 503、第二次成功的假接口确认自动重试后正常匹配。
   - 切换浩瀚星空主题，确认藏蓝/墨紫/炭黑背景及不同颜色和大小的静态星点在桌面和移动端可见且不遮挡交互；切换暗色主题，确认冷灰暗色界面正常显示。
   - 容器内执行 `ls /NetDisk/...` 能看到 `.strm` 指向的目标文件；不需要配置额外环境变量。
   - 播放远程 URL、本地 POSIX 路径和 Windows 路径目标均正常。
   - 两个主题切换、刷新持久化和夜间主题文本对比度正常。

## 冲突处理原则

- `server/utils/strmUtils.js` 和 `client/components/app/ThemeSwitcher.vue` 是定制功能的主要独立文件，优先保留本地版本，再适配上游接口。
- `Appbar.vue`、`app.css`、`AudioFileScanner.js`、`LibraryItemController.js`、`LibraryItemScanner.js` 属于上游高频变化文件，升级时不要整文件覆盖本地版本，只重新应用标记位置的少量耦合代码。
- 不要把主题颜色散落到业务组件中；主题颜色统一放在 `themes.css` 的变量和主题选择器内。
- 不要修改数据库结构保存主题；当前主题属于浏览器用户界面偏好，使用 `localStorage` 可以避免迁移和上游数据库冲突。
- 全局补全队列的状态全部保存在 `PlaybackSessionManager` 实例字段中（不落库），升级时保留这些字段和三个队列处理函数即可，无需迁移数据。
- 书内断点接续不依赖新的数据库迁移；升级时重点检查 `PlaybackSessionManager.completeStrmBook` 是否仍在成功探测后批量保存，以及 `LibraryItemDetails.vue` 是否仍依据 `media.audioFiles` 动态计算持续时间旁的待完成标识。若上游改变媒体模型的 JSON 序列化，只需保证 `audioFiles` 的 `duration`、`codec`、`channels` 和 `metadata.path` 仍可用。
- 计划任务设置字段属于 `ServerSettings`，上游若重命名或移动设置，需要同步保留 STRM、清理、媒体库扫描以及 `aiBookMatchCronExpression`、`aiBookMatchLibraryIds`、`aiBookMatchGlobal`、`aiBookMatchOnScan`、`aiBookMatchMaxHours`、`aiBookMatchApiUrl`、`aiBookMatchApiKey`、`aiBookMatchModel`、`aiBookMatchConfidence` 的构造、序列化和校验逻辑；浏览器序列化必须继续删除 API 密钥。
- AI 请求必须继续经由 `postAiRequest` 统一出口，不要在 `extractSearchMetadata` 或 `chooseCandidate` 里直接调用 `axios.post`，否则会丢掉重试与熔断计数。AI 失败时的降级语义（候选判定失败 → 本地首个候选 + `matched-local`）也必须保留，不能恢复为“异常直接冒泡到 CronManager 写 needs-review”，那会让日志丢失提取规则与搜索标题，看起来像提取规则失效。
- 入库匹配的唯一耦合点是 [`LibraryItemScanner.scanNewLibraryItem`](../server/scanner/LibraryItemScanner.js:197) 中对 `AiBookMatchManager.enqueueScanMatch` 的一行懒加载调用（避免 `Scanner` → `LibraryScanner` → `LibraryItemScanner` 循环依赖）。上游改写该方法时只需重新插入这一行，队列状态全部保存在 `AiBookMatchManager` 实例字段中，不落库。
- `server/utils/strmUtils.js` 的 `resolveStrmTarget` **不得重新引入以 mtime 为键的解析缓存**。上游或早期版本的 `strmUrlCache` 会因 mtime 分辨率过粗而返回旧目标，并把库外路径校验和目标 `stat()` 一起跳过（详见「STRM 指针解析取消 mtime 缓存」一节）。如需缓存必须改为内容哈希或显式失效，且校验逻辑必须留在缓存之外无条件执行。
- 媒体预读活动任务的三个辅助方法（`createStrmPreloadTask` / `updateStrmPreloadTaskBook` / `finishStrmPreloadTask`）与五个入口的调用是一体的，升级时一并保留；不要把 `finishStrmPreloadTask` 里的 `setFinished()` 改成 `setFinished(null, true)`，否则会清掉标识预读来源的描述。同时必须保留服务端 `TaskManager.updateTaskProgress` 的扩展 payload 和前端 `client/store/tasks.js` 的 `taskId` 分支，这两处是活动列表书名随当前书籍刷新的唯一通路。
- 新增翻译键必须让 `client/strings/*.json` 的键名保持**纯代码点升序**（等价于 JavaScript 的 `Object.keys(obj).sort()`），因为上游 CI 工作流 `.github/workflows/i18n-integration.yml` 调用的 `audiobookshelf/audiobookshelf-i18n-updater@v1.3.0` 用的是 `if (keys[i] < keys[i - 1]) throw new Error(...)` 这种区分大小写的直接比较。**不能**用 `localeCompare()` 或 `toLowerCase().localeCompare()` 排序：这两种比较器会把 `ButtonReScan` 排到 `ButtonRemoveSeriesFromContinueSeries` 之后（因为忽略大小写时 `Res` > `Rem`），而代码点比较认为 `ButtonReS`（`S` = 0x53）小于 `ButtonRem`（`m` = 0x6D），于是 CI 报 `Keys are not alphabetized in en-us.json`。新增键后统一执行 `node -e "const fs=require('fs');for(const f of ['en-us','zh-cn']){const p='client/strings/'+f+'.json';const o=JSON.parse(fs.readFileSync(p,'utf8'));const s={};for(const k of Object.keys(o).sort())s[k]=o[k];fs.writeFileSync(p,JSON.stringify(s,null,2)+'\n')}"` 重排，文件格式固定为 2 空格缩进 + 末尾换行 + LF 行尾。
- 书名提取规则全部是纯函数（`extractLocalTitle`、`extractSeparatorTitle`、`extractLocalTitleWithRule`），不依赖数据库或上游模型，可以整段保留；只有 `buildMatchAttempts` 需要在上游改动 `BookFinder.search` 参数签名时同步调整。新增本地规则时在 `TITLE_SEPARATOR_REGEX` 或 `extractLocalTitleWithRule` 内扩展，并同步更新 `MATCH_RULE_LABELS`，不要把规则散落到 `CronManager` 或前端。

## 验证命令

后端测试：

```text
npm test
```

翻译键排序自检（必须输出全部为 `violations=0`，与上游 CI 的比较方式一致）：

```text
node -e "const fs=require('fs');for(const f of fs.readdirSync('client/strings')){if(!f.endsWith('.json'))continue;const k=Object.keys(JSON.parse(fs.readFileSync('client/strings/'+f,'utf8')));let n=0;for(let i=1;i<k.length;i++)if(k[i]<k[i-1])n++;console.log(f,'violations='+n)}"
```

当前已验证后端完整测试通过，包含 STRM 分组和本地路径安全校验测试。前端构建可使用项目已有命令：

```text
cd client
npm run generate
```

若上游升级 Tailwind 或 Nuxt，首先检查 `client/assets/tailwind.css` 的颜色变量命名是否变化，再调整 `themes.css` 中的经典/星空主题变量覆盖。不要重新添加已移除的 AppleTV 主题或主题描述小字。
