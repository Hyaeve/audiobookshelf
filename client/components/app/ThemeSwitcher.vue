<template>
  <div ref="themeSwitcher" class="theme-switcher relative mx-1 sm:mx-2">
    <ui-tooltip text="切换主题" direction="bottom" class="flex items-center">
      <button type="button" class="theme-switcher__button w-9 h-9 flex items-center justify-center" aria-label="切换主题" aria-haspopup="menu" :aria-expanded="showMenu" @click.stop="showMenu = !showMenu">
        <img src="~static/themes/theme-switch.png" alt="" class="w-6 h-6 object-contain" />
      </button>
    </ui-tooltip>

    <transition name="fade">
      <div v-if="showMenu" class="theme-switcher__menu absolute right-0 top-11 z-80 w-48 rounded-xl border p-2 shadow-xl" role="menu">
        <button v-for="item in themes" :key="item.id" type="button" class="theme-switcher__item w-full flex items-center rounded-lg px-3 py-2 text-left" :class="{ 'theme-switcher__item--active': currentTheme === item.id }" role="menuitemradio" :aria-checked="currentTheme === item.id" :aria-label="item.name" @click="selectTheme(item.id)">
          <span class="theme-switcher__swatch mr-3 h-5 w-5 rounded-full border" :style="{ background: item.swatch }" />
          <span class="grow text-sm font-semibold">{{ item.name }}</span>
          <span v-if="currentTheme === item.id" class="material-symbols text-lg">check</span>
        </button>
      </div>
    </transition>
  </div>
</template>

<script>
const STORAGE_KEY = 'absCustomTheme'
const DEFAULT_THEME = 'classic'
const VALID_THEMES = ['classic', 'cosmos']

export default {
  data() {
    return {
      showMenu: false,
      currentTheme: DEFAULT_THEME,
      themes: [
        { id: 'classic', name: '原版经典', swatch: 'linear-gradient(135deg, #232323 0%, #855620 100%)' },
        { id: 'cosmos', name: '浩瀚星空', swatch: 'linear-gradient(135deg, #070a12 0%, #253258 55%, #b79bf2 100%)' }
      ]
    }
  },
  mounted() {
    const savedTheme = localStorage.getItem(STORAGE_KEY)
    this.applyTheme(VALID_THEMES.includes(savedTheme) ? savedTheme : DEFAULT_THEME)
    document.addEventListener('click', this.closeMenu)
    document.addEventListener('keydown', this.handleKeydown)
  },
  beforeDestroy() {
    document.removeEventListener('click', this.closeMenu)
    document.removeEventListener('keydown', this.handleKeydown)
  },
  methods: {
    applyTheme(theme) {
      this.currentTheme = theme
      document.documentElement.dataset.absTheme = theme
      document.documentElement.style.colorScheme = 'dark'
      localStorage.setItem(STORAGE_KEY, theme)
    },
    selectTheme(theme) {
      this.applyTheme(theme)
      this.showMenu = false
    },
    closeMenu(event) {
      if (!this.$refs.themeSwitcher?.contains(event.target)) this.showMenu = false
    },
    handleKeydown(event) {
      if (event.key === 'Escape') this.showMenu = false
    }
  }
}
</script>
