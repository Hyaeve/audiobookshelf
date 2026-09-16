const { expect } = require('chai')
const http = require('http')
const axios = require('axios')
const { HttpProxyAgent } = require('http-proxy-agent')
const { HttpsProxyAgent } = require('https-proxy-agent')
const { createMetadataHttpClient } = require('../../../server/utils/metadataHttpClient')

describe('Metadata HTTP client proxy transport', () => {
  let servers
  let sockets
  let proxyUrl
  let targetUrl
  let received
  let proxied
  let connections

  async function listen(server) {
    servers.push(server)
    server.on('connection', (socket) => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
    })
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    return `http://127.0.0.1:${server.address().port}`
  }

  beforeEach(async () => {
    servers = []
    sockets = new Set()
    received = []
    proxied = []
    connections = []
    targetUrl = await listen(
      http.createServer((request, response) => {
        received.push({ url: request.url, headers: request.headers })
        if (request.url === '/to-proxy') {
          response.writeHead(302, { Location: 'http://provider.invalid/redirected' })
          return response.end()
        }
        response.setHeader('Content-Type', 'application/json')
        response.end(JSON.stringify({ route: 'direct' }))
      })
    )
    const proxy = http.createServer((request, response) => {
      proxied.push({ url: request.url, headers: request.headers })
      if (request.url.endsWith('/to-direct')) {
        response.writeHead(302, { Location: targetUrl + '/final' })
        return response.end()
      }
      if (request.url.endsWith('/failure')) {
        response.writeHead(502)
        return response.end('proxy failed')
      }
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({ route: 'proxy' }))
    })
    proxy.on('connect', (request, socket) => {
      connections.push({ url: request.url, headers: request.headers })
      socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
    })
    proxyUrl = await listen(proxy)
  })

  afterEach(async () => {
    for (const socket of sockets) socket.destroy()
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))))
  })

  it('proxies HTTP targets in absolute form and authenticates only to the proxy', async () => {
    const authenticated = proxyUrl.replace('://', '://reader:secret@')
    const client = createMetadataHttpClient(
      () => authenticated,
      () => ''
    )
    const response = await client.get('http://provider.invalid/search?q=book', { timeout: 2000 })
    expect(response.data.route).to.equal('proxy')
    expect(proxied[0].url).to.equal('http://provider.invalid/search?q=book')
    expect(proxied[0].headers['proxy-authorization']).to.equal('Basic ' + Buffer.from('reader:secret').toString('base64'))
    expect(received).to.have.length(0)
  })

  it('uses CONNECT for HTTPS instead of sending a plaintext absolute HTTPS URL', async () => {
    const client = createMetadataHttpClient(
      () => proxyUrl,
      () => ''
    )
    try {
      await client.get('https://provider.invalid/search', { timeout: 2000 })
      throw new Error('should fail with 407')
    } catch (error) {
      expect(error.response.status).to.equal(407)
    }
    expect(connections[0].url).to.equal('provider.invalid:443')
    expect(proxied).to.have.length(0)
  })

  it('honors NO_PROXY even when explicit proxy credentials are configured', async () => {
    const client = createMetadataHttpClient(
      () => proxyUrl.replace('://', '://reader:secret@'),
      () => '127.0.0.1'
    )
    expect((await client.get(targetUrl, { timeout: 2000 })).data.route).to.equal('direct')
    expect(proxied).to.have.length(0)
    expect(received[0].headers).not.to.have.property('proxy-authorization')
  })

  it('rechecks NO_PROXY after proxy-to-direct redirects without forwarding credentials', async () => {
    const client = createMetadataHttpClient(
      () => proxyUrl.replace('://', '://reader:secret@'),
      () => '127.0.0.1'
    )
    expect((await client.get('http://provider.invalid/to-direct', { timeout: 2000 })).data.route).to.equal('direct')
    expect(proxied).to.have.length(1)
    expect(received).to.have.length(1)
    expect(received[0].headers).not.to.have.property('proxy-authorization')
  })

  it('rechecks routing after direct-to-proxy redirects', async () => {
    const client = createMetadataHttpClient(
      () => proxyUrl,
      () => '127.0.0.1'
    )
    expect((await client.get(targetUrl + '/to-proxy', { timeout: 2000 })).data.route).to.equal('proxy')
    expect(received).to.have.length(1)
    expect(proxied[0].url).to.equal('http://provider.invalid/redirected')
  })

  it('applies saved proxy changes to the next request without changing global Axios', async () => {
    let configuredUrl = proxyUrl
    const before = { proxy: axios.defaults.proxy, httpAgent: axios.defaults.httpAgent, httpsAgent: axios.defaults.httpsAgent }
    const client = createMetadataHttpClient(
      () => configuredUrl,
      () => ''
    )
    expect((await client.get(targetUrl, { timeout: 2000 })).data.route).to.equal('proxy')
    configuredUrl = ''
    expect((await client.get(targetUrl, { proxy: false, timeout: 2000 })).data.route).to.equal('direct')
    expect({ proxy: axios.defaults.proxy, httpAgent: axios.defaults.httpAgent, httpsAgent: axios.defaults.httpsAgent }).to.deep.equal(before)
  })

  it('accepts HTTPS proxy endpoints with TLS verification enabled', async () => {
    const client = createMetadataHttpClient(
      () => 'https://reader:secret@proxy.invalid:8443',
      () => ''
    )
    let captured
    await client.get('https://provider.invalid/', {
      adapter: async (config) => {
        captured = config
        return { status: 200, data: {}, headers: {}, config }
      }
    })
    expect(captured.proxy).to.equal(false)
    expect(captured.httpAgent).to.be.instanceOf(HttpProxyAgent)
    expect(captured.httpsAgent).to.be.instanceOf(HttpsProxyAgent)
    expect(captured.httpsAgent.proxy.protocol).to.equal('https:')
    expect(captured.httpsAgent.connectOpts.rejectUnauthorized).not.to.equal(false)
  })

  it('does not expose proxy URL, authentication or raw Axios config on errors', async () => {
    const client = createMetadataHttpClient(
      () => proxyUrl.replace('://', '://reader:secret@'),
      () => ''
    )
    try {
      await client.get('http://provider.invalid/failure', { timeout: 2000 })
      throw new Error('should fail')
    } catch (error) {
      expect(error.response.status).to.equal(502)
      expect(error.config).to.equal(undefined)
      expect(error.request).to.equal(undefined)
      expect(require('util').inspect(error, { depth: 10 })).not.to.include('secret')
    }
  })

  it('preserves numeric retry-after for provider throttling', async () => {
    const client = createMetadataHttpClient(
      () => proxyUrl,
      () => ''
    )
    try {
      await client.get('https://provider.invalid/', {
        adapter: async (config) => {
          const error = new Error('contains a sensitive proxy password')
          error.config = config
          error.response = { status: 429, headers: { 'retry-after': '12', 'proxy-authenticate': 'secret' } }
          throw error
        }
      })
      throw new Error('should fail')
    } catch (error) {
      expect(error.response).to.deep.equal({ status: 429, headers: { 'retry-after': '12' } })
      expect(error.message).not.to.include('password')
    }
  })
})
