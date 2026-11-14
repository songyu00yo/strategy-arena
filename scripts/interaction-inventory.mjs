import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const nativeControls = new Set([
  "a",
  "button",
  "details",
  "form",
  "input",
  "label",
  "option",
  "select",
  "summary",
  "textarea",
]);
const directEvents =
  /^on(?:Click|DoubleClick|AuxClick|ContextMenu|Pointer\w*|Mouse\w*|Touch\w*|Key\w*|Focus|Blur|Change|Input|Submit|Reset|Toggle|BeforeToggle|Drag\w*|Drop|Scroll|Wheel|Paste|Copy|Cut|Invalid|Select|Composition\w*)(?:Capture)?$/;
const digest = (value) => createHash("sha256").update(value).digest("hex");

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(path);
      return entry.isFile() && /\.[jt]sx?$/.test(entry.name) ? [path] : [];
    })
    .sort();
}

function category(path) {
  if (/identity|history/.test(path)) return "identity-history";
  if (/version-comparison/.test(path)) return "versions";
  if (/recorded-examples|recorded-example-viewer/.test(path)) return "examples";
  if (/model-selector/.test(path)) return "model-selection";
  if (/attachment|intake-source|material/.test(path)) return "materials";
  if (/decision-review|evidence/.test(path)) return "verification";
  if (/step-follow-up|recorded-challenge/.test(path)) return "supplement";
  if (/condition|challenge-form/.test(path)) return "conditions";
  if (/guided-intake|question-input|intake-summary/.test(path)) return "intake";
  if (/console/.test(path)) return "stage-report";
  if (/modal|overlay|disclosure/.test(path)) return "shared-motion";
  if (path === "src/app/page.tsx") return "home-orchestration";
  return "other";
}

function compact(text, length = 180) {
  return text.replace(/\s+/g, " ").trim().slice(0, length);
}

function valueOf(attribute, source) {
  if (!attribute?.initializer) return attribute ? "true" : undefined;
  return ts.isStringLiteral(attribute.initializer)
    ? attribute.initializer.text
    : compact(attribute.initializer.getText(source));
}

function conditionalAncestors(node, source) {
  const conditions = [];
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isConditionalExpression(parent)) {
      const expression = compact(parent.condition.getText(source));
      const inFalseBranch = parent.whenFalse.pos <= node.pos && node.end <= parent.whenFalse.end;
      conditions.push(inFalseBranch ? `!(${expression})` : expression);
    }
    if (
      ts.isBinaryExpression(parent) &&
      [
        ts.SyntaxKind.AmpersandAmpersandToken,
        ts.SyntaxKind.BarBarToken,
        ts.SyntaxKind.QuestionQuestionToken,
      ].includes(parent.operatorToken.kind)
    ) {
      const expression = compact(parent.left.getText(source));
      conditions.push(
        parent.operatorToken.kind === ts.SyntaxKind.BarBarToken
          ? `!(${expression})`
          : parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
            ? `${expression} == null`
            : expression,
      );
    }
    if (
      ts.isCallExpression(parent) &&
      ts.isPropertyAccessExpression(parent.expression) &&
      parent.expression.name.text === "map"
    ) {
      conditions.push("repeated: " + compact(parent.expression.expression.getText(source)));
    }
    if (ts.isFunctionDeclaration(parent)) break;
  }
  return [...new Set(conditions)];
}

function ownerComponent(node, source) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isFunctionDeclaration(parent) && parent.name) return parent.name.text;
    if (ts.isArrowFunction(parent) || ts.isFunctionExpression(parent)) {
      const declaration = parent.parent;
      if (ts.isVariableDeclaration(declaration)) return declaration.name.getText(source);
    }
  }
  return null;
}

function jsxName(node, source) {
  const hints = [];
  function visit(child) {
    if (hints.join(" ").length >= 180) return;
    if (ts.isJsxText(child) && child.text.trim()) hints.push(compact(child.text));
    else if (ts.isJsxExpression(child) && child.expression)
      hints.push("{" + compact(child.expression.getText(source), 80) + "}");
    else if (ts.isJsxElement(child)) child.children.forEach(visit);
  }
  if (ts.isJsxElement(node.parent) && node.parent.openingElement === node) {
    node.parent.children.forEach(visit);
  }
  return compact(hints.join(" "));
}

function wrappingLabel(node, source) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isJsxElement(parent) && parent.openingElement.tagName.getText(source) === "label")
      return jsxName(parent.openingElement, source);
    if (ts.isFunctionDeclaration(parent)) break;
  }
  return undefined;
}

