# Synthetic release-train specification

## Core idea

This fixture describes a fictional sequence of software-delivery phases. Its values are deliberately wide, repetitive, and varied so table rendering and keyboard navigation have stable geometry.

A **work item** is one independently tracked change:

- Item 1: research the behavior
- Item 2: implement the change
- Item 3: verify the result
- And so on

A completed pair is therefore **two work items**, not one combined item.

The fixture is intentionally synthetic. It is not a real project plan, policy, specification, or recommendation, and all names and measurements exist only to exercise Markdown structure.

## Fixture rules

For this deterministic document:

- Every phase begins on a new row.
- Each row contains:

  - one phase identifier, and
  - seven right-aligned measurements.

- Numeric cells use different widths.
- Several values contain punctuation.
- The final row contains the widest cumulative values.
- A blank line follows the table.
- The next paragraph remains ordinary prose.
- Table rows must retain their authored source.
- Moving the caret must not change row height.
- Horizontal scrolling must keep the caret visible.
- Upward selection must preserve its original anchor.
- Word and line navigation must stop at semantic cell boundaries.

These rules make the file useful for exercising both rendered and Raw Markdown behavior without depending on a user's documents.

## Phases

A phase is a fictional group of work performed at one planning rate. The rate increases in later rows only to make the values distinct.

The fixture organizes the sequence as follows:

```text
Phase 1:  items 1–7
Phase 2:  items 8–15
Phase 3:  items 16–23
...
Phase 15: items 143–155
```

The final row therefore reaches 155 synthetic items and 3,100 synthetic units.

## Derived values

The table uses calculated values so decimals, colons, thousands separators, and units all appear in the same rendered surface.

For this fixture, the fictional planning rate is:

- Phase 1: **8.0 units/hour**
- Phase 2: **9.0 units/hour**
- Every later phase: increase by **0.5 units/hour**

For any phase:

```text
ratePerSecond = ratePerHour / 3.6

secondsPerItem
    = 20 / ratePerSecond
    = 72 / ratePerHour
```

For example:

```text
Phase 1:
72 / 8.0 = 9.000 seconds per item

Phase 2:
72 / 9.0 = 8.000 seconds per item

Phase 10:
72 / 13.0 = 5.538461538... seconds per item
```

The figures below are fixture data, chosen to cover wide rows, aligned columns, decimal values, clock-like text, and cumulative units. They have no meaning outside the tests.

| Phase | Items in phase | Cumulative item | Rate / hour | Seconds per item | Phase duration | Cumulative time | Cumulative units |
| ----: | -------------: | --------------: | ----------: | ---------------: | -------------: | --------------: | ---------------: |
|     1 |              7 |               7 |         8.0 |            9.000 |       63.000 s |            1:03 |        140 units |
|     2 |              8 |              15 |         9.0 |            8.000 |       64.000 s |            2:07 |        300 units |
|     3 |              8 |              23 |         9.5 |            7.579 |       60.632 s |            3:08 |        460 units |
|     4 |              9 |              32 |        10.0 |            7.200 |       64.800 s |            4:12 |        640 units |
|     5 |              9 |              41 |        10.5 |            6.857 |       61.714 s |            5:14 |        820 units |
|     6 |              9 |              50 |        11.0 |            6.545 |       58.909 s |            6:13 |      1,000 units |
|     7 |             10 |              60 |        11.5 |            6.261 |       62.609 s |            7:16 |      1,200 units |
|     8 |             10 |              70 |        12.0 |            6.000 |       60.000 s |            8:16 |      1,400 units |
|     9 |             11 |              81 |        12.5 |            5.760 |       63.360 s |            9:19 |      1,620 units |
|    10 |             11 |              92 |        13.0 |            5.538 |       60.923 s |           10:20 |      1,840 units |
|    11 |             12 |             104 |        13.5 |            5.333 |       64.000 s |           11:24 |      2,080 units |
|    12 |             12 |             116 |        14.0 |            5.143 |       61.714 s |           12:26 |      2,320 units |
|    13 |             13 |             129 |        14.5 |            4.966 |       64.552 s |           13:30 |      2,580 units |
|    14 |             13 |             142 |        15.0 |            4.800 |       62.400 s |           14:33 |      2,840 units |
|    15 |             13 |             155 |        15.5 |            4.645 |       60.387 s |           15:33 |      3,100 units |

