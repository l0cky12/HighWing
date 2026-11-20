import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { asTsv, delimiterOf, documentFormatOf, looksLike, parseDelimited, parseTable, zipUnpacked } from "./documents";
import { fakeZip } from "./fakeZip";

const plan = new Uint8Array(readFileSync("src/ui/fixtures/plan.docx"));

describe("Document formats", () => {
  it("knows a PDF or Word file by its name, or else its type", () => {
    expect(documentFormatOf("/srv/Report.PDF")).toBe("pdf");
    expect(documentFormatOf("plan.docx")).toBe("docx");
    expect(documentFormatOf("download", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBe("docx");
    expect(documentFormatOf("old.doc")).toBeUndefined();
    expect(documentFormatOf("pdf")).toBeUndefined();
  });

  it("checks the first bytes", () => {
    expect(looksLike("docx", plan)).toBe(true);
    expect(looksLike("pdf", plan)).toBe(false);
  });

  it("counts what a zip unpacks to, and nothing from what isn't one", async () => {
    // What Python's zipfile sums for the same file.
    expect(await zipUnpacked(plan, 1e6)).toBe(2986);
    expect(await zipUnpacked(new TextEncoder().encode("PK\x03\x04 not really"), 1e6)).toBeUndefined();
    expect(await zipUnpacked(new Uint8Array(3), 1e6)).toBeUndefined();
    // A comment after the end record moves it; the sizes read the same.
    const commented = new Uint8Array([...plan.slice(0, -2), 5, 0, ...new TextEncoder().encode("hello")]);
    expect(await zipUnpacked(commented, 1e6)).toBe(2986);
  });

  it("stops unpacking past the limit, whatever the zip's directory says", async () => {
    const big = new Uint8Array(3000);
    expect(await zipUnpacked(await fakeZip([{ name: "a.xml", data: big }]), 2999)).toBe("over");
    expect(await zipUnpacked(await fakeZip([{ name: "a.xml", data: big, claims: 10 }]), 2999)).toBe("over");
    expect(await zipUnpacked(await fakeZip([{ name: "a.xml", data: big, claims: 10 }]), 3000)).toBe(3000);
    // mammoth's unzip reads every directory entry whatever the end record's count says.
    const uncounted = await fakeZip([{ name: "a.xml", data: big, claims: 10 }]);
    new DataView(uncounted.buffer).setUint16(uncounted.length - 22 + 10, 0, true);
    expect(await zipUnpacked(uncounted, 2999)).toBe("over");
    const misplaced = plan.slice();
    new DataView(misplaced.buffer).setUint32(misplaced.length - 22 + 12, 1, true);
    expect(await zipUnpacked(misplaced, 1e6)).toBeUndefined();
    const half = big.slice(0, 2000);
    expect(await zipUnpacked(await fakeZip([{ name: "a.xml", data: half }, { name: "b.xml", data: half }]), 3999)).toBe("over");
  });
});

describe("CSV and TSV files (issue #30)", () => {
  const rows = (text: string, d: "," | "\t" | ";" = ",") => parseDelimited(text, d).rows;

  it("splits rows and fields, with CRLF, LF or CR line ends", () => {
    expect(rows("a,b,c\r\n1,2,3\r\n")).toEqual([["a", "b", "c"], ["1", "2", "3"]]);
    expect(rows("a,b\n1,2")).toEqual([["a", "b"], ["1", "2"]]);
    expect(rows("a,b\r1,2\r")).toEqual([["a", "b"], ["1", "2"]]);
    expect(rows("a,,\n,,")).toEqual([["a", "", ""], ["", "", ""]]);
  });

  it("keeps commas, quotes and line breaks inside a quoted field in that field", () => {
    const text = 'name,note,qty\r\n"Smith, Jo","said ""hi""\r\nthen left",3\r\n"",x,""\r\n';
    expect(rows(text)).toEqual([
      ["name", "note", "qty"],
      ["Smith, Jo", 'said "hi"\r\nthen left', "3"],
      ["", "x", ""],
    ]);
  });

  it("reads a file that breaks the rules without losing text", () => {
    expect(rows('a b"c,d')).toEqual([['a b"c', "d"]]);
    expect(rows('"ab"cd,e')).toEqual([["abcd", "e"]]);
    expect(rows('x,"never closed\nstill here')).toEqual([["x", "never closed\nstill here"]]);
    expect(rows("\ufeffa,b\n\n\n1,2\n\n")).toEqual([["a", "b"], ["1", "2"]]);
    // A one-column file writes an empty field as "", which is a row; a blank line isn't.
    expect(rows('name\n""\n\nnext\n""')).toEqual([["name"], [""], ["next"], [""]]);
  });

  it("says whether the text stops at the end of a row", () => {
    expect(parseDelimited("a,b\n1,2\n", ",").ended).toBe(true);
    expect(parseDelimited("a,b\n1,2", ",").ended).toBe(false);
    expect(parseDelimited('a,b\n1,"2\n', ",").ended).toBe(false);
  });

  it("tells a tab or semicolon file from a comma one", () => {
    expect(delimiterOf("data.csv", "a,b,c\n1,2,3\n")).toBe(",");
    expect(delimiterOf("data.csv", "a\tb\tc\n1\t2\t3\n")).toBe("\t");
    // Excel's CSV where a comma is the decimal mark.
    expect(delimiterOf("prices.csv", "item;price;qty\napple;1,50;3\npear;0,75;10\n")).toBe(";");
    // A comma inside quotes doesn't count.
    expect(delimiterOf("x.csv", 'a;b\n"1,2,3";4\n')).toBe(";");
    // Every row the same width beats a header that splits further.
    expect(delimiterOf("x.csv", "a,b;c;d\n1,2;3\n4,5;6\n")).toBe(",");
    expect(delimiterOf("one column.csv", "name\nJo\n")).toBe(",");
    // A whole file's last row counts though no line break ends it.
    expect(delimiterOf("x.csv", "Name, as entered;Score\nAlice;10")).toBe(";");
    expect(delimiterOf("data.tsv", "a,b,c\n1,2,3\n")).toBe("\t");
  });

  it("drops the last row of a file read only in part, unless the read stopped at a row's end", () => {
    expect(parseTable("x.csv", "a,b\n1,2\n3,", true)).toEqual({ delimiter: ",", rows: [["a", "b"], ["1", "2"]], width: 2, cut: true });
    expect(parseTable("x.csv", "a,b\n1,2\n", true).rows).toEqual([["a", "b"], ["1", "2"]]);
    expect(parseTable("x.csv", "a,b\n1,2\n3,", false).rows).toEqual([["a", "b"], ["1", "2"], ["3", ""]]);
    expect(parseTable("x.csv", "a\n1,2,3\n", false).width).toBe(3);
  });

  it("copies cells as tab-separated text that pastes back cell for cell", () => {
    expect(asTsv([["a", "b"], ["1", "2"]])).toBe("a\tb\n1\t2");
    expect(asTsv([['say "hi"', "two\nlines", "x\ty"]])).toBe('"say ""hi"""\t"two\nlines"\t"x\ty"');
    expect(rows(asTsv([['say "hi"', "two\nlines", "x\ty"]]), "\t")).toEqual([['say "hi"', "two\nlines", "x\ty"]]);
  });
});
