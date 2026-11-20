// Settings → Gateways' reads and writes (gateways.ts, ADR 0073) through the transport, against the fake dashboard's
// messaging routes (fakeGateways.ts): the list, keep / replace / remove of a token, the switch, the read before a save
// and the read after it, the status check, the three problems told apart, and Slack's two tokens, allowlist and home
// channel (ADR 0238). Every token here is synthetic.
import { describe, expect, it } from "vitest";
import { FakeHermes } from "./fakeHermes";
import { connect } from "./transport";
import { putBody, redact, type Draft, type Gateway } from "./gateways";

const TOKEN = "123456789:AAAAdummydummydummydummydummydummy00";
const NEW_TOKEN = "987654321:BBBBnewnewnewnewnewnewnewnewnewnew11";
// Built at run time: a literal in this shape trips GitHub's push protection.
const DISCORD_SHAPED = ["MTIzNDU2Nzg5MDEyMzQ1Njc4", "GabcDE", "abcdefghijklmnopqrstuvwxyz0123"].join(".");
const SLACK_BOT = ["xoxb", "1234567890", "0987654321", "dummydummydummydummy"].join("-");
const SLACK_APP = ["xapp", "1", "A0123456789", "1234567890", "dummydummydummydummy"].join("-");

async function setUp() {
  const server = new FakeHermes();
  server.otherProfiles = { bot: [] };
  const fake = server.gateways;
  fake.env.default = { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_ALLOWED_USERS: "111,222" };
  fake.enabled.default = { telegram: true };
  const hermes = await connect(server.openPipe, "default");
  return { server, fake, hermes, api: hermes.gateways };
}

const tg = async (api: Awaited<ReturnType<typeof setUp>>["api"], profile = "default") => (await api.list(profile)).gateways.find((g) => g.id === "telegram")!;
const draft = (g: Gateway, d: Partial<Draft> = {}): Draft => ({ enabled: g.enabled, edits: {}, ...d });

describe("Gateways: reading", () => {
  it("lists only Telegram, Discord and Slack, with a redacted preview of each token and never the token", async () => {
    const { api } = await setUp();
    const list = await api.list("default");
    expect(list.gateways.map((g) => g.id)).toEqual(["telegram", "discord", "slack"]);
    expect(list.startCommand).toBe("hermes -p default gateway start");
    const [telegram, discord] = list.gateways;
    expect(telegram).toMatchObject({ enabled: true, configured: true, gatewayRunning: false, state: "gateway_stopped" });
    const token = telegram.fields.find((f) => f.key === "TELEGRAM_BOT_TOKEN")!;
    expect(token).toMatchObject({ secret: true, set: true, required: true, preview: "«redacted:1234...my00»", value: undefined });
    expect(telegram.fields.find((f) => f.key === "TELEGRAM_ALLOWED_USERS")).toMatchObject({ secret: false, value: "111,222" });
    expect(discord).toMatchObject({ enabled: false, configured: false, state: "disabled" });
    expect(JSON.stringify(list)).not.toContain(TOKEN);
  });

  it("reads each profile on its own, and says when Hermes has no messaging routes", async () => {
    const { api, fake } = await setUp();
    expect((await tg(api, "bot")).fields.every((f) => !f.set)).toBe(true);
    await expect(api.list("nobody")).rejects.toThrow("Profile 'nobody' does not exist");
    fake.routes = "none";
    await expect(api.list("default")).rejects.toThrow(/no messaging gateway routes/);
  });
});

