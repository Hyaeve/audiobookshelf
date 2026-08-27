const Sequelize = require('sequelize')
const cron = require('../libs/nodeCron')
const Logger = require('../Logger')
const Database = require('../Database')
const LibraryScanner = require('../scanner/LibraryScanner')
const AiBookMatchManager = require('./AiBookMatchManager')
const Scanner = require('../scanner/Scanner')

const ShareManager = require('./ShareManager')
const TaskManager = require('./TaskManager')

const BOOK_METADATA_FIELD_LABELS = {
  title: '标题',
  subtitle: '副标题',
  description: '简介',
  narrators: '演播者',
  publisher: '出版商',
  publishedYear: '出版年份',
  genres: '流派',
  tags: '标签',
  language: '语言',
  explicit: '露骨内容标记',
  abridged: '删节标记',
  asin: 'ASIN',
  isbn: 'ISBN',
  coverPath: '封面',
  authors: '作者',
  series: '系列'
}

function getBookMetadataFieldLabels(fields = []) {
  return fields.map((field) => BOOK_METADATA_FIELD_LABELS[field] || field)
}

const BUILT_IN_PROVIDER_LABELS = {
  google: 'Google Books',
  itunes: 'iTunes',
  openlibrary: 'Open Library',
  fantlab: 'FantLab',
  audiobookcovers: 'Audiobook Covers',
  audible: 'Audible',
  'audible.ca': 'Audible Canada',
  'audible.uk': 'Audible UK',
  'audible.au': 'Audible Australia',
  'audible.fr': 'Audible France',
  'audible.de': 'Audible Germany',
  'audible.jp': 'Audible Japan',
  'audible.it': 'Audible Italy',
  'audible.in': 'Audible India',
  'audible.es': 'Audible Spain'
}

function getProviderLabel(provider, customProviderNames = new Map()) {
  return customProviderNames.get(provider) || BUILT_IN_PROVIDER_LABELS[provider] || provider || BUILT_IN_PROVIDER_LABELS.google
}

class CronManager {
  constructor(podcastManager, playbackSessionManager) {
    /** @type {import('./PodcastManager')} */
    this.podcastManager = podcastManager
    /** @type {import('./PlaybackSessionManager')} */
    this.playbackSessionManager = playbackSessionManager

    this.libraryScanCrons = []
    this.podcastCrons = []
    this.strmMetadataCron = null
    this.missingItemsCleanupCron = null
    this.scheduledLibraryScanCron = null
    this.aiBookMatchCron = null
    this.bookMetadataCompletionCron = null
    this.aiBookMatchExecuting = false
    this.bookMetadataCompletionExecuting = false
    this.bookMetadataCompletionCancelRequested = false
    this.aiBookMatchCancelRequested = false
    this.aiBookMatchAbortController = null
    this.scheduledLibraryScanExecuting = false
    this.scheduledLibraryScanCancelRequested = false
    this.scheduledLibraryScanTimer = null
    this.missingItemsCleanupExecuting = false
    this.missingItemsCleanupCancelRequested = false
    this.missingItemsCleanupHandler = null
    this.scheduledLibraryScanCurrentLibraryId = null

    this.podcastCronExpressionsExecuting = []
  }

  /**
   * Initialize library scan crons & podcast download crons
   *
   * @param {import('../models/Library')[]} libraries
   */
  async init(libraries) {
    this.initOpenSessionCleanupCron()
    this.initLibraryScanCrons(libraries)
    this.updateStrmMetadataCron()
    this.updateMissingItemsCleanupCron()
    this.updateScheduledLibraryScanCron()
    this.updateAiBookMatchCron()
    this.updateBookMetadataCompletionCron()
    await this.initPodcastCrons()
  }

  /**
   * Initialize open session & auth session cleanup cron
   * Runs every day at 00:30
   * Closes open share sessions that have not been updated in 24 hours
   * Closes open playback sessions that have not been updated in 36 hours
   * Cleans up expired auth sessions
   * Deactivates expired api keys
   * TODO: Clients should re-open the session if it is closed so that stale sessions can be closed sooner
   */
  initOpenSessionCleanupCron() {
    cron.schedule('30 0 * * *', async () => {
      Logger.debug('[CronManager] Open session cleanup cron executing')
      ShareManager.closeStaleOpenShareSessions()
      await this.playbackSessionManager.closeStaleOpenSessions()
      await Database.cleanupExpiredSessions()
      await Database.deactivateExpiredApiKeys()
    })
  }

