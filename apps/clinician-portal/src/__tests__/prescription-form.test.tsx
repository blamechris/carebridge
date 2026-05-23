/**
 * @vitest-environment jsdom
 *
 * Issue #1068 — prescription create/edit form.
 *
 * Covers:
 *   - basic render of all required field labels (name, dose, unit, route,
 *     frequency, status, started_at, prescribed_by, chronic, max_doses_per_day)
 *   - chronic-checkbox tooltip text (matches #1060 spec — PCP duration-gate bypass)
 *   - Zod-driven inline validation for an empty `name`
 *   - `aria-live` error region for non-validation failures
 *   - ALLERGY_CONFLICT surfacing with confirmation override flow
 *   - successful submit invokes the `create` mutation with the expected payload
 *   - edit mode pre-fills fields and submits `update` with `expectedUpdatedAt`
 */
import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  render,
  cleanup,
  screen,
  fireEvent,
  waitFor,
} from "@testing-library/react";

import { PrescriptionForm } from "../../app/patients/[id]/PrescriptionForm";

afterEach(() => {
  cleanup();
});

const PATIENT_ID = "11111111-1111-4111-8111-111111111111";

describe("PrescriptionForm (create mode)", () => {
  it("renders all required field labels and chronic tooltip", () => {
    render(
      <PrescriptionForm
        patientId={PATIENT_ID}
        mode="create"
        onClose={() => {}}
      />,
    );

    expect(screen.getByLabelText(/Medication name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Dose amount/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Dose unit/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Route/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Frequency/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Max doses per day/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Start date/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Status/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Prescribed by/i)).toBeInTheDocument();

    const chronic = screen.getByLabelText(/Chronic/i) as HTMLInputElement;
    expect(chronic).toBeInTheDocument();
    expect(chronic.type).toBe("checkbox");
    // Tooltip must carry the exact #1060 spec language.
    expect(chronic.title).toMatch(/28-day duration gate/i);
    expect(chronic.title).toMatch(/PCP-prophylaxis/i);
    expect(chronic.title).toMatch(/transplant/i);
  });

  it("shows an inline validation error when name is empty on submit", async () => {
    const createMutate = vi.fn();
    render(
      <PrescriptionForm
        patientId={PATIENT_ID}
        mode="create"
        onClose={() => {}}
        createMutate={createMutate}
      />,
    );

    const submit = screen.getByRole("button", { name: /save medication/i });
    fireEvent.click(submit);

    const error = await waitFor(() => screen.getByText(/medication name is required/i));
    expect(error).toBeInTheDocument();
    expect(createMutate).not.toHaveBeenCalled();
  });

  it("calls create mutation with form payload on valid submit", async () => {
    const createMutate = vi.fn().mockResolvedValue({ id: "new-id" });
    const onClose = vi.fn();
    render(
      <PrescriptionForm
        patientId={PATIENT_ID}
        mode="create"
        onClose={onClose}
        createMutate={createMutate}
      />,
    );

    fireEvent.change(screen.getByLabelText(/Medication name/i), {
      target: { value: "Prednisone" },
    });
    fireEvent.change(screen.getByLabelText(/Dose amount/i), {
      target: { value: "10" },
    });
    fireEvent.change(screen.getByLabelText(/Dose unit/i), {
      target: { value: "mg" },
    });
    fireEvent.change(screen.getByLabelText(/Route/i), {
      target: { value: "oral" },
    });
    fireEvent.change(screen.getByLabelText(/Frequency/i), {
      target: { value: "daily" },
    });
    fireEvent.click(screen.getByLabelText(/Chronic/i));

    fireEvent.click(screen.getByRole("button", { name: /save medication/i }));

    await waitFor(() => expect(createMutate).toHaveBeenCalledTimes(1));
    const payload = createMutate.mock.calls[0][0];
    expect(payload).toMatchObject({
      patient_id: PATIENT_ID,
      name: "Prednisone",
      dose_amount: 10,
      dose_unit: "mg",
      route: "oral",
      frequency: "daily",
      chronic: true,
    });
  });

  it("surfaces ALLERGY_CONFLICT with confirmation override flow", async () => {
    const conflictErr = Object.assign(new Error('Medication "Penicillin" conflicts with patient allergies: allergy to "Penicillin"'), {
      data: { code: "CONFLICT" },
    });
    const createMutate = vi
      .fn()
      .mockRejectedValueOnce(conflictErr)
      .mockResolvedValueOnce({ id: "ok" });

    render(
      <PrescriptionForm
        patientId={PATIENT_ID}
        mode="create"
        onClose={() => {}}
        createMutate={createMutate}
      />,
    );

    fireEvent.change(screen.getByLabelText(/Medication name/i), {
      target: { value: "Penicillin" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save medication/i }));

    // First click — conflict surfaces inside an alert region.
    const alert = await waitFor(() => screen.getByRole("alert"));
    expect(alert.textContent).toMatch(/conflicts with patient allergies/i);

    // The override-confirmation button must appear so the prescriber can
    // acknowledge and re-submit.
    const overrideBtn = await waitFor(() =>
      screen.getByRole("button", { name: /override and prescribe anyway/i }),
    );
    expect(overrideBtn).toBeInTheDocument();
    fireEvent.click(overrideBtn);

    // Second mutation invocation = successful override.
    await waitFor(() => expect(createMutate).toHaveBeenCalledTimes(2));
  });

  it("surfaces non-validation errors via aria-live alert region", async () => {
    const createMutate = vi.fn().mockRejectedValue(new Error("Database unreachable"));
    render(
      <PrescriptionForm
        patientId={PATIENT_ID}
        mode="create"
        onClose={() => {}}
        createMutate={createMutate}
      />,
    );

    fireEvent.change(screen.getByLabelText(/Medication name/i), {
      target: { value: "Aspirin" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save medication/i }));

    const alert = await waitFor(() => screen.getByRole("alert"));
    expect(alert.getAttribute("aria-live")).toBe("assertive");
    expect(alert.textContent).toMatch(/database unreachable/i);
  });
});

