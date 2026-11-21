// Saved views: a --where query kept under a name in the index (IndexStore.putView,
// listViews, deleteView). `views save|list|rm`, `sessions --view`, the MCP sessions_list
// view argument and /api/views all go through here, so they check names and queries the
// same way and say the same thing when a view is missing.
import type { IndexStore, SavedView } from "../core/types.ts";
import { andQuery, parseWhere, type ParseOptions, type Query } from "./where.ts";

export const VIEW_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
export const NO_VIEWS = "saved views need the local index (this store has no views)";

/** Why a view could not be saved, read or removed. `status` is the HTTP status the viewer answers with. */
export class ViewError extends Error {
  readonly reason: "bad_name" | "empty_query" | "no_views" | "unknown_view";
  readonly status: number;
  constructor(reason: ViewError["reason"], message: string) {
    super(message);
    this.name = "ViewError";
    this.reason = reason;
    this.status = reason === "unknown_view" ? 404 : reason === "no_views" ? 501 : 400;
  }
}

type ViewStore = Required<Pick<IndexStore, "putView" | "listViews" | "deleteView">>;

/** The store's view methods, or a ViewError when it has none (the postgres and clickhouse plugins). */
export function viewStore(index: IndexStore): ViewStore {
  if (!index.putView || !index.listViews || !index.deleteView) throw new ViewError("no_views", NO_VIEWS);
  return { putView: index.putView.bind(index), listViews: index.listViews.bind(index), deleteView: index.deleteView.bind(index) };
}

export function checkViewName(name: unknown): string {
  if (typeof name !== "string" || !VIEW_NAME_RE.test(name)) {
    throw new ViewError("bad_name", `view names are 1 to 64 letters, digits, '-', '_' and '.', got ${JSON.stringify(name)}`);
  }
  return name;
}

/** "Saved views: a, b." or "No views are saved." */
export function viewsText(views: readonly SavedView[]): string {
  return views.length ? `Saved views: ${views.map((v) => v.name).join(", ")}.` : "No views are saved.";
}

/**
 * Saves `where` as `name`, replacing a view of that name (it keeps its createdAt). The query
 * must parse: a QueryError (./where.ts) is thrown before anything is written.
 */
export async function saveView(index: IndexStore, name: string, where: string, now = Date.now()): Promise<{ view: SavedView; replaced: boolean }> {
  const store = viewStore(index);
  checkViewName(name);
  const q = where.trim();
  if (!q) throw new ViewError("empty_query", "a view needs a query, e.g. 'flagged agent:codex'");
  parseWhere(q, { now });
  const old = (await store.listViews()).find((v) => v.name === name);
  const view: SavedView = { name, where: q, createdAt: old?.createdAt ?? now, updatedAt: now };
  await store.putView(view);
  return { view, replaced: old !== undefined };
}

/** The view named `name`; a ViewError naming the views that exist when there is none. */
export async function getView(index: IndexStore, name: string): Promise<SavedView> {
  const views = await viewStore(index).listViews();
  const v = views.find((x) => x.name === name);
  if (!v) throw new ViewError("unknown_view", `No view named ${JSON.stringify(name)}. ${viewsText(views)}`);
  return v;
}

/** Removes the view; a ViewError naming the views that exist when there is none. */
export async function removeView(index: IndexStore, name: string): Promise<void> {
  const store = viewStore(index);
  if (await store.deleteView(name)) return;
  throw new ViewError("unknown_view", `No view named ${JSON.stringify(name)}. ${viewsText(await store.listViews())}`);
}

/**
 * Both queries must hold. Each side is its own node under one AND, so an OR or a negation in
 * either keeps its meaning (`a OR b` and `c` is `(a OR b) c`, never `a OR (b c)`). `extra`'s
 * sort: and limit: win over the view's.
 */
export function withView(view: Query, extra: Query | undefined): Query {
  if (!extra) return view;
  const out = andQuery({ ...view }, extra.root);
  if (extra.sort) out.sort = extra.sort;
  if (extra.limit !== undefined) out.limit = extra.limit;
  return out;
}

/** The view's query, parsed now (since:7d is seven days before this call), AND `extra`. */
export async function viewQuery(index: IndexStore, name: string, extra?: Query, opts: ParseOptions = {}): Promise<{ view: SavedView; query: Query }> {
  const view = await getView(index, name);
  return { view, query: withView(parseWhere(view.where, opts), extra) };
}
