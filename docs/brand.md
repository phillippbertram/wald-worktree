# wald brand identity

This document is the canonical source for wald's name, message, visual language, and product voice.
Technical behavior remains owned by the implementation and the corresponding reference docs.

## Core identity

- **Name:** wald
- **CLI:** `wald`
- **Repository and package:** `wald-worktree`
- **Primary line:** **wald — Where Git worktrees grow.**
- **Product promise:** **Git worktrees, ready for real work.**
- **Supporting line:** **Parallel work, naturally.**

Write the product name as **wald**, including in headings and at the start of a sentence. The name
comes from the German word *Wald* (/valt/), meaning “forest”. Several worktrees share one repository.

## The analogy

The repository is the shared ground. Its Git history connects the workspace below the surface. Each
worktree is a separate tree with its own files, dependencies, editor, and running processes. Put
them together and you have a forest: several working folders connected to one repository.

Use the analogy to make worktrees approachable, not to replace Git terminology. Commands remain
technical and predictable: `create`, `handoff`, `status`, `doctor`, `remove`, and `prune`. `plant` is
the one playful alias, and it maps directly to `create`. Keep destructive commands technical;
removing a worktree should never be disguised as forest wordplay.

The recommended flat standalone layout is **Wald Flow**. It describes the physical arrangement of a
workspace, not a branching, merging, or release strategy.

## Voice and tone

wald should sound:

- calm and confident about safety;
- practical before playful;
- concise in the terminal and explanatory in guides;
- welcoming to people who are new to worktrees;
- precise about Git state, paths, trust, and destructive actions.

Forest language belongs in the welcome screen, product introduction, section headings, and small
moments of delight. Errors, confirmations, JSON, and safety guidance use direct technical language.
Avoid mystical or extended metaphors and jokes that obscure behavior.

Start with the situation the reader recognizes, then say what wald does. “wald checks for local
changes before removing a worktree” is better than “wald provides a safe and predictable lifecycle.”
Prefer concrete verbs and nouns over strings of reassuring adjectives.

Do not stack several slogans, pad a paragraph with generic benefits, or force every explanation into
a symmetrical list. Sentence length and rhythm may vary. Address the reader directly where that
makes an instruction easier to follow, but do not invent a personal origin story or speak for the
maintainer without a real quote.

## Color palette

| Token | Hex | Use |
| --- | --- | --- |
| Forest | `#1F4D3A` | Primary identity, headings, mature trees |
| Moss | `#5F7D4E` | Supporting foliage and secondary accents |
| Sprout | `#8EBE67` | Fresh growth and small highlights |
| Bark | `#6B4F3A` | Trunks, roots, and warm grounding details |
| Mist | `#F3F6F1` | Quiet light backgrounds |

Terminal output uses the closest existing `picocolors` values rather than adding exact-color ANSI
sequences. Color is decorative and must never be the only carrier of status or meaning.

## Emoji rules

- Use `🌲` and `🌳` for the wald identity and welcome screen.
- Use `🌱` sparingly for setup, first steps, or successful new growth.
- Keep conventional status symbols such as success, warning, error, and information markers where
  they improve scanning.
- Do not decorate every command, log line, table cell, or JSON field.
- Never put emoji into machine-readable output, identifiers, paths, or environment variables.

## Illustration

The primary editorial illustration is [`assets/wald-worktrees.png`](assets/wald-worktrees.png), with
the alt text “Independent Git worktrees growing from one shared repository.” It shows several
different trees above a visibly connected root network on a light Mist background.

Future imagery should use the Forest, Moss, Sprout, Bark, and Mist palette. Keep it calm, editorial,
and free of text, decorative symbols, people, and third-party logos.

## Public naming

| Area | Name |
| --- | --- |
| Product | wald |
| Command | `wald` |
| Repository and npm package | `wald-worktree` |
| Workspace metadata | `.wald/` |
| Repository configuration | `.wald.yml` |
| Adopted Git metadata | `<git-common-dir>/wald/` |
| Automation variables | `WALD_*` |
| Agent skill | `wald-worktrees` |

wald is a clean namespace. Do not add aliases or automatic discovery for metadata created under
earlier product names. Existing repositories should be initialized or adopted through the normal,
preview-first `wald init` flow.
