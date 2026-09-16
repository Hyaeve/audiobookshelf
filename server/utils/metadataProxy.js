function normalizeProxyUrl(value) {
  if (value === null || value === '') return null
  if (typeof value !== 'string' || value.length > 2048) throw new Error('代理地址必须是有效的 HTTP/HTTPS 地址')
  const trimmed = value.trim()
  if (!trimmed) return null
  try {
    if (!/^https?:\/\//i.test(trimmed)) throw new Error()
    const url = new URL(trimmed)
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.pathname !== '/' || url.search || url.hash) throw new Error()
    decodeURIComponent(url.username)
    decodeURIComponent(url.password)
    return url.href
  } catch {
    throw new Error('代理地址格式错误，请使用 http://主机:端口 或 https://主机:端口，不要填写路径、查询参数或片段')
  }
}

function shouldBypassProxy(target, noProxy = '') {
  const url = target instanceof URL ? target : new URL(target)
  const hostname = url.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
  const port = url.port || (url.protocol === 'https:' ? '443' : '80')
  return String(noProxy)
    .toLowerCase()
    .split(/[,\s]+/)
    .filter(Boolean)
    .some((entry) => {
      if (entry === '*') return true
      let entryHost = entry
      let entryPort = ''
      const withPort = entry.match(/^\[([^\]]+)\](?::(\d+))?$/) || entry.match(/^([^:]+):(\d+)$/)
      if (withPort) {
        entryHost = withPort[1]
        entryPort = withPort[2] || ''
      }
      if (entryPort && entryPort !== port) return false
      entryHost = entryHost.replace(/\.$/, '')
      if (entryHost.startsWith('*.')) entryHost = entryHost.slice(1)
      if (entryHost.startsWith('.')) return hostname.endsWith(entryHost)
      return hostname === entryHost
    })
}

module.exports = { normalizeProxyUrl, shouldBypassProxy }
