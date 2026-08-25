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
    // Only skip books that are actually matched. Books requiring review remain
    // eligible for a later scheduled run because they have not been matched.
    return audit?.status === 'matched-ai' || !!libraryItem.media?.isbn || !!libraryItem.media?.asin
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

  async chooseCandidate(libraryItem, candidates, settings = Database.serverSettings) {
    const endpoint = this.getEndpoint(settings.aiBookMatchApiUrl)
    if (!endpoint) throw new Error('AI matching API URL is not configured')

    const book = {
      title: libraryItem.media.title || null,
      author: libraryItem.media.authorName || null,
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

    const results = await BookFinder.search(libraryItem, library.provider || 'google', libraryItem.media.title, libraryItem.media.authorName, null, null, { maxFuzzySearches: 2 })
    const candidates = this.getCandidates(results)
    if (!candidates.length) {
      await this.saveAudit(libraryItem, { status: 'unmatched', source: 'provider', updatedAt: Date.now(), reason: 'No metadata provider candidates found' })
      return { status: 'unmatched' }
    }

    const decision = await this.chooseCandidate(libraryItem, candidates, settings)
    const threshold = Number(settings.aiBookMatchConfidence) || 0.9
    if (decision.candidateIndex === null || decision.confidence < threshold) {
      await this.saveAudit(libraryItem, {
        status: 'needs-review', source: 'ai', model: settings.aiBookMatchModel, confidence: decision.confidence, updatedAt: Date.now(), reason: decision.reason || 'AI confidence did not reach the configured threshold'
      })
      return { status: 'needs-review' }
    }

    const result = await Scanner.applyBookMatch(apiRouterCtx, libraryItem, results[decision.candidateIndex])
    await this.saveAudit(libraryItem, {
      status: result.updated ? 'matched-ai' : 'needs-review', source: 'ai', model: settings.aiBookMatchModel, confidence: decision.confidence, updatedAt: Date.now(), candidate: candidates[decision.candidateIndex], reason: decision.reason
    })
    return { status: result.updated ? 'matched' : 'needs-review' }
  }
}

module.exports = new AiBookMatchManager()
