import { describe, it, expect } from "vitest";
import { parseSSEChunk } from "./sse";

/**
 * A network chunk is not an event. These are the cases that truncate an answer
 * in a way that looks like the model stopping early.
 */
describe("parseSSEChunk", () => {
  it("reads a complete event", () => {
    const { events, rest } = parseSSEChunk("", 'event: token\ndata: {"text":"hi"}\n\n');
    expect(events).toEqual([{ event: "token", data: { text: "hi" } }]);
    expect(rest).toBe("");
  });

  it("reads several events arriving in one chunk", () => {
    const chunk =
      'event: status\ndata: {"stage":"fetching"}\n\n' +
      'event: token\ndata: {"text":"a"}\n\n' +
      'event: token\ndata: {"text":"b"}\n\n';
    const { events } = parseSSEChunk("", chunk);
    expect(events.map(e => e.event)).toEqual(["status", "token", "token"]);
    expect(events[2].data.text).toBe("b");
  });

  it("holds a half-arrived frame until the rest turns up", () => {
    const first = parseSSEChunk("", 'event: token\ndata: {"text":"hel');
    expect(first.events).toEqual([]);
    expect(first.rest).toBe('event: token\ndata: {"text":"hel');

    const second = parseSSEChunk(first.rest, 'lo"}\n\n');
    expect(second.events).toEqual([{ event: "token", data: { text: "hello" } }]);
    expect(second.rest).toBe("");
  });

  it("survives a split in the middle of the frame separator", () => {
    const a = parseSSEChunk("", 'event: token\ndata: {"text":"x"}\n');
    expect(a.events).toEqual([]);
    const b = parseSSEChunk(a.rest, '\nevent: done\ndata: {"cached":false}\n\n');
    expect(b.events.map(e => e.event)).toEqual(["token", "done"]);
  });

  it("reassembles a message delivered one character at a time", () => {
    const whole = 'event: token\ndata: {"text":"streamed"}\n\n';
    let buffer = "";
    const collected = [];
    for (const ch of whole) {
      const { events, rest } = parseSSEChunk(buffer, ch);
      buffer = rest;
      collected.push(...events);
    }
    expect(collected).toEqual([{ event: "token", data: { text: "streamed" } }]);
  });

  it("keeps going when one frame is unparseable", () => {
    const chunk =
      "event: token\ndata: {not json}\n\n" +
      'event: token\ndata: {"text":"after"}\n\n';
    const { events } = parseSSEChunk("", chunk);
    expect(events).toEqual([{ event: "token", data: { text: "after" } }]);
  });

  it("carries the event name across the frame's own lines", () => {
    const { events } = parseSSEChunk("", 'event: data\ndata: {"sources":["ClinVar"]}\n\n');
    expect(events[0].event).toBe("data");
    expect(events[0].data.sources).toEqual(["ClinVar"]);
  });

  it("returns nothing for a keep-alive or blank chunk", () => {
    expect(parseSSEChunk("", "\n\n").events).toEqual([]);
    expect(parseSSEChunk("", "").events).toEqual([]);
  });

  it("does not mistake a colon in the payload for a field separator", () => {
    const { events } = parseSSEChunk("", 'event: token\ndata: {"text":"ratio 1: 2"}\n\n');
    expect(events[0].data.text).toBe("ratio 1: 2");
  });
});
