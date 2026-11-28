import { describe, expect, it } from "vitest";
import {
  makeStyle,
  plainStyle,
  section,
  shouldColor,
  stripAnsi,
  table,
  wrap,
} from "./style.ts";

const color = makeStyle(true);

describe("shouldColor", () => {
  it("honors NO_COLOR above everything else", () => {
    expect(
      shouldColor({ isTTY: true }, { NO_COLOR: "1", FORCE_COLOR: "1" }),
    ).toBe(false);
  });

  it("ignores an empty NO_COLOR", () => {
    expect(shouldColor({ isTTY: true }, { NO_COLOR: "" })).toBe(true);
    expect(
      shouldColor({ isTTY: false }, { NO_COLOR: "", FORCE_COLOR: "1" }),
    ).toBe(true);
  });

  it("forces color for non-empty FORCE_COLOR other than 0", () => {
    expect(shouldColor({ isTTY: false }, { FORCE_COLOR: "1" })).toBe(true);
    expect(shouldColor({ isTTY: false }, { FORCE_COLOR: "yes" })).toBe(true);
  });

  it("treats FORCE_COLOR=0 and empty FORCE_COLOR as not forcing", () => {
    expect(shouldColor({ isTTY: true }, { FORCE_COLOR: "0" })).toBe(true);
    expect(shouldColor({ isTTY: false }, { FORCE_COLOR: "0" })).toBe(false);
    expect(shouldColor({ isTTY: false }, { FORCE_COLOR: "" })).toBe(false);
  });

  it("disables color for TERM=dumb unless FORCE_COLOR wins", () => {
    expect(shouldColor({ isTTY: true }, { TERM: "dumb" })).toBe(false);
    expect(
      shouldColor({ isTTY: true }, { TERM: "dumb", FORCE_COLOR: "1" }),
    ).toBe(true);
  });

  it("falls back to the stream's TTY state", () => {
    expect(shouldColor({ isTTY: true }, { TERM: "xterm-256color" })).toBe(true);
    expect(shouldColor({ isTTY: false }, { TERM: "xterm" })).toBe(false);
    expect(shouldColor({}, {})).toBe(false);
  });
});

describe("makeStyle and plainStyle", () => {
  it("plainStyle returns text unchanged and reports no color", () => {
    expect(plainStyle.color).toBe(false);
    expect(plainStyle.bold("x")).toBe("x");
    expect(plainStyle.dim("x")).toBe("x");
    expect(plainStyle.accent("x")).toBe("x");
    expect(plainStyle.ok("x")).toBe("x");
    expect(plainStyle.warn("x")).toBe("x");
    expect(plainStyle.error("x")).toBe("x");
  });

  it("makeStyle(false) behaves as plain", () => {
    const off = makeStyle(false);
    expect(off.color).toBe(false);
    expect(off.accent("x")).toBe("x");
    expect(off.error("x")).toBe("x");
  });

  it("emits the documented SGR codes when color is on", () => {
    expect(color.color).toBe(true);
    expect(color.bold("x")).toBe("\x1b[1mx\x1b[22m");
    expect(color.dim("x")).toBe("\x1b[2mx\x1b[22m");
    expect(color.accent("x")).toBe("\x1b[36mx\x1b[39m");
    expect(color.ok("x")).toBe("\x1b[32mx\x1b[39m");
    expect(color.warn("x")).toBe("\x1b[33mx\x1b[39m");
    expect(color.error("x")).toBe("\x1b[31mx\x1b[39m");
  });
});

describe("stripAnsi", () => {
  it("removes SGR sequences only", () => {
    expect(stripAnsi("\x1b[1m\x1b[2mx\x1b[22m\x1b[39m")).toBe("x");
    expect(stripAnsi("\x1b[38;5;208mdeep\x1b[0m")).toBe("deep");
  });

  it("leaves non-SGR escape sequences alone", () => {
    expect(stripAnsi("\x1b[2Kx")).toBe("\x1b[2Kx");
  });
});

