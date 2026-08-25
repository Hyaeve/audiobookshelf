const axios = require('axios')
const Logger = require('../Logger')
const Database = require('../Database')
const BookFinder = require('../finders/BookFinder')
const Scanner = require('../scanner/Scanner')

const AUDIT_KEY = 'aiBookMatch'

class AiBookMatchManager {
  isConfigured(settings = Database.serverSettings) {
    return !!(settings?.aiBookMatchApiUrl && settings?.aiBookMatchApiKey && settings?.aiBookMatchModel)
  }

  getAudit(libraryItem) {
    return libraryItem.extraData?.[AUDIT_KEY] || null
  }

  isAlreadyMatched(libraryItem) {
    const audit = this.getAudit(libraryItem)
    const media = libraryItem.media || {}
    const hasAuthors = Array.isArray(media.authors) ? media.authors.length > 0 : !!media.authorName
    // A provider match may not contain ISBN/ASIN. Existing author metadata is
    // the persistent match signal in that case, so do not send it through AI again.
    return audit?.status === 'matched-ai' || !!media.isbn || !!media.asin || hasAuthors
  }

  async saveAudit(libraryItem, audit) {
    libraryItem.extraData = { ...(libraryItem.extraData || {}), [AUDIT_KEY]: audit }
    libraryItem.changed('extraData', true)
    await libraryItem.save()
  }

  getCandidates(results) {
    return results.slice(0, 8).map((result, index) => ({
      index,
      title: result.title || null,
      subtitle: result.subtitle || null,
      author: Array.isArray(result.author) ? result.author.join(', ') : result.author || null,
      narrator: result.narrator || null,
      publisher: result.publisher || null,
      publishedYear: result.publishedYear || null,
      isbn: result.isbn || null,
      asin: result.asin || null,
      series: Array.isArray(result.series) ? result.series.map((series) => ({ sequence: series.sequence || null, title: series.title || series.name || null })) : [],
      matchConfidence: Number(result.matchConfidence) || null
    }))
  }

  getEndpoint(apiUrl) {
    const normalizedUrl = String(apiUrl || '').trim().replace(/\/+$/, '')
    if (!normalizedUrl) return null
    return normalizedUrl.endsWith('/chat/completions') ? normalizedUrl : `${normalizedUrl}/chat/completions`
  }

  async extractSearchMetadata(libraryItem, settings = Database.serverSettings) {
    const endpoint = this.getEndpoint(settings.aiBookMatchApiUrl)
    if (!endpoint) throw new Error('AI matching API URL is not configured')

    const sourceName = libraryItem.media?.title || ''
    const response = await axios.post(endpoint, {
      model: settings.aiBookMatchModel,
      temperature: 0,
      messages: [
        {
          role: 'system',
          content: 'You extract audiobook search metadata from the provided unprocessed audiobook name. Return strict JSON: {"title": string, "authors": string[], "narrators": string[]}. Remove edition, year, format, bitrate, release-group and other technical suffixes. Extract the actual book title, author names, and narrator names. For Chinese names, recognize markers such as 演播, 主播, 播讲, 朗读 and separators such as 丨, |, ., -, parentheses. Never put technical metadata in title or people fields. Use empty arrays when a field is unknown.'
        },
        {
          role: 'user',
          content: JSON.stringify({ unprocessedBookName: sourceName })
        }
      ],
      response_format: { type: 'json_object' }
    }, {
      headers: { Authorization: `Bearer ${settings.aiBookMatchApiKey}`, 'Content-Type': 'application/json' },
      timeout: 30000
    })

    const content = response.data?.choices?.[0]?.message?.content
    let metadata
    try {
      const normalizedContent = typeof content === 'string' ? content.replace(/^```(?:json)?\s*|\s*```$/gi, '').trim() : content
      metadata = typeof normalizedContent === 'string' ? JSON.parse(normalizedContent) : normalizedContent
    } catch (error) {
      throw new Error('AI metadata extraction response is not valid JSON')
    }
    const title = metadata?.title || metadata?.bookTitle || metadata?.name
    if (typeof title !== 'string' || !title.trim()) throw new Error('AI metadata extraction returned no title')

    const toNames = (value) => {
      if (typeof value === 'string') value = value.split(/[,，、;；|丨]/)
      return Array.isArray(value) ? value.filter((name) => typeof name === 'string').map((name) => name.trim()).filter(Boolean).slice(0, 8) : []
    }
    const authors = toNames(metadata.authors || metadata.author)
    const narrators = toNames(metadata.narrators || metadata.narrator)
    return {
      title: title.trim().slice(0, 300),
      authors,
      narrators,
      author: [...new Set([...authors, ...narrators])].join(', ')
    }
  }