  /**
   * Initialize library scan crons
   * @param {import('../models/Library')[]} libraries
   */
  initLibraryScanCrons(libraries) {
    for (const library of libraries) {
      if (library.settings.autoScanCronExpression) {
        this.startCronForLibrary(library)
      }
    }
  }

  /**
   * Start cron schedule for library
   *
   * @param {import('../models/Library')} _library
   */
  startCronForLibrary(_library) {
    Logger.debug(`[CronManager] Init library scan cron for ${_library.name} on schedule ${_library.settings.autoScanCronExpression}`)
    const libScanCron = cron.schedule(_library.settings.autoScanCronExpression, async () => {
      const library = await Database.libraryModel.findByIdWithFolders(_library.id)
      if (!library) {
        Logger.error(`[CronManager] Library not found for scan cron ${_library.id}`)
      } else {
        Logger.debug(`[CronManager] Library scan cron executing for ${library.name}`)
        LibraryScanner.scan(library)
      }
    })
    this.libraryScanCrons.push({
      libraryId: _library.id,
      expression: _library.settings.autoScanCronExpression,
      task: libScanCron
    })
  }

  /**
   *
   * @param {import('../models/Library')} library
   */
  removeCronForLibrary(library) {
    Logger.debug(`[CronManager] Removing library scan cron for ${library.name}`)
    this.libraryScanCrons = this.libraryScanCrons.filter((lsc) => lsc.libraryId !== library.id)
  }

  /**
   *
   * @param {import('../models/Library')} library
   */
  updateLibraryScanCron(library) {
    const expression = library.settings.autoScanCronExpression
    const existingCron = this.libraryScanCrons.find((lsc) => lsc.libraryId === library.id)

    if (!expression && existingCron) {
      if (existingCron.task.stop) existingCron.task.stop()

      this.removeCronForLibrary(library)
    } else if (!existingCron && expression) {
      this.startCronForLibrary(library)
    } else if (existingCron && existingCron.expression !== expression) {
      if (existingCron.task.stop) existingCron.task.stop()

      this.removeCronForLibrary(library)
      this.startCronForLibrary(library)
    }
  }

  /**
   * Start or stop the scheduled media preload task.
   */
  updateStrmMetadataCron() {
    const settings = Database.serverSettings
    const expression = settings.strmMetadataCompletionCronExpression
    if (this.strmMetadataCron && (!expression || this.strmMetadataCron.expression !== expression)) {
      this.strmMetadataCron.task.stop()
      this.strmMetadataCron = null
    }
    if (!expression || this.strmMetadataCron) return
    if (!cron.validate(expression)) {
      Logger.error(`[CronManager] 媒体预读 cron 表达式无效："${expression}"`)
      return
    }

    const task = cron.schedule(expression, async () => {
      if (this.strmMetadataCron.executing) {
        Logger.warn('[CronManager] 媒体预读正在执行中')
        return
      }
      this.strmMetadataCron.executing = true
      try {
        const currentSettings = Database.serverSettings
        await this.playbackSessionManager.completeScheduledStrmMetadata(currentSettings.strmMetadataCompletionMaxHours, currentSettings.strmMetadataCompletionLibraryIds)
      } finally {
        this.strmMetadataCron.executing = false
      }
    })
    this.strmMetadataCron = { expression, task, executing: false }
  }

  async runStrmMetadataCompletion() {
    return this.playbackSessionManager.completeScheduledStrmMetadata(Database.serverSettings.strmMetadataCompletionMaxHours, Database.serverSettings.strmMetadataCompletionLibraryIds)
  }

  cancelStrmMetadataCompletion() {
    return this.playbackSessionManager.cancelScheduledStrmMetadata()
  }

  setMissingItemsCleanupHandler(handler) {
    this.missingItemsCleanupHandler = handler
  }

