const uuidv4 = require('uuid').v4
const Path = require('path')
const serverVersion = require('../../package.json').version
const Logger = require('../Logger')
const SocketAuthority = require('../SocketAuthority')
const Database = require('../Database')

const date = require('../libs/dateAndTime')
const fs = require('../libs/fsExtra')
const uaParserJs = require('../libs/uaParser')
const requestIp = require('../libs/requestIp')

const { PlayMethod } = require('../utils/constants')
const { isStrmPath, probeStrmTargetMedia } = require('../utils/strmUtils')
const AudioFileScanner = require('../scanner/AudioFileScanner')
const TaskManager = require('./TaskManager')

const PlaybackSession = require('../objects/PlaybackSession')
const DeviceInfo = require('../objects/DeviceInfo')
const Stream = require('../objects/Stream')

// Playback-triggered and manual STRM media pre-read share the library level
// "strmMetadataQps" setting and a fixed 3000 track / 3 minute pause window.
const DEFAULT_STRM_METADATA_QPS = 2.0
const STRM_METADATA_BATCH_SIZE = 3000
const STRM_METADATA_PAUSE_MINUTES = 3

class PlaybackSessionManager {
  constructor() {
    this.StreamsPath = Path.join(global.MetadataPath, 'streams')

    this.oldPlaybackSessionMap = {} // TODO: Remove after updated mobile versions

    /** @type {PlaybackSession[]} */
    this.sessions = []

    // Every STRM book completion shares one non-preemptive priority queue.
    // Playback requests run before manual requests, which run before scheduled
    // requests. Jobs within the same priority are processed FIFO.
    this.strmCompletionQueues = {
      playback: [],
      manual: [],
      scheduled: []
    }
    this.strmCompletionQueueRunning = false
    this.strmCompletionQueuedIds = new Set()
    this.strmLibraryCompletionTasks = new Map()
    this.strmItemCompletionTasks = new Map()
    this.strmBatchCompletionTasks = new Map()
    this.strmScheduledCompletionTask = null
    this.strmScheduledCompletionCancelRequested = false
    this.strmScheduledCancellation = null
    this.strmManualEnqueueChain = Promise.resolve()
  }

  /**
   * Get open session by id
   *
   * @param {string} sessionId
   * @returns {PlaybackSession}
   */
  getSession(sessionId) {
    return this.sessions.find((s) => s.id === sessionId)
  }
  getUserSession(userId) {
    return this.sessions.find((s) => s.userId === userId)
  }
  getStream(sessionId) {
    const session = this.getSession(sessionId)
    return session?.stream || null
  }

  /**
   *
   * @param {import('../controllers/LibraryItemController').LibraryItemControllerRequest} req
   * @param {Object} [clientDeviceInfo]
   * @returns {Promise<DeviceInfo>}
   */
  async getDeviceInfo(req, clientDeviceInfo = null) {
    const ua = uaParserJs(req.headers['user-agent'])
    const ip = requestIp.getClientIp(req)

    const deviceInfo = new DeviceInfo()
    deviceInfo.setData(ip, ua, clientDeviceInfo, serverVersion, req.user?.id)

    if (clientDeviceInfo?.deviceId) {
      const existingDevice = await Database.deviceModel.getOldDeviceByDeviceId(clientDeviceInfo.deviceId)
      if (existingDevice) {
        if (existingDevice.update(deviceInfo)) {
          await Database.deviceModel.updateFromOld(existingDevice)
        }
        return existingDevice
      }
    }

    await Database.deviceModel.createFromOld(deviceInfo)

    return deviceInfo
  }

  /**
   *
   * @param {import('../controllers/LibraryItemController').LibraryItemControllerRequest} req
   * @param {import('express').Response} res
   * @param {string} [episodeId]
   */
  async startSessionRequest(req, res, episodeId) {
    const deviceInfo = await this.getDeviceInfo(req, req.body?.deviceInfo)
    Logger.debug(`[PlaybackSessionManager] startSessionRequest for device ${deviceInfo.deviceDescription}`)
    const { libraryItem, body: options } = req
    const session = await this.startSession(req.user, deviceInfo, libraryItem, episodeId, options)
    res.json(session.toJSONForClient(libraryItem))

    // Do not delay the first playback response while an incomplete STRM book is scanned.
    if (!episodeId && libraryItem.mediaType === 'book') {
      void this.completeStrmBookAfterPlayback(libraryItem.id).catch((error) => {
        Logger.warn(`[PlaybackSessionManager] 媒体预读启动失败：书籍 "${libraryItem.id}"，原因：${error.message}`)
      })
    }
  }

  /**
   *
   * @param {import('../models/User')} user
   * @param {*} session
   * @param {*} payload
   * @param {import('express').Response} res
   */
  async syncSessionRequest(user, session, payload, res) {
    if (await this.syncSession(user, session, payload)) {
      res.sendStatus(200)
    } else {
      res.sendStatus(500)
    }
  }

  async syncLocalSessionsRequest(req, res) {
    const deviceInfo = await this.getDeviceInfo(req, req.body?.deviceInfo)
    const user = req.user
    const sessions = req.body.sessions || []

    const syncResults = []
    for (const sessionJson of sessions) {
      Logger.info(`[PlaybackSessionManager] Syncing local session "${sessionJson.displayTitle}" (${sessionJson.id}) (updatedAt: ${sessionJson.updatedAt})`)
      const result = await this.syncLocalSession(user, sessionJson, deviceInfo)
      syncResults.push(result)
    }

    res.json({
      results: syncResults
    })
  }

