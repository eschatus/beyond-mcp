// Listing the account's own homebrew, from the site's "My Creations" page (/my-creations).
// Read-only. Live-observed 2026-10-13:
//   - server-side filters: filter-type (entity type id), filter-name (substring), filter-status
//     (1 Private, 2 Published, 3 Deleted); `page=N`; ~20 rows per page; a `rel="next"` link while
//     more pages exist.
//   - a page number past the end is CLAMPED: ?page=40 serves the last page again (with its own page
//     marked active), so a request past the end must be detected, or a pager loops forever.
//   - DELETING HOMEBREW IS A SOFT DELETE: deleted creations stay listed as "Deleted, …" rows with
//     no view link. Rows are therefore parsed from the row markup (data-slug carries "{id}-{slug}"),
//     not from links, and deleted rows are dropped unless asked for.

import { parse } from "node-html-parser";
import { rtSiteSession } from "./ddb-rt.js";
import { getPage } from "./ddb-homebrew-core.js";

// The listing's own type filter (its option values are the entity type ids).
export const HOMEBREW_TYPES = {
  background: 1669830167,
  feat: 1088085227,
  "magic-item": 112130694,
  monster: 779871897,
  species: 1743923279,
  spell: 1118725998,
  subclass: 789467139,
} as const;
export type HomebrewType = keyof typeof HOMEBREW_TYPES;

const STATUS_FILTER = { private: 1, published: 2, deleted: 3 } as const;

export interface HomebrewListing {
  id: number;
  name: string;
  type: string;        // the row's type label ("Monster", "Item", "Spell", …)
  status: string;      // "Private, Never Submitted", "Published, Approved", "Deleted, …"
  deleted: boolean;
  slug: string;        // "{id}-{slug}"
  modified: string;    // as displayed, e.g. "3/5/2023"
}

/** Pure: parse one /my-creations page. */
export function parseCreationsPage(html: string): { items: HomebrewListing[]; hasNext: boolean; activePage: number } {
  const root = parse(html);
  const text = (el: ReturnType<typeof root.querySelector>) => el?.text.replace(/\s+/g, " ").trim() ?? "";
  const items = root.querySelectorAll("div.list-row-homebrew-creation").map((row) => {
    const slug = row.getAttribute("data-slug") ?? "";
    const id = Number(slug.match(/^(\d+)-/)?.[1]);
    if (!Number.isInteger(id)) throw new Error(`ddb-homebrew-list: listing row without an id slug ("${slug}") — DDB changed the page?`);
    const statusEl = row.querySelector(".homebrew-status");
    return {
      id,
      name: text(row.querySelector(".list-row-name-primary-text")),
      type: text(row.querySelector(".list-row-type-primary-text")),
      status: text(statusEl),
      deleted: statusEl?.classList.contains("homebrew-status-deleted") ?? false,
      slug,
      modified: text(row.querySelector(".list-row-modified-primary-text")),
    };
  });
  // The pager marks the page actually served; absent on a single-page listing.
  const activePage = Number(text(root.querySelector(".b-pagination-item.s-active")) || "1");
  return { items, hasNext: root.querySelector('a[rel="next"]') !== null, activePage };
}

export interface ListHomebrewOptions {
  type?: HomebrewType;
  name?: string;
  status?: keyof typeof STATUS_FILTER;   // omitted: everything except deleted
  page?: number;
}

export async function listHomebrew(o: ListHomebrewOptions = {}): Promise<{ page: number; hasNext: boolean; items: HomebrewListing[] }> {
  const q = new URLSearchParams();
  if (o.type) q.set("filter-type", String(HOMEBREW_TYPES[o.type]));
  if (o.name) q.set("filter-name", o.name);
  if (o.status) q.set("filter-status", String(STATUS_FILTER[o.status]));
  const page = o.page ?? 1;
  if (page > 1) q.set("page", String(page));
  const html = await getPage(rtSiteSession(), `/my-creations${q.size ? `?${q}` : ""}`);
  const { items, hasNext, activePage } = parseCreationsPage(html);
  if (activePage < page) return { page, hasNext: false, items: [] };   // past the end: DDB re-served the last page
  // Unfiltered pages mix in soft-deleted rows; hide them unless deleted ones were asked for.
  return { page, hasNext, items: o.status === "deleted" ? items : items.filter((i) => !i.deleted) };
}