  updateMissingItemsCleanupCron() {
    const expression = Database.serverSettings.missingItemsCleanupCronExpression
    if (this.missingItemsCleanupCron && (!expression || this.missingItemsCleanupCron.expression !== expression)) {
      this.missingItemsCleanupCron.task.stop()
      this.missingItemsCleanupCron = null
    }
    if (!expression || this.missingItemsCleanupCron) return
    if (!cron.validate(expression)) {
      Logger.error(`[CronManager] Invalid missing items cleanup cron expression "${expression}"`)
      return
    }
    const task = cron.schedule(expression, () => this.runMissingItemsCleanup())
    this.missingItemsCleanupCron = { expression, task }
  }

  updateAiBookMatchCron() {
    const expression = Database.serverSettings.aiBookMatchCronExpression
    if (this.aiBookMatchCron && (!expression || this.aiBookMatchCron.expression !== expression)) {
      this.aiBookMatchCron.task.stop()
      this.aiBookMatchCron = null
    }
    if (!expression || this.aiBookMatchCron) return
    if (!cron.validate(expression)) {
      Logger.error(`[CronManager] Invalid AI book match cron expression "${expression}"`)
      return
    }
    const task = cron.schedule(expression, () => this.runAiBookMatch(true))
    this.aiBookMatchCron = { expression, task }
  }

  async runAiBookMatch(scheduledTask = false) {
    if (this.aiBookMatchExecuting) return { skipped: true }
    if (!AiBookMatchManager.isConfigured()) throw new Error('AI book matching is not configured')
    this.aiBookMatchExecuting = true
    this.aiBookMatchCancelRequested = false
    const settings = Database.serverSettings
    const libraryIds = Array.isArray(settings.aiBookMatchLibraryIds) ? settings.aiBookMatchLibraryIds : []
    const maxHours = Number(settings.aiBookMatchMaxHours) > 0 ? Number(settings.aiBookMatchMaxHours) : 1
    const deadline = Date.now() + maxHours * 60 * 60 * 1000
    const task = TaskManager.createAndAddTask('ai-book-match', { text: '书籍匹配' }, null, true, { scheduledTask, progress: 0, libraryIds, globalMatch: settings.aiBookMatchGlobal })
    const result = { matched: 0, unmatched: 0, needsReview: 0, skipped: 0, cancelled: false }
    const startedAt = Date.now()
    this.aiBookMatchAbortController = new AbortController()
    const taskTypeText = scheduledTask ? '计划任务' : '手动任务'
    try {
      const libraries = await Database.libraryModel.getAllWithFolders()
      const selectedLibraries = libraryIds.map((id) => libraries.find((library) => library.id === id)).filter((library) => library?.mediaType === 'book')
      const selectedLibraryNames = selectedLibraries.map((library) => library.name)
      Logger.info(`[CronManager] AI书籍匹配${taskTypeText}开始，模式：${settings.aiBookMatchGlobal ? '全局匹配' : '仅未匹配'}，目标媒体库：${selectedLibraryNames.length ? selectedLibraryNames.join('、') : '无'}`)
      let processed = 0
      for (const library of selectedLibraries) {
        Logger.info(`[CronManager] AI书籍匹配开始处理媒体库："${library.name}"`)
        let offset = 0
        while (!this.aiBookMatchCancelRequested && Date.now() < deadline) {
          const items = await Database.libraryItemModel.getLibraryItemsIncrement(offset, 50, { libraryId: library.id, mediaType: 'book', isMissing: false, isInvalid: false })
          if (!items.length) break
          offset += items.length
          const matchItems = settings.aiBookMatchGlobal ? items : AiBookMatchManager.getUnmatchedCandidates(items)
          result.skipped += items.length - matchItems.length
          for (const libraryItem of matchItems) {
            if (this.aiBookMatchCancelRequested || Date.now() >= deadline) break
            let matchResult
            try {
              matchResult = await AiBookMatchManager.matchLibraryItem(this.apiRouterCtx, libraryItem, library, {
                signal: this.aiBookMatchAbortController.signal,
                scheduledTask: true,
                globalMatch: settings.aiBookMatchGlobal,
                overrideCover: true,
                overrideDetails: true
              })
            } catch (error) {
              if (this.aiBookMatchCancelRequested || error.code === 'ERR_CANCELED' || error.name === 'CanceledError') {
                matchResult = { status: 'skipped', reason: '已停止' }
              } else {
                Logger.warn(`[CronManager] AI matching failed for "${libraryItem.id}": ${error.message}`)
                await AiBookMatchManager.saveAudit(libraryItem, { status: 'needs-review', source: 'ai', model: settings.aiBookMatchModel, updatedAt: Date.now(), reason: error.message })
                matchResult = { status: 'needs-review', reason: error.message }
              }
            }
            if (matchResult.status === 'matched') result.matched += 1
            else if (matchResult.status === 'unmatched') result.unmatched += 1
            else if (matchResult.status === 'needs-review') result.needsReview += 1
            else result.skipped += 1
            Logger.info(`[CronManager] AI书籍匹配：媒体库 "${library.name}"，原名称 "${libraryItem.media?.title || libraryItem.title || '未命名'}"，搜索标题 "${matchResult.searchTitle || '-'}"，搜索作者 "${matchResult.searchAuthor || '-'}"，结果：${matchResult.status}${matchResult.candidateTitle ? `，匹配为 "${matchResult.candidateTitle}"` : ''}${matchResult.reason ? `，原因：${matchResult.reason}` : ''}`)
            processed += 1
            TaskManager.updateTaskProgress(task, selectedLibraries.length ? Math.min(99, ((selectedLibraries.indexOf(library) + 1) / selectedLibraries.length) * 100) : 100, { currentLibrary: library.name, processed, ...result })
          }
          if (items.length < 50) break
        }
      }
      result.cancelled = this.aiBookMatchCancelRequested || Date.now() >= deadline
      const finishedAt = Date.now()
      const summary = { startedAt, finishedAt, durationMs: finishedAt - startedAt, ...result }
      Logger.info(`[CronManager] AI书籍匹配${taskTypeText}结束：${JSON.stringify(summary)}`)
      task.data.result = summary
      task.setFinished(null, true)
      Database.serverSettings.aiBookMatchLastRun = summary
      await Database.updateServerSettings()
      return summary
    } catch (error) {
      task.setFailed({ text: error.message || 'AI book matching failed' })
      throw error
    } finally {
      TaskManager.taskFinished(task)
      this.aiBookMatchExecuting = false
      this.aiBookMatchCancelRequested = false
      this.aiBookMatchAbortController = null
    }
  }

