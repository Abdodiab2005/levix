// Loading the gateway's local libraries can fail independently. Remove each
// script after it settles so a retry always makes a fresh request.
export function loadScript(src, available) {
  if (available()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    const finish = (ok) => {
      clearTimeout(timer);
      script.onload = null;
      script.onerror = null;
      script.remove();
      if (ok && available()) resolve();
      else reject(new Error(`Unable to load ${src}`));
    };
    const timer = setTimeout(() => finish(false), 15000);
    script.src = src;
    script.onload = () => finish(true);
    script.onerror = () => finish(false);
    document.body.appendChild(script);
  });
}
