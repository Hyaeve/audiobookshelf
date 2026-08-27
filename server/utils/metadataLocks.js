const METADATA_LOCK_FIELDS = [
  'title',
  'subtitle',
  'description',
  'authors',
  'narrators',
  'series',
  'publishedYear',
  'publisher',
  'language',
  'isbn',
  'asin',
  'genres',
  'tags',
  'coverPath'
]

const METADATA_LOCK_FIELD_SET = new Set(METADATA_LOCK_FIELDS)

function normalizeMetadataLocks(value) {
  const fields = Array.isArray(value?.fields) ? [...new Set(value.fields.filter((field) => METADATA_LOCK_FIELD_SET.has(field)))] : []
  return {
    all: value?.all === true,
    fields
  }
}

function getMetadataLocks(libraryItem) {
  return normalizeMetadataLocks(libraryItem?.extraData?.metadataLocks)
}

function isMetadataFieldLocked(libraryItem, field) {
  const locks = getMetadataLocks(libraryItem)
  return locks.all || locks.fields.includes(field)
}

function setMetadataLocks(libraryItem, value) {
  const locks = normalizeMetadataLocks(value)
  libraryItem.extraData = {
    ...(libraryItem.extraData || {}),
    metadataLocks: locks
  }
  libraryItem.changed('extraData', true)
  return locks
}

module.exports = {
  METADATA_LOCK_FIELDS,
  normalizeMetadataLocks,
  getMetadataLocks,
  isMetadataFieldLocked,
  setMetadataLocks
}
