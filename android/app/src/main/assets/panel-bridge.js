(function () {
  if (!window.LevixHost || typeof window.LevixHost.request !== "function") return;

  function isLocal(url) {
    try {
      var u = new URL(url, location.href);
      return u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]";
    } catch (e) {
      return false;
    }
  }

  function bytesToB64(bytes) {
    var bin = "";
    var chunk = 0x8000;
    for (var i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
  }

  function encodeBody(body) {
    if (body == null || body === "") return "";
    var bytes;
    if (typeof body === "string") bytes = new TextEncoder().encode(body);
    else if (body instanceof ArrayBuffer) bytes = new Uint8Array(body);
    else if (ArrayBuffer.isView(body)) bytes = new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    else bytes = new TextEncoder().encode(String(body));
    return bytesToB64(bytes);
  }

  function b64ToBytes(b64) {
    var bin = atob(b64 || "");
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function hostRequest(url, method, headers, body) {
    var raw = window.LevixHost.request(
      String(url),
      String(method || "GET"),
      JSON.stringify(headers || {}),
      encodeBody(body)
    );
    return JSON.parse(raw);
  }

  function normPath(u) {
    try {
      var parsed = new URL(u, location.href);
      var path = parsed.pathname.replace(/\/$/, "") || "/";
      return parsed.origin + path;
    } catch (e) {
      return String(u);
    }
  }

  if (!window.__levixBridge) {
    window.__levixBridge = true;

    var origFetch = window.fetch;
    window.fetch = function (input, init) {
      init = init || {};
      var req = new Request(input, init);
      var url = req.url;
      if (!isLocal(url)) return origFetch.call(this, input, init);
      var method = (req.method || "GET").toUpperCase();
      if (method === "GET" || method === "HEAD") {
        return origFetch.call(this, input, init);
      }
      var headers = {};
      req.headers.forEach(function (v, k) {
        headers[k] = v;
      });
      return req.arrayBuffer().then(function (buf) {
        var res = hostRequest(url, method, headers, buf);
        var bytes = b64ToBytes(res.body);
        return new Response(bytes, {
          status: res.status,
          statusText: res.statusText || "",
          headers: res.headers || {},
        });
      });
    };

    var XO = window.XMLHttpRequest;
    var origOpen = XO.prototype.open;
    var origSend = XO.prototype.send;
    var origSet = XO.prototype.setRequestHeader;
    XO.prototype.open = function (method, url) {
      var m = (method || "GET").toUpperCase();
      this.__levix = { method: m, url: String(url), headers: {} };
      try {
        this.__levix.url = new URL(String(url), location.href).href;
        this.__levix.local = isLocal(this.__levix.url);
      } catch (e) {
        this.__levix.local = false;
      }
      if (this.__levix.local && m !== "GET" && m !== "HEAD") {
        return;
      }
      return origOpen.apply(this, arguments);
    };
    XO.prototype.setRequestHeader = function (k, v) {
      if (this.__levix && this.__levix.local && this.__levix.method !== "GET" && this.__levix.method !== "HEAD") {
        this.__levix.headers[k] = v;
        return;
      }
      return origSet.apply(this, arguments);
    };
    XO.prototype.send = function (body) {
      var meta = this.__levix;
      if (!meta || !meta.local || meta.method === "GET" || meta.method === "HEAD") {
        return origSend.apply(this, arguments);
      }
      var self = this;
      var res = hostRequest(meta.url, meta.method, meta.headers, body);
      var bytes = b64ToBytes(res.body);
      var text = new TextDecoder("utf-8").decode(bytes);
      function def(name, value) {
        try {
          Object.defineProperty(self, name, { configurable: true, get: function () { return value; } });
        } catch (e) {
          try { self[name] = value; } catch (e2) {}
        }
      }
      def("status", res.status);
      def("statusText", res.statusText || "");
      def("responseText", text);
      def("readyState", 4);
      if (self.responseType === "arraybuffer") def("response", bytes.buffer);
      else def("response", text);
      self.getAllResponseHeaders = function () {
        var h = res.headers || {};
        return Object.keys(h).map(function (k) { return k + ": " + h[k]; }).join("\r\n");
      };
      self.getResponseHeader = function (name) {
        var h = res.headers || {};
        var want = String(name).toLowerCase();
        var key = Object.keys(h).find(function (k) { return k.toLowerCase() === want; });
        return key ? h[key] : null;
      };
      setTimeout(function () {
        if (typeof self.onreadystatechange === "function") self.onreadystatechange();
        if (typeof self.onload === "function") self.onload();
        try {
          self.dispatchEvent(new Event("readystatechange"));
          self.dispatchEvent(new Event("load"));
          self.dispatchEvent(new Event("loadend"));
        } catch (e) {}
      }, 0);
    };

    var realIo;
    Object.defineProperty(window, "io", {
      configurable: true,
      get: function () {
        return realIo;
      },
      set: function (v) {
        realIo = function (url, opts) {
          opts = Object.assign({}, opts, { transports: ["polling"], upgrade: false });
          return v(url, opts);
        };
        Object.keys(v).forEach(function (k) {
          realIo[k] = v[k];
        });
      },
    });
  }

  if (window.__levixSubmit) return;
  window.__levixSubmit = true;
  document.addEventListener(
    "submit",
    function (e) {
      var form = e.target;
      if (!form || form.tagName !== "FORM") return;
      var action = form.getAttribute("action") || location.href;
      var abs = new URL(action, location.href).href;
      if (!isLocal(abs)) return;
      e.preventDefault();
      var method = (form.getAttribute("method") || "GET").toUpperCase();
      var data = new URLSearchParams(new FormData(form));
      if (method === "GET") {
        var u = new URL(abs);
        data.forEach(function (v, k) { u.searchParams.append(k, v); });
        location.href = u.href;
        return;
      }
      try {
        var res = hostRequest(
          abs,
          method,
          { "Content-Type": "application/x-www-form-urlencoded" },
          data.toString()
        );
        if (res.status >= 400) {
          var html = new TextDecoder("utf-8").decode(b64ToBytes(res.body));
          document.open();
          document.write(html);
          document.close();
          return;
        }
        var dest = "http://127.0.0.1:3001/";
        if (res.url && normPath(res.url) !== normPath(abs)) dest = res.url;
        location.replace(dest);
      } catch (err) {
        location.replace("http://127.0.0.1:3001/");
      }
    },
    true
  );
})();
