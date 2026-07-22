import { describe, expect, it } from "vitest";
import { JsonStructuredConfigCodec, createJsonStructuredConfigCodec, diffFields } from "../src/domain/index.js";
import type { DocumentStyle, JsonObject, SourceDocument } from "../src/domain/index.js";

const source = (text: string): SourceDocument => ({
  path: "C:/project/.kiro/settings.json" as never,
  text,
  format: "json",
});

const style: DocumentStyle = { indentation: "  ", eol: "\n", finalNewline: true };

describe("JsonStructuredConfigCodec", () => {
  it("parses complete JSON objects and reports detected style", () => {
    const codec = new JsonStructuredConfigCodec();
    const result = codec.parse(source('{\r\n\t"unknown": [1, 2],\r\n\t"nested": {"value": true}\r\n}\r\n'));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.model).toEqual({ unknown: [1, 2], nested: { value: true } });
      expect(result.value.style).toEqual({ indentation: "\t", eol: "\r\n", finalNewline: true });
    }
  });

  it("rejects malformed syntax with JSON Pointer and line/column diagnostics", () => {
    const result = new JsonStructuredConfigCodec().parse(source('{\n  "servers": [1,],\n}'));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("CONFIG_SYNTAX");
      expect(result.error.path).toBe("/servers");
      expect(result.error.location).toMatch(/^2:\d+$/);
      expect(result.error.line).toBe(2);
      expect(result.error.column).toBeGreaterThan(0);
    }
  });

  it.each([
    ["duplicate", '{"servers": {"one": 1, "one": 2}}', "DUPLICATE_KEY"],
    ["dangerous", '{"constructor": {}}', "DANGEROUS_KEY"],
  ])("rejects %s object keys", (_name, text, code) => {
    const result = new JsonStructuredConfigCodec().parse(source(text));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(code);
  });

  it("preserves unknown fields and array order during copy-on-write merge", () => {
    const codec = new JsonStructuredConfigCodec();
    const model = { unknown: { keep: "yes" }, servers: [{ id: "a" }, { id: "b" }] } as JsonObject;
    const result = codec.merge(model, {
      paths: { "/managed/enabled": true, "/servers/1/id": "changed" },
    });

    expect(result.ok).toBe(true);
    expect(model).toEqual({ unknown: { keep: "yes" }, servers: [{ id: "a" }, { id: "b" }] });
    if (result.ok) {
      expect(result.value).toEqual({
        unknown: { keep: "yes" },
        servers: [{ id: "a" }, { id: "changed" }],
        managed: { enabled: true },
      });
    }
  });

  it("rejects dangerous patch paths and non-object roots", () => {
    const codec = new JsonStructuredConfigCodec();
    const dangerous = codec.merge({}, { paths: { "/__proto__/polluted": true } });
    const root = codec.merge({}, { paths: { "": [] } });

    expect(dangerous.ok).toBe(false);
    if (!dangerous.ok) expect(dangerous.error.code).toBe("DANGEROUS_KEY");
    expect(root.ok).toBe(false);
    if (!root.ok) expect(root.error.code).toBe("CONFIG_SCHEMA");
  });

  it("serializes with the requested indentation and EOL without reordering keys", () => {
    const codec = new JsonStructuredConfigCodec();
    const result = codec.serialize({ z: 1, a: { keep: ["first", "second"] } }, { ...style, eol: "\r\n" });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe('{\r\n  "z": 1,\r\n  "a": {\r\n    "keep": [\r\n      "first",\r\n      "second"\r\n    ]\r\n  }\r\n}\r\n');
      const reparsed = codec.parse(source(result.value));
      expect(reparsed.ok).toBe(true);
    }
  });

  it("uses schema diagnostics while retaining unknown fields", () => {
    const codec = createJsonStructuredConfigCodec<{ name: string } & JsonObject>({
      schema: (model) => typeof model.name === "string" || "name is required",
    });
    const result = codec.parse(source('{"unknown": 1}'));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("CONFIG_SCHEMA");
      expect(result.error.path).toBe("");
      expect(result.error.message).toBe("name is required");
    }
  });

  it("compares object key order independently but keeps array order significant", () => {
    const codec = new JsonStructuredConfigCodec();
    expect(codec.equivalent({ a: 1, b: { c: 2 } }, { b: { c: 2 }, a: 1 })).toBe(true);
    expect(codec.equivalent({ values: [1, 2] }, { values: [2, 1] })).toBe(false);
  });

  it("produces JSON Pointer field diffs for additions, removals, and changes", () => {
    const diff = diffFields({ keep: 1, remove: true, nested: { same: "x" } }, { keep: 2, add: "new", nested: { same: "x" } });
    expect(diff).toEqual({
      kind: "fields",
      changes: [
        { path: "/add", action: "add", after: "new" },
        { path: "/keep", action: "change", before: 1, after: 2 },
        { path: "/remove", action: "remove", before: true },
      ],
    });
  });
});
