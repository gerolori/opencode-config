---
name: composio-google-sheets
description: Operational rules for Google Sheets automation via Composio MCP. Covers preflight, safe reads/writes, validation, structural edits, imports, formatting, protection, and verification.
compatibility: opencode
---

# Composio Google Sheets Skill

## A) Preflight

1. Call `COMPOSIO_SEARCH_TOOLS` **once** at the start of one external-app workflow/session, not once per tool or child step. Use the returned `session_id` in all subsequent meta-tool calls within that session. Create a new session only for a material task pivot or when the existing plan is stale/irrelevant.
2. Use **task-specific search queries** (e.g. `"Google Sheets batch update"` or `"GOOGLESHEETS get values"`). Do not search broad `"google sheets"` and dump unrelated Google Drive tools unless the task explicitly requires them.
3. Retrieve **complete schemas only for selected tools** that will actually be called via `COMPOSIO_GET_TOOL_SCHEMAS` — not every search result. Reuse schemas within the same session; refresh only after a schema mismatch or session pivot. Cache/reuse active connection status for the workflow. Call `COMPOSIO_MANAGE_CONNECTIONS action=list` again only after auth flow, expiry, account change, or a connection error. Wait only after initiating new auth — do not wait on a known-active connection.
4. Resolve the spreadsheet ID (from URL or known name), sheet title, and numeric `sheetId` before any read/write. The numeric `sheetId` is required for structural operations (add/delete sheets, columns).
5. Note schema spelling differences: the Sheets API uses `spreadsheet_id` (snake_case) in some tools and `spreadsheetId` (camelCase) in others. Check the exact schema each time.
6. Every Sheets call must carry a resolved spreadsheet_id, sheet title, numeric sheetId, and exact range. Never issue `{}` when an ID is required. Record these before every read/write.
7. Disambiguate files by native Google Sheets MIME type (`application/vnd.google-apps.spreadsheet`); confirm `modifiedTime`, `webViewLink`, `owner`, and sheet names before recording the chosen ID. Do not infer from title alone.
8. For read-only audits, explicitly prohibit mutation tools and state the no-write constraint.

## B) Read-Before-Write Snapshot

1. Before modifying any sheet, read:
   - Exact header row values (row 1).
   - All formulas, not just displayed values.
   - Data validations per column.
   - Conditional formatting rules if the tool supports them.
   - Sheet dimensions (row count, column count).
2. Build a header-to-column-index map (1-based or 0-based as the tool expects).
3. Use bounded ranges (e.g. `Sheet1!A1:Z100`) — never whole-column ranges that could hit the 10M-cell limit.
4. For large reads (>1000 rows), save output to a file or the workbench for analysis rather than keeping it inline.
5. After any write, read back the affected range to confirm.
6. Read sheet names/numeric IDs first. Query one sheet at a time. Use exact sheet-qualified ranges. Verify returned range before interpreting data. Check first and last target cells. Fall back to bounded grid reads or manual UI if the API misroutes.
7. Inspect dimensions before writes. Explicitly expand only required grid dimensions. Use bounded writes. Delete accidental rows/columns physically and verify final dimensions.
8. After formula or large writes, re-read FORMULA, FORMATTED_VALUE, and UNFORMATTED_VALUE. Wait/retry for stale cached values. A successful write response is not proof of correctness.

## C) Safe Writes

1. Write only to intended input or formula columns. Never do a full-row overwrite that would destroy formulas in adjacent columns.
2. Batch independent operations in a single `COMPOSIO_MULTI_EXECUTE_TOOL` call where the tool supports it.
3. After writing, validate `updatedRange` and `updatedCells` in the response. Read back and compare.
4. When writing formulas, write the formula string (e.g. `=SUMIFS(...)`) — the API will evaluate it.
5. Never write over a range containing protected cells or formulas you don't own.
6. Pad ragged rows to header width. Map by headers, never by individual row length.
7. Pad/assert equal row widths before `VALUES_UPDATE`. No malformed nested formulas or arrays.
8. Formula input mode: use `RAW` for literal documentation, `USER_ENTERED` only intentionally. Use apostrophe prefix or `CHAR(9472)&CHAR(9472)` for formula-like or Unicode divider text.
9. Dates: inspect FORMULA, UNFORMATTED_VALUE, and FORMATTED_VALUE. Normalize valid text/numeric serials safely. Never create invalid dates.
10. Batch and chunk payloads. Avoid per-cell loops. Use truncated exponential backoff for transient failures — parse `Retry-After` header on HTTP 429, respect per-tool rate-limit tiers. Use bounded ranges. Use workbench for large responses. Re-read only affected ranges.

