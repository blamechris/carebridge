# Third-Party Notices — @carebridge/fhir-gateway

This service bundles or links against the following third-party open-source
software. The full license text for each dependency is shipped inside its
package in `node_modules`; this file summarises the obligations and provides
the canonical license URLs.

## @lhncbc/ucum-lhc

Used by `src/generators/ucum.ts` to validate Unified Code for Units of
Measure (UCUM) codes for FHIR `Quantity.code` outputs.

- Package: [`@lhncbc/ucum-lhc`](https://www.npmjs.com/package/@lhncbc/ucum-lhc)
- Upstream repository: <https://github.com/lhncbc/ucum-lhc>
- License file (canonical): <https://github.com/lhncbc/ucum-lhc/blob/master/LICENSE.md>
- License declared in `package.json`: `SEE LICENSE IN LICENSE.md` (NOT MIT)

### Owner notice (required by license)

> This software (including any associated website-service or downloadable
> source/code) was developed by the Lister Hill National Center for
> Biomedical Communications (LHNCBC), a research and development division
> of the U.S. National Library of Medicine (NLM), with the permission and
> based on the copyrighted content of the Regenstrief Institute.

### License terms

The terms and conditions in `LICENSE.md` are **based on the BSD open-source
license** (a custom BSD-derived license, not MIT). Redistribution and use
in source and binary forms — with or without modification, for commercial
and non-commercial purposes — are permitted, provided that:

- Redistributions of source code retain the Owner Notice, the conditions,
  and the disclaimer, and display them prominently.
- Redistributions in binary form prominently reproduce the Owner Notice,
  the conditions, and the disclaimer in the documentation and/or other
  materials provided with the distribution.
- **Non-endorsement clause**: Neither the names of the National Library of
  Medicine (NLM), the Lister Hill National Center for Biomedical
  Communications (LHNCBC), the National Institutes of Health (NIH), nor
  the names of any of the software contributors may be used to endorse or
  promote products derived from this software without specific prior
  written permission.

The software is provided "AS IS" without warranty of any kind. See the
upstream `LICENSE.md` for the full disclaimer.

### Sub-license: UCUM table content

If a redistribution includes all or a portion of the UCUM table, UCUM
codes, or UCUM definitions, that content is additionally subject to a
license from **Regenstrief Institute, Inc.** and **The UCUM Organization**:

- UCUM license: <https://ucum.org/license>
- Current UCUM table and specification: <https://ucum.org>
- Copyright: © 1995–2009, Regenstrief Institute, Inc. and the Unified
  Codes for Units of Measures (UCUM) Organization. All rights reserved.

The `@lhncbc/ucum-lhc` package bundles `data/ucumDefs.min.json`, which is
derived from the UCUM table; consequently this notice applies to the
fhir-gateway distribution.

### Sub-license: LOINC content (conditional)

If LOINC ® content is included, that content is copyright © 1995–2016
Regenstrief Institute, Inc. and the LOINC Committee, and is distributed
under the LOINC terms of use:

- LOINC terms: <https://loinc.org/terms-of-use>

LOINC ® is a registered United States trademark of Regenstrief Institute,
Inc. As of `@lhncbc/ucum-lhc` v7.1.6, the runtime files shipped to the
fhir-gateway are UCUM-only; the LOINC condition is reproduced here for
completeness because the upstream license enumerates it.

### Citation request

> If publishing research that used this software, please include a
> citation that acknowledges it.

## Corrections

A previous internal discussion (issue #978, closed by PR #1138) referred
to `@lhncbc/ucum-lhc` as "MIT-licensed". That characterisation was
incorrect. The package is distributed under the BSD-derived LHNCBC/NLM
license reproduced above, with the UCUM and LOINC sub-licenses noted. This
file supersedes any prior claim in PRs, issue comments, or commit messages.
