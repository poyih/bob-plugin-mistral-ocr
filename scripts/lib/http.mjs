export class HttpError extends Error {
  constructor(status) {
    super(`HTTP ${status}`);
    this.status = status;
  }
}

// The deadline covers both response headers and the complete body. Bound memory
// while streaming instead of trusting Content-Length or buffering an unlimited body.
export async function fetchBuffer(url, options = {}) {
  const { timeoutMs = 30_000, maxBytes = 10 * 1024 * 1024, fetchImpl = fetch, ...requestOptions } = options;
  const controller = new AbortController();
  let reader;
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Download timed out after ${timeoutMs} ms`));
      controller.abort();
    }, timeoutMs);
  });
  try {
    const download = (async () => {
      const response = await fetchImpl(url, { ...requestOptions, signal: controller.signal });
      if (!response.ok) throw new HttpError(response.status);
      const length = Number(response.headers.get("content-length"));
      if (Number.isFinite(length) && length > maxBytes) throw new Error(`Response exceeds ${maxBytes} bytes`);
      const chunks = [];
      let size = 0;
      if (response.body) {
        reader = response.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > maxBytes) throw new Error(`Response exceeds ${maxBytes} bytes`);
          chunks.push(Buffer.from(value));
        }
      }
      return { buffer: Buffer.concat(chunks, size), response };
    })();
    return await Promise.race([download, deadline]);
  } finally {
    clearTimeout(timer);
    controller.abort();
    if (reader) reader.cancel().catch(() => {});
  }
}

export async function downloadBuffer(url, options) {
  return (await fetchBuffer(url, options)).buffer;
}