  async chooseCandidate(libraryItem, candidates, settings = Database.serverSettings, searchMetadata = null) {
    const endpoint = this.getEndpoint(settings.aiBookMatchApiUrl)
    if (!endpoint) throw new Error('AI matching API URL is not configured')

    const book = {
      title: searchMetadata?.title || libraryItem.media.title || null,
      author: searchMetadata?.author || libraryItem.media.authorName || null,
      authors: searchMetadata?.authors || [],
      narrators: searchMetadata?.narrators || [],
      isbn: libraryItem.media.isbn || null,
      asin: libraryItem.media.asin || null,
      durationMinutes: Math.round((Number(libraryItem.media.duration) || 0) / 60),
      path: libraryItem.relPath || null
    }
    const response = await axios.post(endpoint, {
      model: settings.aiBookMatchModel,
      temperature: 0,
      messages: [
        {
          role: 'system',
          content: 'You are a book metadata match verifier. Select only one candidate that is clearly the same book as the input. Never invent metadata. Reply with strict JSON: {"candidateIndex": number|null, "confidence": number, "reason": string}. candidateIndex must be an index from the provided candidates. Use null when no candidate is reliable.'
        },
        {
          role: 'user',
          content: JSON.stringify({ book, candidates })
        }
      ],
      response_format: { type: 'json_object' }
    }, {
      headers: { Authorization: `Bearer ${settings.aiBookMatchApiKey}`, 'Content-Type': 'application/json' },
      timeout: 30000
    })

    const content = response.data?.choices?.[0]?.message?.content
    let decision
    try {
      decision = typeof content === 'string' ? JSON.parse(content) : content
    } catch (error) {
      throw new Error('AI matching response is not valid JSON')
    }
    const candidateIndex = decision?.candidateIndex === null ? null : Number(decision?.candidateIndex)
    const confidence = Number(decision?.confidence)
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error('AI matching response has invalid confidence')
    if (candidateIndex !== null && (!Number.isInteger(candidateIndex) || candidateIndex < 0 || candidateIndex >= candidates.length)) {
      throw new Error('AI matching response selected an unknown candidate')
    }
    return { candidateIndex, confidence, reason: typeof decision?.reason === 'string' ? decision.reason.slice(0, 500) : '' }
  }

  async matchLibraryItem(apiRouterCtx, libraryItem, library) {
    if (!libraryItem.isBook || this.isAlreadyMatched(libraryItem)) return { status: 'skipped' }
    const settings = Database.serverSettings
    if (!this.isConfigured(settings)) throw new Error('AI book matching is not configured')

    const searchMetadata = await this.extractSearchMetadata(libraryItem, settings)
    const results = await BookFinder.search(libraryItem, library.provider || 'google', searchMetadata.title, searchMetadata.author, null, null, { maxFuzzySearches: 2 })
    const candidates = this.getCandidates(results)
    if (!candidates.length) {
      await this.saveAudit(libraryItem, { status: 'unmatched', source: 'provider', updatedAt: Date.now(), reason: 'No metadata provider candidates found' })
      return { status: 'unmatched', searchTitle: searchMetadata.title, searchAuthor: searchMetadata.author, reason: '没有找到元数据候选' }
    }

    const decision = await this.chooseCandidate(libraryItem, candidates, settings, searchMetadata)
    const threshold = Number(settings.aiBookMatchConfidence) || 0.9
    if (decision.candidateIndex === null || decision.confidence < threshold) {
      await this.saveAudit(libraryItem, {
        status: 'needs-review', source: 'ai', model: settings.aiBookMatchModel, confidence: decision.confidence, updatedAt: Date.now(), reason: decision.reason || 'AI confidence did not reach the configured threshold'
      })
      return { status: 'needs-review', searchTitle: searchMetadata.title, searchAuthor: searchMetadata.author }
    }

    const selectedResult = results[decision.candidateIndex]
    const result = await Scanner.applyBookMatch(apiRouterCtx, libraryItem, selectedResult)
    await this.saveAudit(libraryItem, {
      status: result.updated ? 'matched-ai' : 'needs-review', source: 'ai', model: settings.aiBookMatchModel, confidence: decision.confidence, updatedAt: Date.now(), candidate: candidates[decision.candidateIndex], reason: decision.reason
    })
    return {
      status: result.updated ? 'matched' : 'needs-review',
      searchTitle: searchMetadata.title,
      searchAuthor: searchMetadata.author,
      candidateTitle: selectedResult.title || selectedResult.name || null
    }
  }
}

module.exports = new AiBookMatchManager()
