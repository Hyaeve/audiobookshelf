const Path = require('path')
const NativeFs = require('fs')
const Net = require('net')
const FsPromises = NativeFs.promises
const axios = require('axios')
const ssrfFilter = require('ssrf-req-filter')
const fs = require('../libs/fsExtra')
const Logger = require('../Logger')
const prober = require('./prober')
const { filePathToPOSIX, isSameOrSubPath, getAudioMimeTypeFromExtname } = require('./fileUtils')

const STRM_PREFETCH_SIZE = 10
const STRM_PREFETCH_MAX_BYTES = 512 * 1024 * 1024
const strmUrlCache = new Map()

function isPrivateStrmHost(targetUrl) {
  let hostname
  try {
    hostname = new URL(targetUrl).hostname
  } catch (error) {
    return false
  }

  const ipVersion = Net.isIP(hostname)
  if (ipVersion === 4) {
    const octets = hostname.split('.').map(Number)
    return octets[0] === 10
      || octets[0] === 127
      || (octets[0] === 169 && octets[1] === 254)
      || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
      || (octets[0] === 192 && octets[1] === 168)
  }

  if (ipVersion === 6) {
    const normalized = hostname.toLowerCase()
    return normalized === '::1'
      || normalized.startsWith('fc')
      || normalized.startsWith('fd')
      || normalized.startsWith('fe8')
      || normalized.startsWith('fe9')
      || normalized.startsWith('fea')
      || normalized.startsWith('feb')
  }

  return false
}

function shouldBypassStrmSsrfFilter(targetUrl) {
  return Boolean(global.DisableSsrfRequestFilter?.(targetUrl)) || isPrivateStrmHost(targetUrl)
}

function isStrmPath(filePath) {
  return Path.extname(filePath || '').toLowerCase() === '.strm'
}

async function resolveStrmTarget(filePath, allowedLocalRoots = []) {
  if (!isStrmPath(filePath)) return null

  const fileStat = await fs.stat(filePath)
  // `/NetDisk` is the standard container mount point for local STRM targets.
  // It is still checked with stat() and the target must remain inside this root.
  const effectiveLocalRoots = [...new Set([...allowedLocalRoots, '/NetDisk'])]
  const cacheKey = `${filePath}|${fileStat.mtimeMs}|${effectiveLocalRoots.join('|')}`
  let cached = strmUrlCache.get(cacheKey)
  if (!cached) {
    cached = fs.readFile(filePath, 'utf8').then(async (contents) => {
      const target = contents.trim()
      if (!target) throw new Error('STRM file is empty')

      try {
        const url = new URL(target)
        if (url.protocol === 'http:' || url.protocol === 'https:') return { type: 'remote', value: url.toString() }
        throw new Error(`Unsupported STRM URL protocol "${url.protocol}"`)
      } catch (error) {
        if (/^[a-z][a-z\d+.-]*:/i.test(target) && !Path.win32.isAbsolute(target)) throw error
      }

      const isAbsoluteLocalPath = Path.isAbsolute(target) || Path.posix.isAbsolute(target) || Path.win32.isAbsolute(target)
      const localPath = isAbsoluteLocalPath ? target : Path.resolve(Path.dirname(filePath), target)
      const normalizedPath = filePathToPOSIX(Path.normalize(localPath))
      const normalizedRoots = effectiveLocalRoots.map((root) => filePathToPOSIX(Path.normalize(root)))
      if (!normalizedRoots.some((root) => isSameOrSubPath(root, normalizedPath))) {
        throw new Error(`Local STRM target is outside configured library folders: "${normalizedPath}"`)
      }
      const stat = await fs.stat(normalizedPath)
      if (!stat.isFile()) throw new Error('STRM target is not a file')
      return { type: 'local', value: normalizedPath }
    }).catch((error) => {
      strmUrlCache.delete(cacheKey)
      throw error
    })
    strmUrlCache.set(cacheKey, cached)
  }
  return cached
}

async function resolveStrmUrl(filePath, allowedLocalRoots = []) {
  const target = await resolveStrmTarget(filePath, allowedLocalRoots)
  return target?.type === 'remote' ? target.value : target?.value || null
}

