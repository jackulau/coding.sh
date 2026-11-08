// Calls fn until it succeeds, up to `retries` retries, with exponential backoff.
async function withRetry(fn, { retries = 3, baseMs = 100, isRetryable = () => true } = {}) {
  let attempt = 0;
  while (true) {
    try {
      return await fn(attempt);
    } catch (err) {
      attempt++;
      if (attempt > retries || !isRetryable) throw err;
      const delay = baseMs * 2 ** attempt;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}
module.exports = { withRetry };
