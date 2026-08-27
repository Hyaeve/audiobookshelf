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
- 所有 STRM 媒体预读入口共用一个全局书籍队列，同时最多预读一本书。队列按“播放触发 > 手动执行 > 计划任务”优先级选择下一本书；同一优先级内按请求进入队列的先后顺序处理。当前正在预读的书不会被抢占，完成后才重新选择高优先级队列。播放触发的后台预读每本书固定使用 2.0 QPS，完成后暂停 3 分钟；手动预读和计划任务使用各自定义的限速策略。已有完整音轨信息的目标不会重复请求。
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

### 2. 详情页媒体预读

- 有声书详情页三点菜单在“下载”附近提供“媒体预读”。
- 单本手动媒体预读固定使用 2.0 QPS；每累计扫描 3000 个文件暂停 5 分钟。暂停计数通过该次任务的 `throttleState` 传入扫描核心，避免只配置请求间隔而遗漏批量暂停。手动请求进入全局预读队列后按请求先后顺序处理。
- 选择多本书籍媒体预读时固定使用 1.5 QPS，并在选中书籍之间共享同一个 `throttleState`；跨书累计每 3000 个文件暂停 5 分钟。媒体库级手动媒体预读独立使用 1.5 QPS，并在整个媒体库累计扫描 5000 个文件后暂停 3 分钟。多本书籍会按提交顺序依次进入全局预读队列，不会并发扫描。
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
- 队列初始化于 [`server/managers/PlaybackSessionManager.js`](../server/managers/PlaybackSessionManager.js:31)：`strmCompletionQueues = { playback: [], manual: [], scheduled: [] }` 三个队列、`strmCompletionQueueRunning` 运行锁与 `strmCompletionQueuedIds` 去重集合。
- 入队与调度核心位于 [`enqueueStrmBookCompletion`](../server/managers/PlaybackSessionManager.js:484) 与 [`processStrmCompletionQueue`](../server/managers/PlaybackSessionManager.js:494)：每次轮询按优先级顺序取第一个非空队列，级内 `shift()` 保持 FIFO；取出作业后串行执行，当前作业完成或失败后才重新选择高优先级队列。循环结束后若发现新入队作业会再次触发调度，避免竞态遗漏。
- 单书作业统一走 [`queueStrmBookById`](../server/managers/PlaybackSessionManager.js:522)：加载书籍后先用 [`isCompleteStrmBookMetadata`](../server/managers/PlaybackSessionManager.js:553) 判断整书是否已完成（有 strm 文件且总时长 > 0 且所有 strm 音轨完整），已完成直接跳过；否则只取缺失时长/编码/声道的 strm 音轨交给 [`completeStrmBook`](../server/managers/PlaybackSessionManager.js:591) 进行媒体预读探测。
- 播放触发的媒体预读通过 [`completeStrmBookAfterPlayback`](../server/managers/PlaybackSessionManager.js:561) 以 `playback` 优先级入队，每本书固定 2.0 QPS，完成后暂停 3 分钟，并用 `strmCompletionQueuedIds` 按书籍 ID 去重。
- 手动入口以 `manual` 优先级入队：单本 [`completeStrmItem`](../server/managers/PlaybackSessionManager.js:776) 固定 2.0 QPS、每 3000 文件暂停 5 分钟；多本 [`completeStrmItems`](../server/managers/PlaybackSessionManager.js:891) 固定 1.5 QPS 并共享 `throttleState`；媒体库级 [`completeStrmLibrary`](../server/managers/PlaybackSessionManager.js:705) 固定 1.5 QPS、累计 5000 文件暂停 3 分钟。手动入口通过 `strmManualEnqueueChain` 串行准备作业，避免并发重复提交。
- 计划任务以 `scheduled` 优先级入队，见 [`completeScheduledStrmMetadata`](../server/managers/PlaybackSessionManager.js:798)。

### 5. 计划任务：媒体库扫描、书籍匹配、元数据补全、媒体预读与清理丢失项目

