<template>
  <div class="flex items-center px-1 overflow-hidden">
    <div class="shrink-0 flex items-center justify-center" :class="libraryItemId ? 'relative w-10 h-12' : 'w-8'">
      <img v-if="libraryItemId" :src="coverFailed ? placeholderCover : coverSrc" :alt="task.data.libraryItemTitle || title" width="40" height="48" loading="lazy" class="w-full h-full object-contain rounded-xs" @error="coverFailed = true" />
      <div class="flex items-center justify-center" :class="libraryItemId ? 'absolute bottom-0 right-0 bg-bg rounded-full w-5 h-5' : ''" aria-hidden="true">
        <span v-if="isFinished" :class="taskIconStatus" class="material-symbols text-base">{{ actionIcon }}</span>
        <widgets-loading-spinner v-else />
      </div>
    </div>
    <div class="grow px-2 taskRunningCardContent">
      <p class="truncate text-sm">{{ title }}</p>

      <p class="truncate text-xs text-gray-300">{{ description }}</p>
      <p v-if="strmPreloadProgress" class="truncate text-xs text-gray-300">{{ strmPreloadProgress }}</p>
      <p v-if="specialMessage" class="truncate text-xs text-gray-300">{{ specialMessage }}</p>

      <p v-if="isFailed && failedMessage" class="text-xs truncate text-red-500">{{ failedMessage }}</p>
      <p v-else-if="!isFinished && (cancelingScan || isCancelingPreload)" class="text-xs truncate" role="status">{{ $strings.MessageTaskCanceling }}</p>
      <p v-else-if="isFinished && currentBookCancelled" class="text-xs truncate">{{ $strings.MessageTaskCanceledByUser }}</p>
    </div>
    <ui-btn v-if="userIsAdminOrUp && !isFinished && (isLibraryScan || canCancelPreload || isCancelingPreload)" color="bg-primary" :padding-y="1" :padding-x="1" :disabled="cancelingScan || isCancelingPreload" class="text-xs shrink-0 w-16 max-w-16 truncate mr-1" @click.stop.prevent="cancelTask">{{ $strings.ButtonCancel }}</ui-btn>
  </div>
</template>

