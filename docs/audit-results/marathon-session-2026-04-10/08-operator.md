# Operator Audit: UX, Accessibility, and Clinical Usability

**Auditor:** Operator
**Date:** 2026-04-10
**Scope:** 8 frontend pages across Patient Portal and Clinician Portal

---

## Page-by-Page Ratings

### Patient Portal

| Page | Rating | Notes |
|------|--------|-------|
| Labs (`apps/patient-portal/app/labs/page.tsx`) | 4/5 | Clear table layout, good flag colorization, proper loading/error/empty states. Missing sort/filter. |
| Notes (`apps/patient-portal/app/notes/page.tsx`) | 4/5 | Good Open Notes compliance (21st Century Cures Act reference). Expand/collapse works well. No search. |
| Symptoms (`apps/patient-portal/app/symptoms/page.tsx`) | 4/5 | Best-designed form in the set. Dual severity (slider + categorical) is clinically smart. Good feedback on submit. |
| Messages (`apps/patient-portal/app/messages/page.tsx`) | 3/5 | Functional but cramped mobile experience. Compose flow works. No unread indicators, no message search. |
| Refill (`apps/patient-portal/app/refill/page.tsx`) | 3/5 | Works for simple cases but note field placement is odd (below all meds, not per-med). No error handling on failed refill request. |
| Health Summary (`apps/patient-portal/app/health-summary/page.tsx`) | 4/5 | Clean three-section layout. Resolved diagnoses tucked behind `<details>` is a nice touch. Care team shows provider_id not name. |

### Clinician Portal

| Page | Rating | Notes |
|------|--------|-------|
| Messages (`apps/clinician-portal/app/messages/page.tsx`) | 4/5 | Split-pane layout is appropriate for desktop clinician workflow. Uses CSS variables (design-system aligned). No compose button for clinicians. |
| Schedule (`apps/clinician-portal/app/schedule/page.tsx`) | 2/5 | Static placeholder data only. No real integration. Date nav works but slots are hardcoded. Explicitly says "pending integration." |

---

## Top 5 UX Issues That Would Frustrate Real Users

### 1. Refill page has no error feedback on failure
**File:** `apps/patient-portal/app/refill/page.tsx:68-96`

The `handleRequestRefill` function has a try/finally but no catch that displays an error to the user. If the mutation fails (network error, server error), the button just returns to its resting state with no feedback. For a medication refill -- a clinically important action -- silent failure is unacceptable.

### 2. Patient record lookup falls back to first patient in list
**File:** `apps/patient-portal/app/labs/page.tsx:26-28` (same pattern in all patient-portal pages)

```typescript
const myRecord = patientsQuery.data?.find(
  (p) => p.name === user?.name,
) ?? patientsQuery.data?.[0];
```

