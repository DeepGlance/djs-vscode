import { describe, test, expect } from "vitest";

// W1 load-order canary: importing the ASTCodegen barrel and the visitor spine must evaluate
// the whole cyclic module graph with zero ReferenceError (01 §4: types/declarations cross
// cycles freely; only top-level value reads may not). A load-order regression fails HERE,
// not deep inside a sema test.
import * as ast from "./astcodegen.js";
import * as visitor from "./visitor/index.js";
import * as transitive from "./visitor/transitive.js";

describe("W1 scaffold — load-order smoke", () => {
    test("AST barrel and visitor spine evaluate cleanly", () => {
        expect(typeof ast).toBe("object");
        expect(typeof visitor).toBe("object");
        expect(typeof transitive).toBe("object");
    });
});
