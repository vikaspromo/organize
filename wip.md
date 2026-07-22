# Organize Corpus — Work in Progress

## Status
Organized 940 emails tagged with `!organize` label (last 3 years).

**Current state:**
- P1 (urgent): 3 items (email update, DMV renewal, health insurance)
- P2 (research/interests): ~160 items across categories
  - X/Twitter posts: 119
  - Claude/AI resources: 8
  - Local DC events/spots: 18
  - Dev/website notes: 9
  - Kids activities: 8
  - Home/garden: 6
  - Recipes: 12
  - Furniture research: 3
  - Restaurants: 2
  - General articles: 65
- Warm archive (uncertain): ~308 random notes/captures
- Explicitly archived: Stale shopping, expired tickets, tax/calendar, investment tracking

## Next steps for future session

**Warm archive decision:** The 308 "other" items (random notes, unclear captures) are currently unclassified. Next session should:
1. Sample more of the 308 to understand what's actually in there
2. Decide: keep as P2 research, move to warm archive, or explicitly archive
3. Finalize the P2 list

**Then:** Update INBOX-FINAL.md to show the full picture with three tiers:
- P1: Urgent/time-sensitive
- P2: Research/interests (with organized subcategories)
- Archive: Explicitly removed (stale, completed, noise)
- Warm Archive: Uncertain (the 308 items + anything else in the middle zone)

## How to use the corpus

```bash
# View the current inbox state
cat INBOX-FINAL.md

# If you add new emails tagged !organize:
node corpus/sync-corpus.mjs
node corpus/parse-corpus.mjs

# To revisit and re-triage warm archive items
node corpus/todos-cleaned.json  # has all 101 active items with metadata
```

## Key insights
- Value ≠ urgency. P2 is a personal library, not obligations.
- Most of the inbox was reference material, not actionable items.
- The 308 "warm archive" items are the main unresolved question.
