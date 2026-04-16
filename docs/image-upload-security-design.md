# Image Upload Security Design

Status: **blocking guardrail**. Any PR that adds image upload to CareBridge
(patient photo, wound image, rash photo, chart scan, insurance-card photo,
ID verification) MUST meet every requirement in this document before it
merges. Treat reviews accordingly — image uploads are one of the
highest-risk PHI surfaces the platform can expose.

This document exists because no image-upload code exists in the codebase
yet. The goal is to ensure the first PR to add one does so defensively;
adding these controls retroactively is consistently harder than adding
them up front.

## Threat model

| Threat | Consequence |
|---|---|
| Unsanitized EXIF / GPS metadata in patient-uploaded images | Patient residence leaked in FHIR export or audit |
| Server-rendered SVG with embedded scripts | Stored XSS against clinicians |
| Malicious upload masquerading as JPEG | Worm distribution to staff endpoints |
| Unbounded object size | DoS on the upload path, blob-storage cost exposure |
| Public-bucket misconfiguration | Uncontrolled PHI disclosure on the internet |
| Reuse of download URL by a former caregiver | Unauthorized retrospective PHI access |
| Audit trail bypass | HIPAA § 164.312(b) non-compliance |

## Required controls

Each control is a MUST. A PR that omits any of them requires a written
waiver from the security lead in the PR description.

### 1. Server-side EXIF and GPS scrubbing

- Strip ALL metadata before persisting the object. Library: `sharp`
  (`.rotate().withMetadata(false)`) for raster; `svgo` with a hardened
  plugin set for SVG (or reject SVG outright for patient uploads).
- Strip on both upload and re-upload / re-encoded paths.
- Do NOT trust a client "I already stripped it" flag — browsers re-inject
  metadata on resize via `<canvas>` operations in some implementations.
- Verify the scrubbed bytes with `exifr` or equivalent before accepting
  the object. Reject if any of the keys in
  `{gps*, camera*, author, copyright, software, make, model}` remain.

### 2. MIME / content-type validation

- Decode the first 4 KB with a format sniffer (`file-type` package) and
  reject if the detected MIME does not match the allow list:
  `image/jpeg, image/png, image/webp, image/heic, application/pdf`.
  (Add HEIC only if mobile clients will upload; the sniffer supports it.)
- Never trust the `Content-Type` header or the filename extension. Both
  are attacker-controlled.
- Re-encode raster images with `sharp` to a canonical JPEG/PNG before
  persisting. This both strips metadata (defense in depth with §1) and
  neutralizes polyglot files.

### 3. Antivirus scanning

- Scan every accepted object with ClamAV or an equivalent managed
  service before making it accessible. Quarantine on positive; return
  422 with a generic "upload rejected" message (do NOT echo the
  signature name).
- Scanning happens server-side and blocks the upload from entering the
  signed-URL flow. Asynchronous post-hoc scanning is insufficient —
  clinicians can see the image before the scan completes.

### 4. Size limits

- Request-body cap: 10 MB per file, 25 MB per multipart request. Enforce
  at the Fastify body parser AND at the reverse proxy (nginx
  `client_max_body_size`).
- Per-patient daily quota: to be defined by product, but at least 50
  images/24h per patient account to blunt storage-exhaustion abuse.

### 5. Encryption at rest

- Object store: AWS S3 with SSE-KMS, GCS with customer-managed keys, or
  equivalent. Server-side encryption alone (SSE-S3) is not sufficient
  because the key is shared across the bucket.
- Use a dedicated KMS key for image PHI, distinct from the KMS key that
  would protect DB PHI under the KMS migration (see
  `docs/phi-key-rotation.md`). Rotating image access should not force a
  DB re-encrypt.
- Bucket policy MUST deny unencrypted PUTs (`s3:x-amz-server-side-encryption`
  condition).

### 6. Signed short-TTL download URLs

- Downloads are served exclusively through signed URLs with a TTL of 5
  minutes (configurable down, not up).
- Generate URLs on a per-request basis with the requesting user's id
  embedded in an attached `x-amz-meta-requester` header or equivalent so
  the audit trail ties the download to a user.
- NEVER return long-lived CDN URLs. Do not cache signed URLs client-side.

### 7. Object-key scheme that resists guessing and cross-patient access

- `{patient_id}/{uuid_v4}.{extension}` minimum. Include `patient_id` so
  the RBAC layer can parse the key at serve-time and assert the
  requester's access without re-reading DB metadata.
- Never use sequential or guessable ids. UUID v4 (random) only.

### 8. Bucket-level public access block

- `s3:BlockPublicAcls`, `s3:BlockPublicPolicy`, `s3:IgnorePublicAcls`,
  `s3:RestrictPublicBuckets` all enabled on the bucket. These are the
  default on new AWS accounts but flip to false if anyone clicks through
  the console; the Terraform / CDK module MUST set them explicitly.
- Deploy with infrastructure-as-code only; no manual bucket creation.

### 9. RBAC gating on download

- The signed-URL issuance endpoint passes through the same
  `assertPatientAccess` / `enforcePatientAccess` logic used elsewhere.
- Care-team revocation must flow through the RBAC cache invalidation
  path (see #277 / PR #485) so a revoked clinician cannot receive a
  freshly signed URL after access is removed.

### 10. Audit logging

- Every upload, download-URL issuance, and delete emits an
  `audit_log` row with `resource_type = "image"`, `resource_id =
  <object_key>`, and for uploads a `details` payload containing the
  detected MIME, size, and whether EXIF scrubbing removed any tags.
- The audit insertion is NOT optional and is not best-effort for
  this resource — uploads succeed only if the audit row commits.

### 11. Retention and deletion

- Images are subject to the same 7-year retention policy as other PHI
  (see `docs/hipaa-retention.md`).
- Deletion is logical first (tombstone in DB) with a 30-day purge delay
  so an accidental delete is recoverable. Hard-delete is irreversible;
  log the actor.

### 12. Minimum-necessary access by role

- Patients: upload images for themselves only. Cannot upload on behalf
  of another user even if they are a family caregiver unless the
  caregiver has the `upload_images` scope on an active relationship
  (see Phase B3 scopes).
- Clinicians: upload images only for patients where they have an
  active care-team assignment or an active emergency-access grant.
- Admins: view-only; cannot upload on behalf of others.

## Rollout checklist

Before the first image-upload PR merges:

- [ ] This document linked from `CLAUDE.md`
- [ ] Bucket + KMS key provisioned via IaC (Terraform/CDK)
- [ ] AV scanner running in the AWS / GCP account with alerting
- [ ] ClamAV definitions auto-updating
- [ ] Synthetic upload test in the smoke suite exercises every control
- [ ] Threat model section of this document reviewed and confirmed
      covers the uploads the PR introduces (wound vs. ID vs. chart scan
      all carry different residual risk)

## Explicitly not addressed

- **Client-side EXIF stripping.** Not a substitute for §1. It is useful
  only to reduce upload size; the server MUST still scrub.
- **Watermarking** for provenance. Out of scope; revisit if an
  authenticity dispute arises.
- **DICOM imaging.** Medical imaging (CT/MRI/X-ray) goes through the
  FHIR / PACS path, not this upload path. Do not conflate.

## Maintenance

This document is a living security contract. Update it when:

- A new image-hosting scenario ships (e.g. telehealth video frames,
  patient-to-patient communities, etc.)
- A relevant CVE lands against `sharp` / `svgo` / ClamAV
- The KMS or cloud provider changes

Reviewers should compare any image-upload PR to this document section by
section. If a control is deviated from, the PR description must say why
and the security lead must sign off in-thread.