## D) Centralized Validation

1. Maintain one authoritative configuration sheet (e.g. `system` or `control_panel`) that holds all dropdown source lists, category maps, and validation parameters.
2. Use vertical one-value-per-row lists for dropdown sources (not comma-separated in a single cell).
3. Do NOT create static dropdown lists inline — always reference the centralized list range.
4. Apply strict range validation: reject values not in the source list.
5. Before replacing validation rules, clear stale validation from the target range first. Verify no validation remains on wrong columns after the change.
6. For category/subcategory maps, maintain a portable formula-driven mismatch check: `=COUNTIFS(categories_range, category_value, subcategories_range, subcategory_value)=0`.
7. No Apps Script dependency. No dependent dropdowns (cascading) in portable mode — use separate columns with independent validations instead.
8. Validation rules may be materialized per cell. Clear target range first. Apply one logical range rule. Verify representative cells rather than trusting expanded counts. Use compact vertical source lists.

### Validation Portability Rule

Every validation list source range MUST be:
- **Vertical** (one value per row)
- **Contiguous** with no blank padding rows
- **Exact** `A2:A{last_populated_row}` — never `A:A`, `A2:A`, or `A2:A1000`-style padding
- Insert new entries **within** the referenced block (not at the end beyond the range)
- If extending at the bottom beyond the current range, **manually update** the validation range in every target application
- After any validation source change, recheck cross-platform XLSX/ODS round-trip

## E) Structural Edits

1. When deleting columns or sheets, physically delete them — never just clear contents.
2. Map columns by header name, not position, before deletion.
3. Delete columns right-to-left (highest column index first) to avoid index shifts.
4. Before deletion, scan all formulas, validations, and conditional formatting rules in the affected area for references to the to-be-deleted columns.
5. After deletion, migrate any remaining references that pointed to deleted columns.
6. Verify no `#REF!` errors and no stale sheet references remain.
7. Do not claim deletion was successful from an empty-looking range — verify the column count decreased.
8. For column moves: snapshot headers, formulas, validations, and conditional formatting. Map by headers. Delete/insert right-to-left. Scan for `#REF!` and stale references after each move.

## F) Imports and Merges

1. Stage imported data in a staging sheet first — never write directly into the target sheet.
2. Preserve provenance: record source row, source tab, and import date for every row.
3. Deduplicate by a stable key (not by row number).
4. Include an audit trail: date of import, sign (operator identity), and source file name.
5. Do not treat derived summary rows as events — only raw source rows are events.
6. Merge only after row counts pass and manual review of the staging sheet.
7. Preserve source workbooks — do not delete or modify imported files.

## G) Formatting Contract

### Color theme — all text black, light fills only

| Group | Tab/Header Accent | Cell Fill | Text Color |
|---|---|---|---|
| `input_` / canonical input sheets | Light blue (`#cfe2f3` / `#d9eaf7`) | Light blue (`#cfe2f3`) | Black (`#000000`) |
| `ref_` / `system` / backend / reference sheets | Light gray (`#d9d9d9` / `#e0e0e0`) | Light gray (`#f3f3f3`) | Black (`#000000`) |
| `view_` / dashboard / view sheets | Light green (`#d9ead3` / `#e2f0d9`) | Light green (`#d9ead3`) | Black (`#000000`) |

### Reserved canonical sheet names (document group instead of renaming)
`events`, `system`, `control_panel`, `fx_rates`, `parties`, `accounts`, `assets`, `amounts_owed`, `recurring_events`, `relationships`.
These belong to documented groups — do not rename them without migration.

### Header rows
- Wrapped text, compact height (max ~3 lines).
- Fixed readable row height (not auto-height).
- Bold font on header row.

### Data rows
- Uniform row height.
- No merged cells in data zones.

### Column widths
- Autofit, then cap at a reasonable maximum (e.g. 300px / 40 characters for text columns).
- Manual override for known wide columns (notes, descriptions).

### Alignment
- Text: left aligned.
- Dates: center or right aligned.
- Numbers: right aligned.

### Number formats
- Dates: `yyyy-mm-dd`.
- Money: `#,##0.00` (or explicit currency format where appropriate).
- Percentages: `0.00%` or `0` (whole number).
- Apply consistently across all sheets of the same type.

### Application order
- Apply broad formatting first, accents after. Use non-overlapping ranges. Verify representative cells.
- Document conditional-format limitations; do not claim support for unsupported conditional-format features.

## H) Protection / Portability

