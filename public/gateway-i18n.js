// The gateway pages' bilingual text (login · setup · QR).
//
// The English copy is the markup's own default; this file carries both
// languages and rewrites the marked nodes as the DOM is parsed, so a page
// follows the shared <html lang> that ui-boot.js set — no client framework and
// no second render. It is the same idea as views/dashboard.ejs + dashboard.js,
// kept in its own file because the QR page loads neither.
//
// Markup contract:
//   data-i18n="key"              -> textContent
//   data-i18n-html="key"         -> innerHTML (the string may carry <strong>)
//   data-i18n-placeholder="key"  -> placeholder
//   data-i18n-aria-label="key"   -> aria-label
//   data-i18n-title="key"        -> title attribute
//   data-i18n-error="code"       -> the server-rendered error, translated by code
//   data-i18n-n="8"              -> the {n} in the string
//   <html data-brand>            -> the {brand} in the string

(function () {
  var DICT = {
    en: {
      // Titles
      titleLogin: "{brand} · Sign in",
      titleSetup: "{brand} · First run",
      titleQr: "{brand} · Link WhatsApp",

      // Shared
      tagline: "Personal WhatsApp Bot",
      storyAbout: "About {brand}",
      by: "by",
      backToApp: "Back to app",
      showPassword: "Show password",
      hidePassword: "Hide password",

      // Login
      selfHosted: "Self-hosted by design",
      loginHeadline: "The quiet control room behind every chat.",
      loginLede:
        "Connection, commands, memory, and moderation stay together—on your server and within reach.",
      loginTrust: "<span></span> Private workspace · direct control",
      secureAccess: "Secure access",
      welcomeBack: "Welcome back",
      loginSub: "Sign in to manage your {brand} workspace.",
      passwordLabel: "Control panel password",
      passwordPlaceholder: "Enter your password",
      openWorkspace: "Open workspace",
      forgotPassword: "Forgot password?",

      // Password reset
      backToSignIn: "Back to sign in",
      resetEyebrow: "Password reset",
      resetTitle: "Reset your password",
      resetSubtitle:
        "{brand} sends a one-time code to your WhatsApp — the linked account's own chat. The code works for 10 minutes.",
      resetSend: "Send code to WhatsApp",
      resetCodeLabel: "Reset code",
      resetCodePlaceholder: "6 digits",
      newPassword: "New password",
      minLengthPlaceholder: "At least {n} characters",
      repeatPassword: "Repeat password",
      repeatPlaceholder: "Type it again",
      resetSubmit: "Set new password",
      resetErrThrottled: "Too many requests. Try again in {n} seconds.",
      resetErrNoSession:
        "WhatsApp isn't connected, so the code can't be sent. Sign in on the server and run `levix reset-password`, or start the WhatsApp session first.",
      resetErrSendFailed: "Couldn't send the WhatsApp message. Try again in a minute.",
      resetErrStart: "Couldn't start the reset. Try again.",
      resetErrServer: "Couldn't reach the server. Try again.",
      resetDone: "Password updated. Taking you to sign in…",
      resetErrWrongCode: "Wrong code.",
      resetErrAttemptsLeft: "{n} attempts left.",
      resetErrExpired: "That code is no longer valid. Send a new one.",
      resetErrMismatch: "The two passwords don't match.",
      resetErrInvalidPassword: "That password isn't allowed.",
      resetErrFailed: "Couldn't reset the password. Try again.",

      // Setup
      firstMinute: "Your first minute",
      setupHeadline: "Make the workspace yours.",
      setupLede:
        "Choose one strong password, then manage the assistant from a single private control room.",
      setupTrust: "<span></span> One setup · no configuration files",
      createWorkspace: "Create your workspace",
      setupWelcome: "Welcome to {brand}",
      setupSub: "Protect the linked WhatsApp account with at least {n} characters.",
      setupCodeLabel: "Setup code",
      setupCodePlaceholder: "Printed in the bot's terminal",
      setupCodeHint: "Confirms you can access the server running {brand}.",
      setupPasswordLabel: "Password",
      createWorkspaceBtn: "Create workspace",

      // QR pairing
      directLine: "A direct line",
      qrHeadline: "Bring your assistant online.",
      qrLede: "One scan securely links {brand} to the WhatsApp account you choose.",
      qrTrust: "<span></span> Live pairing status",
      linkDevice: "Link device",
      qrScanTitle: "Scan with WhatsApp",
      qrWaiting: "Waiting…",
      qrStep1: "<span>Open</span> WhatsApp on the phone the bot should use.",
      qrStep2: "<span>Choose</span> Settings → Linked devices → Link a device.",
      qrStep3: "<span>Scan</span> the code shown above.",
      qrCallout:
        "No code yet? Press <strong>Start session</strong> on the dashboard's Connection screen.",
      backToDashboard: "Back to dashboard",
      qrScanMe: "Scan me",
      qrWaitingCode: "Waiting for a code…",
      qrConnected: "Connected",
      qrLinked: "Linked ✓",
      qrNotStarted: "Not started — start it from the dashboard",
      qrConnecting: "Connecting…",

      // Server-rendered errors, keyed by the code app.cjs passes beside them
      tooManyAttempts: "Too many attempts. Try again later.",
      incorrectPassword: "Incorrect Password",
      wrongSetupCode: "Wrong setup code.",
      passwordMismatch: "The two passwords don't match.",
      invalidPassword: "Password must be at least {n} characters",
    },
    ar: {
      // Titles
      titleLogin: "{brand} · تسجيل الدخول",
      titleSetup: "{brand} · التشغيل الأول",
      titleQr: "{brand} · ربط واتساب",

      // Shared
      tagline: "بوت واتساب شخصي",
      storyAbout: "عن {brand}",
      by: "من",
      backToApp: "العودة للتطبيق",
      showPassword: "إظهار كلمة المرور",
      hidePassword: "إخفاء كلمة المرور",

      // Login
      selfHosted: "استضافة ذاتية بالتصميم",
      loginHeadline: "غرفة التحكم الهادئة خلف كل محادثة.",
      loginLede: "الاتصال والأوامر والذاكرة والإشراف في مكان واحد — على خادمك وفي متناول يدك.",
      loginTrust: "<span></span> مساحة عمل خاصة · تحكم مباشر",
      secureAccess: "وصول آمن",
      welcomeBack: "أهلاً بعودتك",
      loginSub: "سجّل الدخول لإدارة مساحة عمل {brand}.",
      passwordLabel: "كلمة مرور لوحة التحكم",
      passwordPlaceholder: "أدخل كلمة المرور",
      openWorkspace: "افتح مساحة العمل",
      forgotPassword: "نسيت كلمة المرور؟",

      // Password reset
      backToSignIn: "العودة لتسجيل الدخول",
      resetEyebrow: "إعادة تعيين كلمة المرور",
      resetTitle: "أعِد تعيين كلمة المرور",
      resetSubtitle:
        "يرسل {brand} كوداً لمرة واحدة إلى واتساب الخاص بك — محادثة الحساب المرتبط نفسه. يصلح الكود لمدة 10 دقائق.",
      resetSend: "أرسل الكود إلى واتساب",
      resetCodeLabel: "كود إعادة التعيين",
      resetCodePlaceholder: "6 أرقام",
      newPassword: "كلمة المرور الجديدة",
      minLengthPlaceholder: "لا تقل عن {n} خانات",
      repeatPassword: "أعِد كتابة كلمة المرور",
      repeatPlaceholder: "اكتبها مرة أخرى",
      resetSubmit: "تعيين كلمة المرور الجديدة",
      resetErrThrottled: "طلبات كثيرة جداً. حاول مرة أخرى خلال {n} ثانية.",
      resetErrNoSession:
        "واتساب غير متصل، لذا لا يمكن إرسال الكود. سجّل الدخول على الخادم ونفّذ `levix reset-password`، أو ابدأ جلسة واتساب أولاً.",
      resetErrSendFailed: "تعذّر إرسال رسالة واتساب. حاول مرة أخرى خلال دقيقة.",
      resetErrStart: "تعذّر بدء إعادة التعيين. حاول مرة أخرى.",
      resetErrServer: "تعذّر الوصول إلى الخادم. حاول مرة أخرى.",
      resetDone: "تم تحديث كلمة المرور. جارٍ تحويلك لتسجيل الدخول…",
      resetErrWrongCode: "كود غير صحيح.",
      resetErrAttemptsLeft: "{n} محاولات متبقية.",
      resetErrExpired: "هذا الكود لم يعد صالحاً. أرسل كوداً جديداً.",
      resetErrMismatch: "كلمتا المرور غير متطابقتين.",
      resetErrInvalidPassword: "كلمة المرور غير مقبولة.",
      resetErrFailed: "تعذّر إعادة تعيين كلمة المرور. حاول مرة أخرى.",

      // Setup
      firstMinute: "دقيقتك الأولى",
      setupHeadline: "اجعل مساحة العمل ملكك.",
      setupLede: "اختر كلمة مرور قوية واحدة، ثم أدِر المساعد من غرفة تحكم خاصة واحدة.",
      setupTrust: "<span></span> إعداد واحد · بلا ملفات إعداد",
      createWorkspace: "أنشئ مساحة عملك",
      setupWelcome: "مرحباً بك في {brand}",
      setupSub: "احمِ حساب واتساب المرتبط بكلمة مرور لا تقل عن {n} خانات.",
      setupCodeLabel: "رمز الإعداد",
      setupCodePlaceholder: "يُطبع في طرفية البوت",
      setupCodeHint: "يتأكد من إمكانية وصولك إلى الخادم الذي يعمل عليه {brand}.",
      setupPasswordLabel: "كلمة المرور",
      createWorkspaceBtn: "إنشاء مساحة العمل",

      // QR pairing
      directLine: "خط مباشر",
      qrHeadline: "اجعل مساعدك متصلاً.",
      qrLede: "مسحة واحدة تربط {brand} بأمان بحساب واتساب الذي تختاره.",
      qrTrust: "<span></span> حالة الربط المباشرة",
      linkDevice: "ربط جهاز",
      qrScanTitle: "امسح باستخدام واتساب",
      qrWaiting: "بانتظار…",
      qrStep1: "<span>افتح</span> واتساب على الهاتف الذي سيعمل عليه البوت.",
      qrStep2: "<span>اختر</span> الإعدادات ← الأجهزة المرتبطة ← ربط جهاز.",
      qrStep3: "<span>امسح</span> الرمز الظاهر بالأعلى.",
      qrCallout: "لا يوجد رمز بعد؟ اضغط <strong>بدء الاتصال</strong> في شاشة الاتصال بلوحة التحكم.",
      backToDashboard: "العودة إلى لوحة التحكم",
      qrScanMe: "امسحني",
      qrWaitingCode: "بانتظار رمز…",
      qrConnected: "متصل",
      qrLinked: "تم الربط ✓",
      qrNotStarted: "لم تبدأ — ابدأها من لوحة التحكم",
      qrConnecting: "جارٍ الاتصال…",

      // Server-rendered errors, keyed by the code app.cjs passes beside them
      tooManyAttempts: "محاولات كثيرة جداً. حاول مرة أخرى لاحقاً.",
      incorrectPassword: "كلمة المرور غير صحيحة",
      wrongSetupCode: "رمز الإعداد غير صحيح.",
      passwordMismatch: "كلمتا المرور غير متطابقتين.",
      invalidPassword: "يجب ألا تقل كلمة المرور عن {n} خانات",
    },
  };

  var root = document.documentElement;
  var lang = root.lang === "ar" ? "ar" : "en";

  function t(key, vars) {
    var value = (DICT[lang] && DICT[lang][key]) || DICT.en[key] || key;
    if (vars) {
      Object.keys(vars).forEach(function (name) {
        value = value.split("{" + name + "}").join(vars[name] == null ? "" : String(vars[name]));
      });
    }
    return value;
  }

  function varsFor(el) {
    return {
      n: el.getAttribute("data-i18n-n"),
      brand: root.getAttribute("data-brand") || "",
    };
  }

  function paint(el) {
    var key = el.getAttribute("data-i18n");
    if (key) el.textContent = t(key, varsFor(el));
    var htmlKey = el.getAttribute("data-i18n-html");
    if (htmlKey) el.innerHTML = t(htmlKey, varsFor(el));
    var placeholder = el.getAttribute("data-i18n-placeholder");
    if (placeholder) el.setAttribute("placeholder", t(placeholder, varsFor(el)));
    var ariaLabel = el.getAttribute("data-i18n-aria-label");
    if (ariaLabel) el.setAttribute("aria-label", t(ariaLabel, varsFor(el)));
    var title = el.getAttribute("data-i18n-title");
    if (title) el.setAttribute("title", t(title, varsFor(el)));
    var errorCode = el.getAttribute("data-i18n-error");
    if (errorCode && DICT[lang] && DICT[lang][errorCode]) {
      el.textContent = t(errorCode, varsFor(el));
    }
  }

  function apply(scope) {
    var nodes = (scope || document).querySelectorAll(
      "[data-i18n],[data-i18n-html],[data-i18n-placeholder],[data-i18n-aria-label],[data-i18n-title],[data-i18n-error]",
    );
    for (var i = 0; i < nodes.length; i += 1) paint(nodes[i]);
  }

  window.LevixGatewayI18n = { lang: lang, t: t, apply: apply };
  apply();
})();
