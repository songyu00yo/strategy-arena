// Explicit temporary source fixtures. These checks do not run a browser or contact models.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  collectInteractionInventory,
  compareInteractionInventories,
} from "./interaction-inventory.mjs";

function fixture(source) {
  const root = mkdtempSync(join(tmpdir(), "arena-interaction-inventory-"));
  mkdirSync(join(root, "src/components"), { recursive: true });
  writeFileSync(join(root, "src/components/fixture.tsx"), source);
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("discovers native controls whose activation relies on browser semantics", () => {
  const f = fixture(`export function View() { return <form onSubmit={submit}>
    <label><input type="file" onChange={upload} />Attach</label>
    <input name="goal" /><textarea /><select><option>One</option></select>
    <button type="submit">Send</button><a href="/history">History</a>
    <details><summary>Original</summary>Body</details>
    <Link href={destination}>Continue</Link>
  </form>; }`);
  try {
    const result = collectInteractionInventory(f.root);
    assert.equal(result.summary.controls, 12);
    assert.equal(result.summary.directEventBindings, 2);
    assert.ok(
      result.entries.some(
        (entry) =>
          entry.tag === "button" && entry.inputType === "submit" && entry.nameHint === "Send",
      ),
    );
    assert.ok(
      result.entries.some((entry) => entry.tag === "a" && entry.destination === "/history"),
    );
    assert.ok(
      result.entries.some((entry) => entry.tag === "Link" && entry.destination === "{destination}"),
    );
    assert.ok(result.entries.every((entry) => entry.verification === "pending"));
    assert.equal(result.verification, "source-discovery-only");
  } finally {
    f.cleanup();
  }
});

test("preserves conditional and repeated control provenance without inventing visible counts", () => {
  const f = fixture(`export function View() { return enabled && <div>
    {items.map(item => <button aria-label={item.title} disabled={busy} onClick={() => choose(item)} />)}
    {expanded ? <summary onClick={collapse}>Close</summary> : null}
  </div>; }`);
  try {
    const result = collectInteractionInventory(f.root);
    const button = result.entries.find(
      (entry) => entry.kind === "control" && entry.tag === "button",
    );
    assert.equal(button.nameHint, "{item.title}");
    assert.deepEqual(button.dynamicAttributes, ["aria-label", "disabled", "onClick"]);
    assert.ok(button.conditions.includes("enabled"));
    assert.ok(button.conditions.includes("repeated: items"));
    assert.equal(result.summary.controls, 2);
    assert.ok(
      result.entries.find((entry) => entry.tag === "summary").conditions.includes("expanded"),
    );
  } finally {
    f.cleanup();
  }
});

test("separates direct UI bindings, component callbacks, spreads and registered listeners", () => {
  const f = fixture(`export function View() {
    window.addEventListener("keydown", handleKey);
    source.addEventListener(name, handler);
    addEventListener("pointerdown", press);
    return <><Widget onCreated={adopt} onClose={close} /><div role="button" tabIndex={0}
      onPointerDown={press} onKeyDown={activate} {...props}>Action</div></>;
  }`);
  try {
    const result = collectInteractionInventory(f.root);
    assert.equal(result.summary.componentCallbacks, 2);
    assert.equal(result.summary.directEventBindings, 2);
    assert.equal(result.summary.eventListeners, 3);
    assert.equal(result.summary.unresolvedSpreads, 1);
    assert.ok(
      result.entries.some((entry) => entry.kind === "listener" && entry.event === "keydown"),
    );
    assert.ok(result.entries.some((entry) => entry.kind === "listener" && entry.event === "name"));
    assert.ok(result.entries.some((entry) => entry.kind === "control" && entry.tag === "div"));
    assert.equal(new Set(result.entries.map((entry) => entry.id)).size, result.entries.length);
  } finally {
    f.cleanup();
  }
});

test("fingerprints source updates and excludes files outside the application source tree", () => {
  const f = fixture(`export const View = () => <button onClick={go}>Go</button>;`);
  try {
    const before = collectInteractionInventory(f.root);
    writeFileSync(join(f.root, ".env.local"), "EXPLICIT_UNREAD_FIXTURE=secret-placeholder");
    assert.equal(collectInteractionInventory(f.root).sourceFingerprint, before.sourceFingerprint);
    writeFileSync(
      join(f.root, "src/components/fixture.tsx"),
      `export const View = () => <button onClick={go}>Next</button>;`,
    );
    const after = collectInteractionInventory(f.root);
    assert.notEqual(after.sourceFingerprint, before.sourceFingerprint);
    assert.equal(before.entries[0].id, after.entries[0].id);
    assert.equal(after.entries[0].line, 1);
  } finally {
    f.cleanup();
  }
});

test("distinguishes false branches and reports syntactically incomplete source", () => {
  const f = fixture(
    `export const View = () => active ? <button>Active</button> : <button>Inactive</button>;`,
  );
  try {
    const result = collectInteractionInventory(f.root);
    assert.deepEqual(
      result.entries.filter((entry) => entry.kind === "control").map((entry) => entry.conditions),
      [["active"], ["!(active)"]],
    );
    writeFileSync(join(f.root, "src/components/fixture.tsx"), `export const View = () => <button`);
    const incomplete = collectInteractionInventory(f.root);
    assert.equal(incomplete.verification, "source-discovery-incomplete");
    assert.ok(incomplete.parseDiagnostics.length > 0);
  } finally {
    f.cleanup();
  }
});

test("source name hints use visible JSX text and exclude decorative attributes", () => {
  const f = fixture(
    `export const View = () => <button><Icon size={13} /><span>Open</span></button>;`,
  );
  try {
    assert.equal(collectInteractionInventory(f.root).entries[0].nameHint, "Open");
  } finally {
    f.cleanup();
  }
});

test("expands local and inline object spread interaction bindings", () => {
  const f = fixture(`export function View() {
    const fieldFocus = { "data-overlay-autofocus": true };
    return <><input {...fieldFocus} /><div {...(front ? {} : { role: "button", onClick: open, onKeyDown: key })} /></>;
  }`);
  try {
    const result = collectInteractionInventory(f.root);
    assert.equal(result.summary.inspectedSpreads, 2);
    assert.equal(result.summary.unresolvedSpreads, 0);
    assert.equal(result.summary.directEventBindings, 2);
    assert.ok(
      result.entries.some(
        (entry) => entry.kind === "control" && entry.role === "button" && entry.suppliedBySpread,
      ),
    );
    assert.ok(
      result.entries.some(
        (entry) => entry.event === "onClick" && entry.conditions.includes("!(front)"),
      ),
    );
  } finally {
    f.cleanup();
  }
});

test("reports source-event drift without treating unchanged line numbers as proof", () => {
  const f = fixture(`export const View = () => <button onClick={open}>Open</button>;`);
  try {
    const before = collectInteractionInventory(f.root);
    writeFileSync(
      join(f.root, "src/components/fixture.tsx"),
      `\nexport const View = () => <button onClick={open}>Open</button>;`,
    );
    assert.equal(
      compareInteractionInventories(before, collectInteractionInventory(f.root)).changed.length,
      0,
    );
    writeFileSync(
      join(f.root, "src/components/fixture.tsx"),
      `export const View = () => <button onClick={replace} onPointerDown={press}>Open</button>;`,
    );
    const drift = compareInteractionInventories(before, collectInteractionInventory(f.root));
    assert.equal(drift.added.length, 1);
    assert.equal(drift.changed.length, 2);
    assert.equal(drift.entriesRequiringReview.length, 3);
    assert.deepEqual(drift.changedFiles, ["src/components/fixture.tsx"]);
  } finally {
    f.cleanup();
  }
});

test("records native field names from their wrapping label before placeholders", () => {
  const f = fixture(
    `export const View = () => <label><span>Budget <small>USD</small></span><input type="number" placeholder="Unlimited" /></label>;`,
  );
  try {
    const result = collectInteractionInventory(f.root);
    assert.equal(result.entries.find((entry) => entry.tag === "input").nameHint, "Budget USD");
  } finally {
    f.cleanup();
  }
});