If name matching fails (e.g., user's display name differs slightly from patient record), the page silently shows **another patient's data**. This is a PHI exposure risk and a data integrity failure. The fallback to `[0]` should never happen in a healthcare context.

### 3. Care team shows provider_id, not provider name
**File:** `apps/patient-portal/app/messages/page.tsx:159`

In the compose recipient dropdown:
```typescript
{member.role} — {member.specialty ?? "General"}
```

The dropdown shows role and specialty but NOT the provider's name. A patient with multiple specialists of the same type cannot distinguish between them. This makes the messaging compose flow unreliable.

### 4. Schedule page is non-functional placeholder
**File:** `apps/clinician-portal/app/schedule/page.tsx:48-57`

All appointment slots are hardcoded. A clinician navigating here in production would see fabricated data with a tiny footnote at line 159 saying "Schedule integration pending." This page should not have shipped or should show a clear "coming soon" state rather than fake data that looks real.

### 5. No keyboard focus management in accordion/expand patterns
**File:** `apps/patient-portal/app/notes/page.tsx:81-104`

The notes expand/collapse buttons work on click but have no `aria-expanded`, no `aria-controls`, and no focus ring styling. Screen reader users cannot determine which note is expanded. Same issue on messages page conversation toggles.

---

## Error, Loading, and Empty State Coverage

| Page | Loading | Error | Empty |
|------|---------|-------|-------|
| Labs | Yes (line 62) | Yes (line 65) | Yes (line 69) |
| Notes | Yes (line 59) | Yes (line 60) | Yes (line 62) |
| Symptoms | No explicit loading for form submission (uses `isPending` on button) | No mutation error display | Yes (line 241) |
| Messages (Patient) | Yes (line 207) | No error state for conversation loading | Yes (line 209) |
| Messages (Clinician) | Yes (line 73) | No error state | Yes (line 77) |
| Refill | Yes (line 116) | **No** -- silent failure on mutation error | Yes (line 118) |
| Health Summary | Yes (per-section) | No error states for any of three queries | Yes (per-section) |
| Schedule | N/A (static) | N/A | Yes (line 151) |

**Verdict:** Loading and empty states are consistently handled. Error states are inconsistently handled -- only labs and notes show query error messages. Mutation errors (messages send, refill request, symptom submit) are universally unhandled in the UI.

---

## Accessibility Concerns

1. **No ARIA attributes on interactive expand/collapse patterns.** The notes page (`notes/page.tsx:81`) and messages page use buttons for toggling content but lack `aria-expanded`, `aria-controls`, and `role` attributes. Screen readers cannot convey state.

2. **Color-only status indicators.** Lab flags (`labs/page.tsx:7-14`), diagnosis status (`health-summary/page.tsx:17-22`), and severity badges rely solely on color to convey meaning. Users with color vision deficiency cannot distinguish critical from high flags without the text label. The flags do include text labels, which partially mitigates this, but the table cell values at line 119 use color as the only differentiator for flagged vs normal values.

3. **No visible focus indicators.** All buttons use inline styles without `:focus-visible` handling. Keyboard-only users cannot see which element is focused. The clinician portal uses className-based buttons (`btn btn-primary`) which may inherit focus styles from a CSS file, but patient portal buttons (all inline-styled) definitively do not.

4. **Range slider has no aria-label.** The severity slider (`symptoms/page.tsx:154-160`) has no `aria-label` or `aria-valuetext`. Screen readers will announce it as an unlabeled slider.

5. **Form labels are not associated via `htmlFor`/`id`.** All `<label>` elements across all pages use visual proximity rather than `htmlFor` attributes to associate with inputs. This breaks screen reader form navigation.

---

## Data Integrity: Clinical Event Emission

**Patient observations ARE correctly emitted.** The `services/patient-records/src/router.ts:128-138` shows proper BullMQ event emission on observation creation:
- Event type: `patient.observation`
- Contains observation_id and type (not PHI -- good)
- Respects encryption boundary (description not in payload)

**Refill requests do NOT emit clinical events.** The refill page creates a messaging conversation and sends a message, but there is no dedicated `patient.refill_request` event emitted to the clinical-events queue. The AI oversight engine will not screen refill requests for drug interaction checks or appropriateness review. This is a gap -- refills bypass the safety net.

**Messages do emit events.** The messaging service router emits to the clinical-events queue (confirmed in `services/messaging/src/router.ts`).

---

## Overall Rating: 3.4 / 5

**Summary:** The pages are functional and demonstrate competent implementation of a healthcare portal MVP. Loading and empty states are handled consistently, and the visual design is clean with a cohesive dark theme. However, the audit reveals concerning gaps for a healthcare application: (1) silent mutation failures with no user feedback on clinically important actions, (2) the fallback-to-first-patient pattern is a potential PHI leak, (3) accessibility is below WCAG 2.1 AA compliance -- no ARIA states, no programmatic label associations, no focus management, (4) refill requests bypass the AI oversight safety net entirely, and (5) the schedule page ships placeholder data that could mislead clinicians. For a platform replacing Epic MyChart, these issues would block production deployment and require remediation before real patient use.