  cancelAiBookMatch() {
    if (!this.aiBookMatchExecuting) return false
    this.aiBookMatchCancelRequested = true
    if (this.aiBookMatchAbortController) this.aiBookMatchAbortController.abort()
    return true
  }

  updateBookMetadataCompletionCron() {
    const expression = Database.serverSettings.bookMetadataCompletionCronExpression
    if (this.bookMetadataCompletionCron && (!expression || this.bookMetadataCompletionCron.expression !== expression)) {
      this.bookMetadataCompletionCron.task.stop()
      this.bookMetadataCompletionCron = null
    }
    if (!expression || this.bookMetadataCompletionCron) return
    if (!cron.validate(expression)) {
      Logger.error(`[CronManager] Invalid book metadata completion cron expression "${expression}"`)
      return
    }
    const task = cron.schedule(expression, () => this.runBookMetadataCompletion(true))
    this.bookMetadataCompletionCron = { expression, task }
  }

  async runBookMetadataCompletion(scheduledTask = false) {
    if (this.bookMetadataCompletionExecuting) return { skipped: true }
    this.bookMetadataCompletionExecuting = true
    this.bookMetadataCompletionCancelRequested = false
    const settings = Database.serverSettings
    const libraryIds = Array.isArray(settings.bookMetadataCompletionLibraryIds) ? settings.bookMetadataCompletionLibraryIds : []
    const maxHours = Number(settings.bookMetadataCompletionMaxHours) > 0 ? Number(settings.bookMetadataCompletionMaxHours) : 1
    const deadline = Date.now() + maxHours * 60 * 60 * 1000
    const task = TaskManager.createAndAddTask('book-metadata-completion', { text: '补全书籍元数据' }, null, true, { scheduledTask, progress: 0, libraryIds })
    const result = { processed: 0, updated: 0, unmatched: 0, skipped: 0, cancelled: false }
    const startedAt = Date.now()
    try {
      const libraries = await Database.libraryModel.getAllWithFolders()
      const selectedLibraries = libraryIds.map((id) => libraries.find((library) => library.id === id)).filter((library) => library?.mediaType === 'book')
      let customProviderNames = new Map()
      try {
        const customProviders = await Database.customMetadataProviderModel.findAll({ attributes: ['id', 'name'] })
        customProviderNames = new Map(customProviders.map((provider) => [`custom-${provider.id}`, provider.name]))
      } catch (error) {
        Logger.warn(`[CronManager] 无法读取自定义元数据提供商名称：${error.message}`)
      }
      Logger.info(`[CronManager] 书籍元数据补全${scheduledTask ? '计划任务' : '手动任务'}开始，目标媒体库：${selectedLibraries.map((library) => library.name).join('、') || '无'}`)
      for (let libraryIndex = 0; libraryIndex < selectedLibraries.length; libraryIndex += 1) {
        const library = selectedLibraries[libraryIndex]
        const provider = library.provider || 'google'
        const providerLabel = getProviderLabel(provider, customProviderNames)
        let offset = 0
        while (!this.bookMetadataCompletionCancelRequested && Date.now() < deadline) {
          const items = await Database.libraryItemModel.getLibraryItemsIncrement(offset, 50, { libraryId: library.id, mediaType: 'book', isMissing: false, isInvalid: false })
          if (!items.length) break
          offset += items.length
          for (const libraryItem of items) {
            if (this.bookMetadataCompletionCancelRequested || Date.now() >= deadline) break
            result.processed += 1
            try {
              const matchResult = await Scanner.quickMatchLibraryItem(this.apiRouterCtx, libraryItem, {
                provider,
                scheduledTask: true,
                overrideCover: false,
                overrideDetails: false,
                isCancelled: () => this.bookMetadataCompletionCancelRequested || Date.now() >= deadline
              })
              if (matchResult.locked) {
                result.skipped += 1
                Logger.info(`[CronManager] 书籍元数据补全：书籍 "${libraryItem.media?.title || libraryItem.title || libraryItem.id}"，已锁定，跳过，提供商：${providerLabel}`)
              } else if (matchResult.warning) {
                result.unmatched += 1
                Logger.info(`[CronManager] 书籍元数据补全：书籍 "${libraryItem.media?.title || libraryItem.title || libraryItem.id}"，未找到候选，提供商：${providerLabel}`)
              } else if (matchResult.updated) {
                result.updated += 1
                Logger.info(`[CronManager] 书籍元数据补全：书籍 "${libraryItem.media?.title || libraryItem.title || libraryItem.id}"，补全字段：${getBookMetadataFieldLabels(matchResult.changedFields).join('、') || '无'}，提供商：${providerLabel}`)
              } else {
                result.skipped += 1
                Logger.info(`[CronManager] 书籍元数据补全：书籍 "${libraryItem.media?.title || libraryItem.title || libraryItem.id}"，无需更新，提供商：${providerLabel}`)
              }
            } catch (error) {
              if (error.code === 'TASK_CANCELLED' || this.bookMetadataCompletionCancelRequested || Date.now() >= deadline) break
              result.skipped += 1
              Logger.warn(`[CronManager] 书籍元数据补全失败：书籍 "${libraryItem.media?.title || libraryItem.title || libraryItem.id}"，原因：${error.message}`)
            }
            TaskManager.updateTaskProgress(task, selectedLibraries.length ? Math.min(99, ((libraryIndex + 1) / selectedLibraries.length) * 100) : 100, { currentLibrary: library.name, ...result })
          }
          if (items.length < 50) break
        }
      }
      result.cancelled = this.bookMetadataCompletionCancelRequested || Date.now() >= deadline
      const finishedAt = Date.now()
      const summary = { startedAt, finishedAt, durationMs: finishedAt - startedAt, ...result }
      task.data.result = summary
      task.setFinished(null, true)
      Database.serverSettings.bookMetadataCompletionLastRun = summary
      await Database.updateServerSettings()
      Logger.info(`[CronManager] 书籍元数据补全结束：${JSON.stringify(summary)}`)
      return summary
    } catch (error) {
      task.setFailed({ text: error.message || 'Book metadata completion failed' })
      throw error
    } finally {
      TaskManager.taskFinished(task)
      this.bookMetadataCompletionExecuting = false
      this.bookMetadataCompletionCancelRequested = false
    }
  }

