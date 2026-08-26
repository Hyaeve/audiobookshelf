<template>
  <div class="w-full my-2">
    <div class="w-full bg-primary px-6 py-2 flex items-center cursor-pointer" @click.stop="clickBar">
      <p class="pr-4">{{ $strings.HeaderChapters }}</p>
      <span class="bg-black-400 rounded-xl py-1 px-2 text-sm font-mono">{{ chapters.length }}</span>
      <div class="grow" />
      <ui-btn v-if="userCanUpdate" small :to="`/audiobook/${libraryItemId}/chapters`" color="bg-primary" class="mr-2" @click="clickEditChapters">{{ $strings.ButtonEditChapters }}</ui-btn>
      <div v-if="!keepOpen" class="cursor-pointer h-10 w-10 rounded-full hover:bg-black-400 flex justify-center items-center duration-500" :class="expanded ? 'transform rotate-180' : ''">
        <span class="material-symbols text-4xl">&#xe313;</span>
      </div>
    </div>
    <transition name="slide">
      <div ref="chaptersViewport" class="w-full max-h-[70vh] overflow-y-auto" v-show="expanded || keepOpen" @scroll.passive="loadMoreChapters">
        <table class="text-sm tracksTable">
          <tr>
            <th class="text-left w-16"><span class="px-4">Id</span></th>
            <th class="text-left">{{ $strings.LabelTitle }}</th>
            <th class="text-center">{{ $strings.LabelStart }}</th>
            <th class="text-center">{{ $strings.LabelDuration }}</th>
          </tr>
          <tr v-if="topSpacerHeight" class="chapters-virtual-spacer"><td colspan="4" :style="{ height: topSpacerHeight + 'px' }"></td></tr>
          <template v-for="chapter in visibleChapters">
            <tr :key="chapter.id">
              <td class="text-left">
                <p class="px-4">{{ chapter.id }}</p>
              </td>
              <td dir="auto">
                <p class="truncate">{{ chapter.title }}</p>
              </td>
              <td class="font-mono text-center hover:underline cursor-pointer" @click.stop="goToTimestamp(chapter.start)">
                {{ $secondsToTimestamp(chapter.start) }}
              </td>
              <td class="font-mono text-center">
                {{ $secondsToTimestamp(Math.max(0, chapter.end - chapter.start)) }}
              </td>
            </tr>
          </template>
          <tr v-if="bottomSpacerHeight" class="chapters-virtual-spacer"><td colspan="4" :style="{ height: bottomSpacerHeight + 'px' }"></td></tr>
        </table>
      </div>
    </transition>
  </div>
</template>

<script>
export default {
  props: {
    libraryItem: {
      type: Object,
      default: () => {}
    },
    keepOpen: Boolean
  },
  data() {
    return {
      expanded: false,
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
    media() {
      return this.libraryItem ? this.libraryItem.media || {} : {}
    },
    metadata() {
      return this.media.metadata || {}
    },
    chapters() {
      return this.media.chapters || []
    },
    userCanUpdate() {
      return this.$store.getters['user/getUserCanUpdate']
    },
    visibleChapters() {
      return this.chapters.slice(this.virtualStart, this.virtualEnd)
    },
    topSpacerHeight() {
      return this.virtualStart * this.rowHeight
    },
    bottomSpacerHeight() {
      return Math.max(0, (this.chapters.length - this.virtualEnd) * this.rowHeight)
    }
  },
  methods: {
    clickBar() {
      this.expanded = !this.expanded
      if (this.expanded || this.keepOpen) this.$nextTick(this.updateVirtualWindow)
    },
    updateVirtualWindow() {
      const viewport = this.$refs.chaptersViewport
      if (!viewport) return
      const firstVisible = Math.floor(viewport.scrollTop / this.rowHeight)
      const visibleRows = Math.ceil(viewport.clientHeight / this.rowHeight)
      const nextStart = Math.max(0, firstVisible - this.overscan)
      const nextEnd = Math.min(this.chapters.length, firstVisible + visibleRows + this.overscan)
      if (nextStart !== this.virtualStart) this.virtualStart = nextStart
      if (nextEnd !== this.virtualEnd) this.virtualEnd = nextEnd
    },
    loadMoreChapters() {
      if (this.scrollFrame) return
      this.scrollFrame = requestAnimationFrame(() => {
        this.scrollFrame = null
        this.updateVirtualWindow()
      })
    },
    goToTimestamp(time) {
      const queueItem = {
        libraryItemId: this.libraryItemId,
        libraryId: this.libraryItem.libraryId,
        episodeId: null,
        title: this.metadata.title,
        subtitle: this.metadata.authors.map((au) => au.name).join(', '),
        caption: '',
        duration: this.media.duration || null,
        coverPath: this.media.coverPath || null
      }

      if (this.$store.getters['getIsMediaStreaming'](this.libraryItemId)) {
        this.$eventBus.$emit('play-item', {
          libraryItemId: this.libraryItemId,
          episodeId: null,
          startTime: time,
          queueItems: [queueItem]
        })
      } else {
        const payload = {
          message: `Start playback for "${this.metadata.title}" at ${this.$secondsToTimestamp(time)}?`,
          callback: (confirmed) => {
            if (confirmed) {
              this.$eventBus.$emit('play-item', {
                libraryItemId: this.libraryItemId,
                episodeId: null,
                startTime: time,
                queueItems: [queueItem]
              })
            }
          },
          type: 'yesNo'
        }
        this.$store.commit('globals/setConfirmPrompt', payload)
      }
    },
    clickEditChapters() {
      // Used for Chapters tab in modal
      if (this.$route.name === 'audiobook-id-chapters' && this.$route.params?.id === this.libraryItem?.id) {
        this.$emit('close')
      }
    }
  },
  mounted() {
    this.virtualEnd = Math.min(this.chapters.length, this.overscan + 20)
  },
  beforeDestroy() {
    if (this.scrollFrame) cancelAnimationFrame(this.scrollFrame)
  },
  watch: {
    chapters() {
      this.virtualStart = 0
      this.virtualEnd = Math.min(this.chapters.length, this.overscan + 20)
      if (this.expanded || this.keepOpen) this.$nextTick(this.updateVirtualWindow)
    }
  }
}
</script>

<style scoped>
.tracksTable :deep(tr:not(.chapters-virtual-spacer):not(:first-child)) {
  height: 48px;
}

.chapters-virtual-spacer,
.chapters-virtual-spacer:hover {
  background: transparent;
}

.chapters-virtual-spacer td {
  padding: 0;
  border: 0;
}
</style>
