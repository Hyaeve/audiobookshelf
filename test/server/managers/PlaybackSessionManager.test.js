const assert = require('assert')
const sinon = require('sinon')
const PlaybackSessionManager = require('../../../server/managers/PlaybackSessionManager')
const Database = require('../../../server/Database')
const TaskManager = require('../../../server/managers/TaskManager')
const SocketAuthority = require('../../../server/SocketAuthority')
const prober = require('../../../server/utils/prober')
const fs = require('../../../server/libs/fsExtra')
const AudioFileScanner = require('../../../server/scanner/AudioFileScanner')

describe('PlaybackSessionManager STRM completion queue', () => {
  function createManager() {
    const manager = Object.create(PlaybackSessionManager.prototype)
    manager.strmCompletionQueues = {
      playback: [],
      manual: [],
      scheduled: []
    }
    manager.strmCompletionQueueRunning = false
    manager.strmPreloadTasks = new Map()
    manager.strmCompletionQueuedIds = new Set()
    manager.strmItemCompletionTasks = new Map()
    manager.strmBatchCompletionTasks = new Map()
    manager.strmLibraryCompletionTasks = new Map()
    manager.strmManualEnqueueChain = Promise.resolve()
    return manager
  }

  beforeEach(() => {
    sinon.stub(SocketAuthority, 'emitter')
    sinon.stub(SocketAuthority, 'libraryItemEmitter')
    sinon.stub(TaskManager, 'tasks').value([])
  })

  afterEach(() => sinon.restore())

  function createBook(id) {
    return {
      id,
      libraryId: 'library',
      mediaType: 'book',
      relPath: id,
      media: {
        title: id,
        audioFiles: [1, 2, 3].map((index) => ({ metadata: { path: `C:/books/${index}.strm`, filename: `${index}.strm` }, duration: 0 })),
        changed: sinon.stub(),
        save: sinon.stub().resolves()
      },
      saveMetadataFile: sinon.stub().resolves()
    }
  }

  function stubBooks(books) {
    const library = { id: 'library', name: 'Library', mediaType: 'book', settings: { strmMetadataQps: 2 }, libraryFolders: [{ path: 'C:/books' }] }
    sinon.stub(Database, 'libraryItemModel').get(() => ({
      getExpandedById: sinon.stub().callsFake(async (id) => books.find((book) => book.id === id)),
      findAll: sinon.stub().resolves(books),
      findAllExpandedWhere: sinon.stub().resolves(books)
    }))
    sinon.stub(Database, 'libraryModel').get(() => ({
      findByIdWithFolders: sinon.stub().resolves(library),
      getAllWithFolders: sinon.stub().resolves([library])
    }))
    sinon.stub(Database, 'serverSettings').value({ strmMetadataCompletionQps: 1, strmMetadataCompletionBatchSize: 5000 })
  }

  it('calculates partial STRM completion without persisting a separate status field', () => {
    const manager = createManager()
    const libraryItem = {
      media: {
        duration: 120,
        audioFiles: [
          { metadata: { path: '01.strm' }, duration: 60, codec: 'aac', channels: 2 },
          { metadata: { path: '02.strm' }, duration: 0, codec: null, channels: 0 },
          { metadata: { path: '03.strm' }, duration: 60, codec: 'aac', channels: 2 },
          { metadata: { path: 'cover.jpg' }, duration: 0, codec: null, channels: 0 }
        ]
      }
    }

    assert.deepStrictEqual(manager.getStrmBookMetadataStatus(libraryItem), {
      totalTracks: 3,
      completedTracks: 2,
      incompleteTracks: 1,
      percent: 67,
      isComplete: false
    })
    assert.strictEqual(manager.isCompleteStrmBookMetadata(libraryItem), false)
  })

  it('marks a STRM book complete when all STRM tracks are complete', () => {
    const manager = createManager()
    const libraryItem = {
      media: {
        duration: 120,
        audioFiles: [
          { metadata: { path: '01.strm' }, duration: 60, codec: 'aac', channels: 2 },
          { metadata: { path: '02.strm' }, duration: 60, codec: 'aac', channels: 2 }
        ]
      }
    }

    assert.strictEqual(manager.isCompleteStrmBookMetadata(libraryItem), true)
    libraryItem.media.duration = 0
    assert.strictEqual(manager.isCompleteStrmBookMetadata(libraryItem), true)
  })

  it('processes only one book at a time and keeps FIFO within a priority', async () => {
    const manager = createManager()
    const active = { count: 0, max: 0 }
    const order = []
    let releaseFirst
    const firstGate = new Promise((resolve) => { releaseFirst = resolve })

    const first = manager.enqueueStrmBookCompletion('manual', 'manual-1', async () => {
      active.count += 1
      active.max = Math.max(active.max, active.count)
      order.push('manual-1')
      await firstGate
      active.count -= 1
      return true
    })
    const second = manager.enqueueStrmBookCompletion('manual', 'manual-2', async () => {
      active.count += 1
      active.max = Math.max(active.max, active.count)
      order.push('manual-2')
      active.count -= 1
      return true
    })

    await new Promise((resolve) => setImmediate(resolve))
    assert.deepStrictEqual(order, ['manual-1'])
    releaseFirst()
    await Promise.all([first, second])

    assert.deepStrictEqual(order, ['manual-1', 'manual-2'])
    assert.strictEqual(active.max, 1)
  })

  it('selects playback before manual and scheduled jobs waiting in the queue', async () => {
    const manager = createManager()
    const order = []
    let releaseRunning
    const runningGate = new Promise((resolve) => { releaseRunning = resolve })

    const running = manager.enqueueStrmBookCompletion('scheduled', 'scheduled-1', async () => {
      order.push('scheduled-1')
      await runningGate
    })
    const manual = manager.enqueueStrmBookCompletion('manual', 'manual-1', async () => {
      order.push('manual-1')
    })
    const playback = manager.enqueueStrmBookCompletion('playback', 'playback-1', async () => {
      order.push('playback-1')
    })

    await new Promise((resolve) => setImmediate(resolve))
    assert.deepStrictEqual(order, ['scheduled-1'])
    releaseRunning()
    await Promise.all([running, manual, playback])

    assert.deepStrictEqual(order, ['scheduled-1', 'playback-1', 'manual-1'])
  })

  it('cancels a queued book without probing it or canceling the running book', async () => {
    const manager = createManager()
    let release
    const running = manager.enqueueStrmBookCompletion('manual', 'running', () => new Promise((resolve) => { release = resolve }))
    const task = manager.createStrmPreloadTask({ text: 'Manual' }, { libraryItemId: 'queued' })
    const probe = sinon.stub(manager, 'completeStrmBook')
    const queued = manager.queueStrmBookById('manual', 'queued', { activityTask: task })
    assert.strictEqual(manager.cancelStrmPreloadTask(task.id, 'other'), false)
    assert.strictEqual(manager.cancelStrmPreloadTask(task.id, 'queued'), true)
    release(true)
    assert.deepStrictEqual(await Promise.all([running, queued]), [true, false])
    assert.strictEqual(probe.called, false)
    manager.finishStrmPreloadTask(task)
    assert.strictEqual(task.data.currentBookCancelled, true)
    assert.strictEqual(task.isFailed, false)
    assert.strictEqual(manager.strmPreloadTasks.size, 0)
  })

  for (const source of ['playback', 'single', 'batch', 'library', 'scheduled']) {
    it(`cancels only the current book for the ${source} entry and releases the queue`, async () => {
      const manager = createManager()
      const books = [createBook('first'), createBook('second')]
      stubBooks(books)
      let started
      const ready = new Promise((resolve) => { started = resolve })
      const visited = []
      sinon.stub(manager, 'completeStrmBook').callsFake(async (book, files, options) => {
        visited.push(book.id)
        assert.strictEqual(options.signal.aborted, false)
        if (book.id === 'second') return true
        return new Promise((resolve) => {
          options.signal.addEventListener('abort', () => resolve(false), { once: true })
          started()
        })
      })
      const operation = source === 'playback' ? manager.completeStrmBookAfterPlayback('first')
        : source === 'single' ? manager.completeStrmItem('first')
          : source === 'batch' ? manager.completeStrmItems(['first', 'second'])
            : source === 'library' ? manager.completeStrmLibrary('library')
              : manager.completeScheduledStrmMetadata(1, ['library'])
      await ready
      const task = TaskManager.tasks[0]
      assert.strictEqual(task.data.libraryItemId, 'first')
      assert.strictEqual(task.data.libraryId, 'library')
      assert.strictEqual(task.data.canCancelPreload, true)
      assert.strictEqual(manager.cancelStrmPreloadTask(task.id, 'first'), true)
      await operation
      assert.strictEqual(task.isFinished, true)
      assert.strictEqual(task.isFailed, false)
      assert.strictEqual(task.data.cancelledBooks, 1)
      assert.strictEqual(task.data.canCancelPreload, false)
      assert.strictEqual(manager.strmPreloadTasks.size, 0)
      if (['batch', 'library', 'scheduled'].includes(source)) {
        assert.deepStrictEqual(visited, ['first', 'second'])
        assert.strictEqual(task.data.libraryItemId, 'second')
        assert.strictEqual(task.data.currentBookCancelled, false)
      } else {
        assert.deepStrictEqual(visited, ['first'])
        assert.strictEqual(task.data.currentBookCancelled, true)
      }
      assert.strictEqual(manager.cancelStrmPreloadTask(task.id, 'first'), false)
    })
  }

  it('flushes fewer than 50 completed tracks when an in-flight probe is canceled', async () => {
    const manager = createManager()
    const book = createBook('partial')
    stubBooks([book])
    sinon.stub(fs, 'stat').resolves({ isFile: () => true })
    sinon.stub(fs, 'readFile').resolves('https://media.invalid/audio.mp3')
    sinon.stub(AudioFileScanner, 'runSmartTrackOrder').callsFake((path, files) => files)
    const controller = new AbortController()
    let startedSecond
    const second = new Promise((resolve) => { startedSecond = resolve })
    const probe = sinon.stub(prober, 'probe')
    probe.onFirstCall().resolves({ duration: 10, codec: 'aac', channels: 2 })
    probe.onSecondCall().callsFake((path, verbose, options) => new Promise((resolve) => {
      options.signal.addEventListener('abort', () => resolve({ error: 'aborted' }), { once: true })
      startedSecond()
    }))
    const operation = manager.completeStrmBook(book, book.media.audioFiles, { qps: 1000, signal: controller.signal })
    await second
    controller.abort()
    await operation
    assert.strictEqual(probe.callCount, 2)
    assert.strictEqual(book.media.audioFiles[0].duration, 10)
    assert.strictEqual(book.media.audioFiles[1].duration, 0)
    assert.strictEqual(book.media.audioFiles[2].duration, 0)
    assert.strictEqual(book.media.save.calledOnce, true)
    assert.strictEqual(book.saveMetadataFile.calledOnce, true)
    assert.strictEqual(book.media.duration, 10)
    assert.strictEqual(book.media.chapters.length, 1)
  })

  for (const waitType of ['qps', 'batch-pause']) {
    it(`can cancel during a ${waitType} wait and still save completed tracks`, async () => {
      const manager = createManager()
      const book = createBook('waiting')
      stubBooks([book])
      const clock = sinon.useFakeTimers()
      sinon.stub(fs, 'stat').resolves({ isFile: () => true })
      sinon.stub(fs, 'readFile').resolves('https://media.invalid/audio.mp3')
      sinon.stub(AudioFileScanner, 'runSmartTrackOrder').callsFake((path, files) => files)
      const probe = sinon.stub(prober, 'probe').resolves({ duration: 10, codec: 'aac', channels: 2 })
      const controller = new AbortController()
      const options = { qps: 0.1, signal: controller.signal }
      if (waitType === 'batch-pause') options.throttleState = { scannedTracks: 0, batchSize: 1, pauseMinutes: 5 }
      const operation = manager.completeStrmBook(book, book.media.audioFiles, options)
      await clock.tickAsync(0)
      assert.strictEqual(probe.calledOnce, true)
      controller.abort()
      await clock.tickAsync(1000)
      await operation
      assert.strictEqual(probe.calledOnce, true)
      assert.strictEqual(book.media.save.calledOnce, true)
      assert.strictEqual(book.media.audioFiles[1].duration, 0)
    })
  }
})