  /**
   *
   * @param {import('../models/User')} user
   * @param {*} sessionJson
   * @param {*} deviceInfo
   * @returns
   */
  async syncLocalSession(user, sessionJson, deviceInfo) {
    // TODO: Combine libraryItem query with library query
    const libraryItem = await Database.libraryItemModel.getExpandedById(sessionJson.libraryItemId)
    const episode = sessionJson.episodeId && libraryItem && libraryItem.isPodcast ? libraryItem.media.podcastEpisodes.find((pe) => pe.id === sessionJson.episodeId) : null
    if (!libraryItem || (libraryItem.isPodcast && !episode)) {
      Logger.error(`[PlaybackSessionManager] syncLocalSession: Media item not found for session "${sessionJson.displayTitle}" (${sessionJson.id})`)
      return {
        id: sessionJson.id,
        success: false,
        error: 'Media item not found'
      }
    }

    const library = await Database.libraryModel.findByPk(libraryItem.libraryId)
    if (!library) {
      Logger.error(`[PlaybackSessionManager] syncLocalSession: Library not found for session "${sessionJson.displayTitle}" (${sessionJson.id})`)
      return {
        id: sessionJson.id,
        success: false,
        error: 'Library not found'
      }
    }

    sessionJson.userId = user.id
    sessionJson.serverVersion = serverVersion

    // TODO: Temp update local playback session id to uuidv4 & library item/book/episode ids
    if (sessionJson.id?.startsWith('play_local_')) {
      if (!this.oldPlaybackSessionMap[sessionJson.id]) {
        const newSessionId = uuidv4()
        this.oldPlaybackSessionMap[sessionJson.id] = newSessionId
        sessionJson.id = newSessionId
      } else {
        sessionJson.id = this.oldPlaybackSessionMap[sessionJson.id]
      }
    }
    if (sessionJson.libraryItemId !== libraryItem.id) {
      Logger.info(`[PlaybackSessionManager] Mapped old libraryItemId "${sessionJson.libraryItemId}" to ${libraryItem.id}`)
      sessionJson.libraryItemId = libraryItem.id
      sessionJson.bookId = episode ? null : libraryItem.media.id
    }
    if (!sessionJson.bookId && !episode) {
      sessionJson.bookId = libraryItem.media.id
    }
    if (episode && sessionJson.episodeId !== episode.id) {
      Logger.info(`[PlaybackSessionManager] Mapped old episodeId "${sessionJson.episodeId}" to ${episode.id}`)
      sessionJson.episodeId = episode.id
    }
    if (sessionJson.libraryId !== libraryItem.libraryId) {
      sessionJson.libraryId = libraryItem.libraryId
    }

    let session = await Database.getPlaybackSession(sessionJson.id)
    if (!session) {
      // New session from local
      session = new PlaybackSession(sessionJson)
      session.deviceInfo = deviceInfo

      if (session.mediaMetadata == null) {
        session.mediaMetadata = {}
      }

      // Populate mediaMetadata with the current library items metadata for any keys not set by client
      const libraryItemMediaMetadata = libraryItem.media.oldMetadataToJSON()
      for (const key in libraryItemMediaMetadata) {
        if (session.mediaMetadata[key] === undefined) {
          session.mediaMetadata[key] = libraryItemMediaMetadata[key]
        }
      }

      if (session.displayTitle == null || session.displayTitle === '') {
        session.displayTitle = libraryItem.title
      }
      if (session.displayAuthor == null || session.displayAuthor === '') {
        session.displayAuthor = libraryItem.authorNamesFirstLast
      }
      session.duration = libraryItem.media.getPlaybackDuration(sessionJson.episodeId)

      Logger.debug(`[PlaybackSessionManager] Inserting new session for "${session.displayTitle}" (${session.id})`)
      await Database.createPlaybackSession(session)
    } else {
      session.currentTime = sessionJson.currentTime
      session.timeListening = sessionJson.timeListening
      session.updatedAt = sessionJson.updatedAt

      let jsDate = new Date(sessionJson.updatedAt)
      if (isNaN(jsDate)) {
        jsDate = new Date()
      }
      session.date = date.format(jsDate, 'YYYY-MM-DD')
      session.dayOfWeek = date.format(jsDate, 'dddd')

      Logger.debug(`[PlaybackSessionManager] Updated session for "${session.displayTitle}" (${session.id})`)
      await Database.updatePlaybackSession(session)
    }

    const result = {
      id: session.id,
      success: true,
      progressSynced: false
    }

    const mediaItemId = session.episodeId || libraryItem.media.id
    let userProgressForItem = user.getMediaProgress(mediaItemId)
    if (userProgressForItem) {
      if (userProgressForItem.updatedAt.valueOf() > session.updatedAt) {
        Logger.info(`[PlaybackSessionManager] Not updating progress for "${session.displayTitle}" because it has been updated more recently (${userProgressForItem.updatedAt.valueOf()} > ${session.updatedAt}) (incoming currentTime: ${session.currentTime}) (current currentTime: ${userProgressForItem.currentTime})`)
      } else {
        Logger.info(`[PlaybackSessionManager] Updating progress for "${session.displayTitle}" with current time ${session.currentTime} (previously ${userProgressForItem.currentTime})`)
        const updateResponse = await user.createUpdateMediaProgressFromPayload({
          libraryItemId: libraryItem.id,
          episodeId: session.episodeId,
          ...session.mediaProgressObject,
          markAsFinishedPercentComplete: library.librarySettings.markAsFinishedPercentComplete,
          markAsFinishedTimeRemaining: library.librarySettings.markAsFinishedTimeRemaining
        })
        result.progressSynced = !!updateResponse.mediaProgress
        if (result.progressSynced) {
          userProgressForItem = updateResponse.mediaProgress
        }
      }
    } else {
      Logger.info(`[PlaybackSessionManager] Creating new media progress for media item "${session.displayTitle}"`)
      const updateResponse = await user.createUpdateMediaProgressFromPayload({
        libraryItemId: libraryItem.id,
        episodeId: session.episodeId,
        ...session.mediaProgressObject,
        markAsFinishedPercentComplete: library.librarySettings.markAsFinishedPercentComplete,
        markAsFinishedTimeRemaining: library.librarySettings.markAsFinishedTimeRemaining
      })
      result.progressSynced = !!updateResponse.mediaProgress
      if (result.progressSynced) {
        userProgressForItem = updateResponse.mediaProgress
      }
    }

    // Update user and emit socket event
    if (result.progressSynced) {
      SocketAuthority.clientEmitter(user.id, 'user_item_progress_updated', {
        id: userProgressForItem.id,
        sessionId: session.id,
        deviceDescription: session.deviceDescription,
        data: userProgressForItem.getOldMediaProgress()
      })
    }

    return result
  }

