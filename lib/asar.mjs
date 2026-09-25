// A minimal, dependency-free asar editor.
//
// An asar archive is a Chromium Pickle header (a JSON file tree) followed by
// every packed file's bytes. Rather than extracting and repacking — which
// would have to reproduce exactly which native modules the original kept in
// app.asar.unpacked — we keep the original data section byte for byte, append
// new or replaced files after it, and rewrite only the header.

import { createHash } from 'node:crypto'
import { closeSync, openSync, readSync, readFileSync, writeFileSync } from 'node:fs'

const BLOCK_SIZE = 4 * 1024 * 1024

function readHeader(archivePath) {
  const fd = openSync(archivePath, 'r')
  try {
    const sizeBuffer = Buffer.alloc(8)
    readSync(fd, sizeBuffer, 0, 8, 0)
    // Outer pickle: payload size (4), header pickle size (4).
    const headerPickleSize = sizeBuffer.readUInt32LE(4)
    const headerBuffer = Buffer.alloc(headerPickleSize)
    readSync(fd, headerBuffer, 0, headerPickleSize, 8)
    // Inner pickle: payload size (4), string length (4), string, padding.
    const stringLength = headerBuffer.readUInt32LE(4)
    const headerString = headerBuffer.subarray(8, 8 + stringLength).toString('utf8')
    return { header: JSON.parse(headerString), dataOffset: 8 + headerPickleSize }
  } finally {
    closeSync(fd)
  }
}

function encodeHeader(header) {
  const headerString = JSON.stringify(header)
  const stringBytes = Buffer.from(headerString, 'utf8')
  const padded = (stringBytes.length + 3) & ~3
  const inner = Buffer.alloc(8 + padded)
  inner.writeUInt32LE(4 + padded, 0)
  inner.writeUInt32LE(stringBytes.length, 4)
  stringBytes.copy(inner, 8)
  const outer = Buffer.alloc(8)
  outer.writeUInt32LE(4, 0)
  outer.writeUInt32LE(inner.length, 4)
  return { bytes: Buffer.concat([outer, inner]), headerString }
}

function integrity(bytes) {
  const blocks = []
  for (let offset = 0; offset < bytes.length; offset += BLOCK_SIZE) {
    blocks.push(createHash('sha256').update(bytes.subarray(offset, offset + BLOCK_SIZE)).digest('hex'))
  }
  if (blocks.length === 0) blocks.push(createHash('sha256').update(Buffer.alloc(0)).digest('hex'))
  return {
    algorithm: 'SHA256',
    hash: createHash('sha256').update(bytes).digest('hex'),
    blockSize: BLOCK_SIZE,
    blocks,
  }
}

function lookup(header, filePath, { create = false } = {}) {
  const parts = filePath.split('/').filter(Boolean)
  const name = parts.pop()
  let directory = header
  for (const part of parts) {
    if (!directory.files[part]) {
      if (!create) return null
      directory.files[part] = { files: {} }
    }
    directory = directory.files[part]
    if (!directory.files) throw new Error(`${filePath}: ${part} is not a directory in app.asar`)
  }
  return { directory, name, entry: directory.files[name] ?? null }
}

export class AsarArchive {
  constructor(archivePath) {
    this.path = archivePath
    const { header, dataOffset } = readHeader(archivePath)
    this.header = header
    this.dataOffset = dataOffset
    this.original = readFileSync(archivePath)
    this.dataLength = this.original.length - dataOffset
    this.appended = []
  }

  list(directoryPath) {
    const found = directoryPath === '/' ? { entry: this.header } : lookup(this.header, directoryPath)
    if (!found?.entry?.files) return []
    return Object.keys(found.entry.files)
  }

  read(filePath) {
    const found = lookup(this.header, filePath)
    if (!found?.entry || found.entry.files) throw new Error(`${filePath} is not in app.asar`)
    if (found.entry.unpacked) throw new Error(`${filePath} is unpacked; refusing to read it from app.asar`)
    const start = this.dataOffset + Number(found.entry.offset)
    return this.original.subarray(start, start + found.entry.size)
  }

  /** Adds a file, or replaces an existing packed one, by appending its bytes. */
  write(filePath, contents) {
    const bytes = Buffer.isBuffer(contents) ? contents : Buffer.from(contents, 'utf8')
    const { directory, name, entry } = lookup(this.header, filePath, { create: true })
    if (entry?.unpacked) throw new Error(`${filePath} is unpacked; refusing to replace it`)
    if (entry?.files) throw new Error(`${filePath} is a directory in app.asar`)
    const offset = this.dataLength
    this.appended.push(bytes)
    this.dataLength += bytes.length
    directory.files[name] = { size: bytes.length, offset: String(offset), integrity: integrity(bytes) }
  }

  /** Writes the archive and returns the header hash Info.plist's ElectronAsarIntegrity records. */
  save(outputPath = this.path) {
    const { bytes, headerString } = encodeHeader(this.header)
    writeFileSync(outputPath, Buffer.concat([bytes, this.original.subarray(this.dataOffset), ...this.appended]))
    return createHash('sha256').update(headerString).digest('hex')
  }
}
