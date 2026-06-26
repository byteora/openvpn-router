/**
 * Tiny DNS wire-format helpers — just enough to read the question and pull A
 * records out of an upstream response. We forward raw query/response bytes
 * unchanged; this only inspects them.
 */

const TYPE_A = 1
const TYPE_AAAA = 28

/** Read a (possibly compressed) name; returns the offset AFTER the name field. */
function skipName(buf, offset) {
  while (offset < buf.length) {
    const len = buf[offset]
    if (len === 0) {
      return offset + 1
    }
    if ((len & 0xc0) === 0xc0) {
      // compression pointer occupies 2 bytes
      return offset + 2
    }
    offset += len + 1
  }
  return offset
}

function readNameString(buf, offset) {
  const labels = []
  let pos = offset
  let jumped = false
  let safety = 0
  while (pos < buf.length && safety++ < 128) {
    const len = buf[pos]
    if (len === 0) {
      pos += 1
      break
    }
    if ((len & 0xc0) === 0xc0) {
      const pointer = ((len & 0x3f) << 8) | buf[pos + 1]
      pos = pointer
      jumped = true
      continue
    }
    labels.push(buf.toString('ascii', pos + 1, pos + 1 + len))
    pos += len + 1
  }
  return labels.join('.')
}

/** Parse the first question. Returns { name, qtype } or null. */
export function parseQuestion(buf) {
  try {
    if (buf.length < 12) return null
    const qdcount = buf.readUInt16BE(4)
    if (qdcount < 1) return null
    const name = readNameString(buf, 12)
    let offset = skipName(buf, 12)
    const qtype = buf.readUInt16BE(offset)
    return { name, qtype }
  } catch {
    return null
  }
}

/** Extract all A-record IPv4 addresses from a DNS response. */
export function extractARecords(buf) {
  const ips = []
  try {
    if (buf.length < 12) return ips
    const qdcount = buf.readUInt16BE(4)
    const ancount = buf.readUInt16BE(6)

    let offset = 12
    for (let i = 0; i < qdcount; i++) {
      offset = skipName(buf, offset)
      offset += 4 // QTYPE + QCLASS
    }

    for (let i = 0; i < ancount; i++) {
      offset = skipName(buf, offset)
      if (offset + 10 > buf.length) break
      const type = buf.readUInt16BE(offset)
      const rdlength = buf.readUInt16BE(offset + 8)
      const rdStart = offset + 10
      if (type === TYPE_A && rdlength === 4 && rdStart + 4 <= buf.length) {
        ips.push(`${buf[rdStart]}.${buf[rdStart + 1]}.${buf[rdStart + 2]}.${buf[rdStart + 3]}`)
      }
      offset = rdStart + rdlength
    }
  } catch {
    /* ignore malformed */
  }
  return ips
}

/**
 * Rewrite the TTL of every ANSWER record to `ttlSeconds`, in place.
 *
 * We serve short TTLs so clients (OS / browser caches) re-query us frequently
 * instead of pinning a domain to an IP for minutes. This makes rule changes
 * take effect almost immediately and keeps CDN routing accurate. Authority /
 * additional sections (incl. EDNS OPT) are left untouched.
 */
export function rewriteAnswerTtl(buf, ttlSeconds) {
  try {
    if (buf.length < 12) return buf
    const qdcount = buf.readUInt16BE(4)
    const ancount = buf.readUInt16BE(6)

    let offset = 12
    for (let i = 0; i < qdcount; i++) {
      offset = skipName(buf, offset)
      offset += 4 // QTYPE + QCLASS
    }

    for (let i = 0; i < ancount; i++) {
      offset = skipName(buf, offset)
      if (offset + 10 > buf.length) break
      buf.writeUInt32BE(ttlSeconds >>> 0, offset + 4) // TTL field
      const rdlength = buf.readUInt16BE(offset + 8)
      offset += 10 + rdlength
    }
  } catch {
    /* leave buffer unchanged on parse error */
  }
  return buf
}

/** Build an empty NOERROR response for a query (used to suppress AAAA). */
export function buildEmptyResponse(query) {
  const resp = Buffer.from(query)
  // set QR=1, RA=1, keep RD; ancount=0
  resp[2] = resp[2] | 0x80 // QR
  resp[3] = (resp[3] & 0x0f) | 0x80 // RA, RCODE=0
  resp.writeUInt16BE(0, 6) // ANCOUNT = 0
  resp.writeUInt16BE(0, 8) // NSCOUNT = 0
  resp.writeUInt16BE(0, 10) // ARCOUNT = 0
  return resp
}

export const QTYPE = { A: TYPE_A, AAAA: TYPE_AAAA }
