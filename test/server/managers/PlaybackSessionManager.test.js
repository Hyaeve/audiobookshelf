const assert = require('assert')
const PlaybackSessionManager = require('../../../server/managers/PlaybackSessionManager')

describe('PlaybackSessionManager STRM completion queue', () => {
  function createManager() {
    const manager = Object.create(PlaybackSessionManager.prototype)
    manager.strmCompletionQueues = {
      playback: [],
      manual: [],
      scheduled: []
    }
    manager.strmCompletionQueueRunning = false
    return manager
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
})
