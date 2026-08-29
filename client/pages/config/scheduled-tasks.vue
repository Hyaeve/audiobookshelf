<template>
  <app-settings-content :header-text="'计划任务'">
    <div class="scheduled-tasks w-full max-w-4xl space-y-2">
      <div v-for="task in taskDefinitions" :key="task.key" class="scheduled-task-row bg-primary border border-gray-600 rounded-md px-4 py-3 flex items-center">
        <div class="grow min-w-0">
          <h2 class="text-xl font-semibold leading-tight truncate">{{ task.title }}</h2>
          <div v-if="isTaskRunning(task)" class="scheduled-task-progress mt-2"><div class="scheduled-task-progress-bar" :style="{ width: taskProgress(task) + '%' }"></div></div>
          <p v-if="isTaskRunning(task)" class="text-xs text-gray-400 mt-1">执行进度 {{ Math.round(taskProgress(task)) }}%</p>
          <p v-else-if="lastRunText(task)" class="text-xs text-gray-400 mt-1">{{ lastRunText(task) }}</p>
          <p class="text-sm text-gray-300 mt-1">{{ task.description }}</p>
        </div>
        <div class="flex items-center ml-4 shrink-0">
          <button type="button" :class="['scheduled-task-action flex items-center justify-center', { 'scheduled-task-stop': isTaskRunning(task) }]" :disabled="running[task.key + 'Stopping']" :aria-label="(isTaskRunning(task) ? '停止任务 ' : '立即执行 ') + task.title" @click="isTaskRunning(task) ? stopTask(task) : runNow(task)">
            <span class="material-symbols text-4xl">{{ isTaskRunning(task) ? 'stop' : 'play_arrow' }}</span>
          </button>
          <button type="button" class="scheduled-task-action flex items-center justify-center ml-2" :aria-label="'设置 ' + task.title" @click="openSettings(task)"><span class="material-symbols text-2xl">more_vert</span></button>
        </div>
      </div>
    </div>

    <modals-modal v-model="showSettings" name="scheduled-task-settings" :width="selectedTask && selectedTask.key === 'bookMatch' ? 920 : 560" :height="'unset'" :processing="saving">
      <div class="p-5 bg-bg rounded-md">
        <h2 class="text-xl font-semibold mb-5">{{ selectedTask ? selectedTask.title + '设置' : '计划任务设置' }}</h2>
        <div v-if="selectedTask && selectedTask.key === 'bookMatch'" class="book-match-settings-grid">
          <section class="flex flex-col">
            <h3 class="text-base font-semibold mb-4">任务设置</h3>
            <div class="scheduled-task-field-grid">
              <div>
                <label class="block text-sm font-semibold mb-2" for="book-match-cron">Cron 表达式</label>
                <input id="book-match-cron" v-model="draftCron" type="text" class="w-full bg-primary border border-gray-600 rounded-md px-3 py-2" placeholder="例如：0 3 * * *" />
              </div>
              <div>
                <label class="block text-sm font-semibold mb-2" for="book-match-hours">时间限制（h）</label>
                <input id="book-match-hours" v-model.number="draftMaxHours" type="number" min="0.5" step="0.5" class="w-full bg-primary border border-gray-600 rounded-md px-3 py-2" />
              </div>
            </div>
            <label class="block text-sm font-semibold mb-2 mt-4">匹配媒体库</label>
            <div class="max-h-40 overflow-y-auto bg-primary border border-gray-600 rounded-md p-2 space-y-1">
              <label v-for="library in bookLibraries" :key="library.id" class="flex items-center text-sm py-1"><input v-model="draftLibraryIds" type="checkbox" :value="library.id" class="mr-2" /><span>{{ library.name }}</span></label>
              <p v-if="!bookLibraries.length" class="text-sm text-gray-400">暂无图书媒体库</p>
            </div>
            <div class="mt-4">
              <ui-tooltip text="匹配成功时允许覆盖的元数据字段，默认全部纳入。删除某项后，书籍已有该字段时不再覆盖；若书籍原本为空，仍然会写入匹配到的内容。">
                <span class="text-sm font-semibold">
                  元数据匹配
                  <span class="material-symbols icon-text text-sm">info</span>
                </span>
              </ui-tooltip>
              <ui-multi-select-dropdown v-model="draftAiOverrideFields" :items="metadataFieldItems" class="mt-1" />
            </div>
            <div class="book-match-toggles flex flex-col mt-auto pt-5 space-y-2">
              <div class="flex items-center">
                <input id="book-match-global" v-model="draftAiGlobal" type="checkbox" class="mr-2 shrink-0" />
                <ui-tooltip text="开启后处理所选媒体库中的全部图书，并以覆盖模式写入匹配元数据；关闭时仅处理未匹配图书，已有 ISBN、ASIN 或匹配成功记录的图书会跳过。">
                  <label class="text-sm font-semibold cursor-pointer" for="book-match-global">
                    全局匹配
                    <span class="material-symbols icon-text text-sm">info</span>
                  </label>
                </ui-tooltip>
              </div>
              <div class="flex items-center">
                <input id="book-match-on-scan" v-model="draftAiOnScan" type="checkbox" class="mr-2 shrink-0" />
                <ui-tooltip text="开启后由书籍匹配接管扫描新入库书籍的匹配流程，按书名号、符号分隔、AI 辅助、全称的顺序逐级尝试。">
                  <label class="text-sm font-semibold cursor-pointer" for="book-match-on-scan">
                    入库匹配
                    <span class="material-symbols icon-text text-sm">info</span>
                  </label>
                </ui-tooltip>
              </div>
            </div>
          </section>
          <section>
            <h3 class="text-base font-semibold mb-4">OpenAI 兼容接口</h3>
            <label class="block text-sm font-semibold mb-2" for="book-match-url">协议地址</label>
            <input id="book-match-url" v-model="draftAiUrl" type="url" class="w-full bg-primary border border-gray-600 rounded-md px-3 py-2" placeholder="https://api.openai.com/v1" />
            <label class="block text-sm font-semibold mb-2 mt-4" for="book-match-key">API 密钥</label>
            <div class="relative">
              <input id="book-match-key" v-model="draftAiKey" :type="showAiKey ? 'text' : 'password'" autocomplete="new-password" class="w-full bg-primary border border-gray-600 rounded-md px-3 py-2 pr-11" placeholder="sk-..." />
              <button type="button" class="ai-key-visibility-button" :aria-label="showAiKey ? '隐藏 API 密钥' : '显示 API 密钥'" :title="showAiKey ? '隐藏 API 密钥' : '显示 API 密钥'" @click="showAiKey = !showAiKey">
                <span class="material-symbols">{{ showAiKey ? 'visibility' : 'visibility_off' }}</span>
              </button>
            </div>
            <label class="block text-sm font-semibold mb-2 mt-4" for="book-match-model">模型</label>
            <input id="book-match-model" v-model="draftAiModel" type="text" class="w-full bg-primary border border-gray-600 rounded-md px-3 py-2" placeholder="gpt-4o-mini" />
            <label class="block text-sm font-semibold mb-2 mt-4" for="book-match-confidence">自动应用最低置信度</label>
            <input id="book-match-confidence" v-model.number="draftAiConfidence" type="number" min="0.5" max="1" step="0.1" class="w-full bg-primary border border-gray-600 rounded-md px-3 py-2" />
          </section>
        </div>
        <div v-else>
          <div class="scheduled-task-field-grid">
            <div>
              <label class="block text-sm font-semibold mb-2" for="scheduled-task-cron">Cron 表达式</label>
              <input id="scheduled-task-cron" v-model="draftCron" type="text" class="w-full bg-primary border border-gray-600 rounded-md px-3 py-2" placeholder="例如：0 3 * * *" />
            </div>
            <div v-if="selectedTask && selectedTask.hasMaxHours">
              <label class="block text-sm font-semibold mb-2" for="scheduled-task-hours">时间限制（h）</label>
              <input id="scheduled-task-hours" v-model.number="draftMaxHours" type="number" min="0.5" step="0.5" class="w-full bg-primary border border-gray-600 rounded-md px-3 py-2" />
            </div>
          </div>
          <div v-if="selectedTask && (selectedTask.key === 'scan' || selectedTask.key === 'bookMetadata' || selectedTask.key === 'metadata')" class="mt-5">
            <label class="block text-sm font-semibold mb-2">{{ selectedTask.key === 'scan' ? '扫描媒体库' : selectedTask.key === 'bookMetadata' ? '补全媒体库' : '预读媒体库' }}</label>
            <div class="max-h-40 overflow-y-auto bg-primary border border-gray-600 rounded-md p-2 space-y-1"><label v-for="library in selectedTask.key === 'scan' ? libraries : bookLibraries" :key="library.id" class="flex items-center text-sm py-1"><input v-model="draftLibraryIds" type="checkbox" :value="library.id" class="mr-2" /><span>{{ library.name }}</span></label></div>
            <div v-if="selectedTask.key === 'bookMetadata'" class="mt-4">
              <ui-tooltip text="需要补全的元数据字段，默认全部纳入。只会向选中且当前为空的字段写入内容，不会覆盖已有值。">
                <span class="text-sm font-semibold">
                  元数据补全
                  <span class="material-symbols icon-text text-sm">info</span>
                </span>
              </ui-tooltip>
              <ui-multi-select-dropdown v-model="draftBookMetadataFields" :items="metadataFieldItems" class="mt-1" />
            </div>
            <template v-if="selectedTask.key === 'metadata'">
              <label class="block text-sm font-semibold mb-2 mt-4">扫描 QPS</label><input v-model.number="draftQps" type="number" min="0.1" max="10" step="0.1" class="w-full bg-primary border border-gray-600 rounded-md px-3 py-2" />
              <label class="block text-sm font-semibold mb-2 mt-4">每隔多少个文件暂停 5 分钟</label><input v-model.number="draftBatchSize" type="number" min="500" step="500" class="w-full bg-primary border border-gray-600 rounded-md px-3 py-2" />
            </template>
            <p v-if="selectedTask.key === 'bookMetadata'" class="text-xs text-gray-400 mt-3">逐本搜索当前书名并仅填充缺失字段；不会覆盖已有标题、作者、系列、封面或其他元数据。</p>
          </div>
          <div v-else-if="selectedTask && selectedTask.key === 'missing'" class="mt-5">
            <label class="block text-sm font-semibold mb-2">清理媒体库</label>
            <div class="max-h-40 overflow-y-auto bg-primary border border-gray-600 rounded-md p-2 space-y-1"><label v-for="library in libraries" :key="library.id" class="flex items-center text-sm py-1"><input v-model="draftLibraryIds" type="checkbox" :value="library.id" class="mr-2" /><span>{{ library.name }}</span></label></div>
            <p class="mt-3 text-sm text-gray-300">只删除所选媒体库中已标记为丢失的项目，不删除文件系统中的任何文件。</p>
          </div>
        </div>
        <div class="flex justify-end mt-6"><ui-btn color="bg-primary" class="mr-2" @click="showSettings = false">取消</ui-btn><ui-btn color="bg-success" :loading="saving" @click="saveSettings">保存</ui-btn></div>
      </div>
    </modals-modal>
  </app-settings-content>
