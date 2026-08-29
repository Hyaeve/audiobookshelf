<template>
  <div class="metadata-field-selector bg-primary border border-gray-600 rounded-md p-2">
    <div class="flex items-center justify-between px-1 pb-1">
      <p class="text-xs text-gray-400">已选 {{ selected.length }} / {{ items.length }}</p>
      <div class="flex items-center shrink-0">
        <button type="button" class="metadata-field-selector-link" @click="selectAll">全选</button>
        <button type="button" class="metadata-field-selector-link ml-3" @click="clearAll">清空</button>
      </div>
    </div>
    <div class="metadata-field-selector-list">
      <label v-for="item in items" :key="item.value" class="flex items-center text-sm py-1 cursor-pointer">
        <input type="checkbox" class="mr-2 shrink-0" :checked="selected.includes(item.value)" @change="toggle(item.value)" />
        <span class="truncate">{{ item.text }}</span>
      </label>
      <p v-if="!items.length" class="text-sm text-gray-400">暂无可选字段</p>
    </div>
  </div>
</template>

<script>
export default {
  props: {
    value: {
      type: Array,
      default: () => []
    },
    items: {
      type: Array,
      default: () => []
    }
  },
  computed: {
    selected() {
      return Array.isArray(this.value) ? this.value : []
    }
  },
  methods: {
    emitSelection(values) {
      const allowed = new Set(values)
      this.$emit(
        'input',
        this.items.filter((item) => allowed.has(item.value)).map((item) => item.value)
      )
    },
    toggle(value) {
      if (this.selected.includes(value)) {
        this.emitSelection(this.selected.filter((v) => v !== value))
      } else {
        this.emitSelection(this.selected.concat([value]))
      }
    },
    selectAll() {
      this.emitSelection(this.items.map((item) => item.value))
    },
    clearAll() {
      this.$emit('input', [])
    }
  }
}
</script>

<style scoped>
.metadata-field-selector-list {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  column-gap: 0.75rem;
  max-height: 8.5rem;
  overflow-y: auto;
}

.metadata-field-selector-link {
  font-size: 0.75rem;
  line-height: 1rem;
  color: rgb(148 163 184);
}

.metadata-field-selector-link:hover {
  color: rgb(226 232 240);
  text-decoration: underline;
}

@media (max-width: 640px) {
  .metadata-field-selector-list {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
