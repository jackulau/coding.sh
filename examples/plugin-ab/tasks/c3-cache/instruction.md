`getUser` in `src/users.js` is called from many places at once, and our API logs show the same
user fetched several times in the same second. Fix the cache so concurrent calls for the same id
share one request. A failed request must not stay cached: the next call should try again. Explain
the fix briefly.