  cancelBookMetadataCompletion() {
    if (!this.bookMetadataCompletionExecuting) return false
    this.bookMetadataCompletionCancelRequested = true
    return true
  }

  setApiRouterContext(apiRouterCtx) {
    this.apiRouterCtx = apiRouterCtx
  }

  updateScheduledLibraryScanCron() {
    const settings = Database.serverSettings
    const expression = settings.scheduledLibraryScanCronExpression
    if (this.scheduledLibraryScanCron && (!expression || this.scheduledLibraryScanCron.expression !== expression)) {
      this.scheduledLibraryScanCron.task.stop()
      this.scheduledLibraryScanCron = null
    }
    if (!expression || this.scheduledLibraryScanCron) return
    if (!cron.validate(expression)) {
      Logger.error(`[CronManager] Invalid scheduled library scan cron expression "${expression}"`)
      return
    }
    const task = cron.schedule(expression, () => this.runScheduledLibraryScan())
    this.scheduledLibraryScanCron = { expression, task }
  }

  async runScheduledLibraryScan() {
    if (this.scheduledLibraryScanExecuting) return { skipped: true }
    this.scheduledLibraryScanExecuting = true
    this.scheduledLibraryScanCancelRequested = false
    const settings = Database.serverSettings
    const libraryIds = Array.isArray(settings.scheduledLibraryScanLibraryIds) ? settings.scheduledLibraryScanLibraryIds : []
    const maxHours = Number(settings.scheduledLibraryScanMaxHours) > 0 ? Number(settings.scheduledLibraryScanMaxHours) : 1
    const task = TaskManager.createAndAddTask('scheduled-library-scan', '媒体库扫描', null, true, { scheduledTask: true, progress: 0, libraryIds })
    const deadline = Date.now() + maxHours * 60 * 60 * 1000
    let currentLibraryId = null
    let scanned = 0
    try {
      const libraries = await Database.libraryModel.getAllWithFolders()
      const selectedLibraries = libraryIds.map((id) => libraries.find((library) => library.id === id)).filter(Boolean)
      const selectedLibraryNames = selectedLibraries.map((library) => library.name)
      Logger.info(`[CronManager] 媒体库扫描计划任务开始，目标媒体库：${selectedLibraryNames.length ? selectedLibraryNames.join('、') : '无'}`)
      for (let index = 0; index < selectedLibraries.length; index += 1) {
        if (this.scheduledLibraryScanCancelRequested || Date.now() >= deadline) break
        const library = selectedLibraries[index]
        Logger.info(`[CronManager] 媒体库扫描开始处理媒体库："${library.name}"`)
        currentLibraryId = library.id
        this.scheduledLibraryScanCurrentLibraryId = library.id
        const remainingMs = deadline - Date.now()
        this.scheduledLibraryScanTimer = setTimeout(() => LibraryScanner.setCancelLibraryScan(library.id), remainingMs)
        await LibraryScanner.scan(library)
        clearTimeout(this.scheduledLibraryScanTimer)
        this.scheduledLibraryScanTimer = null
        currentLibraryId = null
        this.scheduledLibraryScanCurrentLibraryId = null
        scanned += 1
        Logger.info(`[CronManager] 媒体库扫描完成处理媒体库："${library.name}"`)
        TaskManager.updateTaskProgress(task, ((index + 1) / Math.max(selectedLibraries.length, 1)) * 100, { currentLibrary: library.name })
      }
      task.data.result = { scanned, canceled: this.scheduledLibraryScanCancelRequested || Date.now() >= deadline }
      Logger.info(`[CronManager] 媒体库扫描计划任务结束：${JSON.stringify(task.data.result)}`)
      task.setFinished(null, true)
      return task.data.result
    } catch (error) {
      task.setFailed(error.message || 'Scheduled library scan failed')
      throw error
    } finally {
      if (this.scheduledLibraryScanTimer) clearTimeout(this.scheduledLibraryScanTimer)
      if (currentLibraryId && this.scheduledLibraryScanCancelRequested) LibraryScanner.setCancelLibraryScan(currentLibraryId)
      this.scheduledLibraryScanTimer = null
      currentLibraryId = null
      this.scheduledLibraryScanCurrentLibraryId = null
      TaskManager.taskFinished(task)
      this.scheduledLibraryScanExecuting = false
      this.scheduledLibraryScanCancelRequested = false
    }
  }

