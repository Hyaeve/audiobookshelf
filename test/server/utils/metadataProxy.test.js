const { expect } = require('chai')
const { normalizeProxyUrl, shouldBypassProxy } = require('../../../server/utils/metadataProxy')

describe('Metadata proxy configuration', () => {
  it('accepts HTTP/HTTPS proxies, credentials, IPv6 and clearing', () => {
    expect(normalizeProxyUrl(' http://10.0.0.200:7893 ')).to.equal('http://10.0.0.200:7893/')
    expect(normalizeProxyUrl('https://proxy.example:8443')).to.equal('https://proxy.example:8443/')
    expect(normalizeProxyUrl('http://user:p%40ss@[::1]:7890')).to.equal('http://user:p%40ss@[::1]:7890/')
    for (const value of ['', '   ', null]) expect(normalizeProxyUrl(value)).to.equal(null)
  })

  for (const value of [42, {}, [], 'proxy.example:7890', 'http:proxy.example', 'socks5://localhost:1080', 'file:///tmp/a', 'http://localhost:99999', 'http://localhost/path', 'http://localhost?token=x', 'http://localhost#x', 'http://user:%ZZ@localhost', 'a'.repeat(2049)]) {
    it(`rejects invalid proxy input ${JSON.stringify(value).slice(0, 70)}`, () => expect(() => normalizeProxyUrl(value)).to.throw())
  }

  for (const [target, excluded, expected] of [
    ['http://127.0.0.1:9000', '172.17.0.1,127.0.0.1,localhost', true],
    ['https://example.com', 'localhost', false],
    ['https://example.com', '*', true],
    ['https://EXAMPLE.com', 'example.com', true],
    ['https://notexample.com', '.example.com', false],
    ['https://api.example.com', '.example.com', true],
    ['https://api.example.com', '*.example.com', true],
    ['https://example.com', '*.example.com', false],
    ['https://example.com', 'example.com:443', true],
    ['http://example.com', 'example.com:443', false],
    ['http://[::1]:7890', '::1', true],
    ['http://[::1]:7890', '[::1]:7890', true],
    ['http://[::1]:7891', '[::1]:7890', false],
    ['http://localhost.', 'localhost', true]
  ]) {
    it(`matches NO_PROXY ${excluded} against ${target}`, () => expect(shouldBypassProxy(target, excluded)).to.equal(expected))
  }
})
