/**
 * Server-sent event framing.
 *
 * Extracted from the inline reader loop so it can be tested. A network chunk is
 * not an event: frames arrive split across reads, several can land in one
 * chunk, and the tail of a chunk is usually half a frame that must be held over
 * until the next one. Getting that wrong truncates an answer in a way that
 * looks like the model stopping early, so it is worth pinning down.
 */

/**
 * Consume a chunk of an SSE stream.
 *
 * @param {string} buffer  bytes left over from the previous chunk
 * @param {string} chunk   newly decoded text
 * @returns {{events: Array<{event: string|null, data: any}>, rest: string}}
 *          complete events, and whatever is left mid-frame
 */
export function parseSSEChunk(buffer, chunk) {
  const combined = buffer + chunk;
  const frames = combined.split("\n\n");
  // The final piece has no terminating blank line yet, so it is incomplete.
  const rest = frames.pop() ?? "";

  const events = [];
  for (const frame of frames) {
    let event = null;
    for (const line of frame.split("\n")) {
      if (line.startsWith("event: ")) {
        event = line.slice(7).trim();
      } else if (line.startsWith("data: ")) {
        try {
          events.push({ event, data: JSON.parse(line.slice(6)) });
        } catch {
          // A frame split mid-JSON would be unparseable; skip rather than
          // abandoning the stream, and let the next frame carry on.
        }
      }
    }
  }
  return { events, rest };
}
