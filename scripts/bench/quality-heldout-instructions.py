#!/usr/bin/env python3
"""Render the frozen blind X/Y reviewer instructions for one packet directory.

The template is the round-4 artifact verbatim; only the packet root, submission
directory, available-pair count and question-file list vary. It reads only the
public reviewer tree (availability.json), never private/ or the tool pair.
"""
import argparse
import json
from pathlib import Path
from string import Template

TEMPLATE = Template('''# Blind X/Y readability review instructions

## Safety and access boundary
Read ONLY the reviewer packet tree below and this instruction artifact. Do not inspect repository source, original comparison results, source gold, build manifests, private directories, or tool mappings. Do not execute any code or analyzed input. Do not edit pseudocode. The packet root intentionally has no tool identities; X/Y assignment varies per case. Do not guess or name tools. Output style may permit inference, so disclose possible style unblinding without identifying a tool.

## Scope
This is explicitly **LLM readability review, not a human study and not a correctness/equivalence assessment**. Each reviewer independently reviews ALL $count complete available pairs listed below. No favorable-case sampling or dropped packets. Missing pairs remain separately recorded in availability.json and receive no invented readability scores. Source-oracle correctness, availability and performance are separate lanes. Text byte counts are diagnostic only and MUST NOT determine a score or preference.

## Method
1. Read rubric.json once. The six dimensions and 0..4 anchors are frozen.
2. For each question.json, read its X.c and Y.c verbatim. Do not read sibling private data.
3. Answer the same question independently for each side using only that text, including visible boundary/unknown limitations.
4. Score each side independently on all six dimensions with a short quotation or line evidence and concise rationale. Higher means more readable/less clutter under the supplied anchors, not proven correct.
5. Give an X/Y/tie/neither overall readability preference with rationale and confidence; no numerical text-length proxy.
6. Submit all $count case records together in one JSON artifact. No provisional mapping lookup. Mapping stays sealed until BOTH reviewers have submitted immutable results.

## Output contract
Coordinator assigns reviewer id A or B. Write $submissions/review-A.json or $submissions/review-B.json respectively. Only write the assigned output artifact. Use this schema:

```json
{
  "reviewer_id": "A or B",
  "method": "blinded_llm_readability_not_human_study",
  "packet_root": "$reviewer",
  "limitations": ["No source oracle or tool identities supplied", "Style can imperfectly unblind labels", "Readability is not correctness"],
  "cases": [{
    "case": "case-NNN",
    "X": {
      "answer": "Answer to the case question, based only on X",
      "scores": {
        "style": {"score": 0, "evidence": "quote/line", "rationale": "..."},
        "algorithm_comprehension": {"score": 0, "evidence": "quote/line", "rationale": "..."},
        "types_interfaces": {"score": 0, "evidence": "quote/line", "rationale": "..."},
        "control_flow": {"score": 0, "evidence": "quote/line", "rationale": "..."},
        "unresolved_semantics": {"score": 0, "evidence": "quote/line", "rationale": "..."},
        "irrelevant_machine_state_clutter": {"score": 0, "evidence": "quote/line", "rationale": "..."}
      }
    },
    "Y": {"answer": "...", "scores": "same six-dimension object as X"},
    "preference": "X or Y or tie or neither",
    "preference_rationale": "...",
    "confidence": 0.0,
    "possible_style_unblinding": false
  }]
}
```

Scores are integers 0..4; confidence is 0..1. Replace explanatory schema strings with real complete objects; do not emit placeholders. Preserve listed case identifiers.

## Packet files
Packet root: `$reviewer`

Rubric: `$reviewer/rubric.json`

Missing-cell register: `$reviewer/availability.json`

The complete $count question files (each names adjacent X.c and Y.c):

''')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--packets', type=Path, required=True, help='quality-heldout-packets.py output directory')
    parser.add_argument('--submissions', type=Path, required=True, help='Directory reviewers write review-A/B.json into')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    reviewer = args.packets.resolve() / 'reviewer'
    cases = [row['case'] for row in json.loads((reviewer / 'availability.json').read_text()) if row['paired_text_available']]
    text = TEMPLATE.substitute(count=len(cases), reviewer=reviewer, submissions=args.submissions.resolve())
    text += ''.join(f'- `{reviewer}/{case}/question.json`\n' for case in sorted(cases))
    if args.output.exists():
        raise SystemExit(f'{args.output} exists; render into a new path')
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(text)
    print(json.dumps({'instructions': str(args.output), 'pairs': len(cases)}))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