- 设置页面的用户下方新增“计划任务”入口，页面适配项目现有主题变量。
- 计划任务和相关操作的用户可见名称统一为“媒体预读”，内部 API action `strm-metadata-completion` 保持不变以兼容既有调用。
- 书籍、媒体库、批量和计划任务相关的操作选项、任务标题、提示消息及日志均使用“媒体预读”名称，内部 API action `strm-metadata-completion` 保持不变以兼容既有调用。
- 本地新增的第二项“书籍匹配”横条使用 `ai-book-match` 任务动作。它支持 cron、图书媒体库多选、默认关闭的“全局匹配”和 0.5 小时步长的时间限制；设置窗口为左右双栏，左侧是任务参数，右侧是 OpenAI 兼容接口地址、API 密钥、模型和自动应用最低置信度。全局匹配关闭时只处理未匹配图书；开启后所选媒体库中的全部有效图书都会重新经过 AI 书籍匹配，并以覆盖模式应用匹配元数据。横条第二行在手动或计划任务完成后均显示上次执行时间、耗时和成功匹配的图书数量。
- 本地新增的“补全元数据”横条使用 `book-metadata-completion` 任务动作，支持 cron、图书媒体库多选和 0.5 小时步长的时间限制。该任务与 AI 书籍匹配严格分离：按照每本书所属媒体库的默认 `library.provider` 逐本请求 [`BookFinder.search()`](../server/finders/BookFinder.js:374)，找到候选后调用 [`Scanner.quickMatchLibraryItem()`](../server/scanner/Scanner.js:58)；始终关闭覆盖封面和覆盖详情，只补充缺失字段。停止时 provider 搜索等待可被协作式取消抢先结束，取消后不继续写入或处理下一本书。每本书的日志只显示书名、提供商和实际补全的字段类别（如标题、作者、流派、出版商、系列、封面），不输出元数据具体内容；自定义提供商显示设置中配置的名称，不显示 `custom-UUID`，内置提供商显示规范可读名称。AI 书籍匹配仍只处理 [`getUnmatchedCandidates()`](../server/managers/AiBookMatchManager.js:18) 判定为未完成匹配的书籍，对已匹配书籍不执行 AI 请求、provider 搜索或写入。
- 书籍支持不新增数据库列的计划任务元数据锁，锁状态存储在 `LibraryItem.extraData.metadataLocks`，结构为 `{ all, fields }`。单书详情页右下角三点菜单和书籍卡片菜单在“媒体预读”下面显示“锁定元数据/解锁元数据”；媒体库批量选择后的右上角三点菜单提供批量锁定与解锁。总锁只阻止书籍匹配和补全元数据计划任务，手动快速匹配、手动匹配和手动编辑仍可更新。
- 编辑书籍详情页在“删节版”右侧显示“锁定”总开关；成人内容、删节版和总锁三个复选项底部对齐，成人内容与删节版不提供逐字段锁。普通元数据锁图标位于输入控件内部右侧；描述锁图标位于描述输入框内部右上角，富文本工具栏保持原始高度和按钮布局，编辑器右下角保留浏览器原生尺寸拖拽手柄。锁图标默认是暗灰色开锁，点击后成为带主题自适应高亮背景的白色闭锁。逐字段锁即使字段为空也禁止计划任务补全该字段；总锁未开启时，其他未锁字段仍可补全。封面也纳入字段锁。前端图标使用 [`MetadataLockButton.vue`](../client/components/widgets/MetadataLockButton.vue:1)，原始闭锁图资源保留为 [`metadata-lock.png`](../client/static/metadata-lock.png)。
- [`AiBookMatchManager`](../server/managers/AiBookMatchManager.js:9) 先把入库书籍的 `media.title`（该字段就是原始文件夹名）发送给 OpenAI 兼容接口 `/chat/completions`，提取书名、作者和演播者；作者与演播者去重合并后分别作为既有 [`BookFinder.search`](../server/finders/BookFinder.js:329) 的标题和作者参数，再获取最多 8 个候选。随后 AI 只能返回本次候选数组中的序号、0 至 1 置信度和理由；服务端拒绝越界序号、非法 JSON 与非法置信度，禁止 AI 自由生成并直接写入元数据。
- 达到 `aiBookMatchConfidence` 阈值后，任务调用 [`Scanner.applyBookMatch`](../server/scanner/Scanner.js:130)，与原快速匹配共用封面、作者、系列、元数据文件和 Socket 更新流程。
- 书名号场景先由本地从 `《》`、`「」` 或 `『』` 提取并固定书名，AI 主要补充作者和演播者；无书名号时由 AI 提取书名、作者和演播者。提取结果分别作为书名和作者信息参与搜索与候选判断。
- provider 搜索先使用“书名 + 作者/演播者”，无结果时自动删除作者条件，仅按书名重试；只有候选判断达到置信度阈值后才应用匹配。
- 计划任务停止通过 [`AbortController`](../server/managers/CronManager.js:223) 中断当前 AI HTTP 请求，并在 provider 搜索和候选判断边界检查停止状态，避免停止后继续处理或写入取消结果。
- 书名提取采用本地优先：原名称包含 `《》`、`「」` 或 `『』` 时，直接把括号内文本作为确认书名，AI 只补充作者/演播者信息，不能修改确认书名；无书名号时才由 AI 同时提取书名、作者和演播者。AI 提取超时或失败时，书名号场景仍使用本地确认书名继续搜索。
- 搜索先使用“书名 + AI 提取的人物”请求 provider；若没有候选且人物条件非空，则自动删除作者/演播者条件，仅使用书名再次搜索。匹配搜索结果仍由 AI 候选判断后才允许写入，避免仅凭名称直接误匹配。
- 计划任务停止会通过 `AbortController` 取消当前 AI HTTP 请求，并在 provider 搜索和候选判断前后检查停止状态；取消不会写入 `needs-review` 审计，也不会继续处理下一本书。
- 计划任务每批读取书籍后先调用 [`getUnmatchedCandidates`](../server/managers/AiBookMatchManager.js:18) 预过滤，只有“除标题、描述和扫描基础信息外，所有扩展元数据均为空”的历史书籍才进入逐本 AI 匹配。持续时间、文件大小、音轨、章节、文件路径和 `libraryFiles` 属于扫描基础信息，不影响候选资格。
- ISBN、ASIN、副标题、出版日期/年份、出版社、语言、作者、演播者、系列、标签、类型或 `matched-ai` 成功审计任一存在，即视为已有匹配信息并在批次层排除，不执行 AI 提取、provider 搜索或候选判断；书籍封面可有可无，不参与匹配状态判断。`unmatched` 和 `needs-review` 审计仍允许后续计划任务重试。
- [`matchLibraryItem`](../server/managers/AiBookMatchManager.js:178) 仍保留同一候选判断作为防御性保护，防止其他调用入口绕过计划任务批次预过滤。
- 每次失败、低置信度或成功判断都持久化到已有 `LibraryItem.extraData.aiBookMatch`，记录 `status`、`source`、`model`、`confidence`、`candidate`、`updatedAt`、`reason` 等审计信息，不新增数据库表或列。AI 提取失败会记录具体原因并标记待复核；没有 provider 候选的 `unmatched` 会保留实际搜索标题和作者，便于后续排查。
- 四类计划任务都会写入可读的执行日志：媒体库扫描记录目标媒体库和扫描开始/完成；书籍匹配记录媒体库、原名称、AI 提取后的搜索标题和作者、匹配结果及候选书名；媒体预读记录书名、待预读音轨数和成功/失败结果；清理丢失项目记录媒体库名称和被清理项目名称。日志正文不重复写时间，也不使用媒体库 ID，时间由日志系统自动标注。书籍匹配选择多个媒体库时按设置顺序逐个处理，单个媒体库内按书籍顺序逐本处理，不并行执行；媒体预读通过媒体库 ID 到名称的映射输出媒体库名称。
- 配置字段为 `aiBookMatchCronExpression`、`aiBookMatchLibraryIds`、`aiBookMatchGlobal`、`aiBookMatchMaxHours`、`aiBookMatchApiUrl`、`aiBookMatchApiKey`、`aiBookMatchModel` 和 `aiBookMatchConfidence`，其中 `aiBookMatchGlobal` 默认 `false`。密钥只对管理员通过 [`getAiBookMatchSettings()`](../server/controllers/MiscController.js:132) 按需读取，普通浏览器设置仍不会返回密钥；页面打开书籍匹配设置时加载已保存密钥，输入框默认以密码形式显示，右侧按钮可切换明文显示与密码隐藏状态，关闭并重新打开设置时恢复隐藏。留空时不覆盖已保存值。最后一次执行摘要持久化在 `aiBookMatchLastRun`，因此即使 cron 在浏览器未打开时运行，下次进入页面仍能显示上次执行时间、耗时和匹配数量。
- 补全元数据配置字段为 `bookMetadataCompletionCronExpression`、`bookMetadataCompletionLibraryIds`、`bookMetadataCompletionMaxHours` 和 `bookMetadataCompletionLastRun`，运行/停止接口为 `/api/book-metadata-completion/run` 与 `/api/book-metadata-completion/stop`。任务结果包含处理数、更新数、未找到候选数和跳过数；停止接口设置取消标志后，当前搜索最多等待取消轮询间隔即可退出。
- 页面提供“媒体库扫描”“媒体预读”“清理丢失项目”等紧凑横条，媒体库扫描排在第一位；每条依次显示大字功能标题、已运行后的上次运行摘要和小字描述，右侧显示立即执行、运行中的普通停止图标与竖三点图标。停止图标不使用背景填充、高亮或额外描边框，点击热区仍保持足够大小；停止按钮调用对应停止 API，服务端立即设置取消标志，provider 搜索等待通过取消竞速及时退出，扫描/媒体预读/清理任务在当前安全边界结束后停止。
- 三条横条均支持 cron 表达式；不设置 cron 表达式即为不开启，默认不开启。保存时空字符串与纯空格会被规范化为 `null`（前端 [`saveSettings`](../client/pages/config/scheduled-tasks.vue:263) 与服务端 [`updateServerSettings`](../server/controllers/MiscController.js:141) 双重处理），服务端同时校验 cron 合法性，cron 变更后立即重建对应定时任务（[`updateStrmMetadataCron`](../server/managers/CronManager.js:135)、[`updateMissingItemsCleanupCron`](../server/managers/CronManager.js:175)、[`updateScheduledLibraryScanCron`](../server/managers/CronManager.js:190)，表达式为空时停止并清空定时任务）。
- 三项任务接口立即返回 HTTP 202，任务 Socket 事件负责反馈运行状态和完成结果。页面按任务 action 查找未完成任务，手动执行和 cron 执行均显示运行状态与停止按钮；全局布局收到 `task_finished` 后先写入任务 store，再通过 `$eventBus` 转发完成事件，计划任务页优先读取 `task.data.result` 中的服务端摘要并按完成时间去重，同步浏览器本地记录，书籍匹配横条显示“上次执行：时间，耗时 时长，匹配了 N 本图书”（清理任务额外显示清理了 N 项）。
- 媒体库扫描（`scheduled-library-scan`）支持选择要扫描的媒体库（多选，不选则不扫描任何库）和单次最长执行时间（最小 0.5 小时、步长 0.5 小时，服务端校验）；执行时按选定顺序串行扫描，同时只扫描一个媒体库，受截止时间限制，超时或停止后立即结束并只在完成数中统计真正扫描完的库；停止入口为 `/api/scheduled-library-scan/stop`。配置字段为 `scheduledLibraryScanCronExpression`、`scheduledLibraryScanLibraryIds`、`scheduledLibraryScanMaxHours`，保存在服务端设置中（[`ServerSettings.js`](../server/objects/settings/ServerSettings.js:133)）。日志正文使用媒体库名称，不重复输出日志系统已经提供的时间戳。
- 媒体预读跳过已完成的 STRM 书籍；计划任务只处理媒体信息不完整的书籍，部分完成的书籍仅将缺失信息的 STRM 音轨交给真实目标探测和扫描流程。计划任务进入全局预读队列的优先级低于播放触发和手动预读；停止计划任务时，尚未开始的排队书籍会在轮到时跳过，当前音轨探测完成后协作式退出。
- 媒体预读支持 cron 表达式、图书媒体库多选和单次最长执行时间，未选择媒体库时不处理任何书籍；时间限制使用可直接输入的数字步进框，最小 0.5 小时、步长 0.5 小时；服务端校验 cron、媒体库 ID 和步长。媒体库选择设置字段为 `strmMetadataCompletionLibraryIds`。计划任务 QPS 设置字段为 `strmMetadataCompletionQps`，默认 1.0，范围 0.1 至 10.0、步长 0.1。计划任务批量暂停设置字段为 `strmMetadataCompletionBatchSize`，默认 5000、最小 500、步长 500；达到配置阈值后暂停 5 分钟，并受单次小时数截止时间限制。
- 清理丢失项目支持独立 cron 表达式、媒体库多选和立即执行；配置字段为 `missingItemsCleanupLibraryIds`，未选择媒体库时不清理任何项目。任务只清理所选媒体库中扫描后标记 `isMissing` 的项目，不处理仅标记 `isInvalid` 的项目。
- 清理丢失项目复用项目删除的数据库关联清理流程，删除播放进度、播放列表关联、RSS、缓存、metadata 数据和项目记录，但不删除文件系统文件；完成后刷新问题统计并发送项目移除事件。任务结果在 `task.data.result.removed` 返回实际清理数量，页面第二行显示“清理了 N 项”，即使 N 为 `0` 也明确显示 `0`。
- 三项计划任务均有运行中防重入保护和协作式取消：停止入口分别为 `/api/scheduled-library-scan/stop`、`/api/strm-metadata-completion/stop` 与 `/api/missing-items-cleanup/stop`。STRM 任务在当前探测完成后于下一首音轨或下一本书边界退出，批量暂停等待可被轮询取消；清理任务在每个媒体库和项目边界检查取消状态，已完成删除的数量保留在结果中；扫描任务在每库边界检查取消并设置库级取消标记（[`LibraryScanner.setCancelLibraryScan`](../server/scanner/LibraryScanner.js:41)）。配置保存在服务端设置中，cron 变更后立即重建对应定时任务。
- 计划任务页面标题使用 `:header-text` 而非 `:title`：`app-settings-content` 组件只声明 `headerText`/`description`/`note` props（[`SettingsContent.vue`](../client/components/app/SettingsContent.vue:18)），未声明的 `title` 会被 Vue 作为原生 HTML 属性渲染到内容根 div 上，产生浏览器原生“计划任务”悬浮提示框；改为 `:header-text` 后标题仅作为文字渲染，不再出现原生悬浮提示（[`scheduled-tasks.vue`](../client/pages/config/scheduled-tasks.vue:2)）。

