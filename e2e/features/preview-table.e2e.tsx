import { expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import { row } from "../../src/hermes/fakeHermes";
import { boot, shot } from "../harness";

const HEADER = "order,customer,city,item,qty,price,status,note";
/** 300 orders; order 2's customer holds a comma and its note quotes and a line break. */
const SALES = [
  HEADER,
  ...Array.from({ length: 300 }, (_, i) =>
    i === 1
      ? `1002,"Acme, Inc.",Leeds,Bolts,40,0.25,shipped,"said ""rush it""\nthen called back"`
      : `${1001 + i},Customer ${i + 1},${["Leeds", "York", "Bath"][i % 3]},Item ${i % 7},${(i % 9) + 1},${(i % 50) + 0.99},${i % 4 ? "shipped" : "open"},`,
  ),
].join("\r\n");
/** 1,500 rows of 20 columns: 30,000 cells, past the 10,000 the table draws. */
const WIDE = Array.from({ length: 1501 }, (_, r) => Array.from({ length: 20 }, (_, c) => (r ? `${r}.${c}` : `col${c}`)).join(",")).join("\n");

async function openReply() {
  const booted = await boot({
    seed: (s) => {
      s.sessions = [row("export", 0.1, { pinned: true, title: "Weekly export", cwd: "/home/owner/out" })];
      s.transcripts = {
        export: [
          { role: "user", text: "Export this week's orders" },
          { role: "assistant", text: "Done. The orders are in `sales.csv`, and every column is in `wide.csv`." },
        ],
      };
      s.serverFiles = { "/home/owner/out/sales.csv": SALES, "/home/owner/out/wide.csv": WIDE };
    },
  });
  await booted.app.getByRole("button", { name: /Weekly export/ }).click();
  await expect.element(booted.app.getByText(/The orders are in/)).toBeVisible();
  return booted;
}

/** The app's own window, whose clipboard the table writes to. */
const appWindow = () => document.querySelector<HTMLIFrameElement>('iframe[title="Highwing"]')!.contentWindow!;

it("opens a CSV a reply names as a table, whose header row stays on top as it scrolls, and copies a range of cells", async () => {
  const { app, server } = await openReply();
  await app.getByText("sales.csv", { exact: true }).click();
  const grid = app.getByRole("grid");
  await expect.element(grid).toBeVisible();
  const reads = server.restRequests.filter((r) => r.path.startsWith("/api/fs/read"));
  expect(new Set(reads.map((r) => `${r.path} ${r.query.get("path")}`)), "the file read as text, as before").toEqual(new Set(["/api/fs/read-text /home/owner/out/sales.csv"]));
  await expect.element(app.getByText("CSV · 14 KB · 300 rows · 8 columns")).toBeVisible();
  const headers = [...grid.element().querySelectorAll("thead th")];
  expect(headers.map((h) => h.textContent)).toEqual(HEADER.split(","));
  const acme = grid.getByRole("row").nth(2).element();
  expect([...acme.children].map((c) => c.textContent)).toEqual(["1002", "Acme, Inc.", "Leeds", "Bolts", "40", "0.25", "shipped", 'said "rush it"\nthen called back']);
  await shot("table");

  const scroller = grid.element().parentElement!;
  scroller.scrollTop = 2000;
  await expect.poll(() => scroller.scrollTop, { message: "the table scrolled" }).toBeGreaterThan(1500);
  expect(headers[0].getBoundingClientRect().top, "the header row's top").toBe(scroller.getBoundingClientRect().top);
  await shot("scrolled");

  scroller.scrollTop = 0;
  const copied: string[] = [];
  Object.defineProperty(appWindow().navigator, "clipboard", { configurable: true, value: { writeText: async (t: string) => void copied.push(t) } });
  await grid.getByText("Acme, Inc.", { exact: true }).click();
  await userEvent.keyboard("{Shift>}{ArrowDown}{ArrowRight}{ArrowRight}{/Shift}");
  await expect.element(grid.getByText("Customer 3", { exact: true })).toHaveAttribute("aria-selected", "true");
  await shot("selected");
  await userEvent.keyboard("{Control>}c{/Control}");
  await expect.poll(() => copied).toEqual(["Acme, Inc.\tLeeds\tBolts\nCustomer 3\tBath\tItem 2"]);
});

it("says how many rows it shows of a file past the cap, and Open as text shows the file's text", async () => {
  const { app } = await openReply();
  await app.getByText("wide.csv", { exact: true }).click();
  await expect.element(app.getByText("Showing the first 500 rows of 1,500.")).toBeVisible();
  expect(app.getByRole("grid").getByRole("row").elements()).toHaveLength(501);
  await shot("capped");

  await app.getByRole("button", { name: "Open as text" }).click();
  await expect.element(app.getByRole("grid")).not.toBeInTheDocument();
  await expect.element(app.getByText(/^col0,col1,col2/)).toBeVisible();
  await shot("as-text");
});
