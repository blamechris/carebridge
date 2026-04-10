# Family & Caregiver Access — Proxy Authorization Policy

**STATUS: DRAFT — NOT APPROVED**
**Requires privacy officer and legal counsel sign-off before any proxy code is implemented.**

---

## 1. Purpose

This policy governs clinician-assisted proxy access, where a clinician initiates family caregiver access on behalf of a patient who cannot self-initiate. The patient-initiated path (where the patient invites a family member directly from the patient portal) is already implemented and does not require this policy because the patient is their own consenting adult.

## 2. Scope

This policy applies only to proxy grants initiated by a clinician. It does NOT apply to:
- Patient-initiated invitations (already live)
- Clinical care team access (governed by existing `careTeamAssignments` RBAC)
- Emergency "break-the-glass" access (out of scope)

## 3. Proxy Types

The following proxy types are recognized. Each maps to a distinct legal framework:

| Proxy Type | Legal Basis | Documentation Required |
|---|---|---|
| `incapacitated_adult` | State incapacity statutes; healthcare surrogate laws | Clinical assessment of incapacity; attempt to identify designated surrogate |
| `minor_parent` | Parental consent for minors under state law | Verification of legal parent/guardian status |
| `healthcare_poa` | Healthcare Power of Attorney document | Copy of executed POA on file; verification POA is activated (patient lacks capacity per POA terms) |
| `court_appointed_guardian` | Court order of guardianship | Copy of court order on file; verification of scope (may be limited guardianship) |

### 3.1 Incapacitated Adults

- Clinician must document clinical assessment of incapacity (e.g., "patient sedated in ICU", "patient under general anesthesia", "patient with advanced dementia — unable to provide informed consent")
- Surrogate hierarchy follows state law (typically: healthcare POA > spouse > adult child > parent > sibling)
- If the patient later regains capacity, they can revoke or modify the grant from the patient portal

### 3.2 Minors

- Only a legal parent or court-appointed guardian may receive proxy access
- Age of medical majority varies by state (typically 18; some exceptions for emancipated minors)
- Certain categories of minor care may be protected from parental access under state law (e.g., reproductive health, substance abuse treatment, mental health)
- The system must NOT expose protected encounter types to proxy grantees for minors — this requires a scope filter by encounter category

### 3.3 Healthcare Power of Attorney

- Activation requires clinical determination that the patient lacks decision-making capacity
- The POA document must be on file in the EHR (or uploaded during the proxy flow)
- POA scope may be limited — the system must record the scope and enforce it

### 3.4 Court-Appointed Guardianship

- Guardianship may be limited in scope — the court order must be reviewed
- Guardianship may have an expiration date — the system must enforce it
- Guardianship does not survive the patient's death in most jurisdictions

## 4. Dual Clinician Sign-Off

All clinician-initiated proxy grants require approval from two independent clinicians:

1. **Initiating clinician**: Must have an `attending` or `primary` role on the patient's care team
2. **Approving clinician**: Must also have an `attending` or `primary` role on the care team, and must NOT be the same person as the initiator

The approving clinician has 24 hours to approve. If approval is not received within 24 hours:
- The grant auto-expires
- The initiating clinician is notified
- An audit entry is created with `status: expired_no_cosign`

## 5. Privacy Officer Review

Every clinician-initiated proxy grant is flagged for privacy officer review:
- A row is created in the `privacy_review_queue` table at grant time
- The privacy officer reviews the grant within 72 hours (configurable)
- Review outcomes: `approved`, `revoked`, `escalated`
- If revoked, the family relationship is immediately terminated and the family user is notified

## 6. Access Scope & TTL

- Proxy grants have a configurable TTL (default: 30 days, renewable by the initiating clinician)
- A scheduled job checks for expired proxy grants daily and revokes them
- Scopes are the same as patient-initiated grants: `view_summary`, `view_appointments`, `submit_checkins`, `view_checkins_history`, `view_flags`
- The privacy officer can further restrict scopes during review

## 7. Audit Trail

Every proxy-related action is logged to `audit_log` with:
- `actor_relationship`: the relationship of the actor to the patient
- `on_behalf_of_patient_id`: the patient the action is taken for
- `details.proxy_type`: the proxy type
- `details.proxy_justification`: the free-text justification from the initiating clinician
- `details.cosign_clinician_id`: the approving clinician's user ID

## 8. Revocation

Proxy access can be revoked by:
- The patient (if they regain capacity)
- Any attending clinician on the care team
- The privacy officer
- The system (on TTL expiration or failed dual sign-off)

Revocation is immediate and logged.

## 9. Required Schema (NOT YET IMPLEMENTED)

The following tables will be created once this policy is approved:
- `proxy_grants` — tracks the proxy justification, type, dual sign-off state, and TTL
- `privacy_review_queue` — tracks privacy officer reviews of proxy grants

## 10. Sign-Off

| Role | Name | Date | Signature |
|---|---|---|---|
| Privacy Officer | _________________ | ___/___/______ | _________________ |
| Legal Counsel | _________________ | ___/___/______ | _________________ |
| CISO | _________________ | ___/___/______ | _________________ |
| CMO | _________________ | ___/___/______ | _________________ |