describe("Gateways: saving", () => {
  it("keeps an untouched token: a save of the switch alone sends no env and clears nothing", async () => {
    const { api, fake } = await setUp();
    const g = await tg(api);
    expect(putBody(g, draft(g, { enabled: false }))).toEqual({ enabled: false });
    // An empty Replace is a keep, too.
    expect(putBody(g, draft(g, { edits: { TELEGRAM_BOT_TOKEN: { kind: "replace", value: "  " } } }))).toEqual({ enabled: true });
    const r = await api.save("default", g, draft(g, { enabled: false }));
    expect(r.kind).toBe("saved");
    expect(fake.env.default.TELEGRAM_BOT_TOKEN).toBe(TOKEN);
    expect(fake.enabled.default.telegram).toBe(false);
    expect(r.kind === "saved" && r.list.gateways[0]).toMatchObject({ enabled: false, state: "disabled" });
  });

  it("replaces a token, sends the switch with it, and confirms by reading back", async () => {
    const { api, fake } = await setUp();
    const g = await tg(api);
    const r = await api.save("default", g, draft(g, { edits: { TELEGRAM_BOT_TOKEN: { kind: "replace", value: ` ${NEW_TOKEN} ` } } }));
    expect(r.kind).toBe("saved");
    expect(fake.env.default.TELEGRAM_BOT_TOKEN).toBe(NEW_TOKEN);
    expect(fake.writes.at(-1)).toEqual({ profile: "default", what: "put telegram", body: { enabled: true, env: { TELEGRAM_BOT_TOKEN: NEW_TOKEN } } });
    expect(JSON.stringify(r)).not.toContain(NEW_TOKEN);
  });

  it("removes a token and edits an allowlist, and a new token alone never turns a platform on", async () => {
    const { api, fake } = await setUp();
    let g = await tg(api);
    let r = await api.save("default", g, draft(g, { edits: { TELEGRAM_BOT_TOKEN: { kind: "remove" }, TELEGRAM_ALLOWED_USERS: { kind: "replace", value: "333" } } }));
    expect(r.kind).toBe("saved");
    expect(fake.env.default).toEqual({ TELEGRAM_ALLOWED_USERS: "333" });
    g = (await api.list("default")).gateways[1];
    expect(g.id).toBe("discord");
    r = await api.save("default", g, draft(g, { edits: { DISCORD_BOT_TOKEN: { kind: "replace", value: "discord-token-value-xyz" } } }));
    expect(r.kind).toBe("saved");
    expect(fake.writes.at(-1)?.body).toEqual({ enabled: false, env: { DISCORD_BOT_TOKEN: "discord-token-value-xyz" } });
    expect(r.kind === "saved" && r.list.gateways[1]).toMatchObject({ enabled: false, configured: true });
  });

  it("names the profile in every call, so another profile's gateways stay as they were", async () => {
    const { api, fake } = await setUp();
    const g = await tg(api, "bot");
    expect((await api.save("bot", g, draft(g, { enabled: true, edits: { TELEGRAM_BOT_TOKEN: { kind: "replace", value: NEW_TOKEN } } }))).kind).toBe("saved");
    expect(fake.env.bot.TELEGRAM_BOT_TOKEN).toBe(NEW_TOKEN);
    expect(fake.env.default.TELEGRAM_BOT_TOKEN).toBe(TOKEN);
  });

  it("sends nothing when Hermes changed since the screen read it, and hands back what it has now", async () => {
    const { api, fake } = await setUp();
    const g = await tg(api);
    fake.env.default.TELEGRAM_BOT_TOKEN = NEW_TOKEN;
    const r = await api.save("default", g, draft(g, { enabled: false }));
    expect(r.kind).toBe("conflict");
    expect(fake.writes).toEqual([]);
    expect(r.kind === "conflict" && r.list.gateways[0].fields[0].preview).toBe("«redacted:9876...ew11»");
  });

  it("says unconfirmed when the answer is lost, and saved when the read shows it landed", async () => {
    const { api, fake } = await setUp();
    let g = await tg(api);
    fake.drop = "lost";
    let r = await api.save("default", g, draft(g, { enabled: false }));
    expect(r.kind).toBe("unconfirmed");
    expect(fake.enabled.default.telegram).toBe(true);
    g = await tg(api);
    fake.drop = "stored";
    r = await api.save("default", g, draft(g, { enabled: false }));
    expect(r.kind).toBe("saved");
  });

  it("doesn't take a set token as replaced when the answer is lost and the preview didn't change", async () => {
    const { api, fake } = await setUp();
    let g = await tg(api);
    fake.drop = "lost";
    let r = await api.save("default", g, draft(g, { edits: { TELEGRAM_BOT_TOKEN: { kind: "replace", value: NEW_TOKEN } } }));
    expect(r.kind).toBe("unconfirmed");
    expect(fake.env.default.TELEGRAM_BOT_TOKEN).toBe(TOKEN);
    g = await tg(api);
    fake.drop = "stored";
    r = await api.save("default", g, draft(g, { edits: { TELEGRAM_BOT_TOKEN: { kind: "replace", value: NEW_TOKEN } } }));
    expect(r.kind).toBe("saved");
  });

  it("keeps what a save sent out of the gateway errors it reads back, short values included", async () => {
    const { api, fake } = await setUp();
    fake.gateway.default = { running: true, platforms: { telegram: { state: "fatal", error_code: "telegram_connect_error", error_message: "secret ab and webhook-secret-xyz were refused" } } };
    const g = await tg(api);
    // The list read before the save already shows the error; the save's own reads carry what it typed.
    expect(g.error?.text).toBe("secret ab and webhook-secret-xyz were refused");
    fake.refuse = { status: 500, detail: "boom" };
    const r2 = await api.save("default", g, draft(g, { edits: { TELEGRAM_WEBHOOK_SECRET: { kind: "replace", value: "webhook-secret-xyz" } } }));
    expect(r2.kind).toBe("unconfirmed");
    expect(JSON.stringify(r2)).not.toContain("webhook-secret-xyz");
    expect(r2.kind === "unconfirmed" && r2.list?.gateways[0].error?.text).toBe("secret ab and [redacted] were refused");
  });

  it("says a running gateway needs a restart to use the change, unless Hermes served it at once", async () => {
    const { api, fake } = await setUp();
    fake.gateway.default = { running: true, platforms: { telegram: { state: "connected" } } };
    let g = await tg(api);
    let r = await api.save("default", g, draft(g, { edits: { TELEGRAM_BOT_TOKEN: { kind: "replace", value: NEW_TOKEN } } }));
    expect(r.kind === "saved" && r.restart).toBe(true);
    fake.hotServed = true;
    g = await tg(api);
    r = await api.save("default", g, draft(g, { edits: { TELEGRAM_ALLOWED_USERS: { kind: "replace", value: "9" } } }));
    expect(r.kind === "saved" && r.restart).toBe(false);
  });
});

