const { expect } = require('chai')
const sinon = require('sinon')
const { EventEmitter } = require('events')
const { PassThrough } = require('stream')
const childProcess = require('child_process')
const spawnProcess = childProcess.spawn

describe('STRM ffprobe wrapper after server compilation', () => {
  const modulePath = require.resolve('../../../server/libs/nodeFfprobe')
  let previousModule
  let probe
  let processStub
  let spawn

  beforeEach(() => {
    previousModule = require.cache[modulePath]
    delete require.cache[modulePath]
    processStub = new EventEmitter()
    processStub.stdout = new PassThrough()
    processStub.stderr = new PassThrough()
    processStub.stdin = new PassThrough()
    spawn = sinon.stub(childProcess, 'spawn').returns(processStub)
    probe = require(modulePath)
  })

  afterEach(() => {
    sinon.restore()
    delete require.cache[modulePath]
    if (previousModule) require.cache[modulePath] = previousModule
  })

  function complete(result = { format: { duration: '1' }, streams: [] }) {
    processStub.stdout.end(JSON.stringify(result))
    processStub.emit('close', 0)
    return result
  }

  it('keeps the Buffer stdin entry point in the compiled module', async () => {
    const buffer = Buffer.from('fake-audio')
    const pending = probe.probeBuffer(buffer)
    const result = complete()
    expect(await pending).to.deep.equal(result)
    expect(spawn.firstCall.args[1].at(-1)).to.equal('pipe:0')
    expect(processStub.stdin.read()).to.deep.equal(buffer)
  })

  it('preserves the exact media preload User-Agent on URL probes', async () => {
    const pending = probe('https://media.invalid/chapter.mp3', { userAgent: 'AudioBookShelf' })
    complete()
    await pending
    expect(spawn.firstCall.args[1].slice(-3)).to.deep.equal(['-user_agent', 'AudioBookShelf', 'https://media.invalid/chapter.mp3'])
    expect(processStub.stdin.writableEnded).to.equal(false)
  })

  it('passes the cancellation signal to the probe subprocess', async () => {
    const controller = new AbortController()
    const pending = probe('https://media.invalid/chapter.mp3', { signal: controller.signal })
    expect(spawn.firstCall.args[2].signal).to.equal(controller.signal)
    complete()
    await pending
  })

  it('does not spawn a probe for a previously canceled request', async () => {
    const controller = new AbortController()
    controller.abort()
    try {
      await probe('chapter.mp3', { signal: controller.signal })
      throw new Error('expected cancellation')
    } catch (error) {
      expect(error.name).to.equal('AbortError')
    }
    expect(spawn.called).to.equal(false)
  })

  it('waits for the canceled subprocess to close before releasing its result', async () => {
    const controller = new AbortController()
    let settled = false
    const pending = probe('chapter.mp3', { signal: controller.signal }).catch((error) => {
      settled = true
      return error
    })
    controller.abort()
    processStub.emit('error', controller.signal.reason)
    await new Promise((resolve) => setImmediate(resolve))
    expect(settled).to.equal(false)
    processStub.emit('close', null)
    expect((await pending).name).to.equal('AbortError')
  })

  it('terminates a real child process when a media preload is canceled', async () => {
    let child
    spawn.callsFake((file, args, options) => {
      child = spawnProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], options)
      return child
    })
    const controller = new AbortController()
    const pending = probe('chapter.mp3', { signal: controller.signal }).catch((error) => error)
    const closed = new Promise((resolve) => child.once('close', resolve))
    controller.abort()
    expect((await pending).name).to.equal('AbortError')
    await closed
    expect(child.exitCode !== null || child.signalCode !== null).to.equal(true)
  })

  it('does not discard valid probe output after an early stdin EPIPE', async () => {
    const pending = probe.probeBuffer(Buffer.from('fake-audio'))
    processStub.stdin.emit('error', Object.assign(new Error('pipe closed'), { code: 'EPIPE' }))
    const result = complete()
    expect(await pending).to.deep.equal(result)
  })

  it('rejects other stdin errors', async () => {
    const pending = probe.probeBuffer(Buffer.from('fake-audio'))
    const failure = Object.assign(new Error('input failed'), { code: 'EIO' })
    processStub.stdin.emit('error', failure)
    try {
      await pending
      throw new Error('expected input to fail')
    } catch (error) {
      expect(error).to.equal(failure)
    }
  })

  it('reports ffprobe stderr when the output is not JSON', async () => {
    const pending = probe.probeBuffer(Buffer.from('fake-audio'))
    processStub.stderr.end('unsupported media format')
    processStub.stdout.end('invalid-json')
    processStub.emit('close', 1)
    try {
      await pending
      throw new Error('expected invalid output to fail')
    } catch (error) {
      expect(error.message).to.equal('unsupported media format')
    }
  })
})
