const Path = require('path')
const Net = require('net')
const axios = require('axios')
const ssrfFilter = require('ssrf-req-filter')
const fs = require('../libs/fsExtra')
const Logger = require('../Logger')
const prober = require('./prober')
const { filePathToPOSIX, isSameOrSubPath, getAudioMimeTypeFromExtname } = require('./fileUtils')

const STRM_SCAN_MAX_BYTES = 512 * 1024 * 1024
const AUDIOBOOKSHELF_USER_AGENT = 'AudioBookShelf'

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

// The pointer contents are re-read on every call instead of being cached behind
// the `.strm` file mtime. Filesystem mtime resolution is coarse (two writes
// inside the same tick report an identical mtimeMs), so an mtime keyed cache can
// serve a stale target after the pointer was rewritten and, because the library
// root check lived inside the cached callback, skip that check entirely.
// Reading the few bytes of a pointer file is cheap enough to do every time and
// guarantees the target validation below always runs.
async function resolveStrmTarget(filePath, allowedLocalRoots = []) {
  if (!isStrmPath(filePath)) return null

  await fs.stat(filePath)
  // `/NetDisk` is the standard container mount point for local STRM targets.
  // It is still checked with stat() and the target must remain inside this root.
  const effectiveLocalRoots = [...new Set([...allowedLocalRoots, '/NetDisk'])]
  const contents = await fs.readFile(filePath, 'utf8')
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

async function requestRemoteMedia(targetUrl) {
  const disableSsrfFilter = shouldBypassStrmSsrfFilter(targetUrl)
  const response = await axios({
    url: targetUrl,
    method: 'GET',
    responseType: 'arraybuffer',
    timeout: 120000,
    maxRedirects: 5,
    maxContentLength: STRM_SCAN_MAX_BYTES,
    maxBodyLength: STRM_SCAN_MAX_BYTES,
    validateStatus: () => true,
    httpAgent: disableSsrfFilter ? null : ssrfFilter(targetUrl),
    httpsAgent: disableSsrfFilter ? null : ssrfFilter(targetUrl)
  })
  const body = Buffer.from(response.data)
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Remote STRM target returned HTTP ${response.status}`)
  }
  if (!body.length) throw new Error('Remote STRM target returned an empty response')
  if (body.length > STRM_SCAN_MAX_BYTES) throw new Error(`Remote STRM target exceeds ${STRM_SCAN_MAX_BYTES} bytes`)
  return { body, status: response.status, headers: response.headers }
}

async function probeStrmTargetMedia(filePath, allowedLocalRoots = []) {
  const target = await resolveStrmTarget(filePath, allowedLocalRoots)
  if (!target) return null

  if (target.type === 'local') {
    return prober.probe(target.value)
  }

  // Let ffprobe open the remote URL directly. Downloading the whole remote file
  // into a buffer is unreliable for large cloud-drive audio files and can cause
  // ffprobe stdin EPIPE before metadata has been parsed.
  const probeData = await prober.probe(target.value, false, { userAgent: AUDIOBOOKSHELF_USER_AGENT })
  if (probeData?.error) {
    throw new Error(`Unable to probe remote STRM media at "${target.value}": ${probeData.error}`)
  }
  return probeData
}

function getClientUserAgent(req) {
  return req.get?.('user-agent') || req.headers?.['user-agent'] || AUDIOBOOKSHELF_USER_AGENT
}

function getTargetExtension(target) {
  try {
    return Path.extname(new URL(target).pathname)
  } catch (error) {
    return Path.extname(target || '')
  }
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

  const headers = { 'User-Agent': getClientUserAgent(req) }
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

module.exports = { AUDIOBOOKSHELF_USER_AGENT, isStrmPath, isPrivateStrmHost, resolveStrmUrl, resolveStrmTarget, probeStrmTargetMedia, getClientUserAgent, proxyStrm }