/** Source candidates are a discovery inventory. They do not establish browser behavior or motion quality. */
export function collectInteractionInventory(root = process.cwd()) {
  const directory = resolve(root);
  const entries = [];
  const files = [];
  const parseDiagnostics = [];
  for (const path of sourceFiles(join(directory, "src"))) {
    const bytes = readFileSync(path);
    const text = bytes.toString("utf8");
    const file = relative(directory, path).replaceAll("\\", "/");
    const source = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
      extname(file).endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    for (const diagnostic of source.parseDiagnostics) {
      const position = source.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
      parseDiagnostics.push({
        file,
        line: position.line + 1,
        message: ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
      });
    }
    const localObjects = new Map();
    function findObjects(node) {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
        const name = node.name.text;
        localObjects.set(name, localObjects.has(name) ? null : node.initializer);
      }
      ts.forEachChild(node, findObjects);
    }
    findObjects(source);
    const ordinals = new Map();
    const add = (node, kind, tag, event, details) => {
      const key = `${kind}:${tag}:${event}`;
      const ordinal = (ordinals.get(key) ?? 0) + 1;
      ordinals.set(key, ordinal);
      const position = source.getLineAndCharacterOfPosition(node.getStart(source));
      entries.push({
        id: `${file}#${key}:${ordinal}`,
        file,
        line: position.line + 1,
        column: position.character + 1,
        category: category(file),
        component: ownerComponent(node, source),
        kind,
        tag,
        event,
        conditions: conditionalAncestors(node, source),
        verification: "pending",
        ...details,
      });
    };
    function visit(node) {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const tag = node.tagName.getText(source);
        const attributes = node.attributes.properties.filter(ts.isJsxAttribute);
        const attribute = (name) => attributes.find((item) => item.name.getText(source) === name);
        const name =
          valueOf(attribute("aria-label"), source) ??
          (tag === "input" || tag === "textarea" || tag === "select"
            ? wrappingLabel(node, source)
            : undefined) ??
          valueOf(attribute("title"), source) ??
          valueOf(attribute("placeholder"), source) ??
          jsxName(node, source);
        const role = valueOf(attribute("role"), source);
        const details = {
          nameHint: name,
          role,
          inputType: valueOf(attribute("type"), source),
          destination: valueOf(attribute("href"), source),
          disabled: valueOf(attribute("disabled"), source),
          dynamicAttributes: attributes
            .filter((item) => item.initializer && ts.isJsxExpression(item.initializer))
            .map((item) => item.name.getText(source)),
          spreadAttributes: node.attributes.properties.some(ts.isJsxSpreadAttribute),
          coverageUnit: ["form", "label", "option", "details"].includes(tag)
            ? "native-container-or-option"
            : ["-1", "{-1}"].includes(valueOf(attribute("tabIndex"), source)) &&
                !nativeControls.has(tag)
              ? "programmatic-focus-target"
              : "actionable-control",
        };
        if (
          nativeControls.has(tag) ||
          tag === "Link" ||
          role === "button" ||
          role === "option" ||
          role === "tab" ||
          role === "menuitem" ||
          attribute("tabIndex")
        ) {
          add(node, "control", tag, "native-or-delegated", details);
        }
        for (const item of attributes) {
          const event = item.name.getText(source);
          if (!/^on[A-Z]/.test(event)) continue;
          add(item, directEvents.test(event) ? "event" : "component-callback", tag, event, {
            nameHint: name,
            handler: valueOf(item, source),
            nativeElement: tag[0] === tag[0].toLowerCase(),
          });
        }
        for (const spread of node.attributes.properties.filter(ts.isJsxSpreadAttribute)) {
          const expression = ts.isIdentifier(spread.expression)
            ? localObjects.get(spread.expression.text)
            : spread.expression;
          const canInspect =
            expression &&
            (ts.isObjectLiteralExpression(expression) ||
              ts.isConditionalExpression(expression) ||
              ts.isParenthesizedExpression(expression));
          add(spread, "spread", tag, "spread-bindings", {
            nameHint: name,
            expression: compact(spread.expression.getText(source)),
            resolution: canInspect ? "statically-inspected" : "requires-call-site-review",
          });
          if (!canInspect) continue;
          const inspect = (value) => {
            if (ts.isParenthesizedExpression(value)) return inspect(value.expression);
            if (ts.isConditionalExpression(value)) {
              inspect(value.whenTrue);
              inspect(value.whenFalse);
            }
            if (!ts.isObjectLiteralExpression(value)) return;
            for (const property of value.properties) {
              if (!ts.isPropertyAssignment(property)) continue;
              const key = ts.isStringLiteral(property.name)
                ? property.name.text
                : property.name.getText(source);
              if (/^on[A-Z]/.test(key))
                add(property, directEvents.test(key) ? "event" : "component-callback", tag, key, {
                  nameHint: name,
                  handler: compact(property.initializer.getText(source)),
                  nativeElement: tag[0] === tag[0].toLowerCase(),
                  suppliedBySpread: true,
                });
              if (
                key === "role" &&
                ts.isStringLiteral(property.initializer) &&
                ["button", "option", "tab", "menuitem"].includes(property.initializer.text)
              )
                add(property, "control", tag, "spread-role", {
                  nameHint: name,
                  role: property.initializer.text,
                  suppliedBySpread: true,
                });
            }
          };
          inspect(expression);
        }
      }
      if (ts.isCallExpression(node)) {
        const expression = node.expression;
        const propertyListener =
          ts.isPropertyAccessExpression(expression) && expression.name.text === "addEventListener";
        const globalListener =
          ts.isIdentifier(expression) && expression.text === "addEventListener";
        if (propertyListener || globalListener) {
          add(
            node,
            "listener",
            propertyListener ? expression.expression.getText(source) : "globalThis",
            valueOf({ initializer: node.arguments[0] }, source) ?? "unknown-event",
            { handler: compact(node.arguments[1]?.getText(source) ?? "") },
          );
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
    files.push({ path: file, sha256: digest(bytes) });
  }
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    sourceFingerprint: digest(JSON.stringify(files)),
    verification: parseDiagnostics.length ? "source-discovery-incomplete" : "source-discovery-only",
    meaning:
      "Entries identify source candidates. Runtime visibility, interaction execution and animation quality require independent browser evidence.",
    summary: {
      sourceFiles: files.length,
      controls: entries.filter((entry) => entry.kind === "control").length,
      directEventBindings: entries.filter((entry) => entry.kind === "event").length,
      componentCallbacks: entries.filter((entry) => entry.kind === "component-callback").length,
      eventListeners: entries.filter((entry) => entry.kind === "listener").length,
      unresolvedSpreads: entries.filter(
        (entry) => entry.kind === "spread" && entry.resolution === "requires-call-site-review",
      ).length,
      inspectedSpreads: entries.filter(
        (entry) => entry.kind === "spread" && entry.resolution === "statically-inspected",
      ).length,
    },
    files,
    parseDiagnostics,
    entries,
  };
}