1. Protected ranges are a Google Sheets feature and may not be portable to Nextcloud / LibreOffice. Do not rely on protection for data correctness.
2. Use validations, formulas, and a legend sheet to enforce constraints instead.
3. Views should be locked (protected) when requested, but document the manual UI fallback if the API lacks protected-range mutation.
4. For portable workbooks, document protection status in a `README` or `legend` sheet.
5. Never claim unsupported protection, chart, combo, or metadata operations succeeded. Provide manual UI fallback instructions.

## I) Verification Checklist

After any operation, verify:
- [ ] Row counts match expectations (before vs after).
- [ ] Key IDs are present and unique where expected.
- [ ] Formulas evaluate correctly (no `#REF!`, `#VALUE!`, `#N/A` errors).
- [ ] Data validations are present on the correct columns and absent from unrelated columns.
- [ ] No stale references to deleted sheets or columns.
- [ ] Source workbooks are preserved (for imports).
- [ ] The exact changed range matches what was intended.
- [ ] Residual limitations are documented.
- [ ] Delegated task failures: empty/aborted reports are incomplete. Retry narrowly or use independent review. Never report completion from an unverified agent claim.

## J) Performance

1. Use bounded ranges — never `A:Z` or `A:A` whole-column references.
2. Avoid volatile functions (`INDIRECT`, `OFFSET`, `TODAY`, `NOW`, `RAND`) at scale.
3. Prefer simple portable formulas: `SUMIFS`, `INDEX`/`MATCH`, `XLOOKUP`, `FILTER`.
4. Partition sheets around 50K–100K rows. Archive older data to separate sheets or workbooks.
5. For large batch writes, chunk into manageable batches (e.g. 500 rows per call).

## K) Composio/MCP Safeguards

1. **Rate-limit isolation:** Distinguish Composio/org rate limits from Google Sheets project/user quotas. On HTTP 429 inspect `Retry-After` header and error body. Use truncated exponential backoff. Do not compound retries.
2. **Non-atomic batches:** `COMPOSIO_MULTI_EXECUTE_TOOL` is non-atomic. Inspect top-level and per-item success/error fields. Do not retry an entire batch after partial writes. Retry only failed, idempotent items after checking their current state.
3. **Batch cap:** Chunk multi-execute batches at the documented 50-tool cap. When output may be large, set `sync_response_to_workbench=true` and inspect `remote_file_info` / complete saved output.
4. **Siloed connections:** Platform-created and Connect MCP connections may be siloed. If a user says they connected but no active connection appears, verify the auth path before creating duplicates.
5. **Connection freshness:** Before any write, verify the selected toolkit connection is ACTIVE using `COMPOSIO_MANAGE_CONNECTIONS with action=list`. Treat EXPIRED / Auth refresh required as re-authentication, not a blind retry. After waiting for user auth, re-verify with `action=list` rather than trusting a possibly stale wait status. Reuse cached connection status within the same session; call `action=list` again only after auth, expiry, account change, or connection error.
6. **Stale tool slugs:** Search results can include deprecated/stale tool slugs. Cross-check current tool descriptions/docs and prefer current alternatives instead of hardcoding an exhaustive deprecated list.
7. **Schema instability:** Meta-tool parameter/response shapes are not guaranteed backward-compatible. Refresh schemas within the current session and after mismatches. Retrieve schemas only for selected tools that will actually be called.
8. **Google Super overlap:** If Google Super and GOOGLESHEETS both exist, check whether the unified Google connection covers the operation before creating a duplicate.
9. **Session pivot:** On a task/use-case pivot, generate a new Composio session and retry search with `search_strategy: "tool_search"` if the returned plan is stale/irrelevant. Do not reuse a prior session_id across pivots.
10. **End-to-end workflow per delegation:** Perform one complete external-app workflow per Composio agent delegation: search → select → schema → connect → execute → verify → report. Return a compact verified summary, not raw discovery output. Preserve `session_id` only when the parent may continue the same workflow.
11. **Batch independent operations:** Use `COMPOSIO_MULTI_EXECUTE_TOOL` to batch independent operations (e.g. multiple reads, multiple writes to non-overlapping ranges). Use workbench/remote bash only for large output or server-side processing — not as an automatic step.

## L) Stop Conditions (Error/Recovery Checklist)