  cancelScheduledLibraryScan() {
    if (!this.scheduledLibraryScanExecuting) return false
    this.scheduledLibraryScanCancelRequested = true
    if (this.scheduledLibraryScanCurrentLibraryId) LibraryScanner.setCancelLibraryScan(this.scheduledLibraryScanCurrentLibraryId)
    return true
  }

  async runMissingItemsCleanup() {
    if (this.missingItemsCleanupExecuting) return { removed: 0, skipped: true }
    this.missingItemsCleanupExecuting = true
    this.missingItemsCleanupCancelRequested = false
    const libraryIds = Array.isArray(Database.serverSettings.missingItemsCleanupLibraryIds) ? Database.serverSettings.missingItemsCleanupLibraryIds : []
    const task = TaskManager.createAndAddTask('missing-items-cleanup', 'Cleaning missing items', null, true, { scheduledTask: true, progress: 0, libraryIds })
    Logger.info(`[CronManager] 清理丢失项目计划任务开始`)
    try {
      if (!this.missingItemsCleanupHandler) throw new Error('Missing items cleanup handler is not initialized')
      const result = await this.missingItemsCleanupHandler(() => this.missingItemsCleanupCancelRequested, libraryIds)
      task.data.result = result
      Logger.info(`[CronManager] 清理丢失项目计划任务结束：${JSON.stringify(result)}`)
      task.setFinished(null, true)
      return result
    } catch (error) {
      task.setFailed(error.message || 'Missing items cleanup failed')
      throw error
    } finally {
      TaskManager.taskFinished(task)
      this.missingItemsCleanupExecuting = false
      this.missingItemsCleanupCancelRequested = false
    }
  }