### 6. STRM 书内断点接续与未完成标注

- 这是本地新增功能，不新增数据库字段。音轨是否完成仍以 `duration > 0`、存在 `codec` 且 `channels > 0` 为事实来源；整书完成只要求存在的 STRM 音轨全部完成，不再额外依赖书籍聚合 `media.duration`，避免已完成音轨因聚合时长异常为 0 而重复补全。
- [`getStrmBookMetadataStatus`](../server/managers/PlaybackSessionManager.js:553) 动态计算 STRM 音轨总数、已完成数、未完成数、百分比和整书完成状态。由于状态由已保存音轨实时推导，扫描新增或删除 `.strm` 文件后，重新扫描媒体库即可自动纳入或移除统计，不会留下过期状态字段。
- [`completeStrmBook`](../server/managers/PlaybackSessionManager.js:613) 在每成功探测一个音轨后累积待保存数量；每 50 个成功音轨执行一次局部持久化，并在取消、时间限制、循环结束时强制 flush。持久化会先重建当前已知的音轨排序、章节和总时长，再调用 `media.save()` 与 `saveMetadataFile()`，随后发送 `item_updated` 事件。
- 取消或超时只会停止后续探测，不回滚已经成功且已保存的音轨。下次入口重新读取书籍后，`queueStrmBookById` 只把不完整音轨传给探测器，因此可以从上次保存位置继续；已经完成的音轨不会重复请求。当前小批次阈值是内部常量 50，与计划任务的 3000/5000 音轨暂停阈值相互独立。
- [`LibraryItemDetails.vue`](../client/components/content/LibraryItemDetails.vue:72) 在有声书详情页根据 `media.audioFiles` 动态判断补全状态。书籍已经补全出部分有效总时长、但仍有未完成 STRM 音轨时，在“持续时间”值右侧显示小型沙漏“待完成”标识；总时长仍为 `0 sec`、尚未开始有效补全时不显示，全部音轨完成后自动消失。该标识不与 `isMissing`、`isInvalid` 或用户播放进度混用。
- 数据库保存成功但 metadata 文件写入失败时会记录错误，数据库中的进度仍可供下一次断点接续；下一次成功 flush 会再次写 metadata 文件。该策略避免为了 metadata 文件失败而丢弃已经持久化的音轨事实。

