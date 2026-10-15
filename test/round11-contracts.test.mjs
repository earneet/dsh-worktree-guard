// round-11 regression: tool wire projections must be LOSSLESS JSON — the host
// snapshots request/header (tools included) and rejects undefined-valued keys
// ("non-JSON-serializable data"). Root cause was a (name, desc) helper called
// with one argument, leaving `description: undefined` in boolean parameters.
import { test } from "node:test";
import assert from "node:assert/strict";
import { toolSpecs } from "../src/wt-tools.mjs";

function deepEq(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => deepEq(a[k], b[k]));
}
function lossless(x) {
  try { return JSON.stringify(x) !== undefined && deepEq(JSON.parse(JSON.stringify(x)), x); }
  catch { return false; }
}
// mirrors dsh-tools schemaOf(): {name, description, parameters} per tool
function noUndefinedKeys(o, path = "") {
  for (const [k, v] of Object.entries(o)) {
    assert.notEqual(v, undefined, `undefined value at ${path}.${k}`);
    if (v && typeof v === "object") noUndefinedKeys(v, `${path}.${k}`);
  }
}

test("R11-1 every tool wire projection {name,description,parameters} is lossless JSON", () => {
  for (const s of toolSpecs({})) {
    noUndefinedKeys(s.parameters, `${s.name}.parameters`);
    const proj = { name: s.name, description: s.description, parameters: structuredClone(s.parameters) };
    assert.ok(lossless(proj), `${s.name} must survive JSON round-trip losslessly`);
    assert.equal(typeof s.name, "string");
    assert.equal(typeof s.description, "string");
  }
});

test("R11-2 every tool declares output {schema, render} (defineTool contract)", () => {
  for (const s of toolSpecs({})) {
    assert.ok(s.output && typeof s.output === "object", `${s.name} missing output`);
    assert.equal(typeof s.output.render, "function", `${s.name} output.render`);
    assert.ok(lossless(s.output.schema), `${s.name} output.schema must be lossless JSON`);
    // required only on parent objects (strict JSON-subset rule)
    const checkReq = (node, path) => {
      if (node && typeof node === "object") {
        if (node.type !== "object" && "required" in node && Array.isArray(node.required) === false) {
          throw new Error(`inline required on ${node.type} at ${path}`);
        }
        for (const [k, v] of Object.entries(node)) if (v && typeof v === "object") checkReq(v, `${path}.${k}`);
      }
    };
    checkReq(s.output.schema, `${s.name}.output.schema`);
  }
});
