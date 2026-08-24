<template>
  <app-settings-content :header-text="'计划任务'">
    <div class="scheduled-tasks w-full max-w-4xl space-y-2">
      <div
        v-for="task in taskDefinitions"
        :key="task.key"
        class="scheduled-task-row bg-primary border border-gray-600 rounded-md px-4 py-3 flex items-center"
      >
        <div class="grow min-w-0">
          <h2 class="text-xl font-semibold leading-tight truncate">{{ task.title }}</h2>
          <div v-if="isTaskRunning(task)" class="scheduled-task-progress mt-2">
            <div class="scheduled-task-progress-bar" :style="{ width: taskProgress(task) + '%' }"></div>
          </div>
          <p v-if="isTaskRunning(task)" class="text-xs text-gray-400 mt-1">执行进度 {{ Math.round(taskProgress(task)) }}%</p>
          <p v-else-if="lastRunText(task)" class="text-xs text-gray-400 mt-1">{{ lastRunText(task) }}</p>
          <p class="text-sm text-gray-300 mt-1">{{ task.description }}</p>
        </div>
        <div class="flex items-center ml-4 shrink-0">
          <button
            type="button"
            :class="['scheduled-task-action flex items-center justify-center', { 'scheduled-task-stop': isTaskRunning(task) }]"
            :disabled="running[task.key + 'Stopping']"
            :aria-label="(isTaskRunning(task) ? '停止任务 ' : '立即执行 ') + task.title"
            @click="isTaskRunning(task) ? stopTask(task) : runNow(task)"
          >
            <span class="material-symbols text-4xl">{{ isTaskRunning(task) ? 'stop' : 'play_arrow' }}</span>
          </button>
          <button
            type="button"
            class="scheduled-task-action flex items-center justify-center ml-2"
            :aria-label="'设置 ' + task.title"
            @click="openSettings(task)"
          >
            <span class="material-symbols text-2xl">more_vert</span>
          </button>
        </div>
      </div>
    </div>

    <modals-modal v-model="showSettings" name="scheduled-task-settings" :width="560" :height="'unset'" :processing="saving">
      <div class="p-5 bg-bg rounded-md">
        <h2 class="text-xl font-semibold mb-5">{{ selectedTask ? selectedTask.title + '设置' : '计划任务设置' }}</h2>
        <label class="block text-sm font-semibold mb-2" for="scheduled-task-cron">Cron 表达式</label>
        <input
          id="scheduled-task-cron"
          v-model="draftCron"
          type="text"
          class="w-full bg-primary border border-gray-600 rounded-md px-3 py-2"
          placeholder="例如：0 3 * * *"
        />
        <div v-if="selectedTask && selectedTask.key === 'scan'" class="mt-5">
          <label class="block text-sm font-semibold mb-2">扫描媒体库</label>
          <div class="max-h-40 overflow-y-auto bg-primary border border-gray-600 rounded-md p-2 space-y-1">
            <label v-for="library in libraries" :key="library.id" class="flex items-center text-sm py-1">
              <input v-model="draftLibraryIds" type="checkbox" :value="library.id" class="mr-2" />
              <span>{{ library.name }}</span>
            </label>
            <p v-if="!libraries.length" class="text-sm text-gray-400">暂无可扫描的媒体库</p>
          </div>
          <label class="block text-sm font-semibold mb-2 mt-4" for="scheduled-task-scan-max-hours">单次最长执行时间（小时）</label>
          <input
            id="scheduled-task-scan-max-hours"
            v-model.number="draftMaxHours"
            type="number"
            min="0.5"
            step="0.5"
            inputmode="decimal"
            class="w-full bg-primary border border-gray-600 rounded-md px-3 py-2"
          />
        </div>
        <div v-else-if="selectedTask && selectedTask.hasMaxHours" class="mt-5">
          <label class="block text-sm font-semibold mb-2" for="scheduled-task-max-hours">单次最长执行时间（小时）</label>
          <input
            id="scheduled-task-max-hours"
            v-model.number="draftMaxHours"
            type="number"
            min="0.5"
            step="0.5"
            inputmode="decimal"
            class="w-full bg-primary border border-gray-600 rounded-md px-3 py-2"
          />
          <label class="block text-sm font-semibold mb-2 mt-4" for="scheduled-task-qps">扫描 QPS</label>
          <input
            id="scheduled-task-qps"
            v-model.number="draftQps"
            type="number"
            min="0.1"
            max="10"
            step="0.1"
            inputmode="decimal"
            class="w-full bg-primary border border-gray-600 rounded-md px-3 py-2"
          />
          <label class="block text-sm font-semibold mb-2 mt-4" for="scheduled-task-batch-size">每隔多少个文件暂停 5 分钟</label>
          <input
            id="scheduled-task-batch-size"
            v-model.number="draftBatchSize"
            type="number"
            min="500"
            step="500"
            inputmode="numeric"
            class="w-full bg-primary border border-gray-600 rounded-md px-3 py-2"
          />
        </div>
        <div v-if="selectedTask && !selectedTask.hasMaxHours" class="mt-5 text-sm text-gray-300">
          只删除数据库中已标记为丢失的项目，不删除文件系统中的任何文件，也不会清理普通无效项目。
        </div>
        <div class="flex justify-end mt-6">
          <ui-btn color="bg-primary" class="mr-2" @click="showSettings = false">取消</ui-btn>
          <ui-btn color="bg-success" :loading="saving" @click="saveSettings">保存</ui-btn>
        </div>
      </div>
    </modals-modal>
  </app-settings-content>
