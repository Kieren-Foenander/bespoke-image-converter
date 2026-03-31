import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, extname, join, posix } from 'node:path'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createIPX, ipxFSStorage } from 'ipx'
import JSZip from 'jszip'

const TARGET_VIDEO_DURATION_SECONDS = 3

type ArchiveSourceFile = {
  absolutePath: string
  size: number
  zipPath: string
}

type ProcessedFileStat = {
  inputBytes: number
  kind: 'image' | 'video'
  outputBytes: number
}

type ProbeResult = {
  durationSeconds: number
  hasAudio: boolean
}

export type ConversionStats = {
  imageCount: number
  totalInputBytes: number
  totalOutputBytes: number
  totalSavingsBytes: number
  totalSavingsPercent: number
  videoCount: number
}

export type ProcessArchiveResult = {
  outputFilename: string
  outputZipBuffer: Buffer
  stats: ConversionStats
}

export async function processArchive(options: {
  archiveBuffer: Buffer
  originalFilename: string
}): Promise<ProcessArchiveResult> {
  const tempRoot = await mkdtemp(join(tmpdir(), 'bespoke-image-converter-'))
  const extractedDir = join(tempRoot, 'extracted')
  const workingDir = join(tempRoot, 'working')

  await mkdir(extractedDir, { recursive: true })
  await mkdir(workingDir, { recursive: true })

  try {
    const extractedFiles = await extractArchive(options.archiveBuffer, extractedDir)
    const pngFiles = extractedFiles.filter(file => extname(file.zipPath).toLowerCase() === '.png')
    const webmFiles = extractedFiles.filter(file => extname(file.zipPath).toLowerCase() === '.webm')

    if (pngFiles.length === 0) {
      throw new Error('The ZIP file must contain at least one PNG image.')
    }

    if (webmFiles.length === 0) {
      throw new Error('The ZIP file must contain exactly one WebM video.')
    }

    if (webmFiles.length > 1) {
      throw new Error('Only one WebM video is supported per ZIP upload.')
    }

    const outputZip = new JSZip()
    const ipx = createIPX({
      storage: ipxFSStorage({ dir: extractedDir })
    })
    const processedFiles: ProcessedFileStat[] = []

    for (const imageFile of pngFiles) {
      const transformed = await ipx(imageFile.zipPath, {
        format: 'webp',
        quality: '100'
      }).process()
      const outputData = normalizeToBuffer(transformed.data)
      const outputPath = replaceExtension(imageFile.zipPath, '.webp')

      outputZip.file(outputPath, outputData, { binary: true })
      processedFiles.push({
        kind: 'image',
        inputBytes: imageFile.size,
        outputBytes: outputData.byteLength
      })
    }

    const videoFile = webmFiles[0]
    const retimedVideoPath = join(workingDir, `retimed${extname(videoFile.absolutePath) || '.webm'}`)

    await retimeVideoToThreeSeconds(videoFile.absolutePath, retimedVideoPath)

    const retimedVideoBuffer = await readFile(retimedVideoPath)
    outputZip.file(videoFile.zipPath, retimedVideoBuffer, { binary: true })
    processedFiles.push({
      kind: 'video',
      inputBytes: videoFile.size,
      outputBytes: retimedVideoBuffer.byteLength
    })

    const outputZipBuffer = await outputZip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: {
        level: 9
      }
    })

    return {
      outputFilename: buildOutputFilename(options.originalFilename),
      outputZipBuffer,
      stats: buildStats(processedFiles)
    }
  }
  finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
}

async function extractArchive(archiveBuffer: Buffer, destinationDir: string) {
  const archive = await JSZip.loadAsync(archiveBuffer)
  const files: ArchiveSourceFile[] = []

  for (const entry of Object.values(archive.files)) {
    if (entry.dir) {
      continue
    }

    const sanitizedPath = sanitizeZipPath(entry.name)
    if (!sanitizedPath) {
      continue
    }

    const fileBuffer = await entry.async('nodebuffer')
    const absolutePath = join(destinationDir, sanitizedPath)

    await mkdir(dirname(absolutePath), { recursive: true })
    await writeFile(absolutePath, fileBuffer)

    files.push({
      absolutePath,
      size: fileBuffer.byteLength,
      zipPath: sanitizedPath
    })
  }

  return files
}

function sanitizeZipPath(filePath: string) {
  const segments = filePath
    .replaceAll('\\', '/')
    .split('/')
    .filter(Boolean)

  if (segments.length === 0) {
    return null
  }

  if (segments[0] === '__MACOSX' || segments.at(-1) === '.DS_Store') {
    return null
  }

  if (segments.some(segment => segment === '.' || segment === '..')) {
    return null
  }

  return segments.join('/')
}

function replaceExtension(filePath: string, nextExtension: string) {
  return filePath.replace(/\.[^.]+$/u, nextExtension)
}

function normalizeToBuffer(value: Buffer | string) {
  return Buffer.isBuffer(value) ? value : Buffer.from(value)
}

function buildOutputFilename(originalFilename: string) {
  const originalBaseName = posix.basename(originalFilename, extname(originalFilename))
  const safeBaseName = originalBaseName.replace(/[^a-zA-Z0-9-_]+/gu, '-').replace(/^-+|-+$/gu, '')

  return `${safeBaseName || 'converted-media'}-converted.zip`
}