Stop and report — do not guess — when any of these hold:
- [ ] Spreadsheet ID is missing, empty, or unresolved.
- [ ] Multiple files match the search and MIME type / owner does not disambiguate.
- [ ] Toolkit connection is missing, EXPIRED, or not ACTIVE.
- [ ] Tool schemas are stale or from a prior session; re-fetch before proceeding.
- [ ] Validation range does not match the target column or contains wrong data.
- [ ] A multi-execute batch returned partial errors and item-level success/error was not inspected.
- [ ] The operation requires protection, chart, combo, or metadata mutation that the API does not support.
- [ ] A write response was 200 but readback shows incorrect values.
- [ ] Any result (read, structural, validation) was not independently verified — API success ≠ ground truth.
- [ ] A delegated agent returned an empty or aborted report without independent verification.
- [ ] Quota/429 errors persist after truncated exponential backoff.
- [ ] Supplied `COMPOSIO_CONTEXT_V1` is missing, malformed, or references a different task/target.
- [ ] Task pivot detected without a new Composio session.
- [ ] Tool schema mismatch or stale schema detected mid-workflow.
- [ ] Target spreadsheet identity is ambiguous (multiple matches, wrong MIME type).
- [ ] Auth error or connection EXPIRED mid-workflow — re-authenticate, do not retry blindly.
- [ ] Verification step failed or was skipped — do not report completion.

## M) Session Context and Compact Handoffs

### M1) COMPOSIO_CONTEXT_V1 Contract

When passing context between parent and Composio agent (or between successive Composio delegations), use a compact JSON object with **only** these fields:

```jsonc
{
  "protocol": "COMPOSIO_CONTEXT_V1",
  "session_id": "optional-session-id-from-prior-search",  // include only if parent may continue same workflow
  "connection": {
    "status": "ACTIVE",                                    // display-safe status only
    "toolkit": "GOOGLESHEETS"                              // active toolkit name
  },
  "target": {
    "spreadsheet_id": "1abc...",                           // resolved spreadsheet ID
    "sheet_ids": [0],                                      // numeric sheet IDs
    "ranges": ["Sheet1!A1:Z100"]                           // active ranges
  },
  "tools": [
    {
      "slug": "googlesheets_get_values",                   // selected tool slug
      "required_fields": ["spreadsheet_id", "range"],      // non-obvious required fields
      "schema_version": "cached-schema-hash"               // optional: track schema freshness
    }
  ],
  "work_done": [
    "Read Sheet1 headers and dimensions",
    "Verified connection ACTIVE"
  ],
  "next_action": "Write formula values to Sheet1!C2:C10",
  "invalidation_reason": null                              // set when context should not be reused
}
```

**Rules:**
- Exclude tokens, raw API responses, irrelevant tools, and full unused schemas.
- Set `session_id` only when the parent may continue the same workflow (same search plan, same target).
- Set `invalidation_reason` to a string (e.g. `"task pivot"`, `"stale schema"`, `"connection expired"`) when the context must not be reused.
- Never hardcode workbook IDs, credentials, or user-specific values in skill text — they belong in the runtime handoff only.

### M2) Handoff Protocol

1. Parent passes `COMPOSIO_CONTEXT_V1` to Composio agent verbatim when continuing a workflow.
2. Composio agent validates the context: checks `session_id` freshness, `connection.status`, `target` consistency, and tool schema freshness.
3. If context is valid and sufficient, Composio agent skips discovery and proceeds directly to execution.
4. If context is stale, missing, or invalid, Composio agent starts a fresh session (search → select → connect).
5. Composio agent returns a compact verified summary plus an updated `COMPOSIO_CONTEXT_V1` reflecting work done and next action.
6. Parent stores the returned context for potential follow-up; does not re-parse raw tool output.

### M3) Delegation Pattern

- **One complete end-to-end workflow per delegation:** search → select → schema → connect → execute → verify → compact report.
- Do not split a single workflow across multiple Composio agent invocations (e.g. search in one call, schema in another, execute in a third).
- Preserve `session_id` across delegations only when the parent explicitly continues the same workflow.
- Return: compact verified summary + updated `COMPOSIO_CONTEXT_V1`. Never return raw discovery output or "return ALL information."

## N) References

- https://docs.composio.dev/reference/rate-limits
- https://developers.google.com/workspace/sheets/api/limits
- https://docs.composio.dev/toolkits/meta-tools
- https://docs.composio.dev/toolkits/meta-tools/multi_execute_tool.md
- https://docs.composio.dev/toolkits/meta-tools/search_tools
- https://docs.composio.dev/docs/auth-configuration/connected-accounts
- https://docs.composio.dev/reference/errors
- https://docs.composio.dev/kb/guide/toolkits-googlesheets
- https://docs.composio.dev/kb/guide/toolkits-googlesuper