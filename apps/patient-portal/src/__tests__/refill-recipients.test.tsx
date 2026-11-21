import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import RefillPage from "../../app/refill/page";

const patient = { id: "patient-record-1" };
const specialist = { provider_id: "specialist-1", role: "specialist", specialty: "Neurology" };
const primary = { provider_id: "primary-1", role: "primary", specialty: "General" };
const activeMedication = { id: "medication-1", name: "Example medication", status: "active" };
const patientUser = { role: "patient" };
const authState = {
  user: patientUser as { role: string } | null,
  hydrated: true,
  verifying: false,
  isAuthenticated: true,
};
let medication: typeof activeMedication & { ordering_provider_id?: string; prescribed_by?: string };
let recipients: Array<typeof specialist | typeof primary>;

const push = vi.fn();
const replace = vi.fn();
const listRecipients = vi.fn((_input: undefined, { enabled }: { enabled: boolean }) => ({
  data: enabled ? recipients : undefined,
}));
const createConversation = vi.fn(async (_input: unknown) => ({ id: "conversation-1" }));
const sendMessage = vi.fn(async (_input: unknown) => undefined);

vi.mock("next/navigation", () => ({ useRouter: () => ({ push, replace }) }));
vi.mock("@carebridge/portal-shared/auth", () => ({ useAuth: () => authState }));
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
    Object.assign(authState, {
      user: patientUser,
      hydrated: true,
      verifying: false,
      isAuthenticated: true,
    });
    medication = { ...activeMedication };
    recipients = [specialist, primary];
  });

  afterEach(cleanup);

  it("waits for the verified patient session on direct navigation", () => {
    Object.assign(authState, { user: null, hydrated: false, isAuthenticated: false });
    const { rerender } = render(<RefillPage />);

    expect(screen.getByText("Loading...")).toBeInTheDocument();
    expect(listRecipients).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();

    Object.assign(authState, { hydrated: true, verifying: true });
    rerender(<RefillPage />);

    expect(listRecipients).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();

    Object.assign(authState, { user: patientUser, verifying: false, isAuthenticated: true });
    rerender(<RefillPage />);

    expect(listRecipients).toHaveBeenLastCalledWith(undefined, { enabled: true });
    expect(screen.getByRole("button", { name: "Message Provider" })).toBeEnabled();
  });

  it("redirects to login after verification finds no session", () => {
    Object.assign(authState, { user: null, isAuthenticated: false });
    render(<RefillPage />);

    expect(replace).toHaveBeenCalledExactlyOnceWith("/login");
    expect(listRecipients).not.toHaveBeenCalled();
  });

  it.each([
    {
      state: "the ordering provider is eligible",
      orderingProviderId: specialist.provider_id,
      prescribedBy: "Prescribing provider",
      expected: specialist,
    },
    {
      state: "the ordering provider is unavailable",
      orderingProviderId: "previous-provider",
      prescribedBy: specialist.provider_id,
      expected: primary,
    },
    {
      state: "an older medication has only a prescriber ID",
      orderingProviderId: undefined,
      prescribedBy: specialist.provider_id,
      expected: specialist,
    },
  ])("routes the refill message when $state", async ({ orderingProviderId, prescribedBy, expected }) => {
    medication.ordering_provider_id = orderingProviderId;
    medication.prescribed_by = prescribedBy;
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
    authState.user = { role: "family_caregiver" };
    render(<RefillPage />);

    expect(listRecipients).toHaveBeenLastCalledWith(undefined, { enabled: false });
    expect(screen.getByRole("button", { name: "Message Provider" })).toBeDisabled();
    expect(createConversation).not.toHaveBeenCalled();
  });
});
