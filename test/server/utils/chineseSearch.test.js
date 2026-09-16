const { expect } = require('chai')
const { normalizeFields, extractFields, buildPayload, matchesPayload } = require('../../../server/utils/chineseSearch')

describe('Chinese search matching', () => {
  const payload = buildPayload({
    title: ['重返五零之传奇人生｜重生1950｜四合院｜都市穿越｜工业爽文'],
    subtitle: ['王凯'],
    authors: ['王奎荣'],
    narrators: ['单田芳']
  })
  for (const query of ['cfwlzcqrs', 'cfwl', 'dscy', 'chongfanwuling', 'chongfwl', '重返wl', '都shi穿yue', 'ＣＦＷＬ', 'chóng fǎn', '重生1950', '1950', '都市穿越']) {
    it(`matches ${query}`, () => expect(matchesPayload(payload, ['title'], query)).to.equal(true))
  }
  it('supports mixed pinyin in names', () => {
    expect(matchesPayload(payload, ['subtitle'], 'wangk')).to.equal(true)
    expect(matchesPayload(payload, ['authors'], 'wangk')).to.equal(true)
    expect(matchesPayload(payload, ['narrators'], 'shantf')).to.equal(true)
  })
  it('does not join fields, names or pipe-delimited segments', () => {
    expect(matchesPayload(payload, ['title', 'authors'], 'swwang')).to.equal(false)
    expect(matchesPayload(payload, ['title'], 'rszs')).to.equal(false)
    expect(matchesPayload(buildPayload({ authors: ['王凯', '王奎荣'] }), ['authors'], 'kaiwang')).to.equal(false)
  })
  it('does not invent g/k substitutions', () => {
    const sample = buildPayload({ title: ['望古神话之天选者'] })
    expect(matchesPayload(sample, ['title'], 'wangg')).to.equal(true)
    expect(matchesPayload(sample, ['title'], 'wangk')).to.equal(false)
  })
  it('ignores empty, oversized queries and unselected fields', () => {
    for (const query of ['', '|||', 'a'.repeat(129), 'notfound']) expect(matchesPayload(payload, ['title'], query)).to.equal(false)
    expect(matchesPayload(payload, [], 'cfwl')).to.equal(false)
    expect(matchesPayload(payload, ['title'], 'wangk')).to.equal(false)
    expect(normalizeFields()).to.deep.equal([])
    expect(normalizeFields(['authors', 'title', 'title', 'description'])).to.deep.equal(['title', 'authors'])
  })
  it('reads selected metadata without changing the original', () => {
    const item = { media: { title: '书名', authors: [{ name: '王凯' }], narrators: ['单田芳'] } }
    const original = JSON.stringify(item)
    expect(extractFields(item, ['authors', 'narrators'])).to.deep.equal({ authors: ['王凯'], narrators: ['单田芳'] })
    expect(JSON.stringify(item)).to.equal(original)
  })
})
