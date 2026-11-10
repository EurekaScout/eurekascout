"use strict";
// The Terms of Use pop-up: everyone sees it first, before the page can be used, and again whenever the terms change.
// Witty pops up holding a rolled scroll, it unrolls to the short version, and "I agree" rolls it back up.
// Loaded in <head> on every page (not on terms.html itself, which is the full text).
(() => {
  // The "Last updated" date of the terms. Change it here when the terms change: everyone is asked to accept again.
  // terms.html shows this same value.
  const TERMS_VERSION = "10 Nov 2026";
  const KEY = "witty_terms_v";
  const root = document.documentElement;
  const here = document.currentScript?.src || location.href;
  const asset = (p) => new URL(p, here).href;            // works from any folder, file:// included

  const onReady = (fn) => (document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", fn, { once: true }) : fn());
  onReady(() => document.querySelectorAll("[data-terms-updated]").forEach((n) => {
    n.textContent = TERMS_VERSION; n.classList.toggle("tblank", TERMS_VERSION.startsWith("["));   // still a blank to fill
  }));
  if (root.hasAttribute("data-terms-page")) return;      // the terms page itself: read freely, accept anywhere else

  let seen = null;
  try { seen = localStorage.getItem(KEY); } catch { /* storage blocked: ask again on the next load */ }
  if (seen === TERMS_VERSION) return;
  root.classList.add("tp-lock");                          // no scrolling the page behind it

  const POINTS = [
    ["Not financial advice.", "Witty is an AI that makes calls on memecoins. A call is information, not a recommendation to buy or sell anything."],
    ["You can lose everything.", "Memecoins are extremely risky. Most go to zero, many are scams, and prices can drop 90% in minutes. Only use money you can afford to lose."],
    ["Past results don't predict future ones.", "Witty's record is public and checkable, but a good record can turn bad at any time."],
    ["Your decisions are yours.", "Whatever you buy, sell or let Witty trade for you, you are responsible for it, including the taxes and laws where you live."],
    ["You must be 18 or older", "and allowed to use crypto services where you live."],
  ];
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const canAnimate = !still && typeof Element.prototype.animate === "function";

  onReady(() => {
    const termsUrl = asset("../terms.html");
    const box = document.createElement("div");
    box.className = "tp";
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");
    box.setAttribute("aria-labelledby", "tp-h");
    box.setAttribute("aria-describedby", "tp-pts");
    box.tabIndex = -1;
    box.innerHTML = `
      <div class="tp-stage">
        <img class="tp-witty" src="${asset("../img/witty-scroll.webp")}" width="400" height="344" alt="" draggable="false">
        <div class="tp-scroll">
          <div class="tp-roll" aria-hidden="true"></div>
          <div class="tp-paper">
            <div class="tp-in">
              <h2 class="display tp-h" id="tp-h">BEFORE YOU START</h2>
              <ol class="tp-pts" id="tp-pts" tabindex="0" aria-label="The short version of the terms"></ol>
              <div class="tp-foot">
                <label class="tp-check"><input type="checkbox" id="tp-ok"><span>I'm 18 or older and I accept the <a href="${termsUrl}" target="_blank" rel="noopener">Terms of Use</a></span></label>
                <button class="btn btn-blue tp-go" type="button" id="tp-go" disabled>I agree</button>
              </div>
            </div>
          </div>
          <div class="tp-roll tp-roll-b" aria-hidden="true"></div>
        </div>
      </div>`;
    const list = box.querySelector(".tp-pts");
    POINTS.forEach(([lead, rest], i) => {
      const li = document.createElement("li");
      li.style.setProperty("--i", i);
      const b = document.createElement("b"); b.textContent = lead;
      li.append(b, ` ${rest}`);
      list.append(li);
    });

    // everything else on the page sits behind it: no clicks, no focus, hidden from screen readers
    const muted = [];
    for (const n of [...document.body.children]) {
      if (n.tagName === "SCRIPT" || n.inert) continue;
      n.inert = true; n.setAttribute("aria-hidden", "true"); muted.push(n);
    }
    document.body.append(box);

    const ok = box.querySelector("#tp-ok"), go = box.querySelector("#tp-go");
    const stage = box.querySelector(".tp-stage"), paper = box.querySelector(".tp-paper"), witty = box.querySelector(".tp-witty");
    const fades = [...list.children, box.querySelector(".tp-foot")];
    ok.addEventListener("change", () => { go.disabled = !ok.checked; });
    // on a short screen the points scroll inside the paper: fade the bottom edge while there's more to read
    const more = () => list.classList.toggle("more", list.scrollTop + list.clientHeight < list.scrollHeight - 4);
    list.addEventListener("scroll", more, { passive: true }); addEventListener("resize", more);

    // focus stays inside; Esc and clicks outside do nothing
    box.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); return; }
      if (e.key !== "Tab") return;
      const f = [...box.querySelectorAll("a[href],button:not([disabled]),input,[tabindex='0']")].filter((n) => n.offsetParent !== null);
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === box)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });
    document.addEventListener("focusin", (e) => { if (box.isConnected && !box.contains(e.target)) box.focus({ preventScroll: true }); });
    box.focus({ preventScroll: true });

    const anim = (el, frames, opts) => el.animate(frames, { fill: "both", ...opts });
    const settle = () => { box.classList.add("is-on"); more(); [stage, paper, box, ...fades].forEach((n) => n.getAnimations?.().forEach((a) => a.cancel())); };

    if (!canAnimate) { box.classList.add("is-on"); more(); }
    else {
      // 1. the page dims; 2. Witty pops up from the bottom with the rolled scroll; 3. it unrolls with a small bounce;
      // 4. the six points fade in one after another, then the checkbox and button; 5. Witty bobs (CSS, .is-on)
      box.classList.add("is-in");
      const h = paper.offsetHeight;
      anim(box, [{ backgroundColor: "rgba(11,11,15,0)", backdropFilter: "blur(0px)" }, {}], { duration: 260, easing: "ease-out" });
      anim(stage, [{ transform: "translateY(110vh)" }, { transform: "translateY(0)" }], { duration: 560, delay: 120, easing: "cubic-bezier(.2,1.25,.4,1)" });
      const unroll = anim(paper, [{ height: "0px" }, { height: `${h * 1.035}px`, offset: 0.8 }, { height: `${h}px` }], { duration: 620, delay: 640, easing: "cubic-bezier(.3,.6,.35,1)" });
      fades.forEach((n, i) => anim(n, [{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }], { duration: 260, delay: 1100 + i * 80, easing: "ease-out" }));
      Promise.all(fades.map((n) => n.getAnimations()[0]?.finished)).then(() => { box.classList.remove("is-in"); settle(); }).catch(() => {});
      unroll.finished.catch(() => {});
    }

    let leaving = false;
    go.addEventListener("click", () => {
      if (!ok.checked || leaving) return;
      leaving = true;
      try { localStorage.setItem(KEY, TERMS_VERSION); } catch { /* storage blocked: asked again next time */ }
      const done = () => {
        box.remove();
        muted.forEach((n) => { n.inert = false; n.removeAttribute("aria-hidden"); });
        root.classList.remove("tp-lock");
      };
      if (!canAnimate) return done();
      // the scroll rolls back up, Witty cheers and drops out of view, the page undims (about 0.7 s)
      box.classList.add("is-out");
      const h = paper.offsetHeight;
      anim(witty, [{ transform: "none" }, { transform: "translateY(-18px) rotate(-7deg)", offset: 0.45 }, { transform: "none" }], { duration: 320, easing: "ease-out" });
      fades.forEach((n) => anim(n, [{ opacity: 1 }, { opacity: 0 }], { duration: 140 }));
      anim(paper, [{ height: `${h}px` }, { height: "0px" }], { duration: 300, delay: 60, easing: "cubic-bezier(.5,0,.7,.4)" });
      anim(stage, [{ transform: "translateY(0)" }, { transform: "translateY(110vh)" }], { duration: 320, delay: 330, easing: "cubic-bezier(.5,0,.8,.3)" });
      anim(box, [{}, { backgroundColor: "rgba(11,11,15,0)", backdropFilter: "blur(0px)" }], { duration: 220, delay: 480, easing: "ease-in" })
        .finished.then(done, done);
    });
  });
})();
