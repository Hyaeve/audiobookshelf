const chai = require('chai')
const expect = chai.expect
const { BOOK_METADATA_FIELD_KEYS, normalizeBookMetadataFields, isValidBookMetadataFields, getBookMetadataFieldLabels } = require('../../../server/utils/bookMetadataFields')
const Scanner = require('../../../server/scanner/Scanner')

describe('bookMetadataFields', () => {
  it('returns every field when the stored value is not an array', () => {
    expect(normalizeBookMetadataFields(undefined)).to.deep.equal(BOOK_METADATA_FIELD_KEYS)
    expect(normalizeBookMetadataFields(null)).to.deep.equal(BOOK_METADATA_FIELD_KEYS)
    expect(normalizeBookMetadataFields('title')).to.deep.equal(BOOK_METADATA_FIELD_KEYS)
  })

  it('drops unknown keys, de-duplicates and keeps the canonical order', () => {
    expect(normalizeBookMetadataFields(['coverPath', 'title', 'title', 'nope'])).to.deep.equal(['title', 'coverPath'])
    expect(normalizeBookMetadataFields([])).to.deep.equal([])
  })

  it('validates field arrays', () => {
    expect(isValidBookMetadataFields(['title', 'coverPath'])).to.equal(true)
    expect(isValidBookMetadataFields([])).to.equal(true)
    expect(isValidBookMetadataFields(['title', 'nope'])).to.equal(false)
    expect(isValidBookMetadataFields('title')).to.equal(false)
  })

  it('maps field keys to Chinese labels', () => {
    expect(getBookMetadataFieldLabels(['title', 'coverPath'])).to.deep.equal(['\u6807\u9898', '\u5c01\u9762'])
    expect(getBookMetadataFieldLabels(['unknown'])).to.deep.equal(['unknown'])
  })
})

describe('Scanner metadata field gating', () => {
  it('allows every field when allowedFields is not an array', () => {
    expect(Scanner.isFieldAllowed({}, 'title')).to.equal(true)
    expect(Scanner.isFieldAllowed({ allowedFields: null }, 'title')).to.equal(true)
  })

  it('limits writable fields to allowedFields', () => {
    expect(Scanner.isFieldAllowed({ allowedFields: ['title'] }, 'title')).to.equal(true)
    expect(Scanner.isFieldAllowed({ allowedFields: ['title'] }, 'coverPath')).to.equal(false)
    expect(Scanner.isFieldAllowed({ allowedFields: [] }, 'title')).to.equal(false)
  })

  it('never overrides without overrideDetails', () => {
    expect(Scanner.canOverrideField({}, 'title')).to.equal(false)
    expect(Scanner.canOverrideField({ overrideFields: ['title'] }, 'title')).to.equal(false)
  })

  it('limits overridable fields to overrideFields', () => {
    expect(Scanner.canOverrideField({ overrideDetails: true }, 'title')).to.equal(true)
    expect(Scanner.canOverrideField({ overrideDetails: true, overrideFields: ['title'] }, 'title')).to.equal(true)
    expect(Scanner.canOverrideField({ overrideDetails: true, overrideFields: ['title'] }, 'genres')).to.equal(false)
  })
})
