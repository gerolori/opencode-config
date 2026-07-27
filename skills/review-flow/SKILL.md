---
name: review-flow
description: Review diffs and changesets for correctness, regressions, scope control, and verification adequacy.
compatibility: opencode
---
# Review Flow

Use this skill when you need to review a change set, validate a patch, inspect a diff for regressions, or perform a final correctness pass before presenting results.

## Purpose

This skill provides a disciplined review workflow focused on:
- correctness
- scope control
- regressions
- consistency
- verification adequacy

This is a review skill, not an implementation skill.

## When to use

Use this skill when:
- a code change has already been made
- the user asks for a review, audit, or sanity check
- a supervising agent wants an independent review pass
- a patch is risky, broad, or touches multiple files
- you want to confirm that the implementation matches the request

Do not use this skill as the primary workflow for writing new code.

## Core review questions

Always check these first:

1. Does the change actually solve the requested problem?
2. Did it touch unrelated code unnecessarily?
3. Are there obvious regressions in nearby logic, types, imports, or call sites?
4. Is the naming consistent?
5. Was the verification appropriate for the size and risk of the change?
6. Are there edge cases the patch appears to miss?

## Review workflow

### 1. Establish intent
Before judging the patch, restate the intended outcome in one sentence.

If the intended outcome is unclear, infer the narrowest reasonable interpretation from the task and changed files.

### 2. Inspect the diff
Review the actual changed lines first.

Focus on:
- files touched
- amount of churn
- unrelated edits
- partial renames
- dead code left behind
- mismatched interfaces

### 3. Read surrounding context
Do not review the diff in isolation if the change is non-trivial.

Check:
- nearby function definitions
- callers and callees
- related types/interfaces
- imports and exports
- tests or fixtures if present

### 4. Check verification
Look for evidence of:
- targeted tests
- lint/typecheck/build runs
- smoke checks for the touched area

If verification is missing, say so explicitly.

### 5. Form a verdict
Decide whether the patch is:
- good as-is
- correct but under-verified
- mostly correct with concrete issues
- risky / not ready

## Review priorities

Prioritize issues in this order:
1. wrong behavior
2. broken interfaces or regressions
3. scope creep / unnecessary edits
4. missing verification
5. maintainability issues tightly related to the patch

Do not produce generic style feedback unless it materially affects the task.

## Output format

Use this structure:

### Verdict
One-line conclusion.

### Findings
Only concrete issues or meaningful risks.

For each finding, include:
- what is wrong
- where it is
- why it matters

### Verification assessment
State what appears to have been checked and what is still unverified.

### Recommended next step
One short action-oriented conclusion.

## Rules

- Be specific.
- Prefer fewer, sharper findings over a long vague list.
- If the patch looks good, say so plainly.
- Do not invent problems to sound useful.
- Do not rewrite the patch unless asked.