  /**
   *
   * @param {import('../controllers/SessionController').RequestWithUser} req
   * @param {*} res
   */
  async syncLocalSessionRequest(req, res) {
    const deviceInfo = await this.getDeviceInfo(req, req.body?.deviceInfo)
    const sessionJson = req.body
    const result = await this.syncLocalSession(req.user, sessionJson, deviceInfo)
    if (result.error) {
      res.status(500).send(result.error)
    } else {
      res.sendStatus(200)
    }
  }

  /**
   *
   * @param {import('../models/User')} user
   * @param {*} session
   * @param {*} syncData
   * @param {import('express').Response} res
   */
  async closeSessionRequest(user, session, syncData, res) {
    await this.closeSession(user, session, syncData)
    res.sendStatus(200)
  }

  /**
   *
   * @param {import('../models/User')} user
   * @param {DeviceInfo} deviceInfo
   * @param {import('../models/LibraryItem')} libraryItem
   * @param {string|null} episodeId
   * @param {{forceDirectPlay?:boolean, forceTranscode?:boolean, mediaPlayer:string, supportedMimeTypes?:string[]}} options
   * @returns {Promise<PlaybackSession>}
   */
  async startSession(user, deviceInfo, libraryItem, episodeId, options) {
    // Close any sessions already open for user and device
    const userSessions = this.sessions.filter((playbackSession) => playbackSession.userId === user.id && playbackSession.deviceId === deviceInfo.id)
    for (const session of userSessions) {
      Logger.info(`[PlaybackSessionManager] startSession: Closing open session "${session.displayTitle}" for user "${user.username}" (Device: ${session.deviceDescription})`)
      await this.closeSession(user, session, null)
    }

    const bookStrmAudio = (libraryItem.media?.includedAudioFiles || []).some((audioFile) => {
      return audioFile.metadata?.format === 'strm' || Path.extname(audioFile.metadata?.path || '').toLowerCase() === '.strm'
    })
    const podcastStrmAudio = (libraryItem.media?.podcastEpisodes || []).some((episode) => {
      if (episodeId && episode.id !== episodeId) return false
      const audioFile = episode.audioFile
      return audioFile?.metadata?.format === 'strm' || Path.extname(audioFile?.metadata?.path || '').toLowerCase() === '.strm'
    })
    const hasStrmAudio = bookStrmAudio || podcastStrmAudio
    if (hasStrmAudio) {
      Logger.info(`[PlaybackSessionManager] STRM media detected for item "${libraryItem.id}"; forcing direct proxy playback`)
    }
    const shouldDirectPlay = hasStrmAudio || options.forceDirectPlay || (!options.forceTranscode && libraryItem.media.checkCanDirectPlay(options.supportedMimeTypes, episodeId))
    const mediaPlayer = options.mediaPlayer || 'unknown'

    const mediaItemId = episodeId || libraryItem.media.id
    const userProgress = user.getMediaProgress(mediaItemId)
    let userStartTime = 0
    if (userProgress) {
      if (userProgress.isFinished) {
        Logger.info(`[PlaybackSessionManager] Starting session for user "${user.username}" and resetting progress for finished item "${libraryItem.media.title}"`)
        // Keep userStartTime as 0 so the client restarts the media
      } else {
        userStartTime = Number.parseFloat(userProgress.currentTime) || 0
      }
    }
    const newPlaybackSession = new PlaybackSession()
    newPlaybackSession.setData(libraryItem, user.id, mediaPlayer, deviceInfo, userStartTime, episodeId)

    let audioTracks = []
    if (shouldDirectPlay) {
      Logger.debug(`[PlaybackSessionManager] "${user.username}" starting direct play session for item "${libraryItem.id}" with id ${newPlaybackSession.id} (Device: ${newPlaybackSession.deviceDescription})`)
      audioTracks = libraryItem.getTrackList(episodeId)
      newPlaybackSession.playMethod = PlayMethod.DIRECTPLAY
    } else {
      Logger.debug(`[PlaybackSessionManager] "${user.username}" starting stream session for item "${libraryItem.id}" (Device: ${newPlaybackSession.deviceDescription})`)
      const stream = new Stream(newPlaybackSession.id, this.StreamsPath, user, libraryItem, episodeId, userStartTime)
      await stream.generatePlaylist()
      stream.start() // Start transcode

      audioTracks = [stream.getAudioTrack()]
      newPlaybackSession.stream = stream
      newPlaybackSession.playMethod = PlayMethod.TRANSCODE

      stream.on('closed', () => {
        Logger.debug(`[PlaybackSessionManager] Stream closed for session "${newPlaybackSession.id}" (Device: ${newPlaybackSession.deviceDescription})`)
        newPlaybackSession.stream = null
      })
    }
    newPlaybackSession.audioTracks = audioTracks

    this.sessions.push(newPlaybackSession)
    SocketAuthority.adminEmitter('user_stream_update', user.toJSONForPublic(this.sessions))

    return newPlaybackSession
  }

