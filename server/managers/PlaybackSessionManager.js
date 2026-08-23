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
const { isStrmPath, getStrmScanQps, probeStrmTargetMedia } = require('../utils/strmUtils')
const AudioFileScanner = require('../scanner/AudioFileScanner')
const TaskManager = require('./TaskManager')

const PlaybackSession = require('../objects/PlaybackSession')
const DeviceInfo = require('../objects/DeviceInfo')
const Stream = require('../objects/Stream')

class PlaybackSessionManager {
  constructor() {
    this.StreamsPath = Path.join(global.MetadataPath, 'streams')

    this.oldPlaybackSessionMap = {} // TODO: Remove after updated mobile versions

    /** @type {PlaybackSession[]} */
    this.sessions = []

    // Book ids currently being fully probed after STRM playback starts.
    this.strmCompletionTasks = new Map()
    this.strmLibraryCompletionTasks = new Map()
    this.strmItemCompletionTasks = new Map()
    this.strmBatchCompletionTasks = new Map()
    this.strmScheduledCompletionTask = null
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
        Logger.warn(`[PlaybackSessionManager] Failed to start STRM metadata completion for book "${libraryItem.id}": ${error.message}`)
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

  isCompleteStrmAudioFile(audioFile) {
    return Number(audioFile.duration) > 0
      && !!audioFile.codec
      && Number(audioFile.channels) > 0
  }

  async completeStrmBookAfterPlayback(libraryItemId) {
    const libraryItem = await Database.libraryItemModel.getExpandedById(libraryItemId)
    if (!libraryItem?.media || libraryItem.mediaType !== 'book') return false

    const allAudioFiles = libraryItem.media.audioFiles || []
    const allStrmFiles = allAudioFiles.filter((audioFile) => isStrmPath(audioFile.metadata?.path))
    if (!allStrmFiles.length) return Promise.resolve(false)

    const strmFiles = allStrmFiles.filter((audioFile) => !this.isCompleteStrmAudioFile(audioFile))
    const hasCompleteBookMetadata = Number(libraryItem.media.duration) > 0
      && Array.isArray(libraryItem.media.chapters)
      && libraryItem.media.chapters.length === allAudioFiles.length
    if (!strmFiles.length && hasCompleteBookMetadata) return Promise.resolve(false)

    const existingTask = this.strmCompletionTasks.get(libraryItem.id)
    if (existingTask) return existingTask

    const task = this.completeStrmBook(libraryItem, strmFiles)
      .catch((error) => {
        Logger.warn(`[PlaybackSessionManager] STRM metadata completion failed for book "${libraryItem.id}": ${error.message}`)
        return false
      })
      .finally(() => this.strmCompletionTasks.delete(libraryItem.id))
    this.strmCompletionTasks.set(libraryItem.id, task)
    return task
  }

  async completeStrmBook(libraryItem, strmFiles, options = {}) {
    const library = await Database.libraryModel.findByIdWithFolders(libraryItem.libraryId)
    const allowedLocalRoots = (library?.libraryFolders || []).map((folder) => folder.path)
    const totalStrmFiles = (libraryItem.media.audioFiles || []).filter((audioFile) => isStrmPath(audioFile.metadata?.path)).length
    const qps = Number(options.qps) > 0 ? Number(options.qps) : (options.manualLibraryTask ? 0.5 : getStrmScanQps(totalStrmFiles))
    const requestIntervalMs = 1000 / qps
    let updatedCount = 0

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
      } catch (error) {
        Logger.warn(`[PlaybackSessionManager] Failed to complete STRM metadata for "${audioFile.metadata.path}": ${error.message}`)
      }
    }

    for (const [index, audioFile] of strmFiles.entries()) {
      if (options.throttleState) {
        if (options.throttleState.scannedTracks > 0) await new Promise((resolve) => setTimeout(resolve, options.throttleState.requestIntervalMs))
        options.throttleState.scannedTracks += 1
      } else if (index > 0) {
        await new Promise((resolve) => setTimeout(resolve, requestIntervalMs))
      }
      await completeAudioFile(audioFile)
      if (options.throttleState?.deadline && Date.now() >= options.throttleState.deadline) {
        Logger.info(`[PlaybackSessionManager] STRM metadata completion time limit reached after ${options.throttleState.scannedTracks} tracks`)
        break
      }
      if (options.throttleState && options.throttleState.scannedTracks % 5000 === 0) {
        Logger.info(`[PlaybackSessionManager] STRM metadata completion pausing for 5 minutes after ${options.throttleState.scannedTracks} tracks`)
        await new Promise((resolve) => setTimeout(resolve, 5 * 60 * 1000))
      }
    }

    if (strmFiles.length && !updatedCount) return false
    if (strmFiles.length) {
      Logger.info(`[PlaybackSessionManager] Completed metadata for ${updatedCount}/${strmFiles.length} STRM tracks in book "${libraryItem.id}"`)
    }

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
    const library = await Database.libraryModel.findByIdWithFolders(libraryId)
    if (!library) throw new Error(`Library not found: ${libraryId}`)
    if (library.mediaType !== 'book') return { books: 0, updated: 0 }