### 7. 主题

- `浩瀚星空` 回退为静态深邃藏蓝、墨紫和炭黑底色，保留少量错落的银白、浅蓝、淡金和浅紫星点；不使用漂移、缩放或闪烁动画，背景层不阻挡页面交互。
- 新增 `暗色主题`，采用炭黑、冷灰和低饱和蓝灰配色，适合作为低干扰的纯暗色界面。

## 代码锚点

### 后端 STRM 与补全队列

- [`server/utils/globals.js`](../server/utils/globals.js:1)：将 `strm` 注册到音频扩展列表。
- [`server/objects/files/AudioFile.js`](../server/objects/files/AudioFile.js:112)：创建不依赖远程探测的占位音频对象。
- [`server/scanner/AudioFileScanner.js`](../server/scanner/AudioFileScanner.js:157)：扫描时识别 `.strm` 并跳过 `ffprobe`。
- [`server/utils/strmUtils.js`](../server/utils/strmUtils.js:1)：指针解析、URL/本地目标判定、安全校验、完整扫描探测和当前章节媒体代理。
- [`server/utils/scandir.js`](../server/utils/scandir.js:48)：默认保留原项目父级目录分组和末级目录书名解析；启用 `topLevelBookAnchor` 时按根目录下一层文件夹聚合文件，并仅使用首层目录进行书名解析。
- [`server/managers/PlaybackSessionManager.js`](../server/managers/PlaybackSessionManager.js:31)：全局三级补全队列初始化（playback/manual/scheduled 三个 FIFO 队列 + 运行锁 + 书籍去重）。
- [`server/managers/PlaybackSessionManager.js`](../server/managers/PlaybackSessionManager.js:484)：`enqueueStrmBookCompletion` 入队与 `processStrmCompletionQueue` 优先级调度核心。
- [`server/managers/PlaybackSessionManager.js`](../server/managers/PlaybackSessionManager.js:522)：`queueStrmBookById` 单书作业：过滤已完成书籍、只取缺失元数据的 strm 音轨。
- [`server/managers/PlaybackSessionManager.js`](../server/managers/PlaybackSessionManager.js:547)：`isCompleteStrmAudioFile`（duration/codec/channels 完整性判断）。
- [`server/managers/PlaybackSessionManager.js`](../server/managers/PlaybackSessionManager.js:553)：`isCompleteStrmBookMetadata`（整书是否已补全）。
- [`server/managers/PlaybackSessionManager.js`](../server/managers/PlaybackSessionManager.js:591)：`completeStrmBook` 完整扫描核心：探测、QPS/批量暂停/截止时间控制、书内断点保存、结束后重建章节与总时长并保存。
- [`server/managers/PlaybackSessionManager.js`](../server/managers/PlaybackSessionManager.js:553)：`getStrmBookMetadataStatus` 动态计算音轨完成比例；持久化批次和取消前 flush 逻辑位于 `completeStrmBook` 内部，未引入新的数据库状态列。
- [`server/managers/PlaybackSessionManager.js`](../server/managers/PlaybackSessionManager.js:561)：播放触发补全（playback 优先级、2.0 QPS、完成后暂停 3 分钟、书籍 ID 去重）。
- [`server/managers/PlaybackSessionManager.js`](../server/managers/PlaybackSessionManager.js:776)：单本手动媒体预读（manual 优先级、2.0 QPS、每 3000 文件暂停 5 分钟）。
- [`server/managers/PlaybackSessionManager.js`](../server/managers/PlaybackSessionManager.js:891)：多本手动媒体预读（manual 优先级、1.5 QPS、跨书共享每 3000 文件暂停 5 分钟）。
- [`server/managers/PlaybackSessionManager.js`](../server/managers/PlaybackSessionManager.js:705)：媒体库级手动媒体预读（manual 优先级、1.5 QPS、累计 5000 文件暂停 3 分钟）。
- [`server/managers/PlaybackSessionManager.js`](../server/managers/PlaybackSessionManager.js:798)：计划任务媒体预读（scheduled 优先级、读取 QPS/批量设置、按时限运行）。
- [`server/objects/settings/ServerSettings.js`](../server/objects/settings/ServerSettings.js:128)：计划任务设置字段默认值：cron 默认 `null`（不开启）、`strmMetadataCompletionLibraryIds` 默认空数组（不处理任何媒体库）、`strmMetadataCompletionQps` 默认 1.0、`strmMetadataCompletionBatchSize` 默认 5000。
- [`server/objects/settings/ServerSettings.js`](../server/objects/settings/ServerSettings.js:133)：媒体库扫描设置字段：`scheduledLibraryScanCronExpression`（默认 null）、`scheduledLibraryScanLibraryIds`（默认空数组）、`scheduledLibraryScanMaxHours`（默认 1）。
- [`server/controllers/MiscController.js`](../server/controllers/MiscController.js:141)：cron 表达式 trim + 空转 `null` + 合法性校验；QPS、批量、时间步长、媒体库 ID 校验。
- [`server/controllers/MiscController.js`](../server/controllers/MiscController.js:656)：运行/停止 API 和管理员权限校验（`runMissingItemsCleanup`、`stopMissingItemsCleanup`、`runStrmMetadataCompletion`、`stopStrmMetadataCompletion`、`runScheduledLibraryScan`、`stopScheduledLibraryScan`）。
- [`server/managers/CronManager.js`](../server/managers/CronManager.js:135)：媒体预读 cron 生命周期（表达式为空时停止注册）。
- [`server/managers/CronManager.js`](../server/managers/CronManager.js:175)：清理丢失项目 cron 生命周期。
- [`server/managers/CronManager.js`](../server/managers/CronManager.js:190)：媒体库扫描 cron 生命周期与 [`runScheduledLibraryScan`](../server/managers/CronManager.js:206) 串行扫描执行（按选定顺序、截止时间、库级取消）。
- [`server/managers/CronManager.js`](../server/managers/CronManager.js:253)：`cancelScheduledLibraryScan` 协作式取消；计划扫描启动日志将选中的媒体库 ID 映射为名称后输出。
- [`server/scanner/LibraryScanner.js`](../server/scanner/LibraryScanner.js:41)：`setCancelLibraryScan` 库级取消标记；[`scan`](../server/scanner/LibraryScanner.js:51) 为实际扫描入口。
- [`server/routers/ApiRouter.js`](../server/routers/ApiRouter.js:354)：计划任务运行/停止路由和清理 `removed` 数量、取消检查。