function buildStats(files: ProcessedFileStat[]): ConversionStats {
  const imageCount = files.filter(file => file.kind === 'image').length
  const videoCount = files.filter(file => file.kind === 'video').length
  const totalInputBytes = files.reduce((sum, file) => sum + file.inputBytes, 0)
  const totalOutputBytes = files.reduce((sum, file) => sum + file.outputBytes, 0)
  const totalSavingsBytes = totalInputBytes - totalOutputBytes
  const totalSavingsPercent = totalInputBytes === 0 ? 0 : (totalSavingsBytes / totalInputBytes) * 100

  return {
    imageCount,
    totalInputBytes,
    totalOutputBytes,
    totalSavingsBytes,
    totalSavingsPercent,
    videoCount
  }
}

async function retimeVideoToThreeSeconds(inputPath: string, outputPath: string) {
  const probe = await probeVideo(inputPath, 'ffprobe')

  if (!Number.isFinite(probe.durationSeconds) || probe.durationSeconds <= 0) {
    throw new Error('Could not determine the input video duration.')
  }

  const initialSpeedFactor = probe.durationSeconds / TARGET_VIDEO_DURATION_SECONDS
  const firstPassPath = `${outputPath}.pass1.webm`

  await encodeRetimedVideo(inputPath, firstPassPath, initialSpeedFactor, probe.hasAudio)

  const firstPassProbe = await probeVideo(firstPassPath, 'ffprobe')
  const durationDelta = Math.abs(firstPassProbe.durationSeconds - TARGET_VIDEO_DURATION_SECONDS)

  if (durationDelta <= 0.02) {
    await rm(outputPath, { force: true })
    await writeFile(outputPath, await readFile(firstPassPath))
    await rm(firstPassPath, { force: true })
    return
  }

  const correctedSpeedFactor = initialSpeedFactor * (firstPassProbe.durationSeconds / TARGET_VIDEO_DURATION_SECONDS)
  await encodeRetimedVideo(inputPath, outputPath, correctedSpeedFactor, probe.hasAudio)
  await rm(firstPassPath, { force: true })
}

async function encodeRetimedVideo(
  inputPath: string,
  outputPath: string,
  speedFactor: number,
  hasAudio: boolean
) {
  const videoSpeedMultiplier = formatFilterNumber(1 / speedFactor)

  if (hasAudio) {
    const audioFilter = buildAtempoFilter(speedFactor)
    await runBinary('ffmpeg', [
      '-y',
      '-i',
      inputPath,
      '-filter_complex',
      `[0:v:0]setpts=${videoSpeedMultiplier}*PTS[v];[0:a:0]${audioFilter}[a]`,
      '-map',
      '[v]',
      '-map',
      '[a]',
      '-c:v',
      'libvpx-vp9',
      '-crf',
      '18',
      '-b:v',
      '0',
      '-row-mt',
      '1',
      '-c:a',
      'libopus',
      outputPath
    ])
    return
  }

  await runBinary('ffmpeg', [
    '-y',
    '-i',
    inputPath,
    '-filter:v',
    `setpts=${videoSpeedMultiplier}*PTS`,
    '-an',
    '-c:v',
    'libvpx-vp9',
    '-crf',
    '18',
    '-b:v',
    '0',
    '-row-mt',
    '1',
    outputPath
  ])
}

async function probeVideo(inputPath: string, ffprobePath: string): Promise<ProbeResult> {
  const probeOutput = await runBinary(ffprobePath, [
    '-v',
    'error',
    '-show_entries',
    'format=duration:stream=codec_type,duration',
    '-of',
    'json',
    inputPath
  ])

  const parsed = JSON.parse(probeOutput.stdout) as {
    format?: { duration?: string }
    streams?: Array<{ codec_type?: string, duration?: string }>
  }
  const streamDurations = parsed.streams
    ?.map(stream => Number(stream.duration ?? 0))
    .filter(duration => Number.isFinite(duration) && duration > 0) ?? []
  const ffprobeDuration = Math.max(
    Number(parsed.format?.duration ?? 0),
    ...streamDurations
  )
  const durationSeconds = Number.isFinite(ffprobeDuration) && ffprobeDuration > 0
    ? ffprobeDuration
    : await measureDurationWithFfmpeg(inputPath)

  return {
    durationSeconds,
    hasAudio: parsed.streams?.some(stream => stream.codec_type === 'audio') ?? false
  }
}

async function measureDurationWithFfmpeg(inputPath: string) {
  const inspection = await runBinary('ffmpeg', [
    '-hide_banner',
    '-stats',
    '-i',
    inputPath,
    '-f',
    'null',
    '-'
  ])
  const matches = [...inspection.stderr.matchAll(/time=(\d{2}:\d{2}:\d{2}(?:\.\d+)?)/g)]
  const lastTimestamp = matches.at(-1)?.[1]

  return lastTimestamp ? parseTimestampToSeconds(lastTimestamp) : 0
}

function parseTimestampToSeconds(timestamp: string) {
  const [hours, minutes, seconds] = timestamp.split(':')

  return Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds)
}

function buildAtempoFilter(speedFactor: number) {
  const filters: number[] = []
  let remaining = speedFactor

  while (remaining > 2) {
    filters.push(2)
    remaining /= 2
  }

  while (remaining < 0.5) {
    filters.push(0.5)
    remaining /= 0.5
  }

  if (Math.abs(remaining - 1) > 0.000001 || filters.length === 0) {
    filters.push(remaining)
  }

  return filters.map(value => `atempo=${formatFilterNumber(value)}`).join(',')
}

function formatFilterNumber(value: number) {
  return Number(value.toFixed(8)).toString()
}

async function runBinary(command: string, args: string[]) {
  return await new Promise<{ stderr: string, stdout: string }>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe']
    })

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString()
    })

    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString()
    })

    child.on('error', reject)
    child.on('close', exitCode => {
      if (exitCode === 0) {
        resolve({ stderr, stdout })
        return
      }

      reject(new Error(stderr || `Command failed with exit code ${exitCode}.`))
    })
  })
}