function copyRemoteHeaders(remoteHeaders, res) {
  const headersToCopy = ['accept-ranges', 'cache-control', 'content-disposition', 'content-length', 'content-range', 'content-type', 'etag', 'last-modified']
  for (const header of headersToCopy) {
    if (remoteHeaders[header] !== undefined) res.setHeader(header, remoteHeaders[header])
  }
}

function getRange(rangeHeader, size) {
  if (!rangeHeader) return null
  const match = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader)
  if (!match) return null
  let start = match[1] ? Number.parseInt(match[1], 10) : Math.max(0, size - Number.parseInt(match[2], 10))
  let end = match[2] ? Number.parseInt(match[2], 10) : size - 1
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return 'invalid'
  end = Math.min(end, size - 1)
  return { start, end }
}

async function createRemoteEntry(target, filePath) {
  const disableSsrfFilter = shouldBypassStrmSsrfFilter(target.value)
  const response = await axios({
    url: target.value,
    method: 'GET',
    responseType: 'arraybuffer',
    timeout: 30000,
    maxRedirects: 5,
    maxContentLength: STRM_PREFETCH_MAX_BYTES,
    maxBodyLength: STRM_PREFETCH_MAX_BYTES,
    validateStatus: () => true,
    httpAgent: disableSsrfFilter ? null : ssrfFilter(target.value),
    httpsAgent: disableSsrfFilter ? null : ssrfFilter(target.value)
  })
  const body = Buffer.from(response.data)
  if (body.length > STRM_PREFETCH_MAX_BYTES) throw new Error(`Remote STRM target exceeds ${STRM_PREFETCH_MAX_BYTES} bytes`)
  const entry = { type: 'remote', filePath, target: target.value, body, status: response.status, headers: response.headers, duration: 0 }
  entry.duration = await probeDuration(entry)
  return entry
}

async function probeDuration(entry) {
  try {
    const result = entry.type === 'remote'
      ? await prober.probeBuffer(entry.body)
      : await prober.probe(entry.target)
    const duration = Number(result?.duration)
    return Number.isFinite(duration) && duration > 0 ? duration : 0
  } catch (error) {
    Logger.warn(`[strmUtils] Failed to probe STRM target duration "${entry.target}": ${error.message}`)
    return 0
  }
}

async function createLocalEntry(target, filePath) {
  const handle = await FsPromises.open(target.value, 'r')
  const stat = await handle.stat()
  const entry = { type: 'local', filePath, target: target.value, handle, stat, duration: 0 }
  entry.duration = await probeDuration(entry)
  return entry
}

async function probeStrmTargetMedia(filePath, allowedLocalRoots = []) {
  const target = await resolveStrmTarget(filePath, allowedLocalRoots)
  if (!target) return null

  if (target.type === 'local') {
    return prober.probe(target.value)
  }

  const disableSsrfFilter = shouldBypassStrmSsrfFilter(target.value)
  const response = await axios({
    url: target.value,
    method: 'GET',
    responseType: 'arraybuffer',
    timeout: 30000,
    maxRedirects: 5,
    maxContentLength: STRM_PREFETCH_MAX_BYTES,
    maxBodyLength: STRM_PREFETCH_MAX_BYTES,
    validateStatus: () => true,
    httpAgent: disableSsrfFilter ? null : ssrfFilter(target.value),
    httpsAgent: disableSsrfFilter ? null : ssrfFilter(target.value)
  })
  const body = Buffer.from(response.data)
  if (body.length > STRM_PREFETCH_MAX_BYTES) throw new Error(`Remote STRM target exceeds ${STRM_PREFETCH_MAX_BYTES} bytes`)
  return prober.probeBuffer(body)
}

async function createStrmPlaybackWindow(filePaths, startIndex, allowedLocalRoots = []) {
  const window = { entries: new Map(), closed: false }
  const paths = filePaths.slice(startIndex, startIndex + STRM_PREFETCH_SIZE).filter(isStrmPath)
  await Promise.all(paths.map(async (filePath) => {
    try {
      const target = await resolveStrmTarget(filePath, allowedLocalRoots)
      const entry = target.type === 'remote'
        ? await createRemoteEntry(target, filePath)
        : await createLocalEntry(target, filePath)
      window.entries.set(filePath, entry)
    } catch (error) {
      Logger.warn(`[strmUtils] Failed to prefetch STRM file "${filePath}": ${error.message}`)
    }
  }))
  return window
}

