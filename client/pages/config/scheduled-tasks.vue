<template>
  <app-settings-content :title="'计划任务'">
    <div class="w-full max-w-4xl space-y-3">
      <div v-for="task in taskDefinitions" :key="task.key" class="bg-primary border border-gray-600 rounded-md px-4 py-3 flex items-center">
        <div class="grow min-w-0">
          <h2 class="text-lg font-semibold truncate">{{ task.title }}</h2>
          <p class="text-sm text-gray-300 mt-1">{{ task.description }}</p>
          <p class="text-xs text-gray-400 mt-1">{{ scheduleText(task) }}<span v-if="nextRun(task)">，下次执行：{{ nextRun(task) }}</span></p>
        </div>
        <button type="button" class="w-10 h-10 ml-3 rounded-full border border-gray-500 hover:bg-bg flex items-center justify-center" :disabled="running[task.key]" :title="'开始执行'" @click="runNow(task)">
          <span class="material-symbols text-2xl">play_arrow</span>
        </button>
        <button type="button" class="w-10 h-10 ml-2 rounded-full border border-gray-500 hover:bg-bg flex items-center justify-center" title="设置" @click="openSettings(task)">
          <span class="material-symbols text-2xl">more_vert</span>
        </button>
      </div>
    </div>

    <modals-modal v-model="showSettings" name="scheduled-task-settings" :width="680" :height="'unset'" :processing="saving">
      <div class="p-5 bg-bg rounded-md">
        <h2 class="text-xl font-semibold mb-4">{{ selectedTask ? selectedTask.title + '设置' : '计划任务设置' }}</h2>
        <widgets-cron-expression-builder v-model="draftCron" />
        <div v-if="selectedTask && selectedTask.hasMaxHours" class="mt-5">
          <label class="block text-sm font-semibold mb-2">单次最长执行时间（小时）</label>
          <select v-model.number="draftMaxHours" class="w-full bg-primary border border-gray-600 rounded-md px-3 py-2">
            <option v-for="hours in maxHourOptions" :key="hours" :value="hours">{{ hours }} h</option>
          </select>
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
export default {
  data() {
    return {
      showSettings: false,
      saving: false,
      selectedTask: null,
      draftCron: null,
      draftMaxHours: 1,
      running: {}
    }
  },
  computed: {
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
    },
    maxHourOptions() {
      return Array.from({ length: 48 }, (_, index) => (index + 1) * 0.5)
    }
  },
  mounted() {
    this.openSettings(this.taskDefinitions[0], false)
  },
  methods: {
    cronFor(task) {
      return task.key === 'metadata' ? this.serverSettings.strmMetadataCompletionCronExpression : this.serverSettings.missingItemsCleanupCronExpression
    },
    scheduleText(task) {
      const cronExpression = this.cronFor(task)
      if (!cronExpression) return '未启用计划执行'
      const parsed = this.$parseCronExpression(cronExpression, this)
      return parsed ? parsed.description : `Cron：${cronExpression}`
    },
    nextRun(task) {
      const cronExpression = this.cronFor(task)
      if (!cronExpression) return ''
      const date = this.$getNextScheduledDate(cronExpression)
      return date ? this.$formatJsDatetime(date, this.$store.getters['getServerSetting']('dateFormat'), this.$store.getters['getServerSetting']('timeFormat')) : ''
    },
    openSettings(task, show = true) {
      this.selectedTask = task
      this.draftCron = this.cronFor(task) || null
      this.draftMaxHours = Number(this.serverSettings.strmMetadataCompletionMaxHours) || 1
      this.showSettings = show
    },
    async runNow(task) {
      this.$set(this.running, task.key, true)
      try {
        const path = task.key === 'metadata' ? '/api/strm-metadata-completion/run' : '/api/missing-items-cleanup/run'
        await this.$axios.$post(path)
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