<script>
export default {
  props: {
    task: {
      type: Object,
      default: () => {}
    }
  },
  data() {
    return {
      cancelingScan: false,
      cancelingBookId: null,
      coverFailed: false,
      specialMessage: ''
    }
  },
  watch: {
    task: {
      immediate: true,
      handler() {
        this.initTask()
      }
    },
    coverSrc() {
      this.coverFailed = false
    },
    libraryItemId() {
      this.cancelingBookId = null
    }
  },
  computed: {
    userIsAdminOrUp() {
      return this.$store.getters['user/getIsAdminOrUp']
    },
    title() {
      if (this.task.titleKey && this.$strings[this.task.titleKey]) {
        return this.$getString(this.task.titleKey, this.task.titleSubs)
      }
      return this.task.title || 'No Title'
    },
    description() {
      if (this.task.descriptionKey && this.$strings[this.task.descriptionKey]) {
        return this.$getString(this.task.descriptionKey, this.task.descriptionSubs)
      }
      return this.task.description || this.task.data?.libraryItemTitle || ''
    },
    libraryItemId() {
      return this.task.data?.libraryItemId || null
    },
    placeholderCover() {
      return this.$store.getters['globals/getPlaceholderCoverSrc']
    },
    coverSrc() {
      return this.$store.getters['globals/getLibraryItemCoverSrcById'](this.libraryItemId, this.task.data?.coverUpdatedAt || this.task.startedAt)
    },
    currentBookCancelled() {
      return this.task.action === 'strm-metadata-completion' && !!this.task.data?.currentBookCancelled
    },
    canCancelPreload() {
      return this.task.action === 'strm-metadata-completion' && !!this.task.data?.canCancelPreload && !!this.libraryItemId
    },
    isCancelingPreload() {
      return !this.isFinished && this.task.action === 'strm-metadata-completion' && (this.task.data?.cancelRequested || (!!this.cancelingBookId && this.cancelingBookId === this.libraryItemId))
    },
    isFinished() {
      return !!this.task.isFinished
    },
    isFailed() {
      return !!this.task.isFailed
    },
    isSuccess() {
      return this.isFinished && !this.isFailed
    },
    failedMessage() {
      if (this.task.errorKey && this.$strings[this.task.errorKey]) {
        return this.$getString(this.task.errorKey, this.task.errorSubs)
      }
      return this.task.error || ''
    },
    action() {
      return this.task.action || ''
    },
    actionIcon() {
      if (this.isFinished && this.currentBookCancelled && !this.isFailed) {
        return 'cancel'
      } else if (this.isFailed) {
        return 'error'
      } else if (this.isSuccess) {
        return 'done'
      }
      switch (this.action) {
        case 'download-podcast-episode':
          return 'cloud_download'
        case 'encode-m4b':
          return 'sync'
        case 'strm-metadata-completion':
          return 'graphic_eq'
        default:
          return 'settings'
      }
    },
    taskIconStatus() {
      if (this.currentBookCancelled && !this.isFailed) return 'text-gray-300'
      if (this.isFinished && this.isFailed) {
        return 'text-red-500'
      }
      if (this.isFinished && !this.isFailed) {
        return 'text-green-500'
      }

      return ''
    },
    isLibraryScan() {
      return this.action === 'library-scan' || this.action === 'library-match-all'
    },
    strmPreloadProgress() {
      // Track counter for media pre-read tasks so the activity dropdown shows how
      // far the currently pre-read book has progressed.
      if (this.action !== 'strm-metadata-completion' || this.isFinished) return ''
      const scannedTracks = Number(this.task.data?.scannedTracks) || 0
      const totalTracks = Number(this.task.data?.totalTracks) || 0
      if (!totalTracks) return ''
      return `${scannedTracks}/${totalTracks}`
    }
  },
  methods: {
    async cancelTask() {
      if (this.isLibraryScan) return this.cancelScan()
      if (!this.canCancelPreload || this.isCancelingPreload) return
      const libraryItemId = this.libraryItemId
      this.cancelingBookId = libraryItemId
      try {
        await this.$axios.$post(`/api/tasks/${this.task.id}/cancel-preload`, { libraryItemId })
      } catch (error) {
        if (this.cancelingBookId === libraryItemId) this.cancelingBookId = null
        this.$toast.error(this.$strings.MessageTaskCancelFailed)
      }
    },
    initTask() {
      // special message for library scan tasks
      if (this.task?.data?.scanResults) {
        const scanResults = this.task.data.scanResults
        const strs = []
        if (scanResults.added) strs.push(this.$getString('MessageTaskScanItemsAdded', [scanResults.added]))
        if (scanResults.updated) strs.push(this.$getString('MessageTaskScanItemsUpdated', [scanResults.updated]))
        if (scanResults.missing) strs.push(this.$getString('MessageTaskScanItemsMissing', [scanResults.missing]))
        const changesDetected = strs.length > 0 ? strs.join(', ') : this.$strings.MessageTaskScanNoChangesNeeded
        const timeElapsed = scanResults.elapsed ? ` (${this.$elapsedPretty(scanResults.elapsed / 1000, false, true)})` : ''
        this.specialMessage = `${changesDetected}${timeElapsed}`
      } else {
        this.specialMessage = ''
      }
    },
    cancelScan() {
      const libraryId = this.task?.data?.libraryId
      if (!libraryId) {
        console.error('No library id in library-scan task', this.task)
        return
      }
      this.cancelingScan = true
      this.$root.socket.emit('cancel_scan', libraryId)
    }
  },
  mounted() {}
}
</script>

<style>
.taskRunningCardContent {
  min-width: 0;
  min-height: 60px;
  display: flex;
  flex-direction: column;
  justify-content: center;
}
</style>
