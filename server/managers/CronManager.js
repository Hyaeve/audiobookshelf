const Sequelize = require('sequelize')
const cron = require('../libs/nodeCron')
const Logger = require('../Logger')
const Database = require('../Database')
const LibraryScanner = require('../scanner/LibraryScanner')
const AiBookMatchManager = require('./AiBookMatchManager')

const ShareManager = require('./ShareManager')
const TaskManager = require('./TaskManager')

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
    this.aiBookMatchExecuting = false
    this.aiBookMatchCancelRequested = false
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
   * Start or stop the scheduled STRM metadata completion task.
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
      Logger.error(`[CronManager] Invalid STRM metadata completion cron expression "${expression}"`)
      return
    }

    const task = cron.schedule(expression, async () => {
      if (this.strmMetadataCron.executing) {
        Logger.warn('[CronManager] STRM metadata completion is already executing')
        return
      }
      this.strmMetadataCron.executing = true
      try {
        await this.playbackSessionManager.completeScheduledStrmMetadata(settings.strmMetadataCompletionMaxHours)
      } finally {
        this.strmMetadataCron.executing = false
      }
    })
    this.strmMetadataCron = { expression, task, executing: false }
  }

  async runStrmMetadataCompletion() {
    return this.playbackSessionManager.completeScheduledStrmMetadata(Database.serverSettings.strmMetadataCompletionMaxHours)
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
    const task = cron.schedule(expression, () => this.runAiBookMatch())
    this.aiBookMatchCron = { expression, task }
  }

  async runAiBookMatch() {
    if (this.aiBookMatchExecuting) return { skipped: true }
    if (!AiBookMatchManager.isConfigured()) throw new Error('AI book matching is not configured')
    this.aiBookMatchExecuting = true
    this.aiBookMatchCancelRequested = false
    const settings = Database.serverSettings
    const libraryIds = Array.isArray(settings.aiBookMatchLibraryIds) ? settings.aiBookMatchLibraryIds : []
    const maxHours = Number(settings.aiBookMatchMaxHours) > 0 ? Number(settings.aiBookMatchMaxHours) : 1
    const deadline = Date.now() + maxHours * 60 * 60 * 1000
    const task = TaskManager.createAndAddTask('ai-book-match', { text: '书籍匹配' }, null, true, { scheduledTask: true, progress: 0, libraryIds })
    const result = { matched: 0, unmatched: 0, needsReview: 0, skipped: 0, cancelled: false }
    const startedAt = Date.now()
    Logger.info(`[CronManager] AI书籍匹配计划任务开始，时间 ${new Date(startedAt).toISOString()}，目标媒体库 ID：${libraryIds.join(', ') || '无'}`)
    try {
      const libraries = await Database.libraryModel.getAllWithFolders()
      const selectedLibraries = libraryIds.map((id) => libraries.find((library) => library.id === id)).filter((library) => library?.mediaType === 'book')
      let processed = 0
      for (const library of selectedLibraries) {
        Logger.info(`[CronManager] AI书籍匹配开始处理媒体库 "${library.name}" (${library.id})`)
        let offset = 0
        while (!this.aiBookMatchCancelRequested && Date.now() < deadline) {
          const items = await Database.libraryItemModel.getLibraryItemsIncrement(offset, 50, { libraryId: library.id, mediaType: 'book', isMissing: false, isInvalid: false })
          if (!items.length) break
          offset += items.length
          for (const libraryItem of items) {
            if (this.aiBookMatchCancelRequested || Date.now() >= deadline) break
            let matchResult
            try {
              matchResult = await AiBookMatchManager.matchLibraryItem(this.apiRouterCtx, libraryItem, library)
            } catch (error) {
              Logger.warn(`[CronManager] AI matching failed for "${libraryItem.id}": ${error.message}`)
              await AiBookMatchManager.saveAudit(libraryItem, { status: 'needs-review', source: 'ai', model: settings.aiBookMatchModel, updatedAt: Date.now(), reason: error.message })
              matchResult = { status: 'needs-review' }
            }
            if (matchResult.status === 'matched') result.matched += 1
            else if (matchResult.status === 'unmatched') result.unmatched += 1
            else if (matchResult.status === 'needs-review') result.needsReview += 1
            else result.skipped += 1
            Logger.info(`[CronManager] AI书籍匹配：媒体库 "${library.name}"，原名称 "${libraryItem.media?.title || libraryItem.title || libraryItem.id}"，搜索标题 "${matchResult.searchTitle || '-'}"，搜索作者 "${matchResult.searchAuthor || '-'}"，结果 ${matchResult.status}${matchResult.candidateTitle ? `，匹配为 "${matchResult.candidateTitle}"` : ''}`)
            processed += 1
            TaskManager.updateTaskProgress(task, selectedLibraries.length ? Math.min(99, ((selectedLibraries.indexOf(library) + 1) / selectedLibraries.length) * 100) : 100, { currentLibrary: library.name, processed, ...result })
          }
          if (items.length < 50) break
        }
      }
      result.cancelled = this.aiBookMatchCancelRequested || Date.now() >= deadline
      Logger.info(`[CronManager] AI书籍匹配计划任务结束，时间 ${new Date().toISOString()}，结果 ${JSON.stringify(result)}`)
      task.data.result = result
      task.setFinished(null, true)
      Database.serverSettings.aiBookMatchLastRun = { startedAt, finishedAt: Date.now(), durationMs: Date.now() - startedAt, ...result }
      await Database.updateServerSettings()
      return result
    } catch (error) {
      task.setFailed({ text: error.message || 'AI book matching failed' })
      throw error
    } finally {
      TaskManager.taskFinished(task)
      this.aiBookMatchExecuting = false
      this.aiBookMatchCancelRequested = false
    }
  }

  cancelAiBookMatch() {
    if (!this.aiBookMatchExecuting) return false
    this.aiBookMatchCancelRequested = true
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
    Logger.info(`[CronManager] 媒体库扫描计划任务开始，时间 ${new Date().toISOString()}，目标媒体库 ID：${libraryIds.join(', ') || '无'}`)
    let currentLibraryId = null
    let scanned = 0
    try {
      const libraries = await Database.libraryModel.getAllWithFolders()
      const selectedLibraries = libraryIds.map((id) => libraries.find((library) => library.id === id)).filter(Boolean)
      for (let index = 0; index < selectedLibraries.length; index += 1) {
        if (this.scheduledLibraryScanCancelRequested || Date.now() >= deadline) break
        const library = selectedLibraries[index]
        Logger.info(`[CronManager] 媒体库扫描开始处理媒体库 "${library.name}" (${library.id})`)
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
        Logger.info(`[CronManager] 媒体库扫描完成处理媒体库 "${library.name}" (${library.id})`)
        TaskManager.updateTaskProgress(task, ((index + 1) / Math.max(selectedLibraries.length, 1)) * 100, { currentLibrary: library.name })
      }
      task.data.result = { scanned, canceled: this.scheduledLibraryScanCancelRequested || Date.now() >= deadline }
      Logger.info(`[CronManager] 媒体库扫描计划任务结束，时间 ${new Date().toISOString()}，结果 ${JSON.stringify(task.data.result)}`)
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
    const task = TaskManager.createAndAddTask('missing-items-cleanup', 'Cleaning missing items', null, true, { scheduledTask: true, progress: 0 })
    Logger.info(`[CronManager] 清理丢失项目计划任务开始，时间 ${new Date().toISOString()}`)
    try {
      if (!this.missingItemsCleanupHandler) throw new Error('Missing items cleanup handler is not initialized')
      const result = await this.missingItemsCleanupHandler(() => this.missingItemsCleanupCancelRequested)
      task.data.result = result
      Logger.info(`[CronManager] 清理丢失项目计划任务结束，时间 ${new Date().toISOString()}，结果 ${JSON.stringify(result)}`)
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
