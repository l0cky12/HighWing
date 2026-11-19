// Armed on the Bots tab before a click on a bot's row; run.sh puts the profile and the bot's name in place of
// __PROFILE__ and __NAME__. Each animation frame it checks the screen and records, in ms from the click:
//   respond: anything on screen changed for this bot (its row selected, its name in the header, or a switch status)
//   bot:     its row is selected and the header names it over its Bot Chat
//   chat:    that, with at least one message on screen
//   ready:   that, connected, no switch status, no Saved copy or loading note, and models loaded
// It also keeps the header and the last message at `chat`, so a run that showed another bot's chat can be caught.
const profile = "__PROFILE__";
const name = "__NAME__";
const bs = (window.__bs = { profile, name, t0: null, error: null });
const row = () => document.querySelector(`.bots-row[data-profile="${profile}"]`);
const title = () => document.querySelector(".chat-title")?.innerText.trim() ?? "";
const lines = () => title().split("\n").map((l) => l.trim());
const named = () => lines().includes(name) && lines().includes("Bot Chat");
const mark = (key, now) => bs[key] === undefined && now && (bs[key] = Math.round(performance.now() - bs.t0));
row()
  .querySelector(".bots-open")
  .addEventListener("click", () => bs.t0 === null && (bs.t0 = performance.now()), { capture: true, once: true });
const tick = () => {
  if (bs.t0 !== null) {
    const current = !!row()?.classList.contains("is-current");
    const msgs = document.querySelectorAll(".msg");
    if (document.querySelector(".switch-status.failed")) bs.error ??= document.querySelector(".switch-status").innerText;
    mark("respond", current || named() || !!document.querySelector(".switch-progress"));
    mark("bot", current && named());
    if (bs.bot !== undefined && bs.chat === undefined && current && named() && msgs.length) {
      mark("chat", true);
      bs.chatTitle = lines().join(" ");
      bs.chatLast = msgs[msgs.length - 1].innerText.slice(0, 80);
      bs.chatCount = msgs.length;
    }
    const text = document.body.innerText;
    if (bs.chat !== undefined && current && named()) {
      mark(
        "ready",
        !document.querySelector(".switch-progress") &&
          !!document.querySelector(".status-conn.connected") &&
          !document.querySelector(".saved-note, .loading-chat") &&
          !text.includes("Loading models"),
      );
    }
    if (bs.ready !== undefined) {
      bs.readyCount = msgs.length;
      bs.readyLast = msgs[msgs.length - 1]?.innerText.slice(0, 80);
      return;
    }
  }
  requestAnimationFrame(tick);
};
requestAnimationFrame(tick);
return "armed";