  /**
   *
   * @param {import('../models/User')} user
   * @param {*} session
   * @param {*} syncData
   * @returns {Promise<boolean>}
   */
  async syncSession(user, session, syncData) {
    // TODO: Combine libraryItem query with library query
    const libraryItem = await Database.libraryItemModel.getExpandedById(session.libraryItemId)
    if (!libraryItem) {
      Logger.error(`[PlaybackSessionManager] syncSession Library Item not found "${session.libraryItemId}"`)
      return false
    }

    const library = await Database.libraryModel.findByPk(libraryItem.libraryId)
    if (!library) {
      Logger.error(`[PlaybackSessionManager] syncSession Library not found "${libraryItem.libraryId}"`)
      return false
    }

    session.currentTime = syncData.currentTime
    session.addListeningTime(syncData.timeListened)
    Logger.debug(`[PlaybackSessionManager] syncSession "${session.id}" (Device: ${session.deviceDescription}) | Total Time Listened: ${session.timeListening}`)

    const updateResponse = await user.createUpdateMediaProgressFromPayload({
      libraryItemId: libraryItem.id,
      episodeId: session.episodeId,
      // duration no longer required (v2.15.1) but used if available
      duration: syncData.duration || session.duration || 0,
      currentTime: syncData.currentTime,
      progress: session.progress,
      markAsFinishedTimeRemaining: library.librarySettings.markAsFinishedTimeRemaining,
      markAsFinishedPercentComplete: library.librarySettings.markAsFinishedPercentComplete
    })
    if (updateResponse.mediaProgress) {
      SocketAuthority.clientEmitter(user.id, 'user_item_progress_updated', {
        id: updateResponse.mediaProgress.id,
        sessionId: session.id,
        deviceDescription: session.deviceDescription,
        data: updateResponse.mediaProgress.getOldMediaProgress()
      })
    }
    this.saveSession(session)

    return true
  }

  /**
   *
   * @param {import('../models/User')} user
   * @param {*} session
   * @param {*} syncData
   * @returns
   */
  async closeSession(user, session, syncData = null) {
    if (syncData) {
      await this.syncSession(user, session, syncData)
    } else {
      await this.saveSession(session)
    }
    Logger.debug(`[PlaybackSessionManager] closeSession "${session.id}"`)
    SocketAuthority.adminEmitter('user_stream_update', user.toJSONForPublic(this.sessions))
    SocketAuthority.clientEmitter(session.userId, 'user_session_closed', session.id)
    return this.removeSession(session.id)
  }

  saveSession(session) {
    if (!session.timeListening) return // Do not save a session with no listening time

    if (session.lastSave) {
      return Database.updatePlaybackSession(session)
    } else {
      session.lastSave = Date.now()
      return Database.createPlaybackSession(session)
    }
  }

  enqueueStrmBookCompletion(priority, libraryItemId, execute) {
    if (!this.strmCompletionQueues[priority]) throw new Error(`Invalid STRM completion priority: ${priority}`)

    return new Promise((resolve, reject) => {
      this.strmCompletionQueues[priority].push({ libraryItemId, execute, resolve, reject })
      Logger.debug(`[PlaybackSessionManager] 媒体预读已进入 ${priority} 队列：书籍 "${libraryItemId}"`)
      void this.processStrmCompletionQueue()
    })
  }

  async processStrmCompletionQueue() {
    if (this.strmCompletionQueueRunning) return
    this.strmCompletionQueueRunning = true

    try {
      while (true) {
        const priority = ['playback', 'manual', 'scheduled']
          .find((queuePriority) => this.strmCompletionQueues[queuePriority].length)
        if (!priority) break

        const job = this.strmCompletionQueues[priority].shift()
        Logger.debug(`[PlaybackSessionManager] 开始执行 ${priority} 媒体预读：书籍 "${job.libraryItemId}"`)
        try {
          job.resolve(await job.execute())
        } catch (error) {
          job.reject(error)
        }
      }
    } finally {
      this.strmCompletionQueueRunning = false
      // A job may have been queued after the loop observed empty queues but
      // before the running flag was cleared.
      if (Object.values(this.strmCompletionQueues).some((queue) => queue.length)) {
        void this.processStrmCompletionQueue()
      }
    }
  }

  queueStrmBookById(priority, libraryItemId, options) {
    return this.enqueueStrmBookCompletion(priority, libraryItemId, async () => {
      if (options.isCancelled?.()) return false

      const libraryItem = await Database.libraryItemModel.getExpandedById(libraryItemId)
      if (!libraryItem?.media || libraryItem.mediaType !== 'book') return false
      if (this.isCompleteStrmBookMetadata(libraryItem)) return false

      const strmFiles = (libraryItem.media.audioFiles || [])
        .filter((audioFile) => isStrmPath(audioFile.metadata?.path) && !this.isCompleteStrmAudioFile(audioFile))
      if (!strmFiles.length) return false

      options.onStarted?.(libraryItem, strmFiles)
      try {
        const result = await this.completeStrmBook(libraryItem, strmFiles, options)
        options.onCompleted?.(libraryItem, strmFiles, result)
        return result
      } catch (error) {
        options.onFailed?.(libraryItem, strmFiles, error)
        throw error
      }
    })
  }

  enqueueManualStrmOperation(prepareJobs) {
    const operation = this.strmManualEnqueueChain
      .catch(() => {})
      .then(prepareJobs)
    this.strmManualEnqueueChain = operation.then(() => undefined, () => undefined)
    return operation
  }

