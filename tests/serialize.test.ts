import { describe, expect, test } from "bun:test";
import { toCsv } from "../src/export/serialize.ts";

describe("CSV publication", () => {
  test("uses RFC-style quoting and neutralizes spreadsheet formulas", () => {
    expect(
      toCsv(
        ["value", "detail"],
        [
          { value: "=1+1", detail: 'comma, quote " and newline\n' },
          { value: 2, detail: null },
        ],
      ),
    ).toBe(`value,detail
'=1+1,"comma, quote "" and newline
"
2,
`);
  });
});
