// Minimal multipart/form-data reader for the two panel routes that carry a
// file (the feedback attachment, scheduled-message media).
//
// Node ships undici's Request/FormData/File, so there is no parser dependency
// to install. The request body is handed to Request as a stream
// (duplex: "half"), which is why the declared Content-Length is checked
// first: undici buffers file parts in memory, and the cap has to bite before
// that buffering starts.

const MAX_TOTAL_BYTES = 26 * 1024 * 1024; // a 20 MB file + fields + MIME overhead

export class MultipartError extends Error {}

/**
 * Parse a multipart request body.
 *
 * @param {import("express").Request} req
 * @param {{ maxFileSize?: number }} [options]
 * @returns {Promise<{ fields: Record<string, string>, file: File | null } | null>}
 *   null when the request is not multipart — the JSON parser owns those.
 */
export async function readMultipartForm(req, options = {}) {
  const contentType = String(req.headers["content-type"] || "");
  if (!contentType.toLowerCase().startsWith("multipart/form-data")) return null;

  const declared = Number(req.headers["content-length"] || 0);
  if (declared > MAX_TOTAL_BYTES) {
    throw new MultipartError("Attachment is too large");
  }

  const request = new Request("http://localhost/", {
    method: "POST",
    headers: { "content-type": contentType },
    body: req,
    duplex: "half",
  });
  let form;
  try {
    form = await request.formData();
  } catch {
    // A body that is not really multipart (the browser builds these, so this
    // is a broken client, not an operator error) is refused, not crashed on.
    throw new MultipartError("Could not read the upload");
  }

  const fields = {};
  let file = null;
  const maxFileSize = options.maxFileSize ?? 0;
  for (const [key, value] of form.entries()) {
    if (typeof value === "string") {
      fields[key] = value;
      continue;
    }
    if (maxFileSize && value.size > maxFileSize) {
      throw new MultipartError("Attachment is too large");
    }
    // The panel forms carry exactly one file each; a later one replaces it.
    file = value;
  }
  return { fields, file };
}

/** Read the parsed file part into a Buffer for forwarding. */
export async function fileToBuffer(file) {
  if (!file) return null;
  return Buffer.from(await file.arrayBuffer());
}
