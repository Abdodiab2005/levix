// The page the panel serves when the React build is missing: a source checkout
// before `npm run build:frontend`, or a broken package. Code-owned static HTML,
// no template engine.
//
// Rules this file keeps:
// - One escape function, `escapeHtml`, wraps every dynamic value.
// - No script, no inline event handler, no remote resource.
// - Login and setup are native forms, so they work with JavaScript off: same
//   URLs, same field names, same `autocomplete` values as the React gateway.
// - The QR string and every secret stay out of it. The QR page and the signed-in
//   `/` only say the panel files are missing.
//
// The copy is English only on purpose. This page exists for the operator who
// has to fix the install, not for the everyday panel, and the translated
// catalog ships with the frontend build that is missing.

const ESCAPES = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ESCAPES[char]);
}

const STYLE = `
:root{color-scheme:light dark;--bg:#f6f7f9;--panel:#fff;--text:#14171a;--muted:#5b6670;--line:#d5dae0;--brand:#0b7a75;--danger:#b3261e}
@media (prefers-color-scheme:dark){:root{--bg:#0f1214;--panel:#181c1f;--text:#eceff1;--muted:#9aa5ad;--line:#2b3338;--brand:#3cc7bf;--danger:#ff8a80}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:16px;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{width:100%;max-width:26rem;background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:24px}
h1{margin:0 0 4px;font-size:1.4rem}
p{margin:8px 0}
.muted{color:var(--muted);font-size:.9rem}
label{display:block;margin-top:16px;font-weight:600}
input{display:block;width:100%;margin-top:6px;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--text);font:inherit}
small{display:block;margin-top:4px;color:var(--muted);font-weight:400}
button{margin-top:20px;width:100%;padding:10px 12px;border:0;border-radius:8px;background:var(--brand);color:var(--bg);font:inherit;font-weight:600;cursor:pointer}
.error{margin-top:16px;color:var(--danger);font-weight:600}
.notice{margin-top:16px;padding:10px 12px;border:1px solid var(--line);border-radius:8px}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
`;

const MISSING_NOTICE =
  "The panel files are missing, so this basic page is shown. " +
  "Run `npm run build:frontend`, or reinstall Levix.";

function notice() {
  return `<p class="notice" role="status">${escapeHtml(MISSING_NOTICE)}</p>`;
}

function errorBlock(error) {
  return error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : "";
}

function passwordInput({ name, label, autocomplete, minLength, autofocus }) {
  const min = minLength > 0 ? ` minlength="${escapeHtml(Number(minLength))}"` : "";
  return (
    `<label>${escapeHtml(label)}` +
    `<input type="password" name="${escapeHtml(name)}" autocomplete="${escapeHtml(autocomplete)}"` +
    `${min} spellcheck="false" autocapitalize="off" autocorrect="off" dir="ltr" required` +
    `${autofocus ? " autofocus" : ""}>` +
    `</label>`
  );
}

function loginBody({ brandName, error }) {
  return (
    `<h1>${escapeHtml(brandName)}</h1>` +
    `<p class="muted">Sign in to manage your ${escapeHtml(brandName)} workspace.</p>` +
    `<form action="/login" method="post">` +
    passwordInput({
      name: "password",
      label: "Control panel password",
      autocomplete: "current-password",
      minLength: 0,
      autofocus: true,
    }) +
    `<button type="submit">Open workspace</button>` +
    `</form>` +
    errorBlock(error) +
    `<p class="muted">Forgot the password? Run <code>levix reset-password</code> on the server.</p>` +
    notice()
  );
}

function setupBody({ brandName, error, needsCode, minLength }) {
  const code = needsCode
    ? `<label>Setup code` +
      `<input type="text" name="code" autocomplete="off" required autofocus>` +
      `<small>Printed in the bot's terminal. ` +
      `It confirms you can access the server running ${escapeHtml(brandName)}.</small>` +
      `</label>`
    : "";
  return (
    `<h1>Welcome to ${escapeHtml(brandName)}</h1>` +
    `<p class="muted">Protect the linked WhatsApp account with at least ` +
    `${escapeHtml(Number(minLength))} characters.</p>` +
    `<form action="/setup" method="post">` +
    code +
    passwordInput({
      name: "password",
      label: "Choose a password",
      autocomplete: "new-password",
      minLength,
      autofocus: !needsCode,
    }) +
    passwordInput({
      name: "confirm",
      label: "Repeat the password",
      autocomplete: "new-password",
      minLength,
    }) +
    `<button type="submit">Create workspace</button>` +
    `</form>` +
    errorBlock(error) +
    notice()
  );
}

function qrBody({ brandName }) {
  return (
    `<h1>${escapeHtml(brandName)}</h1>` +
    `<p>The pairing QR code cannot be shown on this page.</p>` +
    notice()
  );
}

function panelBody({ brandName }) {
  return (
    `<h1>${escapeHtml(brandName)}</h1>` +
    `<p>You are signed in, but the panel cannot be shown.</p>` +
    notice() +
    `<form action="/logout" method="post"><button type="submit">Sign out</button></form>`
  );
}

const PAGES = {
  login: { title: "Sign in", body: loginBody },
  setup: { title: "Set up", body: setupBody },
  qr: { title: "Link WhatsApp", body: qrBody },
  panel: { title: "Panel", body: panelBody },
};

// `page` is "login", "setup", "qr" or "panel" (the signed-in `/`). Anything
// else renders as "panel". Options: brandName, error (English string or null),
// needsCode (setup), minLength (setup). The QR value is never an option.
function renderFallbackPage({ page, brandName = "Levix", error = null, needsCode = false, minLength = 8 } = {}) {
  const view = PAGES[page] || PAGES.panel;
  const body = view.body({ brandName, error, needsCode: needsCode === true, minLength });
  return (
    `<!doctype html>\n<html lang="en">\n<head>\n` +
    `<meta charset="utf-8">\n` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">\n` +
    `<meta name="robots" content="noindex">\n` +
    `<title>${escapeHtml(brandName)} · ${escapeHtml(view.title)}</title>\n` +
    `<style>${STYLE}</style>\n` +
    `</head>\n<body>\n<main>${body}</main>\n</body>\n</html>\n`
  );
}

module.exports = { escapeHtml, renderFallbackPage, MISSING_NOTICE };
