var util = require('util')
var eos = require('end-of-stream')
var headers = require('./headers')

var Readable = require('readable-stream').Readable
var Writable = require('readable-stream').Writable
var PassThrough = require('readable-stream').PassThrough

var END_OF_TAR = new Buffer(1024)
END_OF_TAR.fill(0)

var noop = function() {}

var overflow = function(self, size) {
  size &= 511
  if (size) self.push(END_OF_TAR.slice(0, 512 - size))
}

var Sink = function(to) {
  Writable.call(this)
  this.written = 0
  this._to = to
  this._destroyed = false
  this.released = false
  this.unwritten = null
}

util.inherits(Sink, Writable)

Sink.prototype._write = function(data, enc, cb) {
  this.written += data.length
  if(this.released) {
    if (this._to.push(data)) return cb()
    this._to._drain = cb
  } else {
    this.unwritten = {data:data, cb:cb}
  }
}

Sink.prototype.destroy = function() {
  if (this._destroyed) return
  this._destroyed = true
  this.emit('close')
}

// releases the sink to start writing data to the `to` destination
Sink.prototype.release = function() {
    this.released = true
    if(this.unwritten !== null) {
        if(this._to.push(this.unwritten.data)) return this.unwritten.cb()
        this._to.drain = this.unwritten.cb()
        this.unwritten = null
    }
}

var Void = function() {
  Writable.call(this)
  this._destroyed = false
}

util.inherits(Void, Writable)

Void.prototype._write = function(data, enc, cb) {
  cb(new Error('No body allowed for this entry'))
}

Void.prototype.destroy = function() {
  if (this._destroyed) return
  this._destroyed = true
  this.emit('close')
}

var Pack = function(opts) {
  if (!(this instanceof Pack)) return new Pack(opts)
  Readable.call(this, opts)

  this._drain = noop
  this._finalized = false
  this._finalizing = false
  this._destroyed = false
  this._stream = null
  this._backOfStreamQueue = null
}

util.inherits(Pack, Readable)

Pack.prototype.entry = function(header, buffer, callback) {
  //if (this._stream) throw new Error('already piping an entry')
  if (this._finalized || this._destroyed) return
  var self = this

  var sink = new Sink(this)

  if(this._backOfStreamQueue) {
    eos(this._backOfStreamQueue, function(err) { // err handled in handleSink code called by previous entry method call
        handleSink()
    })

    this._backOfStreamQueue = sink

  } else {
    handleSink()
  }

  return sink


  function handleSink() {
      sink.release()

      if (typeof buffer === 'function') {
        callback = buffer
        buffer = null
      }

      if (!callback) callback = noop


      if (!header.size)  header.size = 0
      if (!header.type)  header.type = 'file'
      if (!header.mode)  header.mode = header.type === 'directory' ? 0755 : 0644
      if (!header.uid)   header.uid = 0
      if (!header.gid)   header.gid = 0
      if (!header.mtime) header.mtime = new Date()

      if (typeof buffer === 'string') buffer = new Buffer(buffer)
      if (Buffer.isBuffer(buffer)) {
        header.size = buffer.length
        self._encode(header)
        self.push(buffer)
        overflow(self, header.size)
        process.nextTick(callback)
        return new Void()
      }
      if (header.type !== 'file' && header.type !== 'contigious-file') {
        self._encode(header)
        process.nextTick(callback)
        return new Void()
      }

      self._encode(header)

      self._stream = sink
      if(!self._backOfStreamQueue) self._backOfStreamQueue = sink

      eos(sink, function(err) {
        if(self._backOfStreamQueue === self._stream)
          self._backOfStreamQueue = null
        self._stream = null

        if (err) { // stream was closed
          self.destroy()
          return callback(err)
        }

        if (sink.written !== header.size) { // corrupting tar
          self.destroy()
          return callback(new Error('size mismatch'))
        }

        overflow(self, header.size)
        if (self._finalizing && self._backOfStreamQueue === null) self.finalize()
        callback()
      })
  }
}

Pack.prototype.finalize = function() {
  if (this._stream) {
    this._finalizing = true
    return
  }

  if (this._finalized) return
  this._finalized = true
  this.push(END_OF_TAR)
  this.push(null)
}

Pack.prototype.destroy = function(err) {
  if (this._destroyed) return
  this._destroyed = true

  if (err) this.emit('error', err)
  this.emit('close')
  if (this._stream && this._stream.destroy) this._stream.destroy()
}

Pack.prototype._encode = function(header) {
  var buf = headers.encode(header)
  if (buf) this.push(buf)
  else this._encodePax(header)
}

Pack.prototype._encodePax = function(header) {
  var paxHeader = headers.encodePax({
    name: header.name,
    linkname: header.linkname
  })

  var newHeader = {
    name: 'PaxHeader',
    mode: header.mode,
    uid: header.uid,
    gid: header.gid,
    size: paxHeader.length,
    mtime: header.mtime,
    type: 'pax-header',
    linkname: header.linkname && 'PaxHeader',
    uname: header.uname,
    gname: header.gname,
    devmajor: header.devmajor,
    devminor: header.devminor
  }

  this.push(headers.encode(newHeader))
  this.push(paxHeader)
  overflow(this, paxHeader.length)

  newHeader.size = header.size
  newHeader.type = header.type
  this.push(headers.encode(newHeader))
}

Pack.prototype._read = function(n) {
  var drain = this._drain
  this._drain = noop
  drain()
}

module.exports = Pack
