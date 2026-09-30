// Shared behaviour for the gateway pages (login · setup · reset).
//
// Two small things, both of which must never break the form if the script
// itself fails to load: the page works without either one.

(function () {
  // Eye toggles. One delegated listener covers every password field on the
  // page — the button carries two icons and swaps which one is visible.
  document.addEventListener("click", function (event) {
    var btn = event.target.closest ? event.target.closest(".eye-btn") : null;
    if (!btn) return;
    event.preventDefault();
    var input = btn.parentElement ? btn.parentElement.querySelector("input") : null;
    if (!input) return;
    var show = input.type === "password";
    input.type = show ? "text" : "password";
    var on = btn.querySelector(".eye-on");
    var off = btn.querySelector(".eye-off");
    if (on) on.style.display = show ? "none" : "";
    if (off) off.style.display = show ? "" : "none";
    btn.setAttribute("aria-label", show ? "Hide password" : "Show password");
  });

  // Blur the password screens whenever the page can't be watched: another
  // tab, a minimised window, the OS task switcher. This is best effort —
  // the web platform cannot truly forbid screenshots — but it keeps the form
  // out of task-switcher thumbnails and casual over-the-shoulder captures.
  var root = document.documentElement;
  function engage() {
    root.classList.add("screen-guard");
  }
  function release() {
    root.classList.remove("screen-guard");
  }
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") engage();
    else release();
  });
  window.addEventListener("blur", engage);
  window.addEventListener("focus", release);
})();
