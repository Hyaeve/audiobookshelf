const axios = require('axios')
const http = require('http')
const https = require('https')
const { HttpProxyAgent } = require('http-proxy-agent')
const { HttpsProxyAgent } = require('https-proxy-agent')
const { normalizeProxyUrl, shouldBypassProxy } = require('./metadataProxy')

function createMetadataHttpClient(getProxyUrl = () => require('../Database').serverSettings?.metadataProxyUrl, getNoProxy = () => process.env.no_proxy || process.env.NO_PROXY || '') {
  const client = axios.create()
  const directAgents = { http: new http.Agent(), https: new https.Agent() }
  let cachedUrl = null
  let cachedAgents = null

  client.interceptors.request.use((config) => {
    const proxyUrl = normalizeProxyUrl(getProxyUrl() || null)
    if (!proxyUrl) {
      cachedUrl = null
      cachedAgents = null
      return config
    }
    const target = new URL(config.url, config.baseURL)
    if (!['http:', 'https:'].includes(target.protocol)) throw new Error('元数据提供商仅支持 HTTP/HTTPS 请求')
    if (cachedUrl !== proxyUrl) {
      cachedUrl = proxyUrl
      cachedAgents = { http: new HttpProxyAgent(proxyUrl), https: new HttpsProxyAgent(proxyUrl) }
    }
    const proxyAgents = cachedAgents
    const noProxy = getNoProxy()
    const agentsFor = (url) => (shouldBypassProxy(url, noProxy) ? directAgents : proxyAgents)
    const agents = agentsFor(target)
    config.proxy = false
    config.httpAgent = agents.http
    config.httpsAgent = agents.https
    config.metadataProxyActive = true
    const beforeRedirect = config.beforeRedirect
    config.beforeRedirect = (options, responseDetails, requestDetails) => {
      if (beforeRedirect) beforeRedirect(options, responseDetails, requestDetails)
      const redirectedUrl = new URL(options.href || `${options.protocol}//${options.hostname}${options.port ? ':' + options.port : ''}${options.path}`)
      if (!['http:', 'https:'].includes(redirectedUrl.protocol)) throw new Error('不支持的元数据重定向协议')
      const redirectedAgents = agentsFor(redirectedUrl)
      options.agents = redirectedAgents
      options.agent = redirectedUrl.protocol === 'https:' ? redirectedAgents.https : redirectedAgents.http
      for (const header of Object.keys(options.headers || {})) {
        if (header.toLowerCase() === 'proxy-authorization') delete options.headers[header]
      }
    }
    return config
  })

  client.interceptors.response.use(
    (response) => response,
    (error) => {
      if (!error.config?.metadataProxyActive) return Promise.reject(error)
      const status = Number(error.response?.status) || null
      const safeError = new Error(status ? `元数据提供商请求失败（HTTP ${status}）` : '元数据提供商请求失败，请检查代理连接、证书及超时设置')
      safeError.code = error.code
      if (error.__CANCEL__) safeError.__CANCEL__ = true
      if (status) {
        safeError.response = { status, headers: {} }
        const retryAfter = error.response.headers?.['retry-after']
        if (/^\d+$/.test(String(retryAfter || ''))) safeError.response.headers['retry-after'] = String(retryAfter)
      }
      return Promise.reject(safeError)
    }
  )
  return client
}

module.exports = createMetadataHttpClient()
module.exports.createMetadataHttpClient = createMetadataHttpClient
