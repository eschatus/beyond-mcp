import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as hb from "../bridge/ddb-homebrew-background.js";
import { text, optionChoice } from "./helpers.js";

// D&D Beyond homebrew BACKGROUND tools — create / update / delete without the site's builder UX.
// Registered only when DDB_WRITES=enabled (the integrator wires it). Primitives: they do exactly
// what is asked on the caller's account; the caller owns intent. Choices take the builder's LABELS;
// an unknown label fails with the valid list, an ambiguous one (tools, languages and feats have
// true duplicate labels) fails naming the option ids — pass {value: "<id>"} to choose. Backgrounds
// have no JSON read-back, so every write is re-read from the builder's edit page and verified.

const html = (what: string) => z.string().describe(`${what} as HTML, e.g. "<p>…</p>". DDB markup works inside, e.g. [condition]poisoned[/condition], [spell]fireball[/spell].`);
const choice = optionChoice;
const titled = (what: string, max: number) => z.object({ name: z.string().max(max), description: html(`${what} description`) });

const fields = {
  name: z.string().min(2).max(128),
  version: z.string().max(100).optional().describe("Free-text version label shown with the creation."),
  introduction: html("Introduction (the short description shown first; required by the builder)"),
  abilityScoresDescription: html("Ability scores line").optional(),
  featDescription: html("Feat line").optional(),
  skillProficienciesDescription: html("Skill proficiencies line").optional(),
  toolProficienciesDescription: html("Tool proficiencies line").optional(),
  languagesDescription: html("Languages line").optional(),
  equipmentDescription: html("Equipment line").optional(),
  suggestedCharacteristicsDescription: html("Suggested characteristics introduction").optional(),
  feature: titled("Feature", 256).optional().describe("The background's feature, { name, description }."),
  variant: titled("Variant", 128).optional().describe("Optional variant-background blurb."),
  variantFeature: titled("Variant feature", 128).optional(),
  table: titled("Background-specific table intro", 128).optional().describe("Intro of the background-specific table (its rows are not supported yet)."),
  spellListIntro: z.object({ before: html("Text above the spell list").optional(), after: html("Text below the spell list").optional() }).optional(),
  contactsDescription: html("Contacts introduction").optional(),
  tags: z.array(z.string()).optional().describe("Background tag labels (18 builder tags, e.g. \"Combat\")."),
  skills: z.array(choice).optional().describe("ONE \"choose one of these\" skill pool: skill labels, e.g. [\"Athletics\", \"Stealth\"]. Must not be empty. For skills the background GRANTS outright use skillGrants."),
  tools: z.array(choice).optional().describe("ONE \"choose one of these\" tool pool of tool labels (e.g. the four gaming sets). Several tools share labels — an ambiguous label errors with the ids; pass {value}. For tools granted outright use toolGrants."),
  languages: z.array(choice).optional().describe("ONE \"choose one of these\" language pool of language labels (98 options, duplicates exist; pass {value} when told)."),
  skillGrants: z.array(choice).optional().describe("FIXED skill proficiencies: every listed skill is granted outright (one builder row each, as official 2024 backgrounds do). Combine with skills for a granted set plus a pool."),
  toolGrants: z.array(choice).optional().describe("FIXED tool proficiencies, one row each (same duplicate-label rule as tools)."),
  languageGrants: z.array(choice).optional().describe("FIXED languages, one row each (same duplicate-label rule as languages)."),
  grantedFeat: z.object({
    name: z.string().min(2).max(50),
    feats: z.array(choice).min(1).describe("Feat labels; duplicates exist (Alert is id 1789101 = the 2024 feat, 12 = Legacy; Magic Initiate (Cleric) 1789163 vs 59) — pass {value} when told; the 2024 versions are the 17891xx ids."),
  }).optional().describe("A granted feat (a named choice among feats)."),
  equipment: z.array(z.string().min(2).max(2048)).optional().describe("Starting-equipment slots, free text, e.g. \"a dagger\"."),
  characteristics: z.array(z.object({
    type: z.enum(["Personality Trait", "Ideal", "Bond", "Flaw"]),
    text: z.string().min(2).max(256),
  })).optional().describe("Suggested characteristics."),
};

// Update: same fields, all optional. A provided sub-entry value REPLACES that kind; null removes
// a pool / the granted feat.
const nullable = <T extends z.ZodTypeAny>(t: T) => t.nullable().optional();
const updateFields = {
  ...Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v.optional()])) as { [K in keyof typeof fields]: z.ZodOptional<(typeof fields)[K]> },
  skills: nullable(fields.skills.unwrap()).describe("Replaces the skill pool; null removes it."),
  tools: nullable(fields.tools.unwrap()).describe("Replaces the tool pool; null removes it."),
  languages: nullable(fields.languages.unwrap()).describe("Replaces the language pool; null removes it."),
  skillGrants: nullable(fields.skillGrants.unwrap()).describe("Replaces the fixed skill grants; null / [] removes them. A kind's rows (pool + grants) are replaced together: pass both fields to keep both."),
  toolGrants: nullable(fields.toolGrants.unwrap()).describe("Replaces the fixed tool grants; null / [] removes them."),
  languageGrants: nullable(fields.languageGrants.unwrap()).describe("Replaces the fixed language grants; null / [] removes them."),
  grantedFeat: nullable(fields.grantedFeat.unwrap()).describe("Replaces the granted feat; null removes it."),
};

function summary(r: hb.HomebrewBackgroundResult) {
  return { id: r.id, editUrl: r.editUrl, verified: true, ...r.readBack };
}

export function registerDdbHomebrewBackgroundTools(server: McpServer): void {
  server.tool(
    "ddb_create_homebrew_background",
    "Create a private homebrew background on the D&D Beyond account (no builder UI). Descriptions are HTML. Choice fields take the builder's labels; an unknown label errors with the valid list and an ambiguous one with the option ids ({value} picks one). Skill/tool/language pools (\"choose one of\") and fixed grants (skillGrants / toolGrants / languageGrants) and the granted feat are added after the base background, as are equipment slots and suggested characteristics. Not supported yet: spell list, contacts and table rows. The result is re-read from the builder's edit page and verified; on any failure after the base create, the error names the new background's id so it can be fixed (ddb_update_homebrew_background) or removed (ddb_delete_homebrew_background).",
    fields,
    async (f) => text(JSON.stringify(summary(await hb.createHomebrewBackground(f)))),
  );

  server.tool(
    "ddb_update_homebrew_background",
    "Update one of the account's homebrew backgrounds by id. Only the fields given change; everything else keeps its current value. A provided skills|skillGrants / tools|toolGrants / languages|languageGrants (a kind's rows are replaced together) / grantedFeat / equipment / characteristics value REPLACES that kind entirely (null removes a pool or the granted feat; [] clears equipment or characteristics). Labels are resolved before anything is deleted. Read back and verified like create.",
    { backgroundId: z.number().int().positive(), ...updateFields },
    async ({ backgroundId, ...f }) => text(JSON.stringify(summary(await hb.updateHomebrewBackground(backgroundId, f)))),
  );

  server.tool(
    "ddb_delete_homebrew_background",
    "Delete one of the account's homebrew backgrounds by id. DDB soft-deletes: it stays listed as Deleted in My Creations; this server has no restore. Confirmed by a repeat delete answering 404.",
    { backgroundId: z.number().int().positive() },
    async ({ backgroundId }) => text(JSON.stringify(await hb.deleteHomebrewBackground(backgroundId))),
  );
}
