// Installed in the app's page by run.sh (`wd.mjs eval`). Reads only: it observes and moves no node.
// Between `start()` and `stop()` it records each frame's interval (one requestAnimationFrame timestamp to the next),
// the scroll events Settings' page got, and how often a jump link became current. `bareFrames` counts frames with a
// callback that does nothing else, so a probe that misses frames shows.
(() => {
  if (window.__scroll) return "already";
  const stats = (xs) => {
    const s = [...xs].sort((a, b) => a - b);
    const q = (p) => Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))] * 100) / 100;
    return s.length ? { n: s.length, p50: q(0.5), p95: q(0.95), max: q(1), mean: Math.round((s.reduce((a, b) => a + b, 0) / s.length) * 100) / 100, over20: s.filter((x) => x > 20).length, over34: s.filter((x) => x > 34).length } : { n: 0 };
  };
  const main = () => document.querySelector(".settings-main");
  let run;
  let changes = 0;
  new MutationObserver((ms) => {
    for (const m of ms) if (m.target.getAttribute("aria-current") === "location") changes++;
  }).observe(document.querySelector(".settings"), { subtree: true, attributes: true, attributeFilter: ["aria-current"] });
  addEventListener("scroll", (e) => run?.on && e.target === main() && run.events++, { capture: true, passive: true });
  const start = () => {
    const r = (run = { intervals: [], bare: 0, events: 0, changes0: changes, on: true, top0: main().scrollTop, t0: performance.now() });
    let prev;
    const step = (t) => {
      if (!r.on) return;
      requestAnimationFrame(step);
      if (prev !== undefined) r.intervals.push(t - prev);
      prev = t;
    };
    const bare = () => r.on && (r.bare++, requestAnimationFrame(bare));
    requestAnimationFrame(bare);
    requestAnimationFrame(step);
    return 1;
  };
  const stop = () => {
    run.on = false;
    return {
      ms: Math.round(performance.now() - run.t0),
      frames: run.intervals.length + 1,
      bareFrames: run.bare,
      events: run.events,
      linkChanges: changes - run.changes0,
      endTop: Math.round(main().scrollTop),
      intervalMs: stats(run.intervals),
      nodes: document.getElementsByTagName("*").length,
    };
  };
  window.__scroll = { start, stop };
  return "ok";
})()
