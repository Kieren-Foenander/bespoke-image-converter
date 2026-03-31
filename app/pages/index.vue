<script setup lang="ts">
type ConversionStats = {
  totalInputBytes: number
  totalOutputBytes: number
  imageCount: number
  videoCount: number
  totalSavingsBytes: number
  totalSavingsPercent: number
}

const selectedFile = ref<File | null>(null)
const isDragging = ref(false)
const isSubmitting = ref(false)
const errorMessage = ref('')
const stats = ref<ConversionStats | null>(null)
const lastDownloadName = ref('')
const fileInput = ref<HTMLInputElement | null>(null)

const hasFile = computed(() => Boolean(selectedFile.value))

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes === 0) {
    return '0 B'
  }

  const prefix = bytes < 0 ? '-' : ''
  const absoluteBytes = Math.abs(bytes)
  const units = ['B', 'KB', 'MB', 'GB']
  const exponent = Math.min(Math.floor(Math.log(absoluteBytes) / Math.log(1024)), units.length - 1)
  const value = absoluteBytes / 1024 ** exponent

  return `${prefix}${value.toFixed(value >= 10 || exponent === 0 ? 0 : 1)} ${units[exponent]}`
}

function resetState() {
  errorMessage.value = ''
  stats.value = null
  lastDownloadName.value = ''
}

function isZipFile(file: File) {
  return file.name.toLowerCase().endsWith('.zip')
}

function setSelectedFile(file: File | null) {
  if (!file) {
    return
  }

  resetState()

  if (!isZipFile(file)) {
    selectedFile.value = null
    errorMessage.value = 'Please choose a .zip file.'
    return
  }

  selectedFile.value = file
}

function openFilePicker() {
  fileInput.value?.click()
}

function onFileInputChange(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0] ?? null
  setSelectedFile(file)
  input.value = ''
}

function onDragOver() {
  isDragging.value = true
}

function onDragLeave() {
  isDragging.value = false
}

function onDrop(event: DragEvent) {
  isDragging.value = false
  const file = event.dataTransfer?.files?.[0] ?? null
  setSelectedFile(file)
}

async function submitFile() {
  if (!selectedFile.value || isSubmitting.value) {
    return
  }

  resetState()
  isSubmitting.value = true

  try {
    const formData = new FormData()
    formData.append('archive', selectedFile.value)

    const response = await fetch('/api/convert', {
      method: 'POST',
      body: formData
    })

    if (!response.ok) {
      const payload = await response.json().catch(() => null)
      throw new Error(payload?.statusMessage || payload?.message || 'Conversion failed.')
    }

    const statsHeader = response.headers.get('x-conversion-stats')
    if (statsHeader) {
      stats.value = JSON.parse(decodeURIComponent(statsHeader)) as ConversionStats
    }

    const blob = await response.blob()
    const suggestedFilename = response.headers
      .get('content-disposition')
      ?.match(/filename="([^"]+)"/)?.[1] || 'converted-media.zip'

    const objectUrl = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = objectUrl
    link.download = suggestedFilename
    document.body.append(link)
    link.click()
    link.remove()
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000)

    lastDownloadName.value = suggestedFilename
  }
  catch (error) {
    errorMessage.value = error instanceof Error ? error.message : 'Conversion failed.'
  }
  finally {
    isSubmitting.value = false
  }
}
</script>