  cancelMissingItemsCleanup() {
    if (!this.missingItemsCleanupExecuting) return false
    this.missingItemsCleanupCancelRequested = true
    return true
  }

  /**
   * Init cron jobs for auto-download podcasts
   */
  async initPodcastCrons() {
    const cronExpressionMap = {}

    const podcastsWithAutoDownload = await Database.podcastModel.findAll({
      where: {
        autoDownloadEpisodes: true,
        autoDownloadSchedule: {
          [Sequelize.Op.not]: null
        }
      },
      include: {
        model: Database.libraryItemModel
      }
    })

    for (const podcast of podcastsWithAutoDownload) {
      if (!cronExpressionMap[podcast.autoDownloadSchedule]) {
        cronExpressionMap[podcast.autoDownloadSchedule] = {
          expression: podcast.autoDownloadSchedule,
          libraryItemIds: []
        }
      }
      cronExpressionMap[podcast.autoDownloadSchedule].libraryItemIds.push(podcast.libraryItem.id)
    }

    if (!Object.keys(cronExpressionMap).length) return

    Logger.debug(`[CronManager] Found ${Object.keys(cronExpressionMap).length} podcast episode schedules to start`)
    for (const expression in cronExpressionMap) {
      this.startPodcastCron(expression, cronExpressionMap[expression].libraryItemIds)
    }
  }

