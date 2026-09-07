/** A stalled read must reach a visible error instead of leaving the UI pending. */
export async function boundedFetch(input: RequestInfo | URL, init: RequestInit = {}, timeoutMs = init.body instanceof FormData ? 600000 : 30000): Promise<Response> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  try { return await globalThis.fetch(input, {...init, signal}); }
  catch (error) {
    if (timeout.aborted && !init.signal?.aborted) throw new Error("请求超时，请检查连接后重试；已有记录不会被删除。");
    throw error;
  }
}