  isCompleteStrmAudioFile(audioFile) {
    return Number(audioFile.duration) > 0
      && !!audioFile.codec
      && Number(audioFile.channels) > 0
  }

  getStrmBookMetadataStatus(libraryItem) {
    const allAudioFiles = libraryItem?.media?.audioFiles || []
    const strmFiles = allAudioFiles.filter((audioFile) => isStrmPath(audioFile.metadata?.path))
    const completedTracks = strmFiles.filter((audioFile) => this.isCompleteStrmAudioFile(audioFile)).length
    const totalTracks = strmFiles.length
    return {
      totalTracks,
      completedTracks,
      incompleteTracks: Math.max(0, totalTracks - completedTracks),
      percent: totalTracks ? Math.round((completedTracks / totalTracks) * 100) : 0,
      isComplete: totalTracks > 0 && completedTracks === totalTracks
    }
  }

  isCompleteStrmBookMetadata(libraryItem) {
    return this.getStrmBookMetadataStatus(libraryItem).isComplete
  }

  /**
   * Media pre-read QPS configured on the library. Shared by playback-triggered
   * and every manual pre-read entry for books in that library.
   *
   * @param {Object} library
   * @returns {number}
   */
  getLibraryStrmQps(library) {
    const qps = Number(library?.settings?.strmMetadataQps)
    if (!Number.isFinite(qps) || qps < 0.1 || qps > 10) return DEFAULT_STRM_METADATA_QPS
    return qps
  }

  async completeStrmBookAfterPlayback(libraryItemId) {
    if (this.strmCompletionQueuedIds.has(libraryItemId)) return false
    this.strmCompletionQueuedIds.add(libraryItemId)

    return this.enqueueStrmBookCompletion('playback', libraryItemId, async () => {
      try {
        const libraryItem = await Database.libraryItemModel.getExpandedById(libraryItemId)
        if (!libraryItem?.media || libraryItem.mediaType !== 'book') return false

        const allStrmFiles = (libraryItem.media.audioFiles || [])
          .filter((audioFile) => isStrmPath(audioFile.metadata?.path))
        if (!allStrmFiles.length || this.isCompleteStrmBookMetadata(libraryItem)) return false

        const strmFiles = allStrmFiles.filter((audioFile) => !this.isCompleteStrmAudioFile(audioFile))
        Logger.info(`[PlaybackSessionManager] 媒体预读开始：书籍 "${libraryItem.media.title || '未命名'}"，待预读音轨：${strmFiles.length}`)
        const result = await this.completeStrmBook(libraryItem, strmFiles, {
          useLibraryQps: true,
          throttleState: {
            scannedTracks: 0,
            requestIntervalMs: 1000 / DEFAULT_STRM_METADATA_QPS,
            batchSize: STRM_METADATA_BATCH_SIZE,
            pauseMinutes: STRM_METADATA_PAUSE_MINUTES
          }
        })
        Logger.info(`[PlaybackSessionManager] 媒体预读完成：书籍 "${libraryItem.media.title || '未命名'}"，结果：${result ? '已更新' : '未更新'}`)
        return result
      } catch (error) {
        Logger.warn(`[PlaybackSessionManager] 媒体预读失败：书籍 "${libraryItemId}"，原因：${error.message}`)
        return false
      } finally {
        this.strmCompletionQueuedIds.delete(libraryItemId)
      }
    })
  }