describe("Gateways: problems told apart", () => {
  it("a 403 is a permission problem, redacted", async () => {
    const { api, fake } = await setUp();
    const g = await tg(api);
    fake.refuse = { status: 403, detail: `platforms.telegram.enabled is locked by the managed level (was ${TOKEN})` };
    const r = await api.save("default", g, draft(g, { enabled: false }));
    expect(r).toMatchObject({ kind: "refused", problem: { kind: "permission" } });
    expect(r.kind === "refused" && r.problem.text).toBe("platforms.telegram.enabled is locked by the managed level (was [redacted token])");
  });

  it("a token Hermes turns down is an invalid token, and the typed value never shows in the reason", async () => {
    const { api, fake } = await setUp();
    const g = await tg(api);
    let r = await api.save("default", g, draft(g, { edits: { TELEGRAM_BOT_TOKEN: { kind: "replace", value: "not-a-token" } } }));
    expect(r).toMatchObject({ kind: "refused", problem: { kind: "invalid-token", text: "Telegram bot token must be the complete token from @BotFather, such as 123456789:ABC…" } });
    expect(fake.env.default.TELEGRAM_BOT_TOKEN).toBe(TOKEN);
    fake.refuse = { status: 400, detail: "Bad token s3cret-typed-value" };
    r = await api.save("default", g, draft(g, { edits: { TELEGRAM_BOT_TOKEN: { kind: "replace", value: "s3cret-typed-value" } } }));
    expect(r.kind === "refused" && r.problem).toEqual({ kind: "invalid-token", text: "Bad token [redacted]" });
    // Hermes's own preview pasted back is refused before anything is sent.
    const before = fake.writes.length;
    r = await api.save("default", g, draft(g, { edits: { TELEGRAM_BOT_TOKEN: { kind: "replace", value: "«redacted:1234...my00»" } } }));
    expect(r).toMatchObject({ kind: "refused", problem: { kind: "invalid-token" } });
    expect(fake.writes.length).toBe(before);
  });

  it("the gateway's missing library and rejected token come through the list and the status check", async () => {
    const { api, fake } = await setUp();
    fake.gateway.default = {
      running: true,
      platforms: {
        telegram: { state: "fatal", error_code: "missing_dependency", error_message: "python-telegram-bot not installed" },
        discord: { state: "fatal", error_code: "discord_auth_error", error_message: `Discord bot token rejected: Improper token has been passed. Was ${DISCORD_SHAPED}` },
      },
    };
    fake.env.default.DISCORD_BOT_TOKEN = "x";
    fake.enabled.default.discord = true;
    const [telegram, discord] = (await api.list("default")).gateways;
    expect(telegram.error).toEqual({ kind: "missing-dependency", text: "python-telegram-bot not installed" });
    expect(discord.error).toEqual({ kind: "invalid-token", text: "Discord bot token rejected: Improper token has been passed. Was [redacted token]" });
    const { check } = await api.check("default", "telegram");
    expect(check).toMatchObject({ ok: false, text: "python-telegram-bot not installed", problem: { kind: "missing-dependency" } });
    expect(fake.writes.at(-1)).toEqual({ profile: "default", what: "test telegram" });
  });

  it("a 403 on a read is a permission problem, on its own and before a save", async () => {
    const { api, fake } = await setUp();
    const g = await tg(api);
    fake.refuseReads = { status: 403, detail: "Forbidden for this sign-in" };
    await expect(api.list("default")).rejects.toMatchObject({ kind: "permission", message: "Forbidden for this sign-in" });
    const r = await api.save("default", g, draft(g, { enabled: false }));
    expect(r).toMatchObject({ kind: "refused", problem: { kind: "permission" } });
    expect(fake.writes).toEqual([]);
  });

  it("keeps a secret a save sent out of later reads and checks too", async () => {
    const { api, fake } = await setUp();
    const g = await tg(api);
    fake.refuse = { status: 400, detail: "nope" };
    await api.save("default", g, draft(g, { edits: { TELEGRAM_WEBHOOK_SECRET: { kind: "replace", value: "hook-secret-1" } } }));
    fake.gateway.default = { running: true, platforms: { telegram: { state: "fatal", error_code: "x", error_message: "webhook hook-secret-1 refused" } } };
    expect((await tg(api)).error?.text).toBe("webhook [redacted] refused");
    expect((await api.check("default", "telegram")).check.text).toBe("webhook [redacted] refused");
    fake.refuse = { status: 500, detail: "check failed for hook-secret-1" };
    expect((await api.check("default", "telegram")).check.text).toBe("check failed for [redacted]");
  });

  it("an adapter the gateway couldn't build for a platform with its token set is a missing library", async () => {
    const { api, fake } = await setUp();
    const unavailable = { state: "fatal", error_code: "adapter_unavailable", error_message: "No adapter available for enabled discord; check the plugin, dependencies, and credentials." };
    fake.enabled.default.discord = true;
    fake.gateway.default = { running: true, platforms: { discord: unavailable } };
    expect((await api.list("default")).gateways[1].error?.kind).toBe("other");
    fake.env.default.DISCORD_BOT_TOKEN = "x";
    expect((await api.list("default")).gateways[1].error).toEqual({ kind: "missing-dependency", text: unavailable.error_message });
  });

  it("Discord's privileged intents are a permission problem; a check that connects is ok", async () => {
    const { api, fake } = await setUp();
    fake.env.default.DISCORD_BOT_TOKEN = "x";
    fake.gateway.default = { running: true, platforms: { telegram: { state: "connected" }, discord: { state: "fatal", error_code: "discord_intents_required", error_message: "Enable the Message Content intent" } } };
    expect((await api.list("default")).gateways[1].error?.kind).toBe("permission");
    expect((await api.check("default", "telegram")).check).toMatchObject({ ok: true, text: "Telegram is connected." });
    fake.refuse = { status: 403, detail: "Forbidden" };
    expect((await api.check("default", "discord")).check.problem).toEqual({ kind: "permission", text: "Forbidden" });
  });
});

