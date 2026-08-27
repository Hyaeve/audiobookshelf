const chai = require('chai')
const expect = chai.expect
const { METADATA_LOCK_FIELDS, normalizeMetadataLocks, getMetadataLocks, isMetadataFieldLocked, setMetadataLocks } = require('../../../server/utils/metadataLocks')

describe('metadataLocks', () => {
  it('normalizes total and field locks', () => {
    expect(normalizeMetadataLocks({ all: true, fields: ['title', 'title', 'genres', 'unknown'] })).to.deep.equal({
      all: true,
      fields: ['title', 'genres']
    })
    expect(normalizeMetadataLocks(null)).to.deep.equal({ all: false, fields: [] })
  })

  it('reads total and individual field locks', () => {
    const item = { extraData: { metadataLocks: { all: false, fields: ['publisher'] } } }
    expect(getMetadataLocks(item)).to.deep.equal({ all: false, fields: ['publisher'] })
    expect(isMetadataFieldLocked(item, 'publisher')).to.equal(true)
    expect(isMetadataFieldLocked(item, 'genres')).to.equal(false)
    item.extraData.metadataLocks.all = true
    expect(isMetadataFieldLocked(item, 'genres')).to.equal(true)
  })

  it('persists normalized locks without replacing other extra data', () => {
    const changedFields = []
    const item = {
      extraData: { aiBookMatch: { status: 'unmatched' } },
      changed(field, value) {
        changedFields.push([field, value])
      }
    }
    const locks = setMetadataLocks(item, { all: false, fields: ['isbn', 'invalid'] })
    expect(locks).to.deep.equal({ all: false, fields: ['isbn'] })
    expect(item.extraData.aiBookMatch.status).to.equal('unmatched')
    expect(item.extraData.metadataLocks).to.deep.equal(locks)
    expect(changedFields).to.deep.equal([['extraData', true]])
    expect(METADATA_LOCK_FIELDS).to.include('coverPath')
  })
})