  async completeStrmBook(libraryItem, strmFiles, options = {}) {
    const isCancelled = options.isCancelled || (() => false)
    const wait = (durationMs) => new Promise((resolve) => {
      const startedAt = Date.now()
      const check = () => {
        if (isCancelled() || Date.now() - startedAt >= durationMs) return resolve()
        setTimeout(check, Math.min(1000, durationMs - (Date.now() - startedAt)))
      }
      check()
    })
    const library = await Database.libraryModel.findByIdWithFolders(libraryItem.libraryId)
    const allowedLocalRoots = (library?.libraryFolders || []).map((folder) => folder.path)
    const totalStrmFiles = (libraryItem.media.audioFiles || []).filter((audioFile) => isStrmPath(audioFile.metadata?.path)).length
    const qps = options.useLibraryQps ? this.getLibraryStrmQps(library) : Number(options.qps) > 0 ? Number(options.qps) : 0.5
    const requestIntervalMs = 1000 / qps
    if (options.throttleState) options.throttleState.requestIntervalMs = requestIntervalMs
    const persistBatchSize = 50
    let updatedCount = 0
    let pendingPersistCount = 0

    const rebuildBookAggregation = () => {
      libraryItem.media.audioFiles = AudioFileScanner.runSmartTrackOrder(libraryItem.relPath, libraryItem.media.audioFiles)
      let duration = 0
      const chapters = []
      let chapterId = 0
      const hasEmbeddedChapters = libraryItem.media.audioFiles.some((audioFile) => audioFile.chapters?.length)
      for (const [index, audioFile] of libraryItem.media.audioFiles.entries()) {
        const fileDuration = Number(audioFile.duration) > 0 ? Number(audioFile.duration) : 0
        if (!fileDuration) continue

        if (hasEmbeddedChapters && audioFile.chapters?.length) {
          for (const chapter of audioFile.chapters) {
            const start = duration + Math.max(0, Number(chapter.start) || 0)
            const end = duration + Math.min(fileDuration, Number(chapter.end) || fileDuration)
            if (end > start) chapters.push({ ...chapter, id: chapterId++, start, end })
          }
        } else {
          chapters.push({
            id: chapterId++,
            start: duration,
            end: duration + fileDuration,
            title: audioFile.metadata?.filename || `Chapter ${index + 1}`
          })
        }
        duration += fileDuration
      }
      libraryItem.media.duration = duration
      libraryItem.media.chapters = chapters
    }

    const persistProgress = async (force = false) => {
      if (!pendingPersistCount || (!force && pendingPersistCount < persistBatchSize)) return false
      rebuildBookAggregation()
      libraryItem.media.changed('audioFiles', true)
      libraryItem.media.changed('chapters', true)
      try {
        await libraryItem.media.save()
        await libraryItem.saveMetadataFile()
        pendingPersistCount = 0
        SocketAuthority.libraryItemEmitter('item_updated', libraryItem)
        return true
      } catch (error) {
        Logger.error(`[PlaybackSessionManager] Failed to persist partial STRM metadata for book "${libraryItem.id}": ${error.message}`)
        return false
      }
    }

    if (strmFiles.length) {
      Logger.info(`[PlaybackSessionManager] Starting full STRM scan for book "${libraryItem.id}" (${strmFiles.length}/${totalStrmFiles} incomplete files, QPS ${qps})`)
    } else {
      Logger.info(`[PlaybackSessionManager] Rebuilding book metadata from ${totalStrmFiles} completed STRM tracks for book "${libraryItem.id}"`)
    }

    const completeAudioFile = async (audioFile) => {
      try {
        const probeData = await probeStrmTargetMedia(audioFile.metadata.path, allowedLocalRoots)
        if (!probeData || probeData.error || !(Number(probeData.duration) > 0)) {
          const reason = probeData?.error || 'duration was not detected'
          Logger.warn(`[PlaybackSessionManager] Unable to probe STRM target for "${audioFile.metadata.path}": ${reason}`)
          return
        }

        // Keep the STRM identity and pointer path so playback remains proxied.
        audioFile.duration = probeData.duration
        audioFile.bitRate = probeData.bitRate || null
        audioFile.codec = probeData.codec || null
        audioFile.timeBase = probeData.timeBase || null
        audioFile.language = probeData.language || null
        audioFile.channels = probeData.channels || null
        audioFile.channelLayout = probeData.channelLayout || null
        audioFile.chapters = probeData.chapters || []
        audioFile.metaTags = probeData.audioMetaTags || audioFile.metaTags
        if (audioFile.metaTags?.trackNumber !== undefined) audioFile.trackNumFromMeta = audioFile.metaTags.trackNumber
        if (audioFile.metaTags?.discNumber !== undefined) audioFile.discNumFromMeta = audioFile.metaTags.discNumber
        audioFile.updatedAt = Date.now()
        updatedCount += 1
        pendingPersistCount += 1
      } catch (error) {
        Logger.warn(`[PlaybackSessionManager] Failed to complete STRM metadata for "${audioFile.metadata.path}": ${error.message}`)
      }
    }

    for (const [index, audioFile] of strmFiles.entries()) {
      if (isCancelled()) {
        await persistProgress(true)
        return false
      }
      if (options.throttleState) {
        if (options.throttleState.scannedTracks > 0) await wait(options.throttleState.requestIntervalMs)
        options.throttleState.scannedTracks += 1
        options.throttleState.onTrackScanned?.()
      } else if (index > 0) {
        await wait(requestIntervalMs)
      }
      if (isCancelled()) {
        await persistProgress(true)
        return false
      }
      await completeAudioFile(audioFile)
      await persistProgress()
      if (options.throttleState?.deadline && Date.now() >= options.throttleState.deadline) {
        Logger.info(`[PlaybackSessionManager] 媒体预读达到时间限制，已处理 ${options.throttleState.scannedTracks} 条音轨`)
        break
      }
      if (options.throttleState?.batchSize && options.throttleState.scannedTracks % options.throttleState.batchSize === 0) {
        const pauseMinutes = Number(options.throttleState.pauseMinutes) > 0 ? Number(options.throttleState.pauseMinutes) : 5
        Logger.info(`[PlaybackSessionManager] 媒体预读已处理 ${options.throttleState.scannedTracks} 条音轨，暂停 ${pauseMinutes} 分钟`)
        await wait(pauseMinutes * 60 * 1000)
      }
    }

    if (isCancelled()) {
      await persistProgress(true)
      return updatedCount > 0
    }
    if (strmFiles.length && !updatedCount) return false
    await persistProgress(true)
    if (strmFiles.length) {
      Logger.info(`[PlaybackSessionManager] Completed metadata for ${updatedCount}/${strmFiles.length} STRM tracks in book "${libraryItem.id}"`)
    }

    rebuildBookAggregation()
    libraryItem.media.changed('audioFiles', true)
    libraryItem.media.changed('chapters', true)
    await libraryItem.media.save()
    await libraryItem.saveMetadataFile()
    SocketAuthority.libraryItemEmitter('item_updated', libraryItem)
    Logger.info(`[PlaybackSessionManager] Completed STRM metadata for book "${libraryItem.id}" (${updatedCount}/${strmFiles.length} files)`)
    return true
  }

  async completeStrmLibrary(libraryId) {
    const existingTask = this.strmLibraryCompletionTasks.get(libraryId)
    if (existingTask) return existingTask

    const completionTask = this._completeStrmLibrary(libraryId)
      .finally(() => this.strmLibraryCompletionTasks.delete(libraryId))
    this.strmLibraryCompletionTasks.set(libraryId, completionTask)
    return completionTask
  }

