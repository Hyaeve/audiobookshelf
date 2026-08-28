const Path = require('path')
const fs = require('fs/promises')
const os = require('os')
const chai = require('chai')
const expect = chai.expect
const scanUtils = require('../../../server/utils/scandir')
const { resolveStrmTarget, isPrivateStrmHost } = require('../../../server/utils/strmUtils')

describe('scanUtils', async () => {
  it('should properly group files into potential book library items', async () => {
    global.isWin = process.platform === 'win32'
    global.ServerSettings = {
      scannerParseSubtitle: true
    }

    const filePaths = [
      'randomfile.txt', // Should be ignored because it's not a book media file
      'Book1.m4b', // Root single file audiobook
      'Book1/01.strm', // STRM pointer must be treated as book media
      'Book2/audiofile.m4b',
      'Book2/disk 001/audiofile.m4b',
      'Book2/disk 002/audiofile.m4b',
      'Author/Book3/audiofile.mp3',
      'Author/Book3/Disc 1/audiofile.mp3',
      'Author/Book3/Disc 2/audiofile.mp3',
      'Author/Series/Book4/cover.jpg',
      'Author/Series/Book4/CD1/audiofile.mp3',
      'Author/Series/Book4/CD2/audiofile.mp3',
      'Author/Series2/Book5/deeply/nested/cd 01/audiofile.mp3',
      'Author/Series2/Book5/deeply/nested/cd 02/audiofile.mp3',
      'Author/Series2/Book5/randomfile.js' // Should be ignored because it's not a book media file
    ]

    // Create fileItems to match the format of fileUtils.recurseFiles
    const fileItems = []
    for (const filePath of filePaths) {
      const dirname = Path.dirname(filePath)
      fileItems.push({
        name: Path.basename(filePath),
        reldirpath: dirname === '.' ? '' : dirname,
        extension: Path.extname(filePath),
        deep: filePath.split('/').length - 1
      })
    }

    const libraryItemGrouping = scanUtils.groupFileItemsIntoLibraryItemDirs('book', fileItems, false, false, true)

    expect(libraryItemGrouping).to.deep.equal({
      'Book1.m4b': 'Book1.m4b',
      Book1: ['01.strm'],
      Book2: ['audiofile.m4b', 'disk 001/audiofile.m4b', 'disk 002/audiofile.m4b'],
      Author: [
        'Book3/audiofile.mp3',
        'Book3/Disc 1/audiofile.mp3',
        'Book3/Disc 2/audiofile.mp3',
        'Series/Book4/CD1/audiofile.mp3',
        'Series/Book4/CD2/audiofile.mp3',
        'Series2/Book5/deeply/nested/cd 01/audiofile.mp3',
        'Series2/Book5/deeply/nested/cd 02/audiofile.mp3',
        'Series/Book4/cover.jpg',
        'Series2/Book5/randomfile.js'
      ]
    })
  })

  it('should preserve upstream parent-directory grouping by default', async () => {
    const fileItems = [
      'A/A1/volume-one-01.strm',
      'A/A1/volume-one-02.strm',
      'A/A2/volume-two-01.strm'
    ].map((filePath) => ({
      name: Path.basename(filePath),
      reldirpath: Path.dirname(filePath),
      extension: Path.extname(filePath),
      deep: filePath.split('/').length - 1
    }))

    expect(scanUtils.groupFileItemsIntoLibraryItemDirs('book', fileItems, false)).to.deep.equal({
      'A/A1': ['volume-one-01.strm', 'volume-one-02.strm'],
      'A/A2': ['volume-two-01.strm']
    })
    expect(scanUtils.groupFileItemsIntoLibraryItemDirs('book', fileItems, false, false, true)).to.deep.equal({
      A: ['A1/volume-one-01.strm', 'A1/volume-one-02.strm', 'A2/volume-two-01.strm']
    })
  })

  it('sorts top-level anchored files by nested folder and filename naturally', () => {
    const fileItems = [
      '哈利·波特（系列）/哈利·波特与魔法石/7《哈利·波特》第一部 第6集 猫头鹰传书6.strm',
      '哈利·波特（系列）/哈利·波特与阿兹卡班的囚徒/106《哈利·波特》第三部 第2集 猫头鹰传书2.strm',
      '哈利·波特（系列）/哈利·波特与魔法石/2.strm',
      '哈利·波特（系列）/哈利·波特与阿兹卡班的囚徒/10.strm'
    ].map((filePath) => ({
      name: Path.basename(filePath),
      reldirpath: Path.dirname(filePath),
      extension: Path.extname(filePath),
      deep: filePath.split('/').length - 1
    }))

    expect(scanUtils.groupFileItemsIntoLibraryItemDirs('book', fileItems, false, false, true)).to.deep.equal({
      '哈利·波特（系列）': [
        '哈利·波特与魔法石/2.strm',
        '哈利·波特与魔法石/7《哈利·波特》第一部 第6集 猫头鹰传书6.strm',
        '哈利·波特与阿兹卡班的囚徒/10.strm',
        '哈利·波特与阿兹卡班的囚徒/106《哈利·波特》第三部 第2集 猫头鹰传书2.strm'
      ]
    })
  })

  it('recognizes the supported leading volume sequence formats', () => {
    const cases = [
      ['1.avi', 1],
      ['01.mp3', 1],
      ['2.5.jpg', 2.5],
      ['3 标题', 3],
      ['Vol 1', 1],
      ['Volume 02', 2],
      ['Book 3.5', 3.5],
      ['第 1 部', 1],
      ['第1卷', 1],
      ['第一部', 1],
      ['第一季', 1],
      ['S02', 2],
      ['A03', 3],
      ['上卷', 1],
      ['中卷', 2],
      ['下部', 3],
      ['卷 2', 2],
      ['部三', 3],
      ['季 4', 4]
    ]

    cases.forEach(([value, sequence]) => {
      expect(scanUtils.getLeadingSequence(value), value).to.equal(sequence)
    })
    expect(scanUtils.getLeadingSequence('哈利·波特与魔法石')).to.equal(null)
    expect(scanUtils.getLeadingSequence('第十部')).to.equal(10)
  })

  it('sorts all filenames globally when anchored folders have no sequence', () => {
    const fileItems = [
      '系列/第二本书/106.strm',
      '系列/第一本书/7.strm',
      '系列/第三本书/10.strm'
    ].map((filePath) => ({
      name: Path.basename(filePath),
      reldirpath: Path.dirname(filePath),
      extension: Path.extname(filePath),
      deep: filePath.split('/').length - 1
    }))

    expect(scanUtils.groupFileItemsIntoLibraryItemDirs('book', fileItems, false, false, true).系列).to.deep.equal(['第一本书/7.strm', '第三本书/10.strm', '第二本书/106.strm'])
  })

  it('sorts by folder sequence when every anchored folder has a recognized sequence', () => {
    const fileItems = ['系列/第十部/1.strm', '系列/第二部/20.strm', '系列/第一部/100.strm'].map((filePath) => ({
      name: Path.basename(filePath),
      reldirpath: Path.dirname(filePath),
      extension: Path.extname(filePath),
      deep: filePath.split('/').length - 1
    }))

    expect(scanUtils.groupFileItemsIntoLibraryItemDirs('book', fileItems, false, false, true).系列).to.deep.equal(['第一部/100.strm', '第二部/20.strm', '第十部/1.strm'])
  })

  it('uses the matching folder as the book title source', () => {
    expect(scanUtils.getDataFromMediaDir('book', '/Read', 'Author/Book').mediaMetadata.title).to.equal('Book')
    expect(scanUtils.getDataFromMediaDir('book', '/Read', 'Author/Book', true).mediaMetadata.title).to.equal('Author')
  })


  it('should allow direct private IP STRM targets without disabling public SSRF protection', () => {
    expect(isPrivateStrmHost('http://10.0.0.31:19527/d/audio.m4a?/chapter.m4a')).to.equal(true)
    expect(isPrivateStrmHost('http://192.168.1.20/audio.mp3')).to.equal(true)
    expect(isPrivateStrmHost('http://172.16.4.8/audio.flac')).to.equal(true)
    expect(isPrivateStrmHost('http://127.0.0.1:8080/audio.m4a')).to.equal(true)
    expect(isPrivateStrmHost('http://169.254.10.2/audio.m4a')).to.equal(true)
    expect(isPrivateStrmHost('https://example.com/audio.m4a')).to.equal(false)
    expect(isPrivateStrmHost('https://8.8.8.8/audio.m4a')).to.equal(false)
  })

  it('should preserve client User-Agent for playback proxy requests and use AudioBookShelf for server fallback', () => {
    const { getClientUserAgent, AUDIOBOOKSHELF_USER_AGENT } = require('../../../server/utils/strmUtils')
    expect(getClientUserAgent({ get: () => 'Emby/4.8.0' })).to.equal('Emby/4.8.0')
    expect(getClientUserAgent({ headers: { 'user-agent': 'Jellyfin/10.9' } })).to.equal('Jellyfin/10.9')
    expect(getClientUserAgent({ headers: {} })).to.equal(AUDIOBOOKSHELF_USER_AGENT)
    expect(AUDIOBOOKSHELF_USER_AGENT).to.equal('AudioBookShelf')
  })

  it('should resolve local STRM targets without probing the target during scanning', async () => {
    const tempDir = await fs.mkdtemp(Path.join(os.tmpdir(), 'audiobookshelf-strm-'))
    const strmPath = Path.join(tempDir, 'chapter.strm')
    const audioPath = Path.join(tempDir, 'chapter.flac')
    await fs.writeFile(strmPath, './chapter.flac')
    await fs.writeFile(audioPath, 'audio placeholder')

    const target = await resolveStrmTarget(strmPath, [tempDir])
    expect(target).to.deep.equal({ type: 'local', value: audioPath.replace(/\\/g, '/') })

    await fs.writeFile(strmPath, Path.join(tempDir, '..', 'outside.flac'))
    try {
      await resolveStrmTarget(strmPath, [tempDir])
      throw new Error('Expected local STRM target validation to fail')
    } catch (error) {
      expect(error.message).to.include('outside configured library folders')
    }

    await fs.rm(tempDir, { recursive: true, force: true })
  })

  it('re-reads STRM pointer contents even when the mtime is unchanged', async () => {
    const tempDir = await fs.mkdtemp(Path.join(os.tmpdir(), 'audiobookshelf-strm-mtime-'))
    const strmPath = Path.join(tempDir, 'chapter.strm')
    const firstTarget = Path.join(tempDir, 'first.flac')
    const secondTarget = Path.join(tempDir, 'second.flac')
    await fs.writeFile(firstTarget, 'audio placeholder')
    await fs.writeFile(secondTarget, 'audio placeholder')

    // Pin a fixed mtime after every rewrite. Filesystem mtime resolution is
    // coarse enough that two quick rewrites can land on the same tick naturally,
    // so the resolver must never trust mtime to detect content changes.
    const pinnedTime = new Date(Date.now() - 60000)
    const pinMtime = () => fs.utimes(strmPath, pinnedTime, pinnedTime)

    await fs.writeFile(strmPath, './first.flac')
    await pinMtime()
    const pinnedMtimeMs = (await fs.stat(strmPath)).mtimeMs
    expect(await resolveStrmTarget(strmPath, [tempDir])).to.deep.equal({ type: 'local', value: firstTarget.replace(/\\/g, '/') })

    await fs.writeFile(strmPath, './second.flac')
    await pinMtime()
    expect((await fs.stat(strmPath)).mtimeMs).to.equal(pinnedMtimeMs)
    expect(await resolveStrmTarget(strmPath, [tempDir])).to.deep.equal({ type: 'local', value: secondTarget.replace(/\\/g, '/') })

    // The library root check must still run on an unchanged mtime.
    await fs.writeFile(strmPath, Path.join(tempDir, '..', 'outside.flac'))
    await pinMtime()
    expect((await fs.stat(strmPath)).mtimeMs).to.equal(pinnedMtimeMs)
    try {
      await resolveStrmTarget(strmPath, [tempDir])
      throw new Error('Expected local STRM target validation to fail')
    } catch (error) {
      expect(error.message).to.include('outside configured library folders')
    }

    await fs.rm(tempDir, { recursive: true, force: true })
  })
})