</template>

<script>
const LAST_RUN_STORAGE_KEY = 'absScheduledTaskLastRuns'

// Keep in sync with server/utils/bookMetadataFields.js
const METADATA_FIELD_OPTIONS = [
  { value: 'title', text: '标题' },
  { value: 'subtitle', text: '副标题' },
  { value: 'description', text: '简介' },
  { value: 'authors', text: '作者' },
  { value: 'narrators', text: '演播者' },
  { value: 'series', text: '系列' },
  { value: 'genres', text: '流派' },
  { value: 'tags', text: '标签' },
  { value: 'publisher', text: '出版商' },
  { value: 'publishedYear', text: '出版年份' },
  { value: 'language', text: '语言' },
  { value: 'explicit', text: '露骸内容标记' },
  { value: 'abridged', text: '删节标记' },
  { value: 'asin', text: 'ASIN' },
  { value: 'isbn', text: 'ISBN' },
  { value: 'coverPath', text: '封面' }
]

const METADATA_FIELD_KEYS = METADATA_FIELD_OPTIONS.map((option) => option.value)

export default {
  data() {
    return { showSettings: false, saving: false, selectedTask: null, showAiKey: false, draftCron: null, draftMaxHours: 1, draftQps: 1, draftBatchSize: 5000, draftLibraryIds: [], draftAiGlobal: false, draftAiOnScan: false, draftAiUrl: '', draftAiKey: '', draftAiModel: '', draftAiConfidence: 0.9, draftAiOverrideFields: [], draftBookMetadataFields: [], running: {}, lastRuns: {} }
  },
  computed: {
    tasks() { return this.$store.state.tasks.tasks || [] },
    libraries() { return this.$store.state.libraries.libraries || [] },
    bookLibraries() { return this.libraries.filter((library) => library.mediaType === 'book') },
    serverSettings() { return this.$store.state.serverSettings || {} },
    metadataFieldItems() { return METADATA_FIELD_OPTIONS },
    latestCompletedBookMatchTask() {
      return this.tasks
        .filter((task) => task.action === 'ai-book-match' && task.isFinished)
        .sort((a, b) => Number(b.finishedAt) - Number(a.finishedAt))[0] || null
    },
    taskDefinitions() {
      return [
        { key: 'scan', title: '媒体库扫描', description: '扫描选定媒体库', hasMaxHours: true },
        { key: 'bookMatch', title: '书籍匹配', description: '按书名号、符号分隔、AI 辅助、全称逐级提取书名并匹配', hasMaxHours: true },
        { key: 'bookMetadata', title: '补全元数据', description: '根据当前书名搜索并仅补充缺失的书籍元数据', hasMaxHours: true },
        { key: 'metadata', title: '媒体预读', description: '仅预读缺少有声书总时长的书籍', hasMaxHours: true },
        { key: 'missing', title: '清理丢失项目', description: '删除扫描后标记为丢失的项目数据库记录，不删除文件系统文件', hasMaxHours: false }
      ]
    }
  },
  mounted() {
    try { this.lastRuns = JSON.parse(localStorage.getItem(LAST_RUN_STORAGE_KEY) || '{}') } catch (error) { this.lastRuns = {} }
    // Server side last-run records win over the local copy so scheduled runs that
    // happened while nobody had this page open are shown too.
    Object.entries({
      scan: this.serverSettings.scheduledLibraryScanLastRun,
      bookMatch: this.serverSettings.aiBookMatchLastRun,
      bookMetadata: this.serverSettings.bookMetadataCompletionLastRun,
      metadata: this.serverSettings.strmMetadataCompletionLastRun,
      missing: this.serverSettings.missingItemsCleanupLastRun
    }).forEach(([key, lastRun]) => {
      if (!lastRun) return
      if (Number(this.lastRuns[key]?.finishedAt) >= Number(lastRun.finishedAt)) return
      this.$set(this.lastRuns, key, { ...lastRun })
    })
    this.$eventBus.$on('task-finished', this.scheduledTaskFinished)
  },
  beforeDestroy() { this.$eventBus.$off('task-finished', this.scheduledTaskFinished) },
  watch: {
    latestCompletedBookMatchTask(task) {
      if (task) this.scheduledTaskFinished(task)
    }
  },
  methods: {
    actionFor(task) { return { scan: 'scheduled-library-scan', bookMatch: 'ai-book-match', bookMetadata: 'book-metadata-completion', metadata: 'strm-metadata-completion', missing: 'missing-items-cleanup' }[task.key] },
    scheduledTask(task) { return this.tasks.find((item) => item.action === this.actionFor(task) && !item.isFinished) },
    isTaskRunning(task) { return !!this.scheduledTask(task) || !!this.running[task.key] },
    taskProgress(task) { return Number(this.scheduledTask(task)?.data?.progress) || 0 },
    cronFor(task) { return { scan: this.serverSettings.scheduledLibraryScanCronExpression, bookMatch: this.serverSettings.aiBookMatchCronExpression, bookMetadata: this.serverSettings.bookMetadataCompletionCronExpression, metadata: this.serverSettings.strmMetadataCompletionCronExpression, missing: this.serverSettings.missingItemsCleanupCronExpression }[task.key] },
    lastRunText(task) {
      const lastRun = this.lastRuns[task.key]
      if (!lastRun) return ''
      const elapsedMs = Math.max(0, Date.now() - Number(lastRun.startedAt))
      const timeText = elapsedMs < 3600000 ? `${Math.max(1, Math.floor(elapsedMs / 60000))} 分钟前` : elapsedMs < 86400000 ? `${Math.floor(elapsedMs / 3600000)} 小时前` : `${Math.floor(elapsedMs / 86400000)} 天前`
      const durationMinutes = Math.max(1, Math.ceil(Number(lastRun.durationMs) / 60000))
      // The prefix tells whether the last run came from the cron schedule or the play button
      const prefix = lastRun.scheduledTask === true ? '上次计划执行' : '上次手动执行'
      if (task.key === 'missing') return `${prefix}：${timeText}，耗时 ${durationMinutes} 分钟，清理了 ${Number(lastRun.removed) || 0} 项`
      if (task.key === 'bookMatch') return `${prefix}：${timeText}，耗时 ${durationMinutes} 分钟，匹配了 ${Number(lastRun.matched) || 0} 本图书`
      if (task.key === 'bookMetadata') return `${prefix}：${timeText}，耗时 ${durationMinutes} 分钟，更新了 ${Number(lastRun.updated) || 0} 本图书`
      return `${prefix}：${timeText}，耗时 ${durationMinutes} 分钟`
    },
    async openSettings(task) {
      this.selectedTask = task
      this.draftCron = this.cronFor(task) || null
      this.draftLibraryIds = task.key === 'scan' ? [...(this.serverSettings.scheduledLibraryScanLibraryIds || [])] : task.key === 'bookMatch' ? [...(this.serverSettings.aiBookMatchLibraryIds || [])] : task.key === 'bookMetadata' ? [...(this.serverSettings.bookMetadataCompletionLibraryIds || [])] : task.key === 'metadata' ? [...(this.serverSettings.strmMetadataCompletionLibraryIds || [])] : task.key === 'missing' ? [...(this.serverSettings.missingItemsCleanupLibraryIds || [])] : []
      this.draftMaxHours = task.key === 'scan' ? Number(this.serverSettings.scheduledLibraryScanMaxHours) || 1 : task.key === 'bookMatch' ? Number(this.serverSettings.aiBookMatchMaxHours) || 1 : task.key === 'bookMetadata' ? Number(this.serverSettings.bookMetadataCompletionMaxHours) || 1 : Number(this.serverSettings.strmMetadataCompletionMaxHours) || 1
      this.draftQps = Number(this.serverSettings.strmMetadataCompletionQps) || 1
      this.draftBatchSize = Number(this.serverSettings.strmMetadataCompletionBatchSize) || 5000
      this.draftAiGlobal = this.serverSettings.aiBookMatchGlobal === true
      this.draftAiOnScan = this.serverSettings.aiBookMatchOnScan === true
      this.draftAiUrl = this.serverSettings.aiBookMatchApiUrl || ''
      this.draftAiKey = ''
      this.draftAiModel = this.serverSettings.aiBookMatchModel || ''
      this.draftAiConfidence = Number(this.serverSettings.aiBookMatchConfidence) || 0.9
      this.draftAiOverrideFields = this.normalizeFieldSelection(this.serverSettings.aiBookMatchOverrideFields)
      this.draftBookMetadataFields = this.normalizeFieldSelection(this.serverSettings.bookMetadataCompletionFields)
      this.showAiKey = false
      this.showSettings = true
      if (task.key === 'bookMatch') {
        try {
          const sensitiveSettings = await this.$axios.$get('/api/ai-book-match/settings')
          this.draftAiKey = sensitiveSettings.aiBookMatchApiKey || ''
        } catch (error) {
          console.error('Failed to load AI book match API key', error)
          this.$toast.error('加载 AI 接口密钥失败')
        }
      }
    },
    scheduledTaskFinished(task) {
      const key = { 'scheduled-library-scan': 'scan', 'ai-book-match': 'bookMatch', 'book-metadata-completion': 'bookMetadata', 'strm-metadata-completion': 'metadata', 'missing-items-cleanup': 'missing' }[task.action]
      if (!key) return
      const taskResult = task.data?.result || {}
      const startedAt = Number(taskResult.startedAt) || Number(task.startedAt) || Date.now()
      const finishedAt = Number(taskResult.finishedAt) || Number(task.finishedAt) || Date.now()
      if (Number(this.lastRuns[key]?.finishedAt) === finishedAt) {
        this.$set(this.running, key, false)
        return
      }
      const scheduledTask = taskResult.scheduledTask ?? task.data?.scheduledTask ?? false
      const summary = { startedAt, finishedAt, durationMs: Number(taskResult.durationMs) || Math.max(0, finishedAt - startedAt), scheduledTask: scheduledTask === true, removed: Number(taskResult.removed) || 0, matched: Number(taskResult.matched) || 0, updated: Number(taskResult.updated) || 0 }
      this.$set(this.lastRuns, key, summary)
      const lastRunSettingKey = { scan: 'scheduledLibraryScanLastRun', bookMatch: 'aiBookMatchLastRun', bookMetadata: 'bookMetadataCompletionLastRun', metadata: 'strmMetadataCompletionLastRun', missing: 'missingItemsCleanupLastRun' }[key]
      if (lastRunSettingKey) this.$store.commit('setServerSettings', { ...this.serverSettings, [lastRunSettingKey]: summary })
      this.$set(this.running, key, false)
      localStorage.setItem(LAST_RUN_STORAGE_KEY, JSON.stringify(this.lastRuns))
    },
    async runNow(task) {
      this.$set(this.running, task.key, true)
      try { await this.$axios.$post(`/api/${this.actionFor(task)}/run`); this.$toast.success(`${task.title}已开始`) } catch (error) { this.$set(this.running, task.key, false); this.$toast.error(`${task.title}启动失败`) }
    },
    async stopTask(task) {
      this.$set(this.running, task.key + 'Stopping', true)
      try { const result = await this.$axios.$post(`/api/${this.actionFor(task)}/stop`); if (!result.stopped) this.$set(this.running, task.key, false) } catch (error) { this.$toast.error('停止任务失败') } finally { this.$set(this.running, task.key + 'Stopping', false) }
    },
    normalizeFieldSelection(fields) {
      if (!Array.isArray(fields)) return [...METADATA_FIELD_KEYS]
      return METADATA_FIELD_KEYS.filter((field) => fields.includes(field))
    },
    draftNumber(value) {
      const number = typeof value === 'number' ? value : Number(String(value ?? '').trim())
      return Number.isFinite(number) ? number : null
    },
    isStepMultiple(value, step) {
      return Number.isInteger(Math.round(value / step)) && Math.abs(Math.round(value / step) * step - value) < 1e-9
    },
    validateDrafts(taskKey) {
      const numbers = {}
      if (taskKey !== 'missing') {
        const maxHours = this.draftNumber(this.draftMaxHours)
        if (maxHours === null || maxHours < 0.5 || !this.isStepMultiple(maxHours, 0.5)) return { error: '时间限制（h）必须是不小于 0.5 且为 0.5 倍数的数值' }
        numbers.maxHours = maxHours
      }
      if (taskKey === 'metadata') {
        const qps = this.draftNumber(this.draftQps)
        if (qps === null || qps < 0.1 || qps > 10 || !this.isStepMultiple(qps, 0.1)) return { error: '扫描 QPS 必须是 0.1 至 10 之间且为 0.1 倍数的数值' }
        const batchSize = this.draftNumber(this.draftBatchSize)
        if (batchSize === null || !Number.isInteger(batchSize) || batchSize < 500 || batchSize % 500 !== 0) return { error: '暂停阈值必须是不小于 500 且为 500 倍数的整数' }
        numbers.qps = qps
        numbers.batchSize = batchSize
      }
      if (taskKey === 'bookMatch') {
        const confidence = this.draftNumber(this.draftAiConfidence)
        if (confidence === null || confidence < 0.5 || confidence > 1) return { error: '自动应用最低置信度必须是 0.5 至 1 之间的数值' }
        numbers.confidence = confidence
      }
      return { numbers }
    },
    async saveSettings() {
      if (!this.selectedTask) return
      const taskKey = this.selectedTask.key
      const { numbers, error: validationError } = this.validateDrafts(taskKey)
      if (validationError) return this.$toast.error(validationError)
      this.saving = true
      try {
        const cronExpression = typeof this.draftCron === 'string' && this.draftCron.trim() ? this.draftCron.trim() : null
        let payload
        if (taskKey === 'scan') payload = { scheduledLibraryScanCronExpression: cronExpression, scheduledLibraryScanLibraryIds: this.draftLibraryIds, scheduledLibraryScanMaxHours: numbers.maxHours }
        else if (taskKey === 'bookMatch') {
          payload = { aiBookMatchCronExpression: cronExpression, aiBookMatchLibraryIds: this.draftLibraryIds, aiBookMatchGlobal: this.draftAiGlobal, aiBookMatchOnScan: this.draftAiOnScan, aiBookMatchMaxHours: numbers.maxHours, aiBookMatchApiUrl: (this.draftAiUrl || '').trim() || null, aiBookMatchModel: (this.draftAiModel || '').trim() || null, aiBookMatchConfidence: numbers.confidence, aiBookMatchOverrideFields: this.normalizeFieldSelection(this.draftAiOverrideFields) }
          if ((this.draftAiKey || '').trim()) payload.aiBookMatchApiKey = this.draftAiKey.trim()
        } else if (taskKey === 'bookMetadata') payload = { bookMetadataCompletionCronExpression: cronExpression, bookMetadataCompletionLibraryIds: this.draftLibraryIds, bookMetadataCompletionMaxHours: numbers.maxHours, bookMetadataCompletionFields: this.normalizeFieldSelection(this.draftBookMetadataFields) }
        else if (taskKey === 'metadata') payload = { strmMetadataCompletionCronExpression: cronExpression, strmMetadataCompletionLibraryIds: this.draftLibraryIds, strmMetadataCompletionMaxHours: numbers.maxHours, strmMetadataCompletionQps: numbers.qps, strmMetadataCompletionBatchSize: numbers.batchSize }
        else payload = { missingItemsCleanupCronExpression: cronExpression, missingItemsCleanupLibraryIds: this.draftLibraryIds }
        const response = await this.$axios.$patch('/api/settings', payload)
        this.$store.commit('setServerSettings', response.serverSettings)
        this.showSettings = false
        this.$toast.success(`${this.selectedTask.title}设置已保存`)
      } catch (error) {
        console.error('Failed to save scheduled task settings', error)
        const serverMessage = typeof error.response?.data === 'string' ? error.response.data.trim() : ''
        this.$toast.error(serverMessage || '保存设置失败')
      } finally {
        this.saving = false
      }
    }
  }
}
</script>

