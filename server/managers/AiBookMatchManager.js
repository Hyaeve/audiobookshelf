const axios = require('axios')
const Logger = require('../Logger')
const Database = require('../Database')
const BookFinder = require('../finders/BookFinder')
const { getMetadataLocks } = require('../utils/metadataLocks')
const Scanner = require('../scanner/Scanner')
const LibraryScanner = require('../scanner/LibraryScanner')

const AUDIT_KEY = 'aiBookMatch'

const MATCHED_AUDIT_STATUSES = new Set(['matched-ai', 'matched-local'])

const TITLE_SEPARATOR_REGEX = /[丨|｜.．\-－—–]/

const LOCAL_AUTHOR_TRIM_REGEX = /^[\s丨|｜.．\-－—–_~、,，;；]+|[\s丨|｜.．\-－—–_~、,，;；]+$/g

const AI_FAILURE_STREAK_LIMIT = 3

const AI_COOLDOWN_MS = 5 * 60 * 1000

const MATCH_RULE_LABELS = {
  quoted: '书名号',
  'quoted-ai-author': '书名号+AI 人物',
  'quoted-local-author': '书名号+剩余文本',
  separator: '符号分隔',
  'separator-ai-author': '符号分隔+AI 人物',
  'separator-local-author': '符号分隔+后段文本',
  'ai-title-author': 'AI 书名+人物',
  'ai-title': 'AI 仅书名',
  'full-name': '全称'
}

class AiBookMatchManager {
  constructor() {
    /** @type {import('../routers/ApiRouter')} */
    this.apiRouterCtx = null
    this.scanMatchQueue = []
    this.scanMatchQueuedIds = new Set()
    this.scanMatchRunning = false
    // Soft circuit breaker: after repeated transport failures (503 from an
    // overloaded gateway, timeouts, ...) the AI steps are skipped for a while so
    // matching keeps running on the local rules instead of stalling on retries.
    this.aiFailureStreak = 0
    this.aiUnavailableUntil = 0
  }

  isAiTemporarilyUnavailable() {
    return this.aiUnavailableUntil > Date.now()
  }

  /**
   * AI is usable only when it is configured and the circuit breaker is closed.
   *
   * @param {import('../objects/settings/ServerSettings')} settings
   * @returns {boolean}
   */
  isAiUsable(settings = Database.serverSettings) {
    return this.isConfigured(settings) && !this.isAiTemporarilyUnavailable()
  }

  noteAiSuccess() {
    this.aiFailureStreak = 0
    this.aiUnavailableUntil = 0
  }

  /**
   * Record an AI transport failure and open the circuit breaker after 3 in a row.
   *
   * @param {Error} error
   * @param {string} label
   */
  noteAiFailure(error, label) {
    this.aiFailureStreak += 1
    const status = error?.response?.status ? `HTTP ${error.response.status}` : error?.code || error?.message
    if (this.aiFailureStreak >= AI_FAILURE_STREAK_LIMIT) {
      this.aiUnavailableUntil = Date.now() + AI_COOLDOWN_MS
      Logger.warn(`[AiBookMatchManager] ${label}连续失败 ${this.aiFailureStreak} 次（${status}），暂停 AI 辅助 ${AI_COOLDOWN_MS / 60000} 分钟，改用本地规则继续匹配`)
    } else {
      Logger.warn(`[AiBookMatchManager] ${label}失败（${status}），本次降级为本地规则`)
    }
  }

  isConfigured(settings = Database.serverSettings) {
    return !!(settings?.aiBookMatchApiUrl && settings?.aiBookMatchApiKey && settings?.aiBookMatchModel)
  }

  getAudit(libraryItem) {
    return libraryItem.extraData?.[AUDIT_KEY] || null
  }

  getUnmatchedCandidates(libraryItems) {
    return libraryItems.filter((libraryItem) => this.isUnmatchedCandidate(libraryItem))
  }

  hasValue(value) {
    if (Array.isArray(value)) return value.length > 0
    if (value && typeof value === 'object') return Object.keys(value).length > 0
    return value !== undefined && value !== null && String(value).trim() !== ''
  }

