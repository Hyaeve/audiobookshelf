const { polyphonic } = require('pinyin-pro')

const FIELD_KEYS = ['title', 'subtitle', 'authors', 'narrators']
const INDEX_VERSION = 1

function normalizeFields(fields) {
  return FIELD_KEYS.filter((field) => Array.isArray(fields) && fields.includes(field))
}

function normalize(text) {
  return String(text || '')
    .normalize('NFKC')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}]/gu, '')
}

function extractFields(item, fields) {
  return Object.fromEntries(
    normalizeFields(fields).map((field) => {
      const value = item.media?.[field]
      const entries = Array.isArray(value) ? value.map((entry) => (typeof entry === 'string' ? entry : entry?.name)) : [value]
      return [field, entries.filter((entry) => typeof entry === 'string' && entry.trim())]
    })
  )
}

function buildPayload(values) {
  return Object.fromEntries(
    Object.entries(values).map(([field, entries]) => [
      field,
      entries.flatMap((text) =>
        text
          .normalize('NFKC')
          .split(/[丨|｜。；;!?！？\n\r]/u)
          .filter(Boolean)
          .map((segment) => ({
            text: normalize(segment),
            tokens: Array.from(segment)
              .map((character) => {
                const readings = /\p{Script=Han}/u.test(character) ? polyphonic(character, { type: 'array', toneType: 'none' })[0] || [] : []
                return [...new Set([character, ...readings].map(normalize).filter(Boolean))]
              })
              .filter((token) => token.length)
          }))
      )
    ])
  )
}

function matchesValue(value, query) {
  if (value.text.includes(query)) return true
  let positions = new Set()
  for (const alternatives of value.tokens) {
    positions.add(0)
    const next = new Set()
    for (const position of positions) {
      for (const alternative of alternatives) {
        if (alternative.startsWith(query.slice(position))) return true
        if (query.startsWith(alternative, position)) next.add(position + alternative.length)
        if (/^[a-z]/.test(alternative) && query[position] === alternative[0]) next.add(position + 1)
      }
    }
    if (next.has(query.length)) return true
    positions = next
  }
  return false
}

function matchesPayload(payload, fields, query) {
  query = normalize(query)
  if (!query || query.length > 128) return false
  return normalizeFields(fields).some((field) => (payload[field] || []).some((value) => matchesValue(value, query)))
}

module.exports = { FIELD_KEYS, INDEX_VERSION, normalizeFields, normalize, extractFields, buildPayload, matchesPayload }