<style scoped>
.ai-key-visibility-button { position: absolute; top: 0; right: 0; height: 100%; width: 2.75rem; display: flex; align-items: center; justify-content: center; color: var(--abs-theme-muted); }
.ai-key-visibility-button:hover { color: var(--abs-theme-text); }
.ai-key-visibility-button .material-symbols { font-size: 1.25rem; }
.scheduled-task-field-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1rem; }
@media (max-width: 640px) { .scheduled-task-field-grid { grid-template-columns: 1fr; } }
.book-match-settings-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1.5rem; align-items: stretch; }
@media (max-width: 768px) { .book-match-settings-grid { grid-template-columns: 1fr; } }
.scheduled-task-progress { height: 0.45rem; width: 100%; background: rgba(255, 255, 255, 0.22); border-radius: 999px; overflow: hidden; }
.scheduled-task-progress-bar { height: 100%; background: #43b649; transition: width 200ms ease; }
.scheduled-task-action { width: 2.5rem; height: 2.5rem; color: var(--abs-theme-muted); background: transparent; border: 0; transition: color 150ms ease, transform 150ms ease; }
.scheduled-task-stop { color: var(--abs-theme-accent); background: transparent; }
.scheduled-task-action:hover:not(:disabled) { color: var(--abs-theme-accent); transform: translateY(-1px); }
.scheduled-task-action:disabled { opacity: 0.55; }
</style>
