import ts from "typescript";

/**
 * TNM-287: heartbeat.ts's outcome derivation trusts `errorMessage` alone —
 * `!adapterResult.errorMessage` means "succeeded" (TNM-263 removed the
 * `exitCode` re-check that used to backstop this). That makes each adapter's
 * `execute()` the sole authority on pass/fail, per adapter contract:
 * a return whose `exitCode` cannot be proven zero must also carry a truthy
 * `errorMessage`, or the run is silently recorded as a success.
 *
 * This is a static, source-level check rather than a real per-adapter
 * failing-path test: driving all twelve adapters' `execute()` through a
 * genuine failing path needs distinct child-process/network scaffolding per
 * adapter (spawned CLIs, mocked HTTP, mocked cloud APIs), which would end up
 * asserting the mocks more than the adapters. This trades completeness for
 * something that runs on every adapter uniformly and still fails when a
 * future adapter reintroduces the shape of defect TNM-263 fixed.
 */

export interface ContractViolation {
  line: number;
  reason: string;
}

function isAdapterExecutionResultReturnType(typeNode: ts.TypeNode | undefined, sf: ts.SourceFile): boolean {
  if (!typeNode) return false;
  const text = typeNode.getText(sf).replace(/\s+/g, "");
  return text === "Promise<AdapterExecutionResult>" || text === "AdapterExecutionResult";
}

/**
 * Finds every function in the file whose declared return type is exactly
 * `AdapterExecutionResult` (or `Promise<...>` of it) — i.e. the functions
 * that actually implement the adapter execution contract, wherever they live
 * (a top-level `execute`, or one built and returned by a factory, as
 * acpx-local does). Anything else in the file — unrelated helper shapes that
 * happen to share a field name like `exitCode` — is out of scope by
 * construction, not by a name-based guess.
 */
function findContractFunctions(sf: ts.SourceFile): ts.FunctionLikeDeclarationBase[] {
  const found: ts.FunctionLikeDeclarationBase[] = [];
  function visit(node: ts.Node) {
    if (
      (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) &&
      node.body &&
      isAdapterExecutionResultReturnType(node.type, sf)
    ) {
      found.push(node);
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return found;
}

function findProperty(objLit: ts.ObjectLiteralExpression, name: string): ts.ObjectLiteralElementLike | undefined {
  return objLit.properties.find(
    (prop) => prop.name && (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)) && prop.name.text === name,
  );
}

function propertyInitializer(
  objLit: ts.ObjectLiteralExpression,
  name: string,
): { present: boolean; initializer: ts.Expression | null } {
  const p = findProperty(objLit, name);
  if (!p) return { present: false, initializer: null };
  if (ts.isShorthandPropertyAssignment(p)) return { present: true, initializer: null };
  if (!ts.isPropertyAssignment(p)) return { present: true, initializer: null };
  return { present: true, initializer: p.initializer };
}

/** True only when the value can be proven, from source text alone, to never be a real failing exit. */
function isProvablyNotAFailure(initializer: ts.Expression | null): boolean {
  if (!initializer) return false;
  if (ts.isNumericLiteral(initializer) && Number(initializer.text) === 0) return true;
  if (initializer.kind === ts.SyntaxKind.NullKeyword) return true;
  return false;
}

function isLiteralNull(initializer: ts.Expression | null): boolean {
  return Boolean(initializer) && initializer!.kind === ts.SyntaxKind.NullKeyword;
}

/**
 * A return with `exitCode` but no `errorMessage` key is only safe when it's
 * a guarded fall-through — i.e. an earlier sibling `if` in the same block
 * already returned with `errorMessage` set (the `process`/`http` adapter
 * shape: check the exit code first, return failure with a message, then fall
 * through to an unconditional success return that never needed the field).
 */
function hasEarlierSiblingErrorMessageGuard(block: ts.Block, targetTopStatement: ts.Statement | null): boolean {
  if (!targetTopStatement) return false;
  const stmts = block.statements;
  const idx = stmts.indexOf(targetTopStatement);
  if (idx <= 0) return false;
  for (let i = 0; i < idx; i++) {
    const stmt = stmts[i];
    if (!ts.isIfStatement(stmt)) continue;
    let guardFound = false;
    (function scan(n: ts.Node) {
      if (ts.isReturnStatement(n) && n.expression && ts.isObjectLiteralExpression(n.expression)) {
        if (propertyInitializer(n.expression, "errorMessage").present) guardFound = true;
      }
      ts.forEachChild(n, scan);
    })(stmt);
    if (guardFound) return true;
  }
  return false;
}

function findEnclosingTopStatement(block: ts.Block, node: ts.Node): ts.Statement | null {
  for (const stmt of block.statements) {
    if (stmt === node) return stmt;
    let contains = false;
    (function scan(n: ts.Node) {
      if (n === node) contains = true;
      ts.forEachChild(n, scan);
    })(stmt);
    if (contains) return stmt;
  }
  return null;
}

export function findAdapterErrorMessageContractViolations(
  source: string,
  fileName = "adapter.ts",
): ContractViolation[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const violations: ContractViolation[] = [];

  for (const fn of findContractFunctions(sf)) {
    function visit(node: ts.Node, enclosingBlock: ts.Block | null) {
      if (ts.isReturnStatement(node) && node.expression && ts.isObjectLiteralExpression(node.expression)) {
        const exitCode = propertyInitializer(node.expression, "exitCode");
        if (exitCode.present && !isProvablyNotAFailure(exitCode.initializer)) {
          const errorMessage = propertyInitializer(node.expression, "errorMessage");
          const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
          if (!errorMessage.present) {
            const guarded = enclosingBlock
              ? hasEarlierSiblingErrorMessageGuard(enclosingBlock, findEnclosingTopStatement(enclosingBlock, node))
              : false;
            if (!guarded) {
              violations.push({
                line: line + 1,
                reason:
                  "returns exitCode without errorMessage and without an earlier guard return that sets errorMessage",
              });
            }
          } else if (isLiteralNull(errorMessage.initializer)) {
            violations.push({
              line: line + 1,
              reason: "errorMessage is a literal null beside an exitCode that isn't provably 0",
            });
          }
        }
      }
      const nextBlock = ts.isBlock(node) ? node : enclosingBlock;
      ts.forEachChild(node, (child) => visit(child, nextBlock));
    }
    visit(fn.body!, null);
  }

  return violations;
}