  isUnmatchedCandidate(libraryItem) {
    const audit = this.getAudit(libraryItem)
    if (MATCHED_AUDIT_STATUSES.has(audit?.status)) return false

    const media = libraryItem.media || {}
    const expandedAuthors = Array.isArray(media.authors) ? media.authors : []
    const externalMetadata = [
      media.subtitle,
      media.publishedYear,
      media.publishedDate,
      media.publisher,
      media.isbn,
      media.asin,
      media.language,
      media.authorName,
      media.narrators,
      media.tags,
      media.genres,
      media.series,
      expandedAuthors
    ]
    return !externalMetadata.some((value) => this.hasValue(value))
  }

  isAlreadyMatched(libraryItem) {
    return !this.isUnmatchedCandidate(libraryItem)
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

  extractLocalTitle(sourceName) {
    const quotedTitle = String(sourceName || '').match(/[《「『]([^》」』]+)[》」』]/)
    return quotedTitle?.[1]?.trim().slice(0, 300) || ''
  }

  extractSeparatorTitle(sourceName) {
    const normalizedName = String(sourceName || '').trim()
    if (!normalizedName) return ''
    const separatorIndex = normalizedName.search(TITLE_SEPARATOR_REGEX)
    if (separatorIndex < 0) return ''
    const firstSegment = normalizedName
      .split(TITLE_SEPARATOR_REGEX)
      .map((segment) => segment.trim())
      .find((segment) => !!segment)
    return firstSegment && firstSegment !== normalizedName ? firstSegment.slice(0, 300) : ''
  }

  /**
   * Local book title extraction with a fixed rule priority:
   * 1. Text wrapped in book-title brackets
   * 2. Text before the first 丨 | . - separator
   *
   * @param {string} sourceName
   * @returns {{title: string, rule: string|null}}
   */
  extractLocalTitleWithRule(sourceName) {
    const quotedTitle = this.extractLocalTitle(sourceName)
    if (quotedTitle) return { title: quotedTitle, rule: 'quoted' }
    const separatorTitle = this.extractSeparatorTitle(sourceName)
    if (separatorTitle) return { title: separatorTitle, rule: 'separator' }
    return { title: '', rule: null }
  }

  trimLocalAuthor(value) {
    return String(value || '')
      .replace(LOCAL_AUTHOR_TRIM_REGEX, '')
      .trim()
      .slice(0, 300)
  }

  /**
   * Local author extraction used when the AI is not configured or unavailable.
   * quoted rule: the whole name minus the book-title brackets and their content
   * separator rule: everything after the first separator
   *
   * @param {string} sourceName
   * @param {string} rule
   * @returns {string}
   */
  extractLocalAuthor(sourceName, rule) {
    const normalizedName = String(sourceName || '').trim()
    if (!normalizedName) return ''
    if (rule === 'quoted') {
      return this.trimLocalAuthor(normalizedName.replace(/[《「『][^》」』]+[》」』]/, ' '))
    }
    if (rule === 'separator') {
      const separatorTitle = this.extractSeparatorTitle(normalizedName)
      if (!separatorTitle) return ''
      const titleIndex = normalizedName.indexOf(separatorTitle)
      if (titleIndex < 0) return ''
      return this.trimLocalAuthor(normalizedName.slice(titleIndex + separatorTitle.length))
    }
    return ''
  }

  getMatchRuleLabel(rule) {
    return MATCH_RULE_LABELS[rule] || rule || '-'
  }

  /**
   * Run the AI metadata extraction without letting a transport failure abort the match.
   *
   * @param {import('../models/LibraryItem')} libraryItem
   * @param {import('../objects/settings/ServerSettings')} settings
   * @param {Object} options
   * @param {string} sourceName
   * @returns {Promise<{title: string, author: string, authors: string[], narrators: string[]}|null>}
   */
  async extractSearchMetadataSafely(libraryItem, settings, options, sourceName) {
    try {
      const searchMetadata = await this.extractSearchMetadata(libraryItem, settings, options)
      this.noteAiSuccess()
      return searchMetadata
    } catch (error) {
      if (this.isCancelledError(error, options)) throw error
      this.noteAiFailure(error, `AI 书名提取（"${sourceName}"）`)
      return null
    }
  }

  /**
   * Build the ordered list of search attempts for one book.
   * The title always comes from the highest matching rule (brackets, then separator,
   * then AI); the author column is filled by the AI when it is usable and by the
   * leftover text of the same local rule when it is not.
   *
   * @param {import('../models/LibraryItem')} libraryItem
   * @param {import('../objects/settings/ServerSettings')} settings
   * @param {Object} options
   * @returns {Promise<{rule: string, title: string, author: string, authors: string[], narrators: string[]}[]>}
   */
  async buildMatchAttempts(libraryItem, settings = Database.serverSettings, options = {}) {
    const sourceName = String(libraryItem.media?.title || '').trim()
    const attempts = []
    const addAttempt = (attempt) => {
      if (!attempt.title) return
      const isDuplicate = attempts.some((existing) => existing.title === attempt.title && (existing.author || '') === (attempt.author || ''))
      if (!isDuplicate) attempts.push({ authors: [], narrators: [], author: '', ...attempt })
    }

    const localTitle = this.extractLocalTitleWithRule(sourceName)
    const aiUsable = this.isAiUsable(settings)
    if (localTitle.title) {
      // Priority 1 and 2: the local rule owns the title, the AI only supplies the people
      let aiAuthor = ''
      if (aiUsable) {
        const searchMetadata = await this.extractSearchMetadataSafely(libraryItem, settings, options, sourceName)
        if (searchMetadata?.author) {
          aiAuthor = searchMetadata.author
          addAttempt({ rule: `${localTitle.rule}-ai-author`, title: localTitle.title, author: aiAuthor, authors: searchMetadata.authors, narrators: searchMetadata.narrators })
        }
      }
      if (!aiAuthor) {
        // No AI (not configured, cooling down or failed): use the leftover text of the same rule
        const localAuthor = this.extractLocalAuthor(sourceName, localTitle.rule)
        if (localAuthor) addAttempt({ rule: `${localTitle.rule}-local-author`, title: localTitle.title, author: localAuthor })
      }
      // Author-free retry so a noisy author column cannot block an otherwise correct match
      addAttempt({ rule: localTitle.rule, title: localTitle.title })
    } else if (aiUsable) {
      // Priority 3: no brackets and no separator, the AI supplies both title and people
      const searchMetadata = await this.extractSearchMetadataSafely(libraryItem, settings, options, sourceName)
      if (searchMetadata?.title) {
        if (searchMetadata.author) addAttempt({ rule: 'ai-title-author', title: searchMetadata.title, author: searchMetadata.author, authors: searchMetadata.authors, narrators: searchMetadata.narrators })
        addAttempt({ rule: 'ai-title', title: searchMetadata.title, authors: searchMetadata.authors, narrators: searchMetadata.narrators })
      }
    }
    // Last resort: no bracket rule, no separator rule and no AI title
    addAttempt({ rule: 'full-name', title: sourceName.slice(0, 300) })
    return attempts
  }

  async extractSearchMetadata(libraryItem, settings = Database.serverSettings, options = {}) {
    const sourceName = libraryItem.media?.title || ''
    // When a local rule already produced the title the AI is only asked for the people
    const confirmedTitle = this.extractLocalTitleWithRule(sourceName).title
    const response = await this.postAiRequest({
      model: settings.aiBookMatchModel,
      temperature: 0,
      messages: [
        {
          role: 'system',
          content: confirmedTitle
            ? 'You extract people metadata from an audiobook name. Return strict JSON: {"title": string, "authors": string[], "narrators": string[]}. The confirmedTitle was extracted locally by a fixed local rule and must be copied exactly into title. Do not alter, shorten, translate, or omit it. Extract authors only after markers such as 著, 作者, 原著. Extract narrators only after 播, 主播, 演播, 播讲, 朗读, or CV. Do not guess an author. Do not treat narrator, studio, platform, or publisher as an author. Ignore episode counts, completion markers, seasons, collections, and technical suffixes. Use empty arrays when unknown.'
            : 'You extract audiobook search metadata from an unprocessed audiobook name. Return strict JSON: {"title": string, "authors": string[], "narrators": string[]}. Identify the actual work title and remove edition, year, format, bitrate, release-group, episode counts, completion markers, collection/season markers, and other technical suffixes. Extract authors only after 著, 作者, 原著 or an unmistakable author separator; extract narrators only after 演播, 主播, 播讲, 朗读, 播, or CV. Never guess. For Chinese names, recognize 《》, 「」, 『』 and separators such as 丨, |, ., -, &, parentheses. Use empty arrays when unknown.'
        },
        {
          role: 'user',
          content: JSON.stringify({ unprocessedBookName: sourceName, confirmedTitle: confirmedTitle || null })
        }
      ],
      response_format: { type: 'json_object' }
    }, settings, options, 'AI 书名提取')

    const content = response.data?.choices?.[0]?.message?.content
    let metadata
    try {
      const normalizedContent = typeof content === 'string' ? content.replace(/^```(?:json)?\s*|\s*```$/gi, '').trim() : content
      metadata = typeof normalizedContent === 'string' ? JSON.parse(normalizedContent) : normalizedContent
    } catch (error) {
      throw new Error('AI metadata extraction response is not valid JSON')
    }
    const title = confirmedTitle || metadata?.title || metadata?.bookTitle || metadata?.name
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

  async chooseCandidate(libraryItem, candidates, settings = Database.serverSettings, searchMetadata = null, options = {}) {
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
    const response = await this.postAiRequest({
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
    }, settings, options, 'AI 候选判定')

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

  throwIfAborted(options = {}) {
    if (options.signal?.aborted) throw new Error('AI matching cancelled')
  }

  isCancelledError(error, options = {}) {
    return !!(options.signal?.aborted || error?.code === 'ERR_CANCELED' || error?.name === 'CanceledError')
  }

  /**
   * Abort-aware sleep used between AI request retries.
   *
   * @param {number} durationMs
   * @param {Object} options
   */
  wait(durationMs, options = {}) {
    return new Promise((resolve) => {
      const startedAt = Date.now()
      const check = () => {
        if (options.signal?.aborted || Date.now() - startedAt >= durationMs) return resolve()
        setTimeout(check, Math.min(500, durationMs - (Date.now() - startedAt)))
      }
      check()
    })
  }

  /**
   * POST to the OpenAI compatible endpoint, retrying transient failures.
   * Retries 408 / 429 / 5xx and network errors (a 503 from an overloaded
   * gateway is the common case); everything else fails immediately.
   *
   * @param {Object} payload chat completion body
   * @param {import('../objects/settings/ServerSettings')} settings
   * @param {Object} options
   * @param {string} label log label
   */
  async postAiRequest(payload, settings, options = {}, label = 'AI 请求') {
    const endpoint = this.getEndpoint(settings.aiBookMatchApiUrl)
    if (!endpoint) throw new Error('AI matching API URL is not configured')

    const maxAttempts = 3
    for (let attempt = 1; ; attempt++) {
      this.throwIfAborted(options)
      try {
        return await axios.post(endpoint, payload, {
          headers: { Authorization: `Bearer ${settings.aiBookMatchApiKey}`, 'Content-Type': 'application/json' },
          timeout: 30000,
          signal: options.signal
        })
      } catch (error) {
        if (this.isCancelledError(error, options)) throw error
        const status = Number(error.response?.status) || 0
        const isRetryable = !status || status === 408 || status === 429 || status >= 500
        if (!isRetryable || attempt >= maxAttempts) throw error
        const retryAfterSeconds = Number(error.response?.headers?.['retry-after'])
        const waitMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0 ? Math.min(30000, retryAfterSeconds * 1000) : attempt * 2000
        Logger.warn(`[AiBookMatchManager] ${label}失败（${status || error.code || error.message}），${Math.round(waitMs / 1000)} 秒后重试（第 ${attempt + 1}/${maxAttempts} 次）`)
        await this.wait(waitMs, options)
      }
    }
  }

  /**
   * Match one book by walking the fixed extraction rule priority until a candidate is applied.
   * Rule order: book-title brackets (+ AI or leftover author), first separator segment
   * (+ AI or trailing author), the same local title without an author, AI title + people,
   * AI title only, full name.
   *
   * @param {import('../routers/ApiRouter')} apiRouterCtx
   * @param {import('../models/LibraryItem')} libraryItem
   * @param {import('../models/Library')} library
   * @param {Object} options
   */
  async matchLibraryItem(apiRouterCtx, libraryItem, library, options = {}) {
    if (!libraryItem.isBook || (this.isAlreadyMatched(libraryItem) && options.globalMatch !== true)) return { status: 'skipped' }
    if (options.scheduledTask === true && getMetadataLocks(libraryItem).all) return { status: 'skipped', reason: '已锁定' }
    const settings = Database.serverSettings
    const attempts = await this.buildMatchAttempts(libraryItem, settings, options)
    if (!attempts.length) {
      await this.saveAudit(libraryItem, { status: 'unmatched', source: 'local', updatedAt: Date.now(), reason: 'No book title could be extracted' })
      return { status: 'unmatched', reason: '没有可用的书名' }
    }

    const threshold = Number(settings.aiBookMatchConfidence) || 0.9
    // Re-evaluated per attempt: a transport failure degrades the rest of this
    // book to local candidate selection instead of aborting the whole match.
    let aiUsable = this.isAiUsable(settings)
    let lastFailure = null
    for (const attempt of attempts) {
      this.throwIfAborted(options)
      const results = await BookFinder.search(libraryItem, library.provider || 'google', attempt.title, attempt.author || null, null, null, { maxFuzzySearches: 2 })
      this.throwIfAborted(options)
      const candidates = this.getCandidates(results)
      if (!candidates.length) {
        lastFailure = { status: 'unmatched', source: 'provider', reason: '没有找到元数据候选', attempt }
        continue
      }

      let selectedIndex = 0
      let confidence = null
      let decisionReason = ''
      let usedAi = false
      if (aiUsable) {
        let decision = null
        try {
          decision = await this.chooseCandidate(libraryItem, candidates, settings, attempt, options)
          this.noteAiSuccess()
        } catch (error) {
          if (this.isCancelledError(error, options)) throw error
          this.noteAiFailure(error, `AI 候选判定（"${attempt.title}"）`)
          aiUsable = false
        }
        if (decision) {
          usedAi = true
          this.throwIfAborted(options)
          if (decision.candidateIndex === null || decision.confidence < threshold) {
            lastFailure = { status: 'needs-review', source: 'ai', reason: decision.reason || 'AI confidence did not reach the configured threshold', confidence: decision.confidence, attempt }
            continue
          }
          selectedIndex = decision.candidateIndex
          confidence = decision.confidence
          decisionReason = decision.reason
        }
      }

      const selectedResult = results[selectedIndex]
      this.throwIfAborted(options)
      const result = await Scanner.applyBookMatch(apiRouterCtx, libraryItem, selectedResult, options)
      await this.saveAudit(libraryItem, {
        status: result.updated ? (usedAi ? 'matched-ai' : 'matched-local') : 'needs-review',
        source: usedAi ? 'ai' : 'local',
        model: usedAi ? settings.aiBookMatchModel : null,
        rule: attempt.rule,
        confidence,
        updatedAt: Date.now(),
        candidate: candidates[selectedIndex],
        reason: decisionReason
      })
      return {
        status: result.updated ? 'matched' : 'needs-review',
        rule: attempt.rule,
        ruleLabel: this.getMatchRuleLabel(attempt.rule),
        searchTitle: attempt.title,
        searchAuthor: attempt.author || '',
        candidateTitle: selectedResult.title || selectedResult.name || null
      }
    }

    await this.saveAudit(libraryItem, {
      status: lastFailure.status,
      source: lastFailure.source,
      model: lastFailure.source === 'ai' ? settings.aiBookMatchModel : null,
      rule: lastFailure.attempt?.rule || null,
      confidence: lastFailure.confidence ?? null,
      updatedAt: Date.now(),
      reason: lastFailure.reason
    })
    return {
      status: lastFailure.status,
      rule: lastFailure.attempt?.rule || null,
      ruleLabel: this.getMatchRuleLabel(lastFailure.attempt?.rule),
      searchTitle: lastFailure.attempt?.title || '',
      searchAuthor: lastFailure.attempt?.author || '',
      reason: lastFailure.reason
    }
  }

  /**
   * Queue a newly scanned book for the shared book-match flow.
   * Only used by the "入库匹配" option; jobs run one book at a time.
   *
   * @param {import('../models/LibraryItem')} libraryItem
   */
  enqueueScanMatch(libraryItem) {
    const settings = Database.serverSettings
    if (settings?.aiBookMatchOnScan !== true) return false
    if (!libraryItem?.id || libraryItem.mediaType !== 'book') return false
    const selectedLibraryIds = Array.isArray(settings.aiBookMatchLibraryIds) ? settings.aiBookMatchLibraryIds : []
    if (selectedLibraryIds.length && !selectedLibraryIds.includes(libraryItem.libraryId)) return false
    if (this.scanMatchQueuedIds.has(libraryItem.id)) return false
    this.scanMatchQueuedIds.add(libraryItem.id)
    this.scanMatchQueue.push({ id: libraryItem.id, libraryId: libraryItem.libraryId, title: libraryItem.media?.title || libraryItem.title || libraryItem.relPath })
    this.processScanMatchQueue()
    return true
  }

  async processScanMatchQueue() {
    if (this.scanMatchRunning) return
    this.scanMatchRunning = true
    try {
      while (this.scanMatchQueue.length) {
        const job = this.scanMatchQueue.shift()
        this.scanMatchQueuedIds.delete(job.id)
        try {
          // Do not write metadata while the library scan that created the item is still running
          while (LibraryScanner.isLibraryScanning(job.libraryId)) {
            await new Promise((resolve) => setTimeout(resolve, 5000))
          }
          const libraryItem = await Database.libraryItemModel.getExpandedById(job.id)
          if (!libraryItem?.isBook) continue
          const library = await Database.libraryModel.findByPk(job.libraryId)
          if (library?.mediaType !== 'book') continue
          const matchResult = await this.matchLibraryItem(this.apiRouterCtx, libraryItem, library, {
            scheduledTask: true,
            // New items are matched regardless of folder-parsed metadata; this option replaces the scan-time match step
            globalMatch: true,
            overrideCover: true,
            overrideDetails: true
          })
          Logger.info(`[AiBookMatchManager] 入库匹配：媒体库 "${library.name}"，原名称 "${job.title}"，规则：${this.getMatchRuleLabel(matchResult.rule)}，搜索标题 "${matchResult.searchTitle || '-'}"，搜索作者 "${matchResult.searchAuthor || '-'}"，结果：${matchResult.status}${matchResult.candidateTitle ? `，匹配为 "${matchResult.candidateTitle}"` : ''}${matchResult.reason ? `，原因：${matchResult.reason}` : ''}`)
        } catch (error) {
          const localTitle = this.extractLocalTitleWithRule(job.title || '')
          Logger.warn(`[AiBookMatchManager] 入库匹配失败："${job.title}"，规则：${this.getMatchRuleLabel(localTitle.rule)}，搜索标题 "${localTitle.title || '-'}"，原因：${error.message}`)
        }
      }
    } finally {
      this.scanMatchRunning = false
      if (this.scanMatchQueue.length) this.processScanMatchQueue()
    }
  }

  setApiRouterContext(apiRouterCtx) {
    this.apiRouterCtx = apiRouterCtx
  }
}

module.exports = new AiBookMatchManager()