    const items = await Database.libraryItemModel.findAll({ where: { libraryId } })
    const taskTitleString = {
      text: `Completing STRM metadata in "${library.name}" library`,
      key: 'MessageTaskCompletingStrmMetadata',
      subs: [library.name]
    }
    const task = TaskManager.createAndAddTask('strm-metadata-completion', taskTitleString, null, true, { libraryId, libraryName: library.name })
    let updated = 0
    const throttleState = {
      scannedTracks: 0,
      requestIntervalMs: 2000
    }
    try {
      for (const item of items) {
        const expandedItem = await Database.libraryItemModel.getExpandedById(item.id)
        if (!expandedItem?.media || expandedItem.mediaType !== 'book') continue
        const strmFiles = (expandedItem.media.audioFiles || []).filter((audioFile) => isStrmPath(audioFile.metadata?.path))
        if (!strmFiles.length) continue
        if (await this.completeStrmBook(expandedItem, strmFiles, { manualLibraryTask: true, throttleState })) updated++
      }
      task.setFinished(null, true)
      task.data.result = { books: items.length, updated }
      return task.data.result
    } catch (error) {
      Logger.error(`[PlaybackSessionManager] STRM library metadata completion failed for library "${libraryId}"`, error)
      task.setFailed({ text: 'Failed', key: 'MessageTaskFailed' })
      throw error
    } finally {
      TaskManager.taskFinished(task)
    }
  }

  async completeStrmItem(libraryItemId) {
    const existingTask = this.strmItemCompletionTasks.get(libraryItemId)
    if (existingTask) return existingTask

    const task = (async () => {
      const libraryItem = await Database.libraryItemModel.getExpandedById(libraryItemId)
      if (!libraryItem?.media || libraryItem.mediaType !== 'book') return false

      const strmFiles = (libraryItem.media.audioFiles || [])
        .filter((audioFile) => isStrmPath(audioFile.metadata?.path))
      if (!strmFiles.length) return false

      return this.completeStrmBook(libraryItem, strmFiles, { qps: 0.5 })
    })()
      .catch((error) => {
        Logger.warn(`[PlaybackSessionManager] STRM metadata completion failed for item "${libraryItemId}": ${error.message}`)
        return false
      })
      .finally(() => this.strmItemCompletionTasks.delete(libraryItemId))

    this.strmItemCompletionTasks.set(libraryItemId, task)
    return task
  }

  async completeScheduledStrmMetadata(maxHours = 1) {
    if (this.strmScheduledCompletionTask) return this.strmScheduledCompletionTask

    this.strmScheduledCompletionTask = (async () => {
      const deadline = Date.now() + Math.max(0.5, Number(maxHours) || 1) * 60 * 60 * 1000
      const items = await Database.libraryItemModel.findAllExpandedWhere({
        mediaType: 'book'
      })
      const throttleState = {
        scannedTracks: 0,
        requestIntervalMs: 2000,
        deadline
      }
      let updated = 0

      for (const libraryItem of items) {
        if (Date.now() >= deadline) break
        if (!libraryItem?.media || Number(libraryItem.media.duration) > 0) continue
        const strmFiles = (libraryItem.media.audioFiles || [])
          .filter((audioFile) => isStrmPath(audioFile.metadata?.path))
        if (!strmFiles.length) continue
        if (await this.completeStrmBook(libraryItem, strmFiles, { qps: 0.5, throttleState })) updated++
      }

      return { books: items.length, updated }
    })()
      .catch((error) => {
        Logger.error(`[PlaybackSessionManager] Scheduled STRM metadata completion failed`, error)
        throw error
      })
      .finally(() => {
        this.strmScheduledCompletionTask = null
      })

    return this.strmScheduledCompletionTask
  }

  async completeStrmItems(libraryItemIds) {
    const taskKey = [...libraryItemIds].sort().join(',')
    const existingTask = this.strmBatchCompletionTasks.get(taskKey)
    if (existingTask) return existingTask

    const task = (async () => {
      const items = await Database.libraryItemModel.findAllExpandedWhere({ id: libraryItemIds })
      const throttleState = {
        scannedTracks: 0,
        requestIntervalMs: 2000
      }
      let updated = 0

      for (const libraryItem of items) {
        if (!libraryItem?.media || libraryItem.mediaType !== 'book') continue
        const strmFiles = (libraryItem.media.audioFiles || [])
          .filter((audioFile) => isStrmPath(audioFile.metadata?.path))
        if (!strmFiles.length) continue
        if (await this.completeStrmBook(libraryItem, strmFiles, { qps: 0.5, throttleState })) updated++
      }

      return { books: items.length, updated }
    })()
      .catch((error) => {
        Logger.warn(`[PlaybackSessionManager] Batch STRM metadata completion failed: ${error.message}`)
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