  async _completeStrmLibrary(libraryId) {
    return this.enqueueManualStrmOperation(async () => {
      const library = await Database.libraryModel.findByIdWithFolders(libraryId)
      if (!library) throw new Error(`Library not found: ${libraryId}`)
      if (library.mediaType !== 'book') return { books: 0, updated: 0 }

      const items = await Database.libraryItemModel.findAll({ where: { libraryId } })
      const task = TaskManager.createAndAddTask('strm-metadata-completion', {
        text: `媒体预读：${library.name}`,
        key: 'MessageTaskCompletingStrmMetadata',
        subs: [library.name]
      }, null, true, {
        libraryId,
        libraryName: library.name,
        totalBooks: items.length,
        updatedBooks: 0,
        totalTracks: 0,
        scannedTracks: 0,
        progress: 0,
        manualLibraryTask: true
      })
      const throttleState = {
        scannedTracks: 0,
        requestIntervalMs: 1000 / this.getLibraryStrmQps(library),
        batchSize: STRM_METADATA_BATCH_SIZE,
        pauseMinutes: STRM_METADATA_PAUSE_MINUTES,
        onTrackScanned: () => {
          task.data.scannedTracks = throttleState.scannedTracks
          const totalTracks = Math.max(1, task.data.totalTracks)
          task.data.progress = Math.min(100, (task.data.scannedTracks / totalTracks) * 100)
          TaskManager.updateTaskProgress(task, task.data.progress)
        }
      }
      const jobs = items.map((item) => this.queueStrmBookById('manual', item.id, {
        useLibraryQps: true,
        manualLibraryTask: true,
        throttleState,
        onStarted: (libraryItem, strmFiles) => {
          task.data.totalTracks += strmFiles.length
          task.titleSubs = [libraryItem.media.title || libraryItem.title || libraryItem.id]
          TaskManager.updateTaskProgress(task, task.data.progress)
        }
      }))

      return Promise.all(jobs)
        .then((results) => {
          const updated = results.filter(Boolean).length
          task.data.updatedBooks = updated
          task.data.result = { books: items.length, updated, totalTracks: task.data.totalTracks, scannedTracks: task.data.scannedTracks }
          task.setFinished(null, true)
          return task.data.result
        })
        .catch((error) => {
          Logger.error(`[PlaybackSessionManager] 媒体库媒体预读失败：媒体库 "${libraryId}"`, error)
          task.setFailed({ text: 'Failed', key: 'MessageTaskFailed' })
          throw error
        })
        .finally(() => TaskManager.taskFinished(task))
    })
  }

  async completeStrmItem(libraryItemId) {
    const existingTask = this.strmItemCompletionTasks.get(libraryItemId)
    if (existingTask) return existingTask

    const task = this.enqueueManualStrmOperation(() => this.queueStrmBookById('manual', libraryItemId, {
      useLibraryQps: true,
      throttleState: {
        scannedTracks: 0,
        requestIntervalMs: 1000 / DEFAULT_STRM_METADATA_QPS,
        batchSize: STRM_METADATA_BATCH_SIZE,
        pauseMinutes: STRM_METADATA_PAUSE_MINUTES
      }
    }))
      .catch((error) => {
        Logger.warn(`[PlaybackSessionManager] 媒体预读失败：项目 "${libraryItemId}"，原因：${error.message}`)
        return false
      })
      .finally(() => this.strmItemCompletionTasks.delete(libraryItemId))

    this.strmItemCompletionTasks.set(libraryItemId, task)
    return task
  }

  async completeScheduledStrmMetadata(maxHours = 1, libraryIds = []) {
    if (this.strmScheduledCompletionTask) return this.strmScheduledCompletionTask

    const cancellation = { requested: false }
    this.strmScheduledCompletionCancelRequested = false
    this.strmScheduledCancellation = cancellation
    let task = null
    this.strmScheduledCompletionTask = (async () => {
      const startedAt = Date.now()
      const deadline = startedAt + Math.max(0.5, Number(maxHours) || 1) * 60 * 60 * 1000
      task = TaskManager.createAndAddTask('strm-metadata-completion', {
        text: '媒体预读',
        key: 'MessageTaskCompletingStrmMetadata',
        subs: ['']
      }, null, true, { scheduledTask: true, totalBooks: 0, updatedBooks: 0, totalTracks: 0, scannedTracks: 0, progress: 0 })
      const selectedLibraryIds = Array.isArray(libraryIds) ? libraryIds : []
      const items = selectedLibraryIds.length
        ? await Database.libraryItemModel.findAllExpandedWhere({ mediaType: 'book', libraryId: selectedLibraryIds })
        : []
      const libraries = await Database.libraryModel.getAllWithFolders()
      const libraryNames = new Map(libraries.map((library) => [library.id, library.name]))
      const getLibraryName = (libraryId) => libraryNames.get(libraryId) || libraryId || '未知媒体库'
      task.data.totalBooks = items.length
      task.data.libraryIds = selectedLibraryIds
      let currentTitle = ''
      const updateProgress = (title = currentTitle) => {
        const totalTracks = Math.max(1, task.data.totalTracks || 1)
        const progress = Math.min(100, (task.data.scannedTracks / totalTracks) * 100)
        if (title) currentTitle = title
        task.titleSubs = [currentTitle]
        TaskManager.updateTaskProgress(task, progress)
      }
      const settings = Database.serverSettings
      const throttleState = {
        scannedTracks: 0,
        requestIntervalMs: 1000 / settings.strmMetadataCompletionQps,
        batchSize: settings.strmMetadataCompletionBatchSize,
        deadline,
        onTrackScanned: () => {
          task.data.scannedTracks += 1
          updateProgress()
        }
      }
      let updated = 0

      const jobs = items.map((libraryItem) => this.queueStrmBookById('scheduled', libraryItem.id, {
        qps: settings.strmMetadataCompletionQps,
        throttleState,
        isCancelled: () => cancellation.requested || Date.now() >= deadline,
        onStarted: (expandedItem, strmFiles) => {
          task.data.totalTracks += strmFiles.length
          Logger.info(`[PlaybackSessionManager] 媒体预读开始：媒体库：${getLibraryName(expandedItem.libraryId)}，书籍："${expandedItem.media.title || expandedItem.id}"，待预读音轨：${strmFiles.length}`)
          updateProgress(expandedItem.media.title || expandedItem.title || expandedItem.id)
        },
        onCompleted: (expandedItem, strmFiles, result) => {
          Logger.info(`[PlaybackSessionManager] 媒体预读完成：媒体库：${getLibraryName(expandedItem.libraryId)}，书籍："${expandedItem.media.title || expandedItem.id}"，结果：${result ? '已更新' : '未更新'}`)
        },
        onFailed: (expandedItem, strmFiles, error) => {
          Logger.warn(`[PlaybackSessionManager] 媒体预读失败：媒体库：${getLibraryName(expandedItem.libraryId)}，书籍："${expandedItem.media.title || expandedItem.id}"，原因：${error.message}`)
        }
      }))
      const results = await Promise.all(jobs)
      updated = results.filter(Boolean).length

      const finishedAt = Date.now()
      const cancelled = this.strmScheduledCompletionCancelRequested
      Logger.info(`[PlaybackSessionManager] 媒体预读任务结束，时间 ${new Date(finishedAt).toISOString()}，处理书籍：${items.length}，更新书籍：${updated}，已取消：${cancelled}`)
      task.data.result = { books: items.length, updated, cancelled }
      task.setFinished(null, true)
      TaskManager.taskFinished(task)
      return {
        books: items.length,
        updated,
        cancelled,
        startedAt,
        finishedAt,
        durationMs: finishedAt - startedAt
      }
    })()
      .catch((error) => {
        Logger.error(`[PlaybackSessionManager] 计划媒体预读失败`, error)
        if (task && !task.isFinished) {
          task.setFailed({
            text: error.message || '媒体预读失败',
            key: 'MessageTaskCompletingStrmMetadataFailed'
          })
          TaskManager.taskFinished(task)
        }
        throw error
      })
      .finally(() => {
        this.strmScheduledCompletionTask = null
        this.strmScheduledCancellation = null
        this.strmScheduledCompletionCancelRequested = false
      })

    return this.strmScheduledCompletionTask
  }