describe("PrescriptionForm (edit mode)", () => {
  const existing = {
    id: "med-1",
    patient_id: PATIENT_ID,
    name: "Lisinopril",
    dose_amount: 20,
    dose_unit: "mg",
    route: "oral" as const,
    frequency: "daily",
    status: "active" as const,
    started_at: "2025-01-01T00:00:00.000Z",
    prescribed_by: "Dr. Smith",
    chronic: true,
    max_doses_per_day: undefined,
    created_at: "2025-01-01T00:00:00.000Z",
    updated_at: "2025-01-15T00:00:00.000Z",
  };

  it("pre-fills fields from the existing medication", () => {
    render(
      <PrescriptionForm
        patientId={PATIENT_ID}
        mode="edit"
        existing={existing}
        onClose={() => {}}
      />,
    );

    const nameInput = screen.getByLabelText(/Medication name/i) as HTMLInputElement;
    expect(nameInput.value).toBe("Lisinopril");

    const doseInput = screen.getByLabelText(/Dose amount/i) as HTMLInputElement;
    expect(doseInput.value).toBe("20");

    const chronic = screen.getByLabelText(/Chronic/i) as HTMLInputElement;
    expect(chronic.checked).toBe(true);
  });

  it("submits update with expectedUpdatedAt from the loaded record", async () => {
    const updateMutate = vi.fn().mockResolvedValue({ id: existing.id });
    render(
      <PrescriptionForm
        patientId={PATIENT_ID}
        mode="edit"
        existing={existing}
        onClose={() => {}}
        updateMutate={updateMutate}
      />,
    );

    fireEvent.change(screen.getByLabelText(/Medication name/i), {
      target: { value: "Lisinopril HCT" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save medication/i }));

    await waitFor(() => expect(updateMutate).toHaveBeenCalledTimes(1));
    const payload = updateMutate.mock.calls[0][0];
    expect(payload.id).toBe(existing.id);
    expect(payload.name).toBe("Lisinopril HCT");
    expect(payload.expectedUpdatedAt).toBe(existing.updated_at);
  });
});
