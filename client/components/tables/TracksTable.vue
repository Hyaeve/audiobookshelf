<template>
  <div class="w-full my-2">
    <div class="w-full bg-primary px-4 md:px-6 py-2 flex items-center cursor-pointer" @click.stop="clickBar">
      <p class="pr-2 md:pr-4">{{ title }}</p>
      <div class="h-5 md:h-7 w-5 md:w-7 rounded-full bg-white/10 flex items-center justify-center">
        <span class="text-sm font-mono">{{ tracks.length }}</span>
      </div>
      <div class="grow" />
      <ui-btn v-if="userIsAdmin" small :color="showFullPath ? 'bg-gray-600' : 'bg-primary'" class="mr-2 hidden md:block" @click.stop="toggleFullPath">{{ $strings.ButtonFullPath }}</ui-btn>
      <nuxt-link v-if="userCanUpdate && !isFile" :to="`/audiobook/${libraryItemId}/edit`" class="mr-2 md:mr-4" @mousedown.prevent>
        <ui-btn small color="bg-primary">{{ $strings.ButtonManageTracks }}</ui-btn>
      </nuxt-link>
      <div class="cursor-pointer h-10 w-10 rounded-full hover:bg-black-400 flex justify-center items-center duration-500" :class="showTracks ? 'transform rotate-180' : ''">
        <span class="material-symbols text-4xl">&#xe313;</span>
      </div>
    </div>
    <transition name="slide">
      <div ref="tracksViewport" class="w-full max-h-[70vh] overflow-y-auto" v-show="showTracks" @scroll.passive="loadMoreTracks">
        <table class="text-sm tracksTable">
          <tr>
            <th class="w-10">#</th>
            <th class="text-left">{{ $strings.LabelFilename }}</th>
            <th v-if="!showFullPath" class="text-left w-20 hidden lg:table-cell">{{ $strings.LabelCodec }}</th>
            <th v-if="!showFullPath" class="text-left w-20 hidden xl:table-cell">{{ $strings.LabelBitrate }}</th>
            <th class="text-left w-20 hidden md:table-cell">{{ $strings.LabelSize }}</th>
            <th class="text-left w-20 hidden sm:table-cell">{{ $strings.LabelDuration }}</th>
            <th class="text-center w-16"></th>
          </tr>
          <tr v-if="topSpacerHeight" class="tracks-virtual-spacer"><td :colspan="columnCount" :style="{ height: topSpacerHeight + 'px' }"></td></tr>
          <template v-for="track in visibleTracks">
            <tables-audio-tracks-table-row :key="track.index" :track="track" :library-item-id="libraryItemId" :showFullPath="showFullPath" @showMore="showMore" />
          </template>
          <tr v-if="bottomSpacerHeight" class="tracks-virtual-spacer"><td :colspan="columnCount" :style="{ height: bottomSpacerHeight + 'px' }"></td></tr>
        </table>
      </div>
    </transition>

    <modals-audio-file-data-modal v-model="showAudioFileDataModal" :library-item-id="libraryItemId" :audio-file="selectedAudioFile" />
  </div>
</template>

<script>
export default {
  props: {
    title: {
      type: String,
      default: 'Audio Tracks'
    },
    tracks: {
      type: Array,
      default: () => []
    },
    libraryItemId: String,
    isFile: Boolean
  },
  data() {
    return {
      showTracks: false,
      showFullPath: false,
      virtualStart: 0,
      virtualEnd: 0,
      rowHeight: 48,
      overscan: 12,
      scrollFrame: null,
      selectedAudioFile: null,
      showAudioFileDataModal: false
    }
  },
  computed: {
    visibleTracks() {
      return this.tracks.slice(this.virtualStart, this.virtualEnd)
    },
    topSpacerHeight() {
      return this.virtualStart * this.rowHeight
    },
    bottomSpacerHeight() {
      return Math.max(0, (this.tracks.length - this.virtualEnd) * this.rowHeight)
    },
    columnCount() {
      return this.showFullPath ? 4 : 7
    },
    userCanDownload() {
      return this.$store.getters['user/getUserCanDownload']
    },
    userCanUpdate() {
      return this.$store.getters['user/getUserCanUpdate']
    },
    userCanDelete() {
      return this.$store.getters['user/getUserCanDelete']
    },
    userIsAdmin() {
      return this.$store.getters['user/getIsAdminOrUp']
    }
  },
  methods: {
    toggleFullPath() {
      this.showFullPath = !this.showFullPath
      localStorage.setItem('showFullPath', this.showFullPath ? 1 : 0)
    },
    clickBar() {
      this.showTracks = !this.showTracks
      if (this.showTracks) this.$nextTick(this.updateVirtualWindow)
    },
    updateVirtualWindow() {
      const viewport = this.$refs.tracksViewport
      if (!viewport) return
      const firstVisible = Math.floor(viewport.scrollTop / this.rowHeight)
      const visibleRows = Math.ceil(viewport.clientHeight / this.rowHeight)
      const nextStart = Math.max(0, firstVisible - this.overscan)
      const nextEnd = Math.min(this.tracks.length, firstVisible + visibleRows + this.overscan)
      if (nextStart !== this.virtualStart) this.virtualStart = nextStart
      if (nextEnd !== this.virtualEnd) this.virtualEnd = nextEnd
    },
    loadMoreTracks() {
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
    this.virtualEnd = Math.min(this.tracks.length, this.overscan + 20)
    if (this.userIsAdmin) {
      this.showFullPath = !!Number(localStorage.getItem('showFullPath') || 0)
    }
  },
  beforeDestroy() {
    if (this.scrollFrame) cancelAnimationFrame(this.scrollFrame)
  },
  watch: {
    tracks() {
      this.virtualStart = 0
      this.virtualEnd = Math.min(this.tracks.length, this.overscan + 20)
      if (this.showTracks) this.$nextTick(this.updateVirtualWindow)
    }
  }
}
</script>

<style scoped>
.tracksTable :deep(tr:not(.tracks-virtual-spacer):not(:first-child)) {
  height: 48px;
}

.tracks-virtual-spacer,
.tracks-virtual-spacer:hover {
  background: transparent;
}

.tracks-virtual-spacer td {
  padding: 0;
  border: 0;
}
</style>
