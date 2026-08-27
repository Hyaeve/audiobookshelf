<template>
  <button
    type="button"
    class="metadata-lock-button"
    :class="locked ? 'metadata-lock-button-locked' : 'metadata-lock-button-unlocked'"
    :aria-label="locked ? '解锁此元数据' : '锁定此元数据'"
    :title="locked ? '解锁此元数据' : '锁定此元数据'"
    @click.stop.prevent="$emit('toggle')"
  >
    <span class="material-symbols text-base">{{ locked ? 'lock' : 'lock_open' }}</span>
  </button>
</template>

<script>
export default {
  props: {
    locked: Boolean
  }
}
</script>

<style scoped>
.metadata-lock-button {
  width: 2rem;
  height: 2rem;
  min-width: 2rem;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 0.375rem;
  transition: color 120ms ease, background-color 120ms ease;
}
.metadata-lock-button-unlocked {
  color: rgb(107 114 128);
}
.metadata-lock-button-unlocked:hover {
  color: rgb(209 213 219);
  background-color: rgb(127 127 127 / 0.18);
}
.metadata-lock-button-locked {
  color: rgb(255 255 255);
  background-color: rgb(127 127 127 / 0.35);
}
</style>