async function closeStrmPlaybackWindow(window) {
  if (!window || window.closed) return
  window.closed = true
  await Promise.all([...window.entries.values()].map(async (entry) => {
    if (entry.type === 'local' && entry.handle) await entry.handle.close().catch(() => {})
    if (entry.type === 'remote') entry.body = null
  }))
  window.entries.clear()
}

function getTargetExtension(target) {
  try {
    return Path.extname(new URL(target).pathname)
  } catch (error) {
    return Path.extname(target || '')
  }
}

async function serveStrmPlaybackWindowEntry(entry, req, res) {
  const size = entry.type === 'remote' ? entry.body.length : entry.stat.size
  const mimeType = getAudioMimeTypeFromExtname(getTargetExtension(entry.target))
  if (mimeType) res.setHeader('Content-Type', mimeType)
  res.setHeader('Accept-Ranges', 'bytes')
  const range = getRange(req.headers.range, size)
  if (range === 'invalid') return res.status(416).setHeader('Content-Range', `bytes */${size}`).send()
  const start = range?.start || 0
  const end = range?.end ?? size - 1
  const length = end - start + 1
  res.status(range ? 206 : 200)
  res.setHeader('Content-Length', length)
  if (range) res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`)

  if (entry.type === 'remote') return res.end(entry.body.subarray(start, end + 1))
  const stream = entry.handle.createReadStream({ start, end, autoClose: false })
  stream.on('error', (error) => {
    if (!res.headersSent) res.sendStatus(502)
    else res.destroy(error)
  })
  stream.pipe(res)
}

async function prefetchStrmUrls(filePaths, startIndex, allowedLocalRoots = []) {
  return createStrmPlaybackWindow(filePaths, startIndex, allowedLocalRoots)
}

async function proxyStrm(req, res, filePath, allowedLocalRoots = []) {
  let target
  try {
    target = await resolveStrmTarget(filePath, allowedLocalRoots)
  } catch (error) {
    Logger.error(`[strmUtils] Invalid STRM file "${filePath}": ${error.message}`)
    return res.status(400).send('Invalid STRM file')
  }

  if (target.type === 'local') {
    const audioMimeType = getAudioMimeTypeFromExtname(Path.extname(target.value))
    if (audioMimeType) res.setHeader('Content-Type', audioMimeType)
    return res.sendFile(target.value)
  }

  const headers = { 'User-Agent': req.get?.('user-agent') || 'audiobookshelf (+https://audiobookshelf.org)' }
  if (req.headers.range) headers.Range = req.headers.range
  if (req.headers['if-range']) headers['If-Range'] = req.headers['if-range']
  try {
    const disableSsrfFilter = shouldBypassStrmSsrfFilter(target.value)
    const response = await axios({ url: target.value, method: 'GET', responseType: 'stream', headers, timeout: 30000, maxRedirects: 5, validateStatus: () => true, httpAgent: disableSsrfFilter ? null : ssrfFilter(target.value), httpsAgent: disableSsrfFilter ? null : ssrfFilter(target.value) })
    copyRemoteHeaders(response.headers, res)
    if (!response.headers['content-type'] || response.headers['content-type'] === 'application/octet-stream') {
      const mimeType = getAudioMimeTypeFromExtname(getTargetExtension(target.value))
      if (mimeType) res.setHeader('Content-Type', mimeType)
    }
    res.status(response.status)
    response.data.on('error', (error) => res.headersSent ? res.destroy(error) : res.sendStatus(502))
    req.on('close', () => response.data.destroy())
    response.data.pipe(res)
  } catch (error) {
    Logger.error(`[strmUtils] Failed to request remote media for "${filePath}": ${error.message}`)
    if (!res.headersSent) return res.sendStatus(502)
    res.destroy(error)
  }
}

module.exports = { STRM_PREFETCH_SIZE, isStrmPath, isPrivateStrmHost, resolveStrmUrl, resolveStrmTarget, probeStrmTargetMedia, prefetchStrmUrls, createStrmPlaybackWindow, closeStrmPlaybackWindow, serveStrmPlaybackWindowEntry, proxyStrm }