/** Reports source drift only. Every changed surface still needs independent browser evidence. */
export function compareInteractionInventories(before, after) {
  const previous = new Map(before.entries.map((entry) => [entry.id, entry]));
  const current = new Map(after.entries.map((entry) => [entry.id, entry]));
  const comparable = (entry) =>
    JSON.stringify(
      Object.fromEntries(
        Object.entries(entry).filter(([key]) => !["line", "column", "verification"].includes(key)),
      ),
    );
  const added = after.entries.filter((entry) => !previous.has(entry.id)).map((entry) => entry.id);
  const removed = before.entries.filter((entry) => !current.has(entry.id)).map((entry) => entry.id);
  const changed = after.entries
    .filter(
      (entry) => previous.has(entry.id) && comparable(previous.get(entry.id)) !== comparable(entry),
    )
    .map((entry) => entry.id);
  const previousFiles = new Map(before.files.map((file) => [file.path, file.sha256]));
  return {
    verification: "source-drift-only",
    added,
    removed,
    changed,
    changedFiles: after.files
      .filter((file) => previousFiles.get(file.path) !== file.sha256)
      .map((file) => file.path),
    removedFiles: before.files
      .filter((file) => !after.files.some((currentFile) => currentFile.path === file.path))
      .map((file) => file.path),
    entriesRequiringReview: [...added, ...changed],
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const options = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!["--output", "--root", "--baseline"].includes(flag) || !value || value.startsWith("--")) {
      throw new Error(
        "Usage: node scripts/interaction-inventory.mjs [--root directory] [--output file.json] [--baseline inventory.json]",
      );
    }
    options.set(flag, value);
  }
  const inventory = collectInteractionInventory(options.get("--root") ?? process.cwd());
  if (options.has("--baseline")) {
    inventory.sourceDrift = compareInteractionInventories(
      JSON.parse(readFileSync(resolve(options.get("--baseline")), "utf8")),
      inventory,
    );
  }
  if (options.has("--output")) {
    const output = resolve(options.get("--output"));
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, JSON.stringify(inventory, null, 2) + "\n");
    console.log(
      JSON.stringify({ output, ...inventory.summary, verification: inventory.verification }),
    );
  } else console.log(JSON.stringify(inventory, null, 2));
}
