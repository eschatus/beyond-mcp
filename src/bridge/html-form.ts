// Server-rendered HTML form handling for D&D Beyond's homebrew builders. There is no JSON API
// for homebrew: the site's own forms POST multipart/urlencoded bodies carrying per-render CSRF
// tokens (`security-token`, `authenticity-token`) and, for some controls, per-render HASHED field
// names (STR is `fdb5c7a0…` on one load and `f062b861…` on the next). Only the element ids
// (`field-strength`) are stable. So every write parses the live form, addresses controls by id,
// and posts every control the way a browser would — never a baked body.

import { parse, type HTMLElement } from "node-html-parser";

export interface FormOption { value: string; label: string }

export interface FormControl {
  id: string | null;
  name: string;
  tag: "input" | "select" | "textarea";
  /** input type (text/hidden/checkbox/file/…); "select"/"textarea" for those tags. */
  type: string;
  multiple: boolean;
  options: FormOption[];
  /** Current value(s) — what a browser would submit right now. Empty for an unchecked box. */
  values: string[];
  /** For checkbox/radio: the value submitted when checked. */
  checkedValue: string;
}

export interface ParsedForm {
  action: string;
  method: string;
  enctype: string;
  controls: FormControl[];
}

const optionLabel = (o: HTMLElement) => o.text.replace(/\s+/g, " ").trim();

function readControl(el: HTMLElement): FormControl | null {
  const name = el.getAttribute("name");
  if (!name) return null;
  const tag = el.tagName.toLowerCase() as FormControl["tag"];
  const id = el.getAttribute("id") ?? null;
  if (tag === "select") {
    const opts = el.querySelectorAll("option");
    const options = opts.map((o) => ({ value: o.getAttribute("value") ?? optionLabel(o), label: optionLabel(o) }));
    const multiple = el.hasAttribute("multiple");
    const selected = opts.filter((o) => o.hasAttribute("selected")).map((o) => o.getAttribute("value") ?? optionLabel(o));
    // A single select with nothing marked submits its first option, as a browser does.
    const values = selected.length ? selected : (!multiple && options.length ? [options[0].value] : []);
    return { id, name, tag, type: "select", multiple, options, values: multiple ? values : values.slice(0, 1), checkedValue: "" };
  }
  if (tag === "textarea") {
    // node-html-parser leaves textarea content raw; the escaped HTML inside is the field's value.
    return { id, name, tag, type: "textarea", multiple: false, options: [], values: [decodeHtml(el.innerHTML)], checkedValue: "" };
  }
  const type = (el.getAttribute("type") ?? "text").toLowerCase();
  if (type === "submit" || type === "button" || type === "reset" || type === "image") return null;
  const value = el.getAttribute("value") ?? "";
  if (type === "checkbox" || type === "radio") {
    const checkedValue = value || "on";
    return { id, name, tag, type, multiple: false, options: [], values: el.hasAttribute("checked") ? [checkedValue] : [], checkedValue };
  }
  return { id, name, tag, type, multiple: false, options: [], values: type === "file" ? [] : [value], checkedValue: "" };
}

// Textarea bodies arrive entity-escaped (`&lt;p&gt;…`); attribute values are already decoded by
// the parser. Only the entities a server emits inside a textarea need handling here.
function decodeHtml(s: string): string {
  return s
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&");
}

/** Parse the first form whose action matches `actionPattern`. Throws if none does. */
export function parseForm(html: string, actionPattern: RegExp): ParsedForm {
  const root = parse(html, { blockTextElements: { script: false, style: false, textarea: true } });
  const form = root.querySelectorAll("form").find((f) => actionPattern.test(f.getAttribute("action") ?? ""));
  if (!form) throw new Error(`html-form: no <form> with action matching ${actionPattern} on the page`);
  const controls = form.querySelectorAll("input, select, textarea").map(readControl).filter((c): c is FormControl => c !== null);
  return {
    action: form.getAttribute("action") ?? "",
    method: (form.getAttribute("method") ?? "get").toLowerCase(),
    enctype: (form.getAttribute("enctype") ?? "application/x-www-form-urlencoded").toLowerCase(),
    controls,
  };
}

export function controlById(form: ParsedForm, id: string): FormControl {
  const c = form.controls.find((x) => x.id === id);
  if (!c) throw new Error(`html-form: form ${form.action} has no control #${id}`);
  return c;
}

/** An explicit option VALUE, for selects whose labels are ambiguous (e.g. two "Thieves' Tools"). */
export interface OptionValue { value: string }
export type ControlValue = string | number | boolean | OptionValue | Array<string | number | OptionValue>;

/**
 * Set a control's value(s) by element id. Selects take an option LABEL (exact, else case-
 * insensitive), or an explicit { value } when labels are ambiguous; anything unmatched or
 * ambiguous throws — a wrong choice is a caller error, never something to guess at or drop.
 * Checkboxes take a boolean.
 */
