import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import RefillPage from "../../app/refill/page";

const patient = { id: "patient-record-1" };
const specialist = { provider_id: "specialist-1", role: "specialist", specialty: "Neurology" };
const primary = { provider_id: "primary-1", role: "primary", specialty: "General" };
const activeMedication = { id: "medication-1", name: "Example medication", status: "active" };
let userRole: "patient" | "family_caregiver";
let medication: typeof activeMedication & { ordering_provider_id?: string; prescribed_by?: string };
let recipients: Array<typeof specialist | typeof primary>;

const listRecipients = vi.fn((_input: undefined, { enabled }: { enabled: boolean }) => ({
  data: enabled ? recipients : undefined,
}));
const createConversation = vi.fn(async (_input: unknown) => ({ id: "conversation-1" }));
const sendMessage = vi.fn(async (_input: unknown) => undefined);

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { role: userRole } }) }));
vi.mock("@/lib/use-my-patient", () => ({ useMyPatientRecord: () => ({ patient }) }));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    clinicalData: {
      medications: { getByPatient: { useQuery: () => ({ data: [medication] }) } },
    },
    messaging: {
      listRecipients: { useQuery: (...args: Parameters<typeof listRecipients>) => listRecipients(...args) },
      createConversation: { useMutation: () => ({ mutateAsync: createConversation }) },
      sendMessage: { useMutation: () => ({ mutateAsync: sendMessage }) },
    },
  },
}));

describe("RefillPage recipients", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    userRole = "patient";
    medication = { ...activeMedication, prescribed_by: "Prescribing provider" };
    recipients = [specialist, primary];
  });

  afterEach(cleanup);

  it.each([
    { state: "the ordering provider is eligible", orderingProviderId: specialist.provider_id, expected: specialist },
    { state: "the prescriber is unavailable", orderingProviderId: "previous-provider", expected: primary },
  ])("routes the refill message when $state", async ({ orderingProviderId, expected }) => {
    medication.ordering_provider_id = orderingProviderId;
    render(<RefillPage />);

    fireEvent.click(screen.getByRole("button", { name: "Message Provider" }));

    expect(listRecipients).toHaveBeenLastCalledWith(undefined, { enabled: true });
    expect(createConversation).toHaveBeenCalledExactlyOnceWith({
      patientId: patient.id,
      subject: `Refill Request: ${medication.name}`,
      participantIds: [expected.provider_id],
    });
    await waitFor(() => expect(sendMessage).toHaveBeenCalledExactlyOnceWith({
      conversationId: "conversation-1",
      body: expect.stringContaining(medication.name),
      messageType: "refill_request",
    }));
  });

  it("keeps refill sending disabled for caregivers", () => {
    userRole = "family_caregiver";
    render(<RefillPage />);

    expect(listRecipients).toHaveBeenLastCalledWith(undefined, { enabled: false });
    expect(screen.getByRole("button", { name: "Message Provider" })).toBeDisabled();
    expect(createConversation).not.toHaveBeenCalled();
  });
});
