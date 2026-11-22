import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { FetchStatus, QueryStatus } from "@tanstack/react-query";
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
const patientRecordState = { patient: patient as typeof patient | null, isUnlinked: false };
let medication: typeof activeMedication & { ordering_provider_id?: string; prescribed_by?: string };
const recipientLookup: {
  data: Array<typeof specialist> | undefined;
  status: QueryStatus;
  fetchStatus: FetchStatus;
} = { data: [specialist, primary], status: "success", fetchStatus: "idle" };

const push = vi.fn();
const replace = vi.fn();
const refetchRecipients = vi.fn();
const listRecipients = vi.fn((_input: undefined, _options: { enabled: boolean }) => ({
  ...recipientLookup,
  refetch: refetchRecipients,
}));
const createConversation = vi.fn(async (_input: unknown) => ({ id: "conversation-1" }));
const sendMessage = vi.fn(async (_input: unknown) => undefined);

vi.mock("next/navigation", () => ({ useRouter: () => ({ push, replace }) }));
vi.mock("@carebridge/portal-shared/auth", () => ({ useAuth: () => authState }));
vi.mock("@/lib/use-my-patient", () => ({ useMyPatientRecord: () => patientRecordState }));
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
    Object.assign(patientRecordState, { patient, isUnlinked: false });
    medication = { ...activeMedication };
    Object.assign(recipientLookup, { data: [specialist, primary], status: "success", fetchStatus: "idle" });
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

  it("distinguishes recipient states and only sends after the lookup recovers", async () => {
    const { rerender } = render(<RefillPage />);
    const send = screen.getByRole("button", { name: "Message Provider" });
    expect(send).toBeEnabled();

    recipientLookup.fetchStatus = "fetching";
    rerender(<RefillPage />);
    expect(screen.getByRole("status")).toHaveTextContent(/loading your care team/i);
    expect(screen.queryByText(/no care team members/i)).not.toBeInTheDocument();
    expect(send).toBeDisabled();

    Object.assign(recipientLookup, { status: "error", fetchStatus: "idle" });
    rerender(<RefillPage />);
    expect(screen.getByRole("alert")).toHaveTextContent(/couldn.t load your care team/i);
    expect(screen.queryByText(/no care team members/i)).not.toBeInTheDocument();
    expect(send).toBeDisabled();
    fireEvent.click(send);
    expect(createConversation).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(refetchRecipients).toHaveBeenCalledExactlyOnceWith();

    Object.assign(recipientLookup, { data: [], status: "success" });
    rerender(<RefillPage />);
    expect(screen.getByRole("status")).toHaveTextContent(/no care team members.*contact your care team/i);
    expect(screen.queryByRole("button", { name: /try again/i })).not.toBeInTheDocument();
    expect(send).toBeDisabled();

    recipientLookup.data = [specialist];
    rerender(<RefillPage />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(send).toBeEnabled();
    fireEvent.click(send);
    expect(createConversation).toHaveBeenCalledExactlyOnceWith({
      patientId: patient.id,
      subject: `Refill Request: ${medication.name}`,
      participantIds: [specialist.provider_id],
    });
    await waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());
  });

  it.each([
    { state: "caregivers", user: { role: "family_caregiver" }, isUnlinked: false },
    { state: "unlinked patients", user: patientUser, isUnlinked: true },
  ])("keeps the recipient lookup and refill sending disabled for $state", ({ user, isUnlinked }) => {
    authState.user = user;
    Object.assign(patientRecordState, { patient: isUnlinked ? null : patient, isUnlinked });
    render(<RefillPage />);

    expect(listRecipients).toHaveBeenLastCalledWith(undefined, { enabled: false });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    const send = screen.getByRole("button", { name: "Message Provider" });
    expect(send).toBeDisabled();
    fireEvent.click(send);
    expect(createConversation).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