export function setControl(form: ParsedForm, id: string, value: ControlValue): void {
  const c = controlById(form, id);
  if (c.type === "checkbox" || c.type === "radio") {
    if (typeof value !== "boolean") throw new Error(`html-form: #${id} is a ${c.type}; pass a boolean`);
    c.values = value ? [c.checkedValue] : [];
    return;
  }
  if (c.type === "file") throw new Error(`html-form: #${id} is a file input; uploads are not supported`);
  if (typeof value === "boolean") throw new Error(`html-form: #${id} is not a checkbox`);
  const wanted = Array.isArray(value) ? value : [value];
  if (c.tag === "select") {
    if (wanted.length > 1 && !c.multiple) throw new Error(`html-form: #${id} takes a single value`);
    c.values = wanted.map((w) => resolveOption(c, id, w));
    return;
  }
  if (wanted.length !== 1 || typeof wanted[0] === "object") throw new Error(`html-form: #${id} takes a single plain value`);
  c.values = [String(wanted[0])];
}

function resolveOption(c: FormControl, id: string, w: string | number | OptionValue): string {
  if (typeof w === "object") {
    if (!c.options.some((o) => o.value === w.value && o.value !== "")) throw new Error(`html-form: #${id} has no option with value "${w.value}"`);
    return w.value;
  }
  // LABELS only, never bare option values: values are opaque ids that collide with labels (the CR
  // select's value "5" is the label "1"; label "5" is value "9"), so value-matching silently
  // picked the wrong CR. Exact label first — DDB lists hold case-variant duplicates ("devil" and
  // "Devil" tags) — then case-insensitive. Several options sharing the winning label (tools,
  // languages and feats have true duplicates with different ids) is ambiguous: throw with the
  // candidate values so the caller can pick one with { value }.
  const label = String(w).trim();
  let hits = c.options.filter((o) => o.label === label && o.value !== "");
  if (!hits.length) hits = c.options.filter((o) => o.label.toLowerCase() === label.toLowerCase() && o.value !== "");
  if (hits.length > 1) {
    throw new Error(`html-form: "${label}" is ambiguous on #${id} — options ${hits.map((h) => `${h.value} ("${h.label}")`).join(", ")}; pass { value } to choose`);
  }
  if (!hits.length) {
    const choices = c.options.filter((o) => o.value !== "").map((o) => o.label);
    const shown = choices.length > 60 ? `${choices.slice(0, 60).join(", ")}, … (${choices.length - 60} more)` : choices.join(", ");
    throw new Error(`html-form: "${label}" is not an option of #${id}. Options: ${shown}`);
  }
  return hits[0].value;
}

/**
 * Clear a control the way a user would: a single select back to its blank ("—") option, a multi
 * select to nothing, a text/textarea to "", a checkbox unchecked. setControl can't express this —
 * it deliberately refuses the blank option as a *choice* — and builders need it (e.g. dropping a
 * spell's higher-level scale). A single select with no blank option can't be cleared: throws.
 */
export function clearControl(form: ParsedForm, id: string): void {
  const c = controlById(form, id);
  if (c.type === "file") throw new Error(`html-form: #${id} is a file input`);
  if (c.tag === "select" && !c.multiple) {
    if (!c.options.some((o) => o.value === "")) throw new Error(`html-form: #${id} has no blank option to clear to`);
    c.values = [""];
    return;
  }
  c.values = c.type === "checkbox" || c.type === "radio" || c.multiple ? [] : [""];
}

export interface FieldError { id: string | null; label: string; message: string }

/**
 * Server-side validation errors from a re-rendered form (the site answers a rejected POST with
 * 200 + the same form). Each `<span class="field-errors">` sits next to its control inside the
 * field's wrapper; the wrapper's label div names it for humans.
 */
export function formErrors(html: string): FieldError[] {
  const root = parse(html, { blockTextElements: { script: false, style: false, textarea: true } });
  return root.querySelectorAll("span.field-errors").flatMap((span) => {
    const message = span.text.replace(/\s+/g, " ").trim();
    if (!message) return [];
    const control = span.parentNode?.querySelector("input, select, textarea");
    const item = span.closest(".ddb-homebrew-create-form-fields-item");
    const label = item?.querySelector(".ddb-homebrew-create-form-fields-item-label")?.text.replace(/\s+/g, " ").trim() ?? "";
    return [{ id: control?.getAttribute("id") ?? null, label, message }];
  });
}

/** The body a browser would submit for this form, in document order. */
export function encodeForm(form: ParsedForm): FormData | URLSearchParams {
  if (form.enctype === "multipart/form-data") {
    const fd = new FormData();
    for (const c of form.controls) {
      // An empty file input still submits a part with an empty filename, as browsers do.
      if (c.type === "file") { fd.append(c.name, new Blob([], { type: "application/octet-stream" }), ""); continue; }
      for (const v of c.values) fd.append(c.name, v);
    }
    return fd;
  }
  const params = new URLSearchParams();
  for (const c of form.controls) {
    if (c.type === "file") continue;
    for (const v of c.values) params.append(c.name, v);
  }
  return params;
}