</template>

<script>
const LAST_RUN_STORAGE_KEY = 'absScheduledTaskLastRuns'

export default {
  data() {
    return {
      showSettings: false,
      saving: false,
      selectedTask: null,
      draftCron: null,
      draftMaxHours: 1,
      draftQps: 1.0,
      draftBatchSize: 5000,
      draftLibraryIds: [],
      running: {},
      lastRuns: {}
    }
  },
  computed: {
    tasks() {
      return this.$store.state.tasks.tasks || []
    },
    libraries() {
      return this.$store.state.libraries.libraries || []
    },
    serverSettings() {
      return this.$store.state.serverSettings || {}
    },
    taskDefinitions() {
      return [
        {
          key: 'scan',
          title: '媒体库扫描',
          description: '扫描选定媒体库',
          hasMaxHours: true
        },
        {
          key: 'metadata',
          title: '补全元数据',
          description: '仅补全缺少有声书总时长的书籍',
          hasMaxHours: true
        },
        {
          key: 'missing',
          title: '清理丢失项目',
          description: '删除扫描后标记为丢失的项目数据库记录，不删除文件系统文件',
          hasMaxHours: false
        }
      ]
    }
  },
  mounted() {
    try {
      this.lastRuns = JSON.parse(localStorage.getItem(LAST_RUN_STORAGE_KEY) || '{}')
    } catch (error) {
      this.lastRuns = {}
    }
    this.$root.socket?.on('task_finished', this.scheduledTaskFinished)
  },
  beforeDestroy() {
    this.$root.socket?.off('task_finished', this.scheduledTaskFinished)
  },
  methods: {
    metadataTask() {
      return this.tasks.find((item) => item.action === 'strm-metadata-completion' && item.data?.scheduledTask && !item.isFinished)
    },
    scheduledTask(task) {
      const action = task.key === 'scan' ? 'scheduled-library-scan' : task.key === 'metadata' ? 'strm-metadata-completion' : 'missing-items-cleanup'
      return this.tasks.find((item) => item.action === action && item.data?.scheduledTask && !item.isFinished)
    },
    isTaskRunning(task) {
      return !!this.scheduledTask(task) || !!this.running[task.key]
    },
    taskProgress(task) {
      if (task.key !== 'scan' && task.key !== 'metadata') return 0
      const activeTask = this.scheduledTask(task)
      return Number(activeTask?.data?.progress) || 0
    },
    cronFor(task) {
      if (task.key === 'scan') return this.serverSettings.scheduledLibraryScanCronExpression
      return task.key === 'metadata' ? this.serverSettings.strmMetadataCompletionCronExpression : this.serverSettings.missingItemsCleanupCronExpression
    },
    scheduleText(task) {
      const cronExpression = this.cronFor(task)
      if (!cronExpression) return '未启用计划执行'
      const parsed = this.$parseCronExpression(cronExpression, this)
      return parsed ? parsed.description : `Cron：${cronExpression}`
    },
    lastRunText(task) {
      const lastRun = this.lastRuns[task.key]
      if (!lastRun) return ''
      const elapsedMs = Math.max(0, Date.now() - Number(lastRun.startedAt))
      const timeText = elapsedMs < 86400000
        ? `${Math.floor(elapsedMs / 3600000)} 小时前`
        : `${Math.floor(elapsedMs / 86400000)} 天前`
      const durationMinutes = Math.max(1, Math.ceil(Number(lastRun.durationMs) / 60000))
      if (task.key === 'missing') return `上次执行：${timeText}，耗时 ${durationMinutes} 分钟，清理了 ${Number(lastRun.removed) || 0} 项`
      return `上次执行：${timeText}，耗时 ${durationMinutes} 分钟`
    },
    openSettings(task) {
      this.selectedTask = task
      this.draftCron = this.cronFor(task) || null
      this.draftMaxHours = task.key === 'scan'
        ? Number(this.serverSettings.scheduledLibraryScanMaxHours) || 1
        : Number(this.serverSettings.strmMetadataCompletionMaxHours) || 1
      this.draftLibraryIds = task.key === 'scan' ? [...(this.serverSettings.scheduledLibraryScanLibraryIds || [])] : []
      this.draftQps = Number(this.serverSettings.strmMetadataCompletionQps) || 1.0
      this.draftBatchSize = Number(this.serverSettings.strmMetadataCompletionBatchSize) || 5000
      this.showSettings = true
    },
    scheduledTaskFinished(task) {
      const key = task.action === 'scheduled-library-scan' ? 'scan' : task.action === 'strm-metadata-completion' ? 'metadata' : task.action === 'missing-items-cleanup' ? 'missing' : null
      if (!key) return
      const lastRun = {
        startedAt: task.startedAt || Date.now(),
        durationMs: Math.max(0, (task.finishedAt || Date.now()) - (task.startedAt || Date.now())),
        removed: Number(task.data?.result?.removed) || 0
      }
      this.$set(this.lastRuns, key, lastRun)
      this.$set(this.running, key, false)
      localStorage.setItem(LAST_RUN_STORAGE_KEY, JSON.stringify(this.lastRuns))
    },
    async runNow(task) {
      this.$set(this.running, task.key, true)
      try {
        const path = task.key === 'scan' ? '/api/scheduled-library-scan/run' : task.key === 'metadata' ? '/api/strm-metadata-completion/run' : '/api/missing-items-cleanup/run'
        await this.$axios.$post(path)
        this.$toast.success(task.key === 'scan' ? '媒体库扫描已开始' : task.key === 'metadata' ? this.$strings.ToastLibraryMetadataCompletionStarted : '丢失项目清理已开始')
      } catch (error) {
        console.error(`Failed to run ${task.key} scheduled task`, error)
        this.$set(this.running, task.key, false)
        this.$toast.error(task.key === 'scan' ? '媒体库扫描启动失败' : task.key === 'metadata' ? this.$strings.ToastLibraryMetadataCompletionFailed : '丢失项目清理失败')
      }
    },
    async stopTask(task) {
      this.$set(this.running, task.key + 'Stopping', true)
      try {
        const path = task.key === 'scan' ? '/api/scheduled-library-scan/stop' : task.key === 'metadata' ? '/api/strm-metadata-completion/stop' : '/api/missing-items-cleanup/stop'
        const result = await this.$axios.$post(path)
        if (!result.stopped) this.$set(this.running, task.key, false)
      } catch (error) {
        console.error(`Failed to stop ${task.key} scheduled task`, error)
        this.$toast.error('停止任务失败')
      } finally {
        this.$set(this.running, task.key + 'Stopping', false)
      }
    },
    async saveSettings() {
      this.saving = true
      try {
        const cronExpression = typeof this.draftCron === 'string' && this.draftCron.trim() ? this.draftCron.trim() : null
        const payload = this.selectedTask.key === 'scan'
          ? { scheduledLibraryScanCronExpression: cronExpression, scheduledLibraryScanLibraryIds: this.draftLibraryIds, scheduledLibraryScanMaxHours: this.draftMaxHours }
          : this.selectedTask.key === 'metadata'
            ? { strmMetadataCompletionCronExpression: cronExpression, strmMetadataCompletionMaxHours: this.draftMaxHours, strmMetadataCompletionQps: this.draftQps, strmMetadataCompletionBatchSize: this.draftBatchSize }
            : { missingItemsCleanupCronExpression: cronExpression }
        const response = await this.$axios.$patch('/api/settings', payload)
        this.$store.commit('setServerSettings', response.serverSettings)
        this.showSettings = false
      } catch (error) {
        console.error('Failed to save scheduled task settings', error)
      } finally {
        this.saving = false
      }
    }
  }
}
</script>

<style scoped>
.scheduled-task-progress {
  height: 0.45rem;
  width: 100%;
  background: rgba(255, 255, 255, 0.22);
  border-radius: 999px;
  overflow: hidden;
}

.scheduled-task-progress-bar {
  height: 100%;
  background: #43b649;
  transition: width 200ms ease;
}

.scheduled-task-action {
  width: 2.5rem;
  height: 2.5rem;
  color: var(--abs-theme-muted);
  background: transparent;
  border: 0;
  transition: color 150ms ease, transform 150ms ease;
}

.scheduled-task-stop {
  color: var(--abs-theme-accent);
  background: transparent;
}

.scheduled-task-action:hover:not(:disabled) {
  color: var(--abs-theme-accent);
  transform: translateY(-1px);
}

.scheduled-task-action:disabled {
  opacity: 0.55;
}
</style>