<template>
  <main class="page-shell">
    <section class="hero-card">
      <p class="eyebrow">
        ZIP Upload Conversion App
      </p>
      <h1>Drop a ZIP and get back optimized media.</h1>
      <p class="description">
        Upload one archive that contains PNG images and a single WebM video. Files can sit at the
        ZIP root or inside folders. The app will convert the PNGs to WebP at max quality, retime the
        video to exactly 3 seconds, and return a fresh ZIP.
      </p>

      <div
        class="drop-zone"
        :class="{ 'drop-zone-active': isDragging }"
        @click="openFilePicker"
        @dragover.prevent="onDragOver"
        @dragleave.prevent="onDragLeave"
        @drop.prevent="onDrop"
      >
        <input
          ref="fileInput"
          class="sr-only"
          type="file"
          accept=".zip,application/zip"
          @change="onFileInputChange"
        >

        <p class="drop-title">
          {{ hasFile ? selectedFile?.name : 'Drag a ZIP file here' }}
        </p>
        <p class="drop-subtitle">
          {{ hasFile ? 'Click or drop another ZIP to replace it.' : 'Click to browse if you prefer.' }}
        </p>
      </div>

      <div class="actions">
        <button
          class="primary-button"
          type="button"
          :disabled="!hasFile || isSubmitting"
          @click="submitFile"
        >
          {{ isSubmitting ? 'Processing archive...' : 'Convert and download' }}
        </button>
        <p v-if="selectedFile" class="file-meta">
          Selected: {{ selectedFile.name }} ({{ formatBytes(selectedFile.size) }})
        </p>
      </div>

      <p v-if="errorMessage" class="message error-message">
        {{ errorMessage }}
      </p>

      <div v-if="stats" class="stats-panel">
        <div class="stat">
          <span class="stat-label">Input size</span>
          <strong>{{ formatBytes(stats.totalInputBytes) }}</strong>
        </div>
        <div class="stat">
          <span class="stat-label">Output size</span>
          <strong>{{ formatBytes(stats.totalOutputBytes) }}</strong>
        </div>
        <div class="stat">
          <span class="stat-label">Savings</span>
          <strong>{{ formatBytes(stats.totalSavingsBytes) }} ({{ stats.totalSavingsPercent.toFixed(1) }}%)</strong>
        </div>
        <div class="stat">
          <span class="stat-label">Processed</span>
          <strong>{{ stats.imageCount }} images, {{ stats.videoCount }} video</strong>
        </div>
      </div>

      <p v-if="lastDownloadName" class="message success-message">
        Download started for {{ lastDownloadName }}.
      </p>
    </section>
  </main>
</template>

<style scoped>
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

.page-shell {
  min-height: 100vh;
  padding: 2rem;
  background:
    radial-gradient(circle at top, rgba(56, 189, 248, 0.16), transparent 40%),
    linear-gradient(180deg, #0f172a 0%, #020617 100%);
  color: #e2e8f0;
}

.hero-card {
  max-width: 56rem;
  margin: 0 auto;
  padding: 2rem;
  border: 1px solid rgba(148, 163, 184, 0.2);
  border-radius: 1.5rem;
  background: rgba(15, 23, 42, 0.88);
  box-shadow: 0 24px 80px rgba(15, 23, 42, 0.45);
}

.eyebrow {
  margin: 0 0 0.75rem;
  font-size: 0.8rem;
  font-weight: 700;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: #38bdf8;
}

h1 {
  margin: 0;
  font-size: clamp(2rem, 5vw, 3.5rem);
  line-height: 1.05;
}

.description {
  max-width: 44rem;
  margin: 1rem 0 0;
  font-size: 1.05rem;
  line-height: 1.6;
  color: #cbd5e1;
}

.drop-zone {
  margin-top: 2rem;
  padding: 3rem 1.5rem;
  border: 2px dashed rgba(125, 211, 252, 0.35);
  border-radius: 1.25rem;
  background: rgba(15, 23, 42, 0.55);
  text-align: center;
  transition:
    border-color 0.2s ease,
    transform 0.2s ease,
    background 0.2s ease;
  cursor: pointer;
}

.drop-zone:hover,
.drop-zone-active {
  border-color: #38bdf8;
  background: rgba(8, 47, 73, 0.65);
  transform: translateY(-2px);
}

.drop-title {
  margin: 0;
  font-size: 1.2rem;
  font-weight: 700;
}

.drop-subtitle {
  margin: 0.75rem 0 0;
  color: #94a3b8;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 1rem;
  align-items: center;
  margin-top: 1.5rem;
}

.primary-button {
  padding: 0.95rem 1.4rem;
  border: 0;
  border-radius: 999px;
  background: linear-gradient(135deg, #38bdf8, #818cf8);
  color: #020617;
  font-size: 0.95rem;
  font-weight: 800;
  cursor: pointer;
}

.primary-button:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}

.file-meta {
  margin: 0;
  color: #cbd5e1;
}

.message {
  margin: 1rem 0 0;
  font-weight: 600;
}

.error-message {
  color: #fca5a5;
}

.success-message {
  color: #86efac;
}

.stats-panel {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr));
  gap: 1rem;
  margin-top: 1.5rem;
}

.stat {
  padding: 1rem;
  border: 1px solid rgba(148, 163, 184, 0.15);
  border-radius: 1rem;
  background: rgba(15, 23, 42, 0.72);
}

.stat-label {
  display: block;
  margin-bottom: 0.4rem;
  color: #94a3b8;
  font-size: 0.9rem;
}

@media (max-width: 640px) {
  .page-shell {
    padding: 1rem;
  }

  .hero-card {
    padding: 1.5rem;
  }

  .drop-zone {
    padding: 2rem 1rem;
  }

  .actions {
    align-items: stretch;
  }

  .primary-button {
    width: 100%;
  }
}
</style>
