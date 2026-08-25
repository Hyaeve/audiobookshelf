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
          <section>
            <h3 class="text-base font-semibold mb-4">任务设置</h3>
            <label class="block text-sm font-semibold mb-2" for="book-match-cron">Cron 表达式</label>
            <input id="book-match-cron" v-model="draftCron" type="text" class="w-full bg-primary border border-gray-600 rounded-md px-3 py-2" placeholder="例如：0 3 * * *" />
            <label class="block text-sm font-semibold mb-2 mt-4">匹配媒体库</label>
            <div class="max-h-40 overflow-y-auto bg-primary border border-gray-600 rounded-md p-2 space-y-1">
              <label v-for="library in bookLibraries" :key="library.id" class="flex items-center text-sm py-1"><input v-model="draftLibraryIds" type="checkbox" :value="library.id" class="mr-2" /><span>{{ library.name }}</span></label>
              <p v-if="!bookLibraries.length" class="text-sm text-gray-400">暂无图书媒体库</p>
            </div>
            <label class="block text-sm font-semibold mb-2 mt-4" for="book-match-hours">单次最长执行时间（小时）</label>
            <input id="book-match-hours" v-model.number="draftMaxHours" type="number" min="0.5" step="0.5" class="w-full bg-primary border border-gray-600 rounded-md px-3 py-2" />
            <p class="text-xs text-gray-400 mt-3">仅处理未匹配图书；已有 ISBN、ASIN 或 AI 成功记录的图书会跳过。</p>
          </section>
          <section>
            <h3 class="text-base font-semibold mb-4">OpenAI 兼容接口</h3>
            <label class="block text-sm font-semibold mb-2" for="book-match-url">协议地址</label>
            <input id="book-match-url" v-model="draftAiUrl" type="url" class="w-full bg-primary border border-gray-600 rounded-md px-3 py-2" placeholder="https://api.openai.com/v1" />
            <label class="block text-sm font-semibold mb-2 mt-4" for="book-match-key">API 密钥</label>
            <input id="book-match-key" v-model="draftAiKey" type="password" autocomplete="new-password" class="w-full bg-primary border border-gray-600 rounded-md px-3 py-2" :placeholder="serverSettings.aiBookMatchApiConfigured ? '已配置，留空保持不变' : 'sk-...'" />
            <label class="block text-sm font-semibold mb-2 mt-4" for="book-match-model">模型</label>
            <input id="book-match-model" v-model="draftAiModel" type="text" class="w-full bg-primary border border-gray-600 rounded-md px-3 py-2" placeholder="gpt-4o-mini" />
            <label class="block text-sm font-semibold mb-2 mt-4" for="book-match-confidence">自动应用最低置信度</label>
            <input id="book-match-confidence" v-model.number="draftAiConfidence" type="number" min="0.5" max="1" step="0.1" class="w-full bg-primary border border-gray-600 rounded-md px-3 py-2" />
          </section>
        </div>
        <div v-else>
          <label class="block text-sm font-semibold mb-2" for="scheduled-task-cron">Cron 表达式</label>
          <input id="scheduled-task-cron" v-model="draftCron" type="text" class="w-full bg-primary border border-gray-600 rounded-md px-3 py-2" placeholder="例如：0 3 * * *" />
          <div v-if="selectedTask && selectedTask.key === 'scan'" class="mt-5">
            <label class="block text-sm font-semibold mb-2">扫描媒体库</label>
            <div class="max-h-40 overflow-y-auto bg-primary border border-gray-600 rounded-md p-2 space-y-1"><label v-for="library in libraries" :key="library.id" class="flex items-center text-sm py-1"><input v-model="draftLibraryIds" type="checkbox" :value="library.id" class="mr-2" /><span>{{ library.name }}</span></label></div>
            <label class="block text-sm font-semibold mb-2 mt-4">单次最长执行时间（小时）</label><input v-model.number="draftMaxHours" type="number" min="0.5" step="0.5" class="w-full bg-primary border border-gray-600 rounded-md px-3 py-2" />
          </div>
          <div v-else-if="selectedTask && selectedTask.hasMaxHours" class="mt-5">
            <label class="block text-sm font-semibold mb-2">单次最长执行时间（小时）</label><input v-model.number="draftMaxHours" type="number" min="0.5" step="0.5" class="w-full bg-primary border border-gray-600 rounded-md px-3 py-2" />
            <label class="block text-sm font-semibold mb-2 mt-4">扫描 QPS</label><input v-model.number="draftQps" type="number" min="0.1" max="10" step="0.1" class="w-full bg-primary border border-gray-600 rounded-md px-3 py-2" />
            <label class="block text-sm font-semibold mb-2 mt-4">每隔多少个文件暂停 5 分钟</label><input v-model.number="draftBatchSize" type="number" min="500" step="500" class="w-full bg-primary border border-gray-600 rounded-md px-3 py-2" />
          </div>
          <p v-if="selectedTask && selectedTask.key === 'missing'" class="mt-5 text-sm text-gray-300">只删除数据库中已标记为丢失的项目，不删除文件系统中的任何文件。</p>
        </div>
        <div class="flex justify-end mt-6"><ui-btn color="bg-primary" class="mr-2" @click="showSettings = false">取消</ui-btn><ui-btn color="bg-success" :loading="saving" @click="saveSettings">保存</ui-btn></div>
      </div>
    </modals-modal>
  </app-settings-content>
