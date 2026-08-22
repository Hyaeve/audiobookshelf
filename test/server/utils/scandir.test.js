const Path = require('path')
const fs = require('fs/promises')
const os = require('os')
const chai = require('chai')
const expect = chai.expect
const scanUtils = require('../../../server/utils/scandir')
const { resolveStrmTarget } = require('../../../server/utils/strmUtils')

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

    const libraryItemGrouping = scanUtils.groupFileItemsIntoLibraryItemDirs('book', fileItems, false)

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

  it('should group nested audiobook volumes under the first-level book folder', async () => {
    const fileItems = [
      'A/A1/七玄门风云-01.strm',
      'A/A1/七玄门风云-02.strm',
      'A/A2/初踏修仙路-01.strm'
    ].map((filePath) => ({
      name: Path.basename(filePath),
      reldirpath: Path.dirname(filePath),
      extension: Path.extname(filePath),
      deep: filePath.split('/').length - 1
    }))

    expect(scanUtils.groupFileItemsIntoLibraryItemDirs('book', fileItems, false)).to.deep.equal({
      A: ['A1/七玄门风云-01.strm', 'A1/七玄门风云-02.strm', 'A2/初踏修仙路-01.strm']
    })
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
})
