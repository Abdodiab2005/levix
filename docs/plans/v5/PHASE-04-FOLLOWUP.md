# Phase 04 follow-up audit and plan (2026-11-02)

The #128 and #129 sibling heads merge cleanly with #130 in a temporary integration tree.
Their combined behavior still needs the gates below. Existing branches and device state are untouched.

* Remote Terms: adding the supplied public key currently arms the scheduler. Add a code-owned,
  disabled activation gate, validate the key, and test both the disabled production path and injected
  verifier paths. No private key, signed release, endpoint deployment, or activation is in scope.
* Gateway: failed QR and socket script requests reject without a visible error. Fix loading and retry
  in the gateway and cover failed requests, successful retry, cleanup and missing globals.
* Privacy and translations: reconcile the full policy and bundled notices with explicit installation
  consent, review the new Portuguese and Spanish text against English, version changed legal copy,
  and record machine review separately from human legal approval. Self-host the existing fonts.
* CI: locate all paths that open actual sockets, replace them with fakes and guard against unintended
  outbound connections without losing lifecycle coverage. No real WhatsApp connection is authorized.
* Audit authentication, release identity, remote verification, Android alerts and React gateway;
  check the sibling merge, stack and final combined tree. Run the listed automated gates only after
  establishing isolation. Device and WebView QA remain explicitly out of scope.

No database migration is planned. Acceptance remains installation-scoped and excluded from exports;
linking or unlinking must not delete it. Verify exact document hashes and fail closed on malformed
acceptance and release data. Roll back follow-up changes by reverting their commits; remote Terms
remain off unless a later approved release explicitly enables them. Human legal approval is required.