### 前端计划任务与主题

- [`client/pages/config/scheduled-tasks.vue`](../client/pages/config/scheduled-tasks.vue:2)：计划任务页面四条任务横条，第二项为书籍匹配；标题使用 `:header-text`（无原生 title 悬浮提示）；cron 空值规范化为 `null`。书籍匹配设置使用左右双栏，管理员打开设置时按需读取已保存密钥。
- [`server/managers/AiBookMatchManager.js`](../server/managers/AiBookMatchManager.js:1)：AI 候选白名单、OpenAI 协议调用、严格结果校验、“仅标题/描述和扫描基础信息”的未匹配筛选（封面不参与判断）及 `extraData.aiBookMatch` 审计持久化；计划任务确认匹配后以覆盖封面和详情模式应用候选结果，同时继续遵守元数据锁。
- [`server/managers/CronManager.js`](../server/managers/CronManager.js:231)：普通 AI 书籍匹配按 50 本分页读取后先批量过滤，只有未匹配候选进入逐本 AI 流程，已匹配项直接计入 `skipped`；开启 `aiBookMatchGlobal` 后不执行该预过滤，全部有效书籍都会进入逐本 AI 流程。确认匹配后使用覆盖封面和详情模式写入，但总锁和字段锁继续生效。运行中通过 `AbortController` 取消 AI 请求，停止后不再写入失败审计；启动和结束日志使用媒体库名称，多个媒体库和书籍均按顺序串行处理。
- [`server/managers/PlaybackSessionManager.js`](../server/managers/PlaybackSessionManager.js:867)：STRM 计划媒体预读按 `strmMetadataCompletionLibraryIds` 筛选图书媒体库，建立媒体库 ID 到名称的映射，开始、完成和失败日志均输出媒体库名称，不输出媒体库 ID；计划媒体预读仍通过全局队列逐书调度。
- [`server/scanner/Scanner.js`](../server/scanner/Scanner.js:130)：`applyBookMatch` 是普通快速匹配与 AI 匹配共用的候选应用入口。
- [`server/managers/AiBookMatchManager.js`](../server/managers/AiBookMatchManager.js:84)：书名号本地书名提取、AI 作者/演播者提取、仅标题搜索回退和停止信号检查。
- [`client/components/app/SettingsContent.vue`](../client/components/app/SettingsContent.vue:18)：只声明 `headerText`/`description`/`note` props，未声明 `title`。
- [`client/layouts/default.vue`](../client/layouts/default.vue:256)：全局处理 `task_finished` 后更新任务 store，并通过 `$eventBus` 转发任务完成事件，保证计划任务页面能收到手动任务结果。
- [`client/components/app/ConfigSideNav.vue`](../client/components/app/ConfigSideNav.vue:57)：设置页面用户下方的计划任务入口。
- [`client/components/tables/TracksTable.vue`](../client/components/tables/TracksTable.vue:18)：大量音轨展开时使用固定行高、可视窗口和上下占位进行虚拟渲染。
- [`client/components/tables/ChaptersTable.vue`](../client/components/tables/ChaptersTable.vue:13)：详情页大量章节展开时复用音轨表的虚拟窗口渲染，保留章节播放跳转和编辑入口。
- [`client/components/tables/LibraryFilesTable.vue`](../client/components/tables/LibraryFilesTable.vue:15)：详情页媒体库文件使用普通文档流完整渲染，移除虚拟窗口和内部滚动容器，避免动态替换表格行引起持续自动滚动；保留长路径单行截断、稳定文件键和文件操作入口。
- [`client/pages/item/_id/index.vue`](../client/pages/item/_id/index.vue:406)：详情页三点菜单在下载项下增加书籍“匹配”入口，复用媒体库书籍菜单的编辑窗口并直接打开 Match 标签。
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
   - 保留全局单书补全队列：三个优先级队列（播放 > 手动 > 计划）级内 FIFO、非抢占；初始化、入队、调度和去重分别位于 `PlaybackSessionManager.js` 的 `strmCompletionQueues`、`enqueueStrmBookCompletion`、`processStrmCompletionQueue`、`queueStrmBookById`。播放补全 2.0 QPS 且每本完成后暂停 3 分钟；单本手动 2.0 QPS；多本手动 1.5 QPS、跨书共享每 3000 文件暂停 5 分钟；媒体库级手动 1.5 QPS、累计每 5000 文件暂停 3 分钟；计划任务读取 `strmMetadataCompletionQps` 和 `strmMetadataCompletionBatchSize` 设置。所有入口都直接跳过已完成元数据的 STRM 书籍，仅扫描部分完成书籍中仍缺失的音轨元数据。
   - 保留播放响应后的整书后台补全：只有后台探测成功后才回写书籍数据库和 metadata 文件，扫描阶段仍不得访问 `.strm` 指针目标。
   - 计划任务页面需要重新接入运行态播放/停止按钮、任务 action 过滤和 `task_finished` 结果处理；后端需要重新接入 `CronManager.js`、`MiscController.js` 与 `ApiRouter.js` 的停止 API。清理摘要依赖 `task.data.result.removed`，不能恢复为耗时显示，也不能把 `0` 项隐藏。媒体库扫描横条依赖 `scheduledLibraryScanCronExpression`、`scheduledLibraryScanLibraryIds`、`scheduledLibraryScanMaxHours` 三个设置字段，执行时按选定顺序串行扫描，不能并发扫描多个媒体库；书籍匹配手动和 cron 执行都必须保留服务端完成摘要和运行状态。
   - 保留计划任务 cron 默认不开启语义：所有 cron 字段默认 `null`，空字符串保存时规范化为 `null`，CronManager 在表达式为空时不注册定时任务。
   - AI 书籍匹配升级时优先保留独立文件 `AiBookMatchManager.js`；若上游调整 `BookFinder.search` 返回结构，只修改候选摘要映射。若上游调整快速匹配写入逻辑，继续让普通快速匹配和 AI 匹配共同调用 `Scanner.applyBookMatch`，不要复制两套作者、系列和封面保存逻辑。
   - 保留 AI 安全边界：模型只能选择 provider 已返回的候选序号，服务端必须校验序号和置信度；`aiBookMatchApiKey` 不得出现在 `toJSONForBrowser`、Socket 任务数据或日志中。审计继续写入 `LibraryItem.extraData.aiBookMatch`，不要写入用户可编辑的标签、描述或 metadata 文件。
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
   - 验证媒体库扫描和媒体预读的开始、完成、失败日志均显示媒体库名称而非 ID；展开媒体库文件列表后持续上下滑动，不发生自动跳顶、跳底或自动连续滚动。
   - 验证三个 cron 字段保存空字符串或纯空格后变为 `null`（不开启），页面不再出现原生“计划任务”悬浮提示框。
   - 验证“顶层书籍锚点”默认关闭：`作者/A1`、`作者/A2` 按原项目父级目录逻辑识别为两本书；开启后验证 `A/A1`、`A/A2` 被聚合为同一本书 `A`，且按卷目录顺序排列。完整扫描和 watcher 增量扫描结果应一致。
   - 播放时验证只访问当前章节目标，章节切换和恢复进度不会额外预取其他章节；远程服务端看到的播放代理请求应保持客户端软件的 User-Agent，媒体预读请求则应为精确值 `AudioBookShelf`。
   - 播放响应返回后验证后台按请求顺序逐本以 2.0 QPS 执行完整扫描，每本完成后暂停 3 分钟；成功后数据库中的 STRM 音轨时长、音轨元数据、章节和总时长均被补全；重复播放不会重复请求已完整书籍。
   - 分别验证详情页单本补全使用 2.0 QPS 且每 3000 文件暂停 5 分钟，选择多本补全使用 1.5 QPS 且跨书累计每 3000 文件暂停 5 分钟；媒体库三点菜单补全使用 1.5 QPS 且累计每 5000 文件暂停 3 分钟，并能在任务通知中显示当前书名和进度。
   - 验证全局单书队列互斥与优先级：播放补全执行中发起手动补全会排队，手动补全执行中发起计划任务会排队；同一优先级内先请求的先执行；当前书完成后才切换到更高优先级队列。
   - 在设置侧栏用户下方验证计划任务入口；分别手动执行四条任务，确认清理任务只删除 `isMissing` 数据库项目，不删除文件，也不删除仅 `isInvalid` 的项目。
   - 验证书名号书籍名称由本地固定提取，AI 只补充作者/演播者；无书名号时由 AI 提取书名、作者和演播者；带人物条件搜索无结果时自动回退到仅书名搜索；停止计划任务时当前 AI 请求立即取消且不写入取消失败审计。
   - 为书籍匹配配置测试用 OpenAI 兼容接口、一个图书媒体库和高置信度阈值；确认第二项横条、左右双栏设置、运行/停止、手动执行完成后的上次执行摘要及“匹配了 N 本图书”正常。确认只有标题、描述、持续时间、文件大小、音轨、章节和路径等扫描基础信息的书进入 AI 流程；确认 ISBN、ASIN、副标题、出版信息、语言、作者、演播者、系列、标签、类型或 `matched-ai` 审计任一存在时在批次层排除，不提取、不搜索、不请求 AI；确认有无实际封面均不影响判断。确认带 `《书名》` 的原名称由本地确定书名、AI 提取作者/演播者；无书名号时由 AI 提取书名和人物；“书名+人物”无结果时自动回退到“仅书名”搜索。确认停止按钮可立即中断当前 AI 请求，不写入取消失败审计；确认 `unmatched`/`needs-review` 可重试，低置信度写入 `needs-review`，越界候选不会写入元数据，API 密钥不会返回浏览器。
   - 验证已完成元数据的 STRM 书籍在播放补全、单本手动、多本手动、媒体库手动和计划任务中均被直接跳过；即使书籍聚合 `media.duration` 为 0，只要所有 STRM 音轨的时长、编码和声道均完整，也不得再次补全。验证部分完成的书籍只扫描缺失元数据的音轨，确认页面显示的是整个扫描任务的服务端总耗时，而不是接口响应耗时。
   - 手工制造一本包含大量 `.strm` 音轨的书，在补全完成一部分后停止或触发时间限制；确认已成功音轨在数据库中保留，重新执行时只请求剩余音轨，详情页显示完成数量/剩余数量，全部完成后提示消失。
   - 切换浩瀚星空主题，确认藏蓝/墨紫/炭黑背景及不同颜色和大小的静态星点在桌面和移动端可见且不遮挡交互；切换暗色主题，确认冷灰暗色界面正常显示。
   - 容器内执行 `ls /NetDisk/...` 能看到 `.strm` 指向的目标文件；不需要配置额外环境变量。
   - 播放远程 URL、本地 POSIX 路径和 Windows 路径目标均正常。
   - 两个主题切换、刷新持久化和夜间主题文本对比度正常。

