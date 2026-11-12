// Types for pack-manifest.mjs, so TypeScript tests can import it without allowJs.
/** The backup's file name, next to package.json. */
export const BACKUP: string;
/** A copy of the manifest with every "source" export condition removed. */
export function withoutSource<T>(pkg: T): T;
/** prepack: keep a copy of package.json, then write it without the source conditions. */
export function prepack(root?: string): void;
/** postpack: put the backup back. Throws when there is none. */
export function postpack(root?: string): void;
/** For the build: put back a backup an interrupted pack left. Returns true when it did. */
export function restoreManifest(root?: string): boolean;
