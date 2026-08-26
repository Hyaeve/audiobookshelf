<template>
  <div class="w-full my-2">
    <div class="w-full bg-primary px-4 md:px-6 py-2 flex items-center cursor-pointer" @click.stop="clickBar">
      <p class="pr-2 md:pr-4">{{ $strings.HeaderLibraryFiles }}</p>
      <div class="h-5 md:h-7 w-5 md:w-7 rounded-full bg-white/10 flex items-center justify-center">
        <span class="text-sm font-mono">{{ files.length }}</span>
      </div>
      <div class="grow" />
      <ui-btn v-if="userIsAdmin" small :color="showFullPath ? 'bg-gray-600' : 'bg-primary'" class="mr-2 hidden md:block" @click.stop="toggleFullPath">{{ $strings.ButtonFullPath }}</ui-btn>
      <div class="cursor-pointer h-10 w-10 rounded-full hover:bg-black-400 flex justify-center items-center duration-500" :class="showFiles ? 'transform rotate-180' : ''">
        <span class="material-symbols text-4xl">&#xe313;</span>
      </div>
    </div>
    <transition name="slide">
      <div ref="filesViewport" class="files-viewport w-full max-h-[70vh] overflow-y-auto" v-show="showFiles" @scroll.passive="loadMoreFiles">
        <div class="files-virtual-canvas" :style="{ height: totalVirtualHeight + 'px' }">
          <table class="text-sm tracksTable files-virtual-table" :style="{ height: totalVirtualHeight + 'px' }">
            <tr class="files-header-row">
              <th class="text-left px-4">{{ $strings.LabelPath }}</th>
              <th class="text-left w-24 min-w-24">{{ $strings.LabelSize }}</th>
              <th class="text-left px-4 w-24">{{ $strings.LabelType }}</th>
              <th v-if="hasActionColumn" class="text-center w-16"></th>
            </tr>
            <template v-for="entry in visibleFiles">
              <tables-library-files-table-row :key="entry.file.ino || entry.file.metadata.path" :style="{ top: (entry.index + 1) * rowHeight + 'px' }" :libraryItemId="libraryItemId" :showFullPath="showFullPath" :file="entry.file" :inModal="inModal" @showMore="showMore" />
            </template>
          </table>
        </div>
      </div>
    </transition>

    <modals-audio-file-data-modal v-model="showAudioFileDataModal" :library-item-id="libraryItemId" :audio-file="selectedAudioFile" />
  </div>
</template>

<script>
export default {
  props: {
    libraryItem: {
      type: Object,
      default: () => {}
    },
    expanded: Boolean, // start expanded
    inModal: Boolean
  },
  data() {
    return {
      showFiles: false,
      showFullPath: false,
      showAudioFileDataModal: false,
      selectedAudioFile: null,
      virtualStart: 0,
      virtualEnd: 0,
      rowHeight: 48,
      overscan: 12,
      scrollFrame: null
    }
  },
  computed: {
    libraryItemId() {
      return this.libraryItem.id
    },
    userCanDownload() {
      return this.$store.getters['user/getUserCanDownload']
    },
    userCanDelete() {
      return this.$store.getters['user/getUserCanDelete']
    },
    userIsAdmin() {
      return this.$store.getters['user/getIsAdminOrUp']
    },
    files() {
      return this.libraryItem.libraryFiles || []
    },
    audioFiles() {
      if (this.libraryItem.mediaType === 'podcast') {
        return this.libraryItem.media?.episodes.map((ep) => ep.audioFile).filter((af) => af) || []
      }
      return this.libraryItem.media?.audioFiles || []
    },
    audioFileByIno() {
      return new Map(this.audioFiles.map((audioFile) => [audioFile.ino, audioFile]))
    },
    filesWithAudio() {
      return this.files.map((file) => {
        if (file.fileType !== 'audio') return file
        return { ...file, audioFile: this.audioFileByIno.get(file.ino) }
      })
    },
    visibleFiles() {
      return this.filesWithAudio.slice(this.virtualStart, this.virtualEnd).map((file, offset) => ({ file, index: this.virtualStart + offset }))
    },
    totalVirtualHeight() {
      return (this.files.length + 1) * this.rowHeight
    },
    hasActionColumn() {
      return this.userCanDelete || this.userCanDownload || (this.userIsAdmin && this.audioFiles.length && !this.inModal)
    }
  },
  methods: {
    toggleFullPath() {
      this.showFullPath = !this.showFullPath
      localStorage.setItem('showFullPath', this.showFullPath ? 1 : 0)
    },
    clickBar() {
      this.showFiles = !this.showFiles
      if (this.showFiles) this.$nextTick(this.updateVirtualWindow)
    },
    updateVirtualWindow() {
      const viewport = this.$refs.filesViewport
      if (!viewport) return
      const firstVisible = Math.max(0, Math.floor(Math.max(0, viewport.scrollTop - this.rowHeight) / this.rowHeight))
      const visibleRows = Math.ceil(viewport.clientHeight / this.rowHeight)
      this.virtualStart = Math.max(0, firstVisible - this.overscan)
      this.virtualEnd = Math.min(this.files.length, firstVisible + visibleRows + this.overscan)
    },
    loadMoreFiles() {
      if (this.scrollFrame) return
      this.scrollFrame = requestAnimationFrame(() => {
        this.scrollFrame = null
        this.updateVirtualWindow()
      })
    },
    showMore(audioFile) {
      this.selectedAudioFile = audioFile
      this.showAudioFileDataModal = true
    }
  },
  mounted() {
    if (this.userIsAdmin) {
      this.showFullPath = !!Number(localStorage.getItem('showFullPath') || 0)
    }
    this.showFiles = this.expanded
    this.virtualEnd = Math.min(this.files.length, this.overscan + 20)
  },
  beforeDestroy() {
    if (this.scrollFrame) cancelAnimationFrame(this.scrollFrame)
  },
  watch: {
    files() {
      this.virtualStart = 0
      this.virtualEnd = Math.min(this.files.length, this.overscan + 20)
      if (this.showFiles) this.$nextTick(this.updateVirtualWindow)
    }
  }
}
</script>

<style scoped>
.files-viewport {
  overflow-anchor: none;
}

.files-virtual-canvas {
  position: relative;
  width: 100%;
}

.files-virtual-table {
  position: absolute;
  inset: 0;
  width: 100%;
  table-layout: fixed;
  border-collapse: collapse;
}

.files-virtual-table :deep(tr:not(.files-header-row)) {
  position: absolute;
  left: 0;
  right: 0;
  height: 48px;
}

.files-virtual-table :deep(.files-header-row) {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 48px;
}
</style>
