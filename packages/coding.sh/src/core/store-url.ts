/**
 * A store URL as `status` and `doctor` print it: the password (postgres://user:secret@host/db)
 * becomes `***`, and so do query values that name one (?password=, ?access_key=…). A path
 * or a value that is not a URL is returned as it is.
 */
const SECRET_PARAM = /^(?:password|passwd|pass|pwd|secret|token|access[_-]?key|secret[_-]?access[_-]?key|api[_-]?key|sslpassword)$/i;

export function maskStoreUrl(value: string): string {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    // Not a URL the parser takes: hide what sits between "://user:" and "@".
    return value.replace(/^([a-z][a-z0-9+.-]*:\/\/[^/:@]*:)[^@/]*@/i, "$1***@");
  }
  let changed = false;
  if (url.password) {
    url.password = "***";
    changed = true;
  }
  for (const key of [...url.searchParams.keys()]) {
    if (SECRET_PARAM.test(key)) {
      url.searchParams.set(key, "***");
      changed = true;
    }
  }
  return changed ? url.toString().replaceAll("%2A%2A%2A", "***") : value;
}

/** `text` (an error message) with the password of every URL in it masked. */
export function maskUrlsIn(text: string): string {
  return text.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, (u) => maskStoreUrl(u));
}
