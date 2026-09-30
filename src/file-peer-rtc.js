/** The RTC owner/lifecycle remains in the file-peer manager, not this adapter. */
export async function createFilePeerConnection({ iceServers = [] } = {}) {
  // Import only when a file peer is requested; ordinary Host startup stays light.
  const { RTCPeerConnection } = await import('werift');
  return new RTCPeerConnection({ iceServers });
}

/**
 * Send one files-v1 binary block, including the zero-byte EOF sentinel.
 *
 * Pinned to werift 0.24.4: its native empty Buffer send creates no SCTP DATA
 * chunk but still consumes an ordered stream sequence number, blocking EOF
 * AND subsequent transfers. RFC 8831 uses PPID 57 plus one ignored octet for
 * empty binary messages. Queue it through the same transport as normal data;
 * direct sctp.send() would bypass the queue and its bufferedAmount accounting.
 *
 * These are private werift APIs. Any dependency upgrade MUST rerun the real
 * Chromium smoke (including EOF followed by another transfer), not just mocks.
 * Await this function: an asynchronous flush rejection must reach the owner.
 */
export async function sendFilePeerBinary(channel, bytes) {
  if (!Buffer.isBuffer(bytes)) throw new TypeError('FILE_PEER_BINARY_REQUIRED');
  if (!channel || channel.readyState !== 'open') throw new Error('FILE_PEER_CLOSED');
  if (bytes.length) {
    if (typeof channel.send !== 'function') throw new Error('FILE_PEER_RTC_UNSUPPORTED');
    await channel.send(bytes);
    return;
  }
  const transport = channel.sctp;
  if (!transport || !Array.isArray(transport.dataChannelQueue) ||
      typeof transport.dataChannelFlush !== 'function' ||
      typeof channel.addBufferedAmount !== 'function' ||
      !Number.isSafeInteger(channel.messagesSent)) {
    throw new Error('FILE_PEER_RTC_UNSUPPORTED');
  }
  channel.addBufferedAmount(1);
  transport.dataChannelQueue.push([channel, 57, Buffer.from([0])]);
  channel.messagesSent++;
  // bytesSent stays unchanged: the ignored octet is framing, not file payload.
  await transport.dataChannelFlush();
}