This synthetic planning table is **intentionally shaped for editor geometry tests rather than operational use**. Its column widths, decimal values, clock-like strings, and row count exercise wrapping, horizontal scrolling, keyboard navigation, and selection boundaries. Keep the fixture structurally stable when changing its wording, and do not replace it with personal, proprietary, or externally sourced material.

## Synthetic navigation tail

The lines below provide stable, nonpersonal traversal content for long-range selection tests.

Synthetic navigation checkpoint 116.
Synthetic navigation checkpoint 117.
Synthetic navigation checkpoint 118.
Synthetic navigation checkpoint 119.
Synthetic navigation checkpoint 120.
Synthetic navigation checkpoint 121.
Synthetic navigation checkpoint 122.
Synthetic navigation checkpoint 123.
Synthetic navigation checkpoint 124.
Synthetic navigation checkpoint 125.
Synthetic navigation checkpoint 126.
Synthetic navigation checkpoint 127.
Synthetic navigation checkpoint 128.
Synthetic navigation checkpoint 129.
Synthetic navigation checkpoint 130.
Synthetic navigation checkpoint 131.
Synthetic navigation checkpoint 132.
Synthetic navigation checkpoint 133.
Synthetic navigation checkpoint 134.
Synthetic navigation checkpoint 135.
Synthetic navigation checkpoint 136.
Synthetic navigation checkpoint 137.
Synthetic navigation checkpoint 138.
Synthetic navigation checkpoint 139.
Synthetic navigation checkpoint 140.
Synthetic navigation checkpoint 141.
Synthetic navigation checkpoint 142.
Synthetic navigation checkpoint 143.
Synthetic navigation checkpoint 144.
Synthetic navigation checkpoint 145.
Synthetic navigation checkpoint 146.
Synthetic navigation checkpoint 147.
Synthetic navigation checkpoint 148.
Synthetic navigation checkpoint 149.
Synthetic navigation checkpoint 150.
Synthetic navigation checkpoint 151.
Synthetic navigation checkpoint 152.
Synthetic navigation checkpoint 153.
Synthetic navigation checkpoint 154.
Synthetic navigation checkpoint 155.
Synthetic navigation checkpoint 156.
Synthetic navigation checkpoint 157.
Synthetic navigation checkpoint 158.
Synthetic navigation checkpoint 159.
Synthetic navigation checkpoint 160.
Synthetic navigation checkpoint 161.
Synthetic navigation checkpoint 162.
Synthetic navigation checkpoint 163.
Synthetic navigation checkpoint 164.
Synthetic navigation checkpoint 165.
Synthetic navigation checkpoint 166.
Synthetic navigation checkpoint 167.
Synthetic navigation checkpoint 168.
Synthetic navigation checkpoint 169.
Synthetic navigation checkpoint 170.
Synthetic navigation checkpoint 171.
Synthetic navigation checkpoint 172.
Synthetic navigation checkpoint 173.
Synthetic navigation checkpoint 174.
Synthetic navigation checkpoint 175.
Synthetic navigation checkpoint 176.
Synthetic navigation checkpoint 177.
Synthetic navigation checkpoint 178.
Synthetic navigation checkpoint 179.
Synthetic navigation checkpoint 180.
Synthetic navigation checkpoint 181.
Synthetic navigation checkpoint 182.
Synthetic navigation checkpoint 183.
Synthetic navigation checkpoint 184.
Synthetic navigation checkpoint 185.
Synthetic navigation checkpoint 186.
Synthetic navigation checkpoint 187.
Synthetic navigation checkpoint 188.
Synthetic navigation checkpoint 189.
Synthetic navigation checkpoint 190.
Synthetic navigation checkpoint 191.
Synthetic navigation checkpoint 192.
Synthetic navigation checkpoint 193.
Synthetic navigation checkpoint 194.
Synthetic navigation checkpoint 195.
Synthetic navigation checkpoint 196.
Synthetic navigation checkpoint 197.
Synthetic navigation checkpoint 198.
Synthetic navigation checkpoint 199.
Synthetic navigation checkpoint 200.
Synthetic navigation checkpoint 201.
Synthetic navigation checkpoint 202.
Synthetic navigation checkpoint 203.
Synthetic navigation checkpoint 204.
Synthetic navigation checkpoint 205.
Synthetic navigation checkpoint 206.
Synthetic navigation checkpoint 207.
Synthetic navigation checkpoint 208.
Synthetic navigation checkpoint 209.
Synthetic navigation checkpoint 210.
Synthetic navigation checkpoint 211.
Synthetic navigation checkpoint 212.
Synthetic navigation checkpoint 213.
Synthetic navigation checkpoint 214.
Synthetic navigation checkpoint 215.
Synthetic navigation checkpoint 216.
Synthetic navigation checkpoint 217.
Synthetic navigation checkpoint 218.
Synthetic navigation checkpoint 219.
Synthetic navigation checkpoint 220.
Synthetic navigation checkpoint 221.
Synthetic navigation checkpoint 222.
Synthetic navigation checkpoint 223.
Synthetic navigation checkpoint 224.
Synthetic navigation checkpoint 225.
Synthetic navigation checkpoint 226.
Synthetic navigation checkpoint 227.
Synthetic navigation checkpoint 228.
Synthetic navigation checkpoint 229.
Synthetic navigation checkpoint 230.
Synthetic navigation checkpoint 231.
Synthetic navigation checkpoint 232.
Synthetic navigation checkpoint 233.
Synthetic navigation checkpoint 234.
Synthetic navigation checkpoint 235.
Synthetic navigation checkpoint 236.
Synthetic navigation checkpoint 237.
Synthetic navigation checkpoint 238.
Synthetic navigation checkpoint 239.
Synthetic navigation checkpoint 240.
Synthetic navigation checkpoint 241.
Synthetic navigation checkpoint 242.
Synthetic navigation checkpoint 243.
Synthetic navigation checkpoint 244.
Synthetic navigation checkpoint 245.
Synthetic navigation checkpoint 246.
Synthetic navigation checkpoint 247.
Synthetic navigation checkpoint 248.
Synthetic navigation checkpoint 249.
Synthetic navigation checkpoint 250.
Synthetic navigation checkpoint 251.
Synthetic navigation checkpoint 252.
Synthetic navigation checkpoint 253.
Synthetic navigation checkpoint 254.
Synthetic navigation checkpoint 255.
Synthetic navigation checkpoint 256.
Synthetic navigation checkpoint 257.
Synthetic navigation checkpoint 258.
Synthetic navigation checkpoint 259.
Synthetic navigation checkpoint 260.
Synthetic navigation checkpoint 261.
Synthetic navigation checkpoint 262.
Synthetic navigation checkpoint 263.
Synthetic navigation checkpoint 264.
Synthetic navigation checkpoint 265.
Synthetic navigation checkpoint 266.
Synthetic navigation checkpoint 267.
Synthetic navigation checkpoint 268.
Synthetic navigation checkpoint 269.
Synthetic navigation checkpoint 270.
Synthetic navigation checkpoint 271.
Synthetic navigation checkpoint 272.
Synthetic navigation checkpoint 273.
Synthetic navigation checkpoint 274.
Synthetic navigation checkpoint 275.
Synthetic navigation checkpoint 276.
Synthetic navigation checkpoint 277.
Synthetic navigation checkpoint 278.
Synthetic navigation checkpoint 279.
Synthetic navigation checkpoint 280.
Synthetic navigation checkpoint 281.
Synthetic navigation checkpoint 282.
Synthetic navigation checkpoint 283.
Synthetic navigation checkpoint 284.
Synthetic navigation checkpoint 285.
Synthetic navigation checkpoint 286.
Synthetic navigation checkpoint 287.
Synthetic navigation checkpoint 288.
Synthetic navigation checkpoint 289.
Synthetic navigation checkpoint 290.
Synthetic navigation checkpoint 291.
Synthetic navigation checkpoint 292.
Synthetic navigation checkpoint 293.
Synthetic navigation checkpoint 294.
Synthetic navigation checkpoint 295.
Synthetic navigation checkpoint 296.
Synthetic navigation checkpoint 297.
