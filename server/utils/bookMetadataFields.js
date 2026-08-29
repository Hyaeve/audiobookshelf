/**
 * Shared book metadata field definitions used by the local scheduled tasks.
 * "书籍匹配" uses them to decide which fields may be overwritten and
 * "补全元数据" uses them to decide which fields may be filled at all.
 */

const BOOK_METADATA_FIELD_LABELS = {
  title: '标题',
  subtitle: '副标题',
  description: '简介',
  authors: '作者',
  narrators: '演播者',
  series: '系列',
  genres: '流派',
  tags: '标签',
  publisher: '出版商',
  publishedYear: '出版年份',
  language: '语言',
  explicit: '露骸内容标记',
  abridged: '删节标记',
  asin: 'ASIN',
  isbn: 'ISBN',
  coverPath: '封面'
}

const BOOK_METADATA_FIELD_KEYS = Object.keys(BOOK_METADATA_FIELD_LABELS)

/**
 * @param {string[]} fields
 * @returns {string[]}
 */
function getBookMetadataFieldLabels(fields = []) {
  return fields.map((field) => BOOK_METADATA_FIELD_LABELS[field] || field)
}

/**
 * Keep only known field keys, de-duplicated and in the canonical order.
 *
 * @param {any} fields
 * @returns {string[]}
 */
function normalizeBookMetadataFields(fields) {
  if (!Array.isArray(fields)) return [...BOOK_METADATA_FIELD_KEYS]
  const selected = new Set(fields.filter((field) => typeof field === 'string' && BOOK_METADATA_FIELD_LABELS[field]))
  return BOOK_METADATA_FIELD_KEYS.filter((field) => selected.has(field))
}

/**
 * True when every entry is a known field key.
 *
 * @param {any} fields
 * @returns {boolean}
 */
function isValidBookMetadataFields(fields) {
  return Array.isArray(fields) && fields.every((field) => typeof field === 'string' && !!BOOK_METADATA_FIELD_LABELS[field])
}

module.exports = { BOOK_METADATA_FIELD_LABELS, BOOK_METADATA_FIELD_KEYS, getBookMetadataFieldLabels, normalizeBookMetadataFields, isValidBookMetadataFields }
