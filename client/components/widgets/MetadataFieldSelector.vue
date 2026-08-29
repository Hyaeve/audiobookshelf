<template>
  <div class="metadata-field-selector bg-primary border border-gray-600 rounded-md px-2 py-2">
    <div class="metadata-field-selector-list">
      <button v-for="item in items" :key="item.value" type="button" :class="['metadata-field-chip', { 'metadata-field-chip-off': !selected.includes(item.value) }]" :aria-pressed="selected.includes(item.value) ? 'true' : 'false'" @click="toggle(item.value)">{{ item.text }}</button>
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
    toggle(value) {
      const next = this.selected.includes(value) ? this.selected.filter((v) => v !== value) : this.selected.concat([value])
      const allowed = new Set(next)
      this.$emit(
        'input',
        this.items.filter((item) => allowed.has(item.value)).map((item) => item.value)
      )
    }
  }
}
</script>

<style scoped>
.metadata-field-selector-list {
  display: flex;
  flex-wrap: wrap;
  gap: 0.375rem;
}

.metadata-field-chip {
  font-size: 0.75rem;
  line-height: 1rem;
  padding: 0.25rem 0.625rem;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, var(--abs-theme-accent) 55%, transparent);
  background: color-mix(in srgb, var(--abs-theme-accent) 20%, transparent);
  color: var(--abs-theme-text);
  transition: background 150ms ease, color 150ms ease, border-color 150ms ease;
}

.metadata-field-chip:hover {
  border-color: var(--abs-theme-accent);
}

.metadata-field-chip-off {
  border-color: rgba(148, 163, 184, 0.45);
  background: rgba(148, 163, 184, 0.12);
  color: rgba(148, 163, 184, 0.85);
}

.metadata-field-chip-off:hover {
  border-color: rgba(148, 163, 184, 0.75);
  color: rgba(203, 213, 225, 0.95);
}
</style>