  cancelScheduledStrmMetadata() {
    if (!this.strmScheduledCompletionTask) return false
    this.strmScheduledCompletionCancelRequested = true
    if (this.strmScheduledCancellation) this.strmScheduledCancellation.requested = true
    return true
  }

  async completeStrmItems(libraryItemIds) {
    const taskKey = [...libraryItemIds].sort().join(',')
    const existingTask = this.strmBatchCompletionTasks.get(taskKey)
    if (existingTask) return existingTask

    const task = this.enqueueManualStrmOperation(async () => {
      const items = await Database.libraryItemModel.findAllExpandedWhere({ id: libraryItemIds })
      const throttleState = {
        scannedTracks: 0,
        requestIntervalMs: 1000 / DEFAULT_STRM_METADATA_QPS,
        batchSize: STRM_METADATA_BATCH_SIZE,
        pauseMinutes: STRM_METADATA_PAUSE_MINUTES
      }
      const jobs = items.map((libraryItem) => this.queueStrmBookById('manual', libraryItem.id, {
        useLibraryQps: true,
        throttleState
      }))
      const results = await Promise.all(jobs)
      return { books: items.length, updated: results.filter(Boolean).length }
    })
      .catch((error) => {
        Logger.warn(`[PlaybackSessionManager] 批量媒体预读失败：${error.message}`)
        throw error
      })
      .finally(() => this.strmBatchCompletionTasks.delete(taskKey))

    this.strmBatchCompletionTasks.set(taskKey, task)
    return task
  }

  async removeSession(sessionId) {
    const session = this.sessions.find((s) => s.id === sessionId)
    if (!session) return
    if (session.stream) {
      await session.stream.close()
    }
    this.sessions = this.sessions.filter((s) => s.id !== sessionId)
    Logger.debug(`[PlaybackSessionManager] Removed session "${sessionId}"`)
  }

  /**
   * Remove all stream folders in `/metadata/streams`
   */
  async removeOrphanStreams() {
    try {
      await fs.ensureDir(this.StreamsPath)
    } catch (error) {
      Logger.error(`[PlaybackSessionManager] Failed to create streams directory at "${this.StreamsPath}": ${error.message}`)
      throw new Error(`[PlaybackSessionManager] Failed to create streams directory at "${this.StreamsPath}"`, { cause: error })
    }
    try {
      const streamsInPath = await fs.readdir(this.StreamsPath)
      for (const streamId of streamsInPath) {
        if (/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/.test(streamId)) {
          // Ensure is uuidv4
          const session = this.sessions.find((se) => se.id === streamId)
          if (!session) {
            const streamPath = Path.join(this.StreamsPath, streamId)
            Logger.debug(`[PlaybackSessionManager] Removing orphan stream "${streamPath}"`)
            await fs.remove(streamPath)
          }
        }
      }
    } catch (error) {
      Logger.error(`[PlaybackSessionManager] cleanOrphanStreams failed`, error)
    }
  }

  /**
   * Close all open sessions that have not been updated in the last 36 hours
   */
  async closeStaleOpenSessions() {
    const updatedAtTimeCutoff = Date.now() - 1000 * 60 * 60 * 36
    const staleSessions = this.sessions.filter((session) => session.updatedAt < updatedAtTimeCutoff)
    for (const session of staleSessions) {
      const sessionLastUpdate = new Date(session.updatedAt)
      Logger.info(`[PlaybackSessionManager] Closing stale session "${session.displayTitle}" (${session.id}) last updated at ${sessionLastUpdate}`)
      await this.removeSession(session.id)
    }
  }
}
module.exports = PlaybackSessionManager