  startPodcastCron(expression, libraryItemIds) {
    try {
      if (!cron.validate(expression)) {
        Logger.error(`[CronManager] Invalid auto download schedule cron expression "${expression}" - not starting podcast episode check cron`)
        return
      }

      Logger.debug(`[CronManager] Scheduling podcast episode check cron "${expression}" for ${libraryItemIds.length} item(s)`)
      const task = cron.schedule(expression, () => {
        if (this.podcastCronExpressionsExecuting.includes(expression)) {
          Logger.warn(`[CronManager] Podcast cron "${expression}" is already executing`)
        } else {
          this.executePodcastCron(expression, libraryItemIds)
        }
      })
      this.podcastCrons.push({
        libraryItemIds,
        expression,
        task
      })
    } catch (error) {
      Logger.error(`[PodcastManager] Failed to schedule podcast cron ${expression}`, error)
    }
  }

  async executePodcastCron(expression) {
    const podcastCron = this.podcastCrons.find((cron) => cron.expression === expression)
    if (!podcastCron) {
      Logger.error(`[CronManager] Podcast cron not found for expression ${expression}`)
      return
    }
    this.podcastCronExpressionsExecuting.push(expression)

    const libraryItemIds = podcastCron.libraryItemIds
    Logger.debug(`[CronManager] Start executing podcast cron ${expression} for ${libraryItemIds.length} item(s)`)

    // Get podcast library items to check
    const libraryItems = []
    for (const libraryItemId of libraryItemIds) {
      const libraryItem = await Database.libraryItemModel.getExpandedById(libraryItemId)
      if (!libraryItem) {
        Logger.error(`[CronManager] Library item ${libraryItemId} not found for episode check cron ${expression}`)
        podcastCron.libraryItemIds = podcastCron.libraryItemIds.filter((lid) => lid !== libraryItemId) // Filter it out
      } else {
        libraryItems.push(libraryItem)
      }
    }

    // Run episode checks
    for (const libraryItem of libraryItems) {
      const keepAutoDownloading = await this.podcastManager.runEpisodeCheck(libraryItem)
      if (!keepAutoDownloading) {
        // auto download was disabled
        podcastCron.libraryItemIds = podcastCron.libraryItemIds.filter((lid) => lid !== libraryItem.id) // Filter it out
      }
    }

    // Stop and remove cron if no more library items
    if (!podcastCron.libraryItemIds.length) {
      this.removePodcastEpisodeCron(podcastCron)
      return
    }

    Logger.debug(`[CronManager] Finished executing podcast cron ${expression} for ${libraryItems.length} item(s)`)
    this.podcastCronExpressionsExecuting = this.podcastCronExpressionsExecuting.filter((exp) => exp !== expression)
  }

  removePodcastEpisodeCron(podcastCron) {
    Logger.info(`[CronManager] Stopping & removing podcast episode cron for ${podcastCron.expression}`)
    if (podcastCron.task) podcastCron.task.stop()
    this.podcastCrons = this.podcastCrons.filter((pc) => pc.expression !== podcastCron.expression)
  }

  /**
   *
   * @param {import('../models/LibraryItem')} libraryItem
   */
  checkUpdatePodcastCron(libraryItem) {
    // Remove from old cron by library item id
    const existingCron = this.podcastCrons.find((pc) => pc.libraryItemIds.includes(libraryItem.id))
    if (existingCron) {
      existingCron.libraryItemIds = existingCron.libraryItemIds.filter((lid) => lid !== libraryItem.id)
      if (!existingCron.libraryItemIds.length) {
        this.removePodcastEpisodeCron(existingCron)
      }
    }

    // Add to cron or start new cron
    if (libraryItem.media.autoDownloadEpisodes && libraryItem.media.autoDownloadSchedule) {
      const cronMatchingExpression = this.podcastCrons.find((pc) => pc.expression === libraryItem.media.autoDownloadSchedule)
      if (cronMatchingExpression) {
        cronMatchingExpression.libraryItemIds.push(libraryItem.id)

        // TODO: Update after old model removed
        const podcastTitle = libraryItem.media.title || libraryItem.media.metadata?.title
        Logger.info(`[CronManager] Added podcast "${podcastTitle}" to auto dl episode cron "${cronMatchingExpression.expression}"`)
      } else {
        this.startPodcastCron(libraryItem.media.autoDownloadSchedule, [libraryItem.id])
      }
    }
  }
}
module.exports = CronManager
