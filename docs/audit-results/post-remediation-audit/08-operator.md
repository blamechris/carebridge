# Operator's Audit: CareBridge Post-Remediation

**Agent**: Operator — Clinician UX expert; daily workflow, error states, accessibility
**Overall Rating**: 3.2 / 5
**Date**: 2026-04-06

---

## Section Ratings

| Area | Rating | Notes |
|---|---|---|
| Login/MFA Flow | 4/5 | Clear two-step auth; no lockout indicator |
| Clinical Flag Display | 3/5 | Color-coded severity; no confirmation on dismiss |
| Patient Record Navigation | 3.5/5 | Clean tabs; no vitals trending |
| Error States | 3/5 | Session expiry handled; no retry mechanism; no "extend session" |
| Accessibility | 2/5 | No ARIA labels; no keyboard nav; color-only warnings |
| Patient Safety in UI | 2.5/5 | No confirmation on irreversible actions; no audit trail |
| Loading States | 3.5/5 | Loading text shown; no skeleton screens |
| Mobile Responsiveness | 1.5/5 | No @media queries; fixed sidebar; unusable on tablet |
| Missing Features | 2/5 | Notes, scheduling, messaging not built |
| Patient Portal | 2/5 | Basic dashboard; MFA breaks patient access |

---

## Top 5 Findings

### Finding 1 — No Confirmation on Flag Acknowledge/Dismiss
**File:** `apps/clinician-portal/app/patients/[id]/page.tsx:394-395`
Single click dismisses critical clinical alerts. No confirmation dialog, no reason capture.

### Finding 2 — No Mobile/Tablet Responsiveness
**File:** `apps/clinician-portal/app/globals.css`
Zero @media queries. Fixed 240px sidebar. Unusable on iPad at bedside.

### Finding 3 — Missing ARIA Labels and Semantic HTML
Only 1 alt text in entire portal. Alert banners missing role="alert". Fails WCAG 2.1 AA.

### Finding 4 — Flag Actions Not Persisted / No Audit Trail
**File:** `apps/clinician-portal/app/inbox/page.tsx`
Flag acknowledgments are client-only. No database persistence. No audit trail.

### Finding 5 — Patient Portal MFA Breaks Access
**File:** `apps/patient-portal/app/login/page.tsx:24-26`
MFA-enabled patients get error message redirecting to clinician portal.
