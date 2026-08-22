const Path = require('path')
const NativeFs = require('fs')
const FsPromises = NativeFs.promises
const axios = require('axios')
const ssrfFilter = require('ssrf-req-filter')
const fs = require('../libs/fsExtra')
const Logger = require('../Logger')
const { filePathToPOSIX, isSameOrSubPath, getAudioMimeTypeFromExtname } = require('./fileUtils')

const STRM_PREFETCH_SIZE = 10
const STRM_PREFETCH_MAX_BYTES = 512 * 1024 * 1024
const strmUrlCache = new Map()

function isStrmPath(filePath) {
  return Path.extname(filePath || '').toLowerCase() === '.strm'
}

async function resolveStrmTarget(filePath, allowedLocalRoots = []) {
  if (!isStrmPath(filePath)) return null

  const fileStat = await fs.stat(filePath)
  const configuredLocalRoots = (process.env.STRM_LOCAL_ROOTS || '')
    .split(',')
    .map((root) => root.trim())
    .filter(Boolean)
  const effectiveLocalRoots = [...new Set([...allowedLocalRoots, ...configuredLocalRoots])]
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
  const disableSsrfFilter = global.DisableSsrfRequestFilter?.(target.value)
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
  return { type: 'remote', filePath, target: target.value, body, status: response.status, headers: response.headers }
}

async function createLocalEntry(target, filePath) {
  const handle = await FsPromises.open(target.value, 'r')
  const stat = await handle.stat()
  return { type: 'local', filePath, target: target.value, handle, stat }
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

async function serveStrmPlaybackWindowEntry(entry, req, res) {
  const size = entry.type === 'remote' ? entry.body.length : entry.stat.size
  const mimeType = getAudioMimeTypeFromExtname(Path.extname(entry.target))
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
    const disableSsrfFilter = global.DisableSsrfRequestFilter?.(target.value)
    const response = await axios({ url: target.value, method: 'GET', responseType: 'stream', headers, timeout: 30000, maxRedirects: 5, validateStatus: () => true, httpAgent: disableSsrfFilter ? null : ssrfFilter(target.value), httpsAgent: disableSsrfFilter ? null : ssrfFilter(target.value) })
    copyRemoteHeaders(response.headers, res)
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

module.exports = { STRM_PREFETCH_SIZE, isStrmPath, resolveStrmUrl, resolveStrmTarget, prefetchStrmUrls, createStrmPlaybackWindow, closeStrmPlaybackWindow, serveStrmPlaybackWindowEntry, proxyStrm }