describe("Gateways: redaction", () => {
  it("takes out typed values, Telegram and Discord tokens, and provider keys", () => {
    expect(redact(`a ${TOKEN} b`)).toBe("a [redacted token] b");
    expect(redact(`x ${DISCORD_SHAPED} y`)).toBe("x [redacted token] y");
    expect(redact("my-own-token went wrong", ["my-own-token"])).toBe("[redacted] went wrong");
    expect(redact(`GET https://api.telegram.org/bot${TOKEN}/getMe: 401`)).toBe("GET https://api.telegram.org/bot[redacted token]/getMe: 401");
    expect(redact("Rejected credential abc (about abc.)", ["abc"])).toBe("Rejected credential [redacted] (about [redacted].)");
    expect(redact("key sk-ant-abcdefghijklmnop1234")).toBe("key [redacted key]");
    expect(redact("«redacted:1234...my00» kept")).toBe("«redacted:1234...my00» kept");
  });
});

describe("Gateways: Slack", () => {
  const slack = async (api: Awaited<ReturnType<typeof setUp>>["api"], profile = "default") => (await api.list(profile)).gateways.find((g) => g.id === "slack")!;

  it("lists Slack's two tokens as write-only and its member IDs as a value, with no home channel setting", async () => {
    const { api } = await setUp();
    const g = await slack(api);
    expect(g).toMatchObject({ name: "Slack", enabled: false, configured: false, state: "disabled", docsUrl: "https://api.slack.com/apps", homeChannel: undefined });
    expect(g.fields.map((f) => [f.key, f.secret, f.required])).toEqual([
      ["SLACK_BOT_TOKEN", true, true],
      ["SLACK_APP_TOKEN", true, true],
      ["SLACK_ALLOWED_USERS", false, false],
    ]);
  });

  it("saves both tokens, the member IDs and the switch in one write, and reads back only previews", async () => {
    const { api, fake } = await setUp();
    const g = await slack(api, "bot");
    const r = await api.save("bot", g, {
      enabled: true,
      edits: { SLACK_BOT_TOKEN: { kind: "replace", value: SLACK_BOT }, SLACK_APP_TOKEN: { kind: "replace", value: ` ${SLACK_APP} ` }, SLACK_ALLOWED_USERS: { kind: "replace", value: "U01ABC2DEF3" } },
    });
    expect(r.kind).toBe("saved");
    expect(fake.writes.at(-1)).toEqual({
      profile: "bot",
      what: "put slack",
      body: { enabled: true, env: { SLACK_BOT_TOKEN: SLACK_BOT, SLACK_APP_TOKEN: SLACK_APP, SLACK_ALLOWED_USERS: "U01ABC2DEF3" } },
    });
    expect(fake.env.bot).toEqual({ SLACK_BOT_TOKEN: SLACK_BOT, SLACK_APP_TOKEN: SLACK_APP, SLACK_ALLOWED_USERS: "U01ABC2DEF3" });
    expect(fake.env.default.SLACK_BOT_TOKEN).toBeUndefined();
    const after = r.kind === "saved" ? r.list.gateways.find((x) => x.id === "slack")! : undefined;
    expect(after).toMatchObject({ enabled: true, configured: true, state: "gateway_stopped" });
    expect(after?.fields.find((f) => f.key === "SLACK_BOT_TOKEN")?.preview).toBe(`«redacted:xoxb...ummy»`);
    const shown = JSON.stringify(r);
    expect(shown).not.toContain(SLACK_BOT);
    expect(shown).not.toContain(SLACK_APP);
  });

  it("a token in the wrong field is turned down with Hermes's words, and nothing is written", async () => {
    const { api, fake } = await setUp();
    const g = await slack(api);
    // The app token pasted where the bot token goes.
    const r = await api.save("default", g, { enabled: true, edits: { SLACK_BOT_TOKEN: { kind: "replace", value: SLACK_APP }, SLACK_APP_TOKEN: { kind: "replace", value: SLACK_APP } } });
    expect(r).toMatchObject({ kind: "refused", problem: { kind: "invalid-token", text: "Slack Bot Token must start with xoxb-. Paste the bot token from OAuth & Permissions." } });
    expect(fake.env.default.SLACK_APP_TOKEN).toBeUndefined();
    expect(JSON.stringify(r)).not.toContain(SLACK_APP);
    // A member ID list Hermes doesn't take is refused too, as a plain problem.
    const ids = await api.save("default", g, { enabled: false, edits: { SLACK_ALLOWED_USERS: { kind: "replace", value: "lena" } } });
    expect(ids).toMatchObject({ kind: "refused", problem: { kind: "other", text: "Slack allowed user IDs must be comma-separated member IDs like U01ABC2DEF3." } });
  });

  it("checks Slack's status through Hermes's test route, and a running gateway needs a restart for a new token", async () => {
    const { api, fake } = await setUp();
    fake.env.default = { ...fake.env.default, SLACK_BOT_TOKEN: SLACK_BOT, SLACK_APP_TOKEN: SLACK_APP };
    fake.enabled.default = { ...fake.enabled.default, slack: true };
    fake.gateway.default = { running: true, platforms: { slack: { state: "retrying", error_message: "failed to connect" } } };
    const { check, list } = await api.check("default", "slack");
    expect(fake.writes.at(-1)).toEqual({ profile: "default", what: "test slack" });
    expect(check).toMatchObject({ ok: false, text: "failed to connect", problem: undefined });
    expect(list?.gateways.find((g) => g.id === "slack")).toMatchObject({ state: "retrying", error: { kind: "other", text: "failed to connect" } });
    const g = await slack(api);
    const r = await api.save("default", g, { enabled: true, edits: { SLACK_BOT_TOKEN: { kind: "replace", value: `${SLACK_BOT}2` } } });
    expect(r).toMatchObject({ kind: "saved", restart: true });
  });

  it("a missing slack-bolt reads as missing on the server", async () => {
    const { api, fake } = await setUp();
    fake.env.default = { SLACK_BOT_TOKEN: SLACK_BOT, SLACK_APP_TOKEN: SLACK_APP };
    fake.gateway.default = { running: true, platforms: { slack: { state: "fatal", error_code: "missing_dependency", error_message: "slack-bolt not installed" } } };
    expect((await slack(api)).error).toEqual({ kind: "missing-dependency", text: "slack-bolt not installed" });
  });

  it("reads the home channel /sethome saved in config.yaml, for any platform", async () => {
    const { api, fake } = await setUp();
    fake.home.default = { slack: { chat_id: "C01234567890", name: "general" }, telegram: { chat_id: -1001234567890, name: "Home" } };
    const list = await api.list("default");
    expect(list.gateways.find((g) => g.id === "slack")?.homeChannel).toEqual({ id: "C01234567890", name: "general" });
    expect(list.gateways.find((g) => g.id === "telegram")?.homeChannel).toEqual({ id: "-1001234567890", name: "Home" });
    expect(list.gateways.find((g) => g.id === "discord")?.homeChannel).toBeUndefined();
  });

  it("takes a Slack token, either kind, out of Hermes's text", () => {
    expect(redact(`auth failed for ${SLACK_BOT} and ${SLACK_APP}`)).not.toMatch(/xoxb-|xapp-1-A/);
  });
});
