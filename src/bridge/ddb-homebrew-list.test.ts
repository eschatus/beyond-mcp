import { describe, it, expect } from "vitest";
import { parseCreationsPage } from "./ddb-homebrew-list.js";

// Row markup trimmed from a live /my-creations capture (2026-10-13): a live row with a view link,
// and a soft-deleted row without one.
const row = (slug: string, name: string, type: string, statusClass: string, status: string, link: boolean) => `
<li><div class="list-row list-row-homebrew-creation" data-type="x" data-slug="${slug}">
  <div class="list-row-col list-row-col-name"><div class="list-row-name">
    <div class="list-row-name-primary"><div class="list-row-name-primary-text">
      ${link ? `<a class="link" href="/homebrew/creations/view?entityTypeId=1&amp;id=1"> ${name} </a>` : ` ${name} `}</div></div>
    <div class="list-row-name-secondary"><div class="list-row-name-secondary-text homebrew-status ${statusClass}"> ${status} </div></div>
  </div></div>
  <div class="list-row-col list-row-col-type"><div class="list-row-primary-text list-row-type-primary-text"> ${type} </div></div>
  <div class="list-row-col list-row-col-modified"><div class="list-row-primary-text list-row-modified-primary-text"> 3/5/2023 </div></div>
</div></li>`;

describe("parseCreationsPage", () => {
  it("parses live and soft-deleted rows from the row markup, and the next-page link", () => {
    const html = `<ul>${row("6384083-adamantine-sixblade", "Adamantine Sixblade", "Item", "homebrew-status-private homebrew-status-moderation-never-submitted", "Private, Never Submitted", true)}
      ${row("6849351-zz-beyond-mcp-bisect-a", "zz beyond-mcp bisect A", "Monster", "homebrew-status-deleted homebrew-status-moderation-never-submitted", "Deleted, Never Submitted", false)}</ul>
      <a href="/my-creations?page=2" rel="next" data-next-page>Next</a>`;
    const { items, hasNext, activePage } = parseCreationsPage(html);
    expect(hasNext).toBe(true);
    expect(activePage).toBe(1);
    expect(items).toEqual([
      { id: 6384083, name: "Adamantine Sixblade", type: "Item", status: "Private, Never Submitted", deleted: false, slug: "6384083-adamantine-sixblade", modified: "3/5/2023" },
      { id: 6849351, name: "zz beyond-mcp bisect A", type: "Monster", status: "Deleted, Never Submitted", deleted: true, slug: "6849351-zz-beyond-mcp-bisect-a", modified: "3/5/2023" },
    ]);
  });

  it("reads which page DDB actually served (it clamps past-the-end requests to the last page)", () => {
    const html = `<ul class="b-pagination-list"><li class="b-pagination-item"><a href="/my-creations?page=3">3</a></li><li class="b-pagination-item"><span class="b-pagination-item s-active active">4</span></li></ul>`;
    expect(parseCreationsPage(html)).toMatchObject({ activePage: 4, hasNext: false });
  });

  it("reports no next page on the last page, and fails loud on a row without an id", () => {
    expect(parseCreationsPage("<ul></ul>").hasNext).toBe(false);
    expect(() => parseCreationsPage(`<div class="list-row-homebrew-creation" data-slug="nope"></div>`)).toThrow(/without an id slug/);
  });
});