describe("styled output matches plain output after stripAnsi", () => {
  const rows: Array<readonly [string, string]> = [
    ["Harness", "claude"],
    ["Models", "opus, sonnet"],
  ];

  it("section", () => {
    expect(stripAnsi(section(color, 2, 7, "Models"))).toBe(
      section(plainStyle, 2, 7, "Models"),
    );
  });

  it("table", () => {
    expect(stripAnsi(table(color, rows))).toBe(table(plainStyle, rows));
  });

  it("wrap accepts text stripped of styling", () => {
    expect(wrap(stripAnsi(color.bold("alpha beta")), 5, 0)).toBe(
      "alpha\nbeta\n",
    );
  });
});

describe("section", () => {
  it("renders a plain header with a rule of the title's width", () => {
    expect(section(plainStyle, 2, 7, "Models")).toBe(
      "\n[2/7] Models\n------\n",
    );
  });

  it("renders dim counter, bold title and dim rule when colored", () => {
    expect(section(color, 2, 7, "Models")).toBe(
      "\n\x1b[2m[2/7]\x1b[22m \x1b[1mModels\x1b[22m\n\x1b[2m------\x1b[22m\n",
    );
  });
});

describe("table", () => {
  it("pads labels to the longest label with two spaces of gap", () => {
    expect(
      table(plainStyle, [
        ["Harness", "claude"],
        ["Models", "opus"],
      ]),
    ).toBe("  Harness  claude\n  Models   opus\n");
  });

  it("honors a custom indent", () => {
    expect(
      table(
        plainStyle,
        [
          ["a", "1"],
          ["bbb", "2"],
        ],
        0,
      ),
    ).toBe("a    1\nbbb  2\n");
    expect(
      table(
        plainStyle,
        [
          ["a", "1"],
          ["bbb", "2"],
        ],
        4,
      ),
    ).toBe("    a    1\n    bbb  2\n");
  });

  it("returns an empty string for no rows", () => {
    expect(table(plainStyle, [])).toBe("");
  });

  it("dims only the labels when colored", () => {
    expect(
      table(color, [
        ["Harness", "claude"],
        ["Models", "opus"],
      ]),
    ).toBe(
      "  \x1b[2mHarness\x1b[22m  claude\n  \x1b[2mModels\x1b[22m   opus\n",
    );
  });

  it("measures label width by visible text, not raw escape bytes", () => {
    expect(
      table(plainStyle, [
        ["\x1b[1mKey\x1b[22m", "v"],
        ["Longer", "w"],
      ]),
    ).toBe("  \x1b[1mKey\x1b[22m     v\n  Longer  w\n");
  });
});

describe("wrap", () => {
  it("breaks at the column budget and indents each line", () => {
    expect(wrap("alpha beta gamma delta", 11, 2)).toBe(
      "  alpha beta\n  gamma delta\n",
    );
  });

  it("allows a line exactly at the width", () => {
    expect(wrap("abcde fghij", 11, 0)).toBe("abcde fghij\n");
    expect(wrap("abcde fghijk", 11, 0)).toBe("abcde\nfghijk\n");
  });

  it("puts a word longer than the width on its own line", () => {
    expect(wrap("a supercalifragilistic b", 8, 1)).toBe(
      " a\n supercalifragilistic\n b\n",
    );
  });

  it("returns an empty string for empty or blank input", () => {
    expect(wrap("", 20, 2)).toBe("");
    expect(wrap("   \n\t ", 20, 2)).toBe("");
  });

  it("collapses whitespace runs, including newlines", () => {
    expect(wrap("one\n\n  two\tthree", 80, 0)).toBe("one two three\n");
  });

  it("uses a default width of 76 and indent of 2", () => {
    const word = "abcdefghi";
    // Seven 9-letter words plus spaces fill 69 of 76 columns; an eighth would reach 79.
    expect(wrap(Array(8).fill(word).join(" "))).toBe(
      "  abcdefghi abcdefghi abcdefghi abcdefghi abcdefghi abcdefghi abcdefghi\n  abcdefghi\n",
    );
  });

  it("supports indent 0", () => {
    expect(wrap("hello world", 76, 0)).toBe("hello world\n");
  });
});