## 冲突处理原则

- `server/utils/strmUtils.js` 和 `client/components/app/ThemeSwitcher.vue` 是定制功能的主要独立文件，优先保留本地版本，再适配上游接口。
- `Appbar.vue`、`app.css`、`AudioFileScanner.js`、`LibraryItemController.js` 属于上游高频变化文件，升级时不要整文件覆盖本地版本，只重新应用标记位置的少量耦合代码。
- 不要把主题颜色散落到业务组件中；主题颜色统一放在 `themes.css` 的变量和主题选择器内。
- 不要修改数据库结构保存主题；当前主题属于浏览器用户界面偏好，使用 `localStorage` 可以避免迁移和上游数据库冲突。
- 全局补全队列的状态全部保存在 `PlaybackSessionManager` 实例字段中（不落库），升级时保留这些字段和三个队列处理函数即可，无需迁移数据。
- 书内断点接续不依赖新的数据库迁移；升级时重点检查 `PlaybackSessionManager.completeStrmBook` 是否仍在成功探测后批量保存，以及 `LibraryItemDetails.vue` 是否仍依据 `media.audioFiles` 动态计算持续时间旁的待完成标识。若上游改变媒体模型的 JSON 序列化，只需保证 `audioFiles` 的 `duration`、`codec`、`channels` 和 `metadata.path` 仍可用。
- 计划任务设置字段属于 `ServerSettings`，上游若重命名或移动设置，需要同步保留 STRM、清理、媒体库扫描以及 `aiBookMatchCronExpression`、`aiBookMatchLibraryIds`、`aiBookMatchMaxHours`、`aiBookMatchApiUrl`、`aiBookMatchApiKey`、`aiBookMatchModel`、`aiBookMatchConfidence` 的构造、序列化和校验逻辑；浏览器序列化必须继续删除 API 密钥。

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