</template>

<script>
const LAST_RUN_STORAGE_KEY = 'absScheduledTaskLastRuns'

export default {
  data() {
    return { showSettings: false, saving: false, selectedTask: null, draftCron: null, draftMaxHours: 1, draftQps: 1, draftBatchSize: 5000, draftLibraryIds: [], draftAiUrl: '', draftAiKey: '', draftAiModel: '', draftAiConfidence: 0.9, running: {}, lastRuns: {} }
  },
  computed: {
    tasks() { return this.$store.state.tasks.tasks || [] },
    libraries() { return this.$store.state.libraries.libraries || [] },
    bookLibraries() { return this.libraries.filter((library) => library.mediaType === 'book') },
    serverSettings() { return this.$store.state.serverSettings || {} },
    taskDefinitions() {
      return [
        { key: 'scan', title: '媒体库扫描', description: '扫描选定媒体库', hasMaxHours: true },
        { key: 'bookMatch', title: '书籍匹配', description: 'AI 辅助匹配未匹配书籍', hasMaxHours: true },
        { key: 'metadata', title: '补全元数据', description: '仅补全缺少有声书总时长的书籍', hasMaxHours: true },
        { key: 'missing', title: '清理丢失项目', description: '删除扫描后标记为丢失的项目数据库记录，不删除文件系统文件', hasMaxHours: false }
      ]
    }
  },
  mounted() {
    try { this.lastRuns = JSON.parse(localStorage.getItem(LAST_RUN_STORAGE_KEY) || '{}') } catch (error) { this.lastRuns = {} }
    if (!this.lastRuns.bookMatch && this.serverSettings.aiBookMatchLastRun) this.$set(this.lastRuns, 'bookMatch', { ...this.serverSettings.aiBookMatchLastRun })
    this.$root.socket?.on('task_finished', this.scheduledTaskFinished)
  },
  beforeDestroy() { this.$root.socket?.off('task_finished', this.scheduledTaskFinished) },
  methods: {
    actionFor(task) { return { scan: 'scheduled-library-scan', bookMatch: 'ai-book-match', metadata: 'strm-metadata-completion', missing: 'missing-items-cleanup' }[task.key] },
    scheduledTask(task) { return this.tasks.find((item) => item.action === this.actionFor(task) && item.data?.scheduledTask && !item.isFinished) },
    isTaskRunning(task) { return !!this.scheduledTask(task) || !!this.running[task.key] },
    taskProgress(task) { return Number(this.scheduledTask(task)?.data?.progress) || 0 },
    cronFor(task) { return { scan: this.serverSettings.scheduledLibraryScanCronExpression, bookMatch: this.serverSettings.aiBookMatchCronExpression, metadata: this.serverSettings.strmMetadataCompletionCronExpression, missing: this.serverSettings.missingItemsCleanupCronExpression }[task.key] },
    lastRunText(task) {
      const lastRun = this.lastRuns[task.key]
      if (!lastRun) return ''
      const elapsedMs = Math.max(0, Date.now() - Number(lastRun.startedAt))
      const timeText = elapsedMs < 3600000 ? `${Math.max(1, Math.floor(elapsedMs / 60000))} 分钟前` : elapsedMs < 86400000 ? `${Math.floor(elapsedMs / 3600000)} 小时前` : `${Math.floor(elapsedMs / 86400000)} 天前`
      const durationMinutes = Math.max(1, Math.ceil(Number(lastRun.durationMs) / 60000))
      if (task.key === 'missing') return `上次执行：${timeText}，耗时 ${durationMinutes} 分钟，清理了 ${Number(lastRun.removed) || 0} 项`
      if (task.key === 'bookMatch') return `上次执行：${timeText}，耗时 ${durationMinutes} 分钟，匹配了 ${Number(lastRun.matched) || 0} 本图书`
      return `上次执行：${timeText}，耗时 ${durationMinutes} 分钟`
    },
    openSettings(task) {
      this.selectedTask = task
      this.draftCron = this.cronFor(task) || null
      this.draftLibraryIds = task.key === 'scan' ? [...(this.serverSettings.scheduledLibraryScanLibraryIds || [])] : task.key === 'bookMatch' ? [...(this.serverSettings.aiBookMatchLibraryIds || [])] : []
      this.draftMaxHours = task.key === 'scan' ? Number(this.serverSettings.scheduledLibraryScanMaxHours) || 1 : task.key === 'bookMatch' ? Number(this.serverSettings.aiBookMatchMaxHours) || 1 : Number(this.serverSettings.strmMetadataCompletionMaxHours) || 1
      this.draftQps = Number(this.serverSettings.strmMetadataCompletionQps) || 1
      this.draftBatchSize = Number(this.serverSettings.strmMetadataCompletionBatchSize) || 5000
      this.draftAiUrl = this.serverSettings.aiBookMatchApiUrl || ''
      this.draftAiKey = ''
      this.draftAiModel = this.serverSettings.aiBookMatchModel || ''
      this.draftAiConfidence = Number(this.serverSettings.aiBookMatchConfidence) || 0.9
      this.showSettings = true
    },
    scheduledTaskFinished(task) {
      const key = { 'scheduled-library-scan': 'scan', 'ai-book-match': 'bookMatch', 'strm-metadata-completion': 'metadata', 'missing-items-cleanup': 'missing' }[task.action]
      if (!key) return
      this.$set(this.lastRuns, key, { startedAt: task.startedAt || Date.now(), durationMs: Math.max(0, (task.finishedAt || Date.now()) - (task.startedAt || Date.now())), removed: Number(task.data?.result?.removed) || 0, matched: Number(task.data?.result?.matched) || 0 })
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
    async saveSettings() {
      this.saving = true
      try {
        const cronExpression = typeof this.draftCron === 'string' && this.draftCron.trim() ? this.draftCron.trim() : null
        let payload
        if (this.selectedTask.key === 'scan') payload = { scheduledLibraryScanCronExpression: cronExpression, scheduledLibraryScanLibraryIds: this.draftLibraryIds, scheduledLibraryScanMaxHours: this.draftMaxHours }
        else if (this.selectedTask.key === 'bookMatch') {
          payload = { aiBookMatchCronExpression: cronExpression, aiBookMatchLibraryIds: this.draftLibraryIds, aiBookMatchMaxHours: this.draftMaxHours, aiBookMatchApiUrl: this.draftAiUrl.trim() || null, aiBookMatchModel: this.draftAiModel.trim() || null, aiBookMatchConfidence: this.draftAiConfidence }
          if (this.draftAiKey.trim()) payload.aiBookMatchApiKey = this.draftAiKey.trim()
        } else if (this.selectedTask.key === 'metadata') payload = { strmMetadataCompletionCronExpression: cronExpression, strmMetadataCompletionMaxHours: this.draftMaxHours, strmMetadataCompletionQps: this.draftQps, strmMetadataCompletionBatchSize: this.draftBatchSize }
        else payload = { missingItemsCleanupCronExpression: cronExpression }
        const response = await this.$axios.$patch('/api/settings', payload)
        this.$store.commit('setServerSettings', response.serverSettings)
        this.showSettings = false
      } catch (error) { console.error('Failed to save scheduled task settings', error) } finally { this.saving = false }
    }
  }
}
</script>

<style scoped>
.book-match-settings-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1.5rem; }
@media (max-width: 768px) { .book-match-settings-grid { grid-template-columns: 1fr; } }
.scheduled-task-progress { height: 0.45rem; width: 100%; background: rgba(255, 255, 255, 0.22); border-radius: 999px; overflow: hidden; }
.scheduled-task-progress-bar { height: 100%; background: #43b649; transition: width 200ms ease; }
.scheduled-task-action { width: 2.5rem; height: 2.5rem; color: var(--abs-theme-muted); background: transparent; border: 0; transition: color 150ms ease, transform 150ms ease; }
.scheduled-task-stop { color: var(--abs-theme-accent); background: transparent; }
.scheduled-task-action:hover:not(:disabled) { color: var(--abs-theme-accent); transform: translateY(-1px); }
.scheduled-task-action:disabled { opacity: 0.55; }
</style>
