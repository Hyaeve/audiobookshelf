<template>
  <app-settings-content :title="'计划任务'">
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
          <ui-tooltip text="立即执行" direction="bottom">
            <button
              type="button"
              class="scheduled-task-action flex items-center justify-center"
              :disabled="isTaskRunning(task) || running[task.key]"
              :title="'立即执行'"
              :aria-label="'立即执行 ' + task.title"
              @click="runNow(task)"
            >
              <span class="material-symbols text-4xl">play_arrow</span>
            </button>
          </ui-tooltip>
          <ui-tooltip text="设置" direction="bottom">
            <button
              type="button"
              class="scheduled-task-action flex items-center justify-center ml-2"
              title="设置"
              :aria-label="'设置 ' + task.title"
              @click="openSettings(task)"
            >
              <span class="material-symbols text-2xl">more_vert</span>
            </button>
          </ui-tooltip>
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
        <div v-if="selectedTask && selectedTask.hasMaxHours" class="mt-5">
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
      running: {},
      lastRuns: {}
    }
  },
  computed: {
    tasks() {
      return this.$store.state.tasks.tasks || []
    },
    serverSettings() {
      return this.$store.state.serverSettings || {}
    },
    taskDefinitions() {
      return [
        {
          key: 'metadata',
          title: '补全元数据',
          description: '仅补全缺少有声书总时长的书籍，使用 0.5 QPS，每 5000 个文件暂停 5 分钟。',
          hasMaxHours: true
        },
        {
          key: 'missing',
          title: '清理丢失项目',
          description: '删除扫描后标记为丢失的项目数据库记录，不删除文件系统文件。',
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
      return this.tasks.find((item) => item.action === 'strm-metadata-completion' && !item.isFinished)
    },
    isTaskRunning(task) {
      return task.key === 'metadata' ? !!this.metadataTask() : !!this.running[task.key]
    },
    taskProgress(task) {
      if (task.key !== 'metadata') return 0
      return Number(this.metadataTask()?.data?.progress) || 0
    },
    cronFor(task) {
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
      const elapsedMinutes = Math.max(0, Math.floor((Date.now() - lastRun.startedAt) / 60000))
      const ago = elapsedMinutes < 60 ? `${elapsedMinutes} 分钟前` : `${Math.floor(elapsedMinutes / 60)} 小时前`
      const durationMinutes = Math.floor(lastRun.durationMs / 60000)
      const duration = durationMinutes < 60
        ? `${durationMinutes} 分钟`
        : `${Math.floor(durationMinutes / 60)} 小时 ${durationMinutes % 60} 分钟`
      return `上次运行：${ago}，耗时 ${duration}`
    },
    openSettings(task) {
      this.selectedTask = task
      this.draftCron = this.cronFor(task) || null
      this.draftMaxHours = Number(this.serverSettings.strmMetadataCompletionMaxHours) || 1
      this.showSettings = true
    },
    scheduledTaskFinished(task) {
      if (task.action !== 'strm-metadata-completion') return
      const lastRun = {
        startedAt: task.startedAt || Date.now(),
        durationMs: Math.max(0, (task.finishedAt || Date.now()) - (task.startedAt || Date.now()))
      }
      this.$set(this.lastRuns, 'metadata', lastRun)
      localStorage.setItem(LAST_RUN_STORAGE_KEY, JSON.stringify(this.lastRuns))
    },
    async runNow(task) {
      this.$set(this.running, task.key, true)
      const startedAt = Date.now()
      try {
        const path = task.key === 'metadata' ? '/api/strm-metadata-completion/run' : '/api/missing-items-cleanup/run'
        const result = await this.$axios.$post(path)
        if (task.key === 'metadata') {
          this.$toast.success(this.$strings.ToastLibraryMetadataCompletionStarted)
          return
        }
        const lastRun = {
          startedAt: result.startedAt || startedAt,
          durationMs: Date.now() - startedAt
        }
        this.$set(this.lastRuns, task.key, lastRun)
        localStorage.setItem(LAST_RUN_STORAGE_KEY, JSON.stringify(this.lastRuns))
        this.$toast.success(task.key === 'metadata' ? this.$strings.ToastLibraryMetadataCompletionStarted : '丢失项目清理已开始')
      } catch (error) {
        console.error(`Failed to run ${task.key} scheduled task`, error)
        this.$toast.error(task.key === 'metadata' ? this.$strings.ToastLibraryMetadataCompletionFailed : '丢失项目清理失败')
      } finally {
        this.$set(this.running, task.key, false)
      }
    },
    async saveSettings() {
      this.saving = true
      try {
        const payload = this.selectedTask.key === 'metadata'
          ? { strmMetadataCompletionCronExpression: this.draftCron, strmMetadataCompletionMaxHours: this.draftMaxHours }
          : { missingItemsCleanupCronExpression: this.draftCron }
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

.scheduled-task-action:hover:not(:disabled) {
  color: var(--abs-theme-accent);
  transform: translateY(-1px);
}

.scheduled-task-action:disabled {
  opacity: 0.55;
}
</style>
