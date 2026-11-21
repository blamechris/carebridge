import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PatientMessagesPage from "../../app/messages/page";

const patient = { id: "patient-record-1" };
const conversation = {
  id: "conversation-1",
  subject: "Follow-up visit",
  updated_at: "2026-11-01T09:00:00Z",
};
const message = {
  id: "message-1",
  sender_id: "provider-1",
  body: "Your follow-up visit has been scheduled.",
  created_at: "2026-11-01T09:00:00Z",
};
const caregiverUser = { id: "caregiver-1", role: "family_caregiver" };
const patientUser = { id: "patient-1", role: "patient" };
const authState = {
  user: caregiverUser as typeof caregiverUser | null,
  hydrated: true,
  verifying: false,
  isAuthenticated: true,
};
const patientRecordState = {
  patient: patient as typeof patient | null,
  isLoading: false,
  isUnlinked: false,
};
let conversations = [conversation];

const push = vi.fn();
const replace = vi.fn();
const listConversations = vi.fn(() => ({ data: conversations, isLoading: false }));
const listMessages = vi.fn((input: { conversationId: string }, options: { enabled: boolean }) => ({
  data: options.enabled && input.conversationId === conversation.id ? [message] : [],
  isLoading: false,
}));
const createConversation = vi.fn();
const sendMessage = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace }),
}));

vi.mock("@carebridge/portal-shared/auth", () => ({
  useAuth: () => authState,
}));

vi.mock("@/lib/use-my-patient", () => ({
  useMyPatientRecord: () => patientRecordState,
}));

vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({
      messaging: {
        listConversations: { invalidate: vi.fn() },
        listMessages: { invalidate: vi.fn() },
      },
    }),
    messaging: {
      listConversations: { useQuery: () => listConversations() },
      listMessages: {
        useQuery: (...args: Parameters<typeof listMessages>) => listMessages(...args),
      },
      createConversation: {
        useMutation: ({ onSuccess }: { onSuccess: (result: { id: string }) => void }) => ({
          mutate: (input: unknown) => {
            createConversation(input);
            onSuccess({ id: "new-conversation" });
          },
          isPending: false,
        }),
      },
      sendMessage: {
        useMutation: () => ({ mutate: sendMessage, isPending: false }),
      },
    },
    patients: {
      careTeam: {
        getByPatient: {
          useQuery: () => ({
            data: [{ provider_id: "provider-1", role: "Physician", specialty: "General" }],
          }),
        },
      },
    },
  },
}));

describe("PatientMessagesPage", () => {
  beforeEach(() => {
    Object.assign(authState, {
      user: caregiverUser,
      hydrated: true,
      verifying: false,
      isAuthenticated: true,
    });
    Object.assign(patientRecordState, { patient, isLoading: false });
    conversations = [conversation];
    vi.clearAllMocks();
  });

  afterEach(cleanup);

  it("waits for the verified caregiver session before reading messages on direct navigation", () => {
    Object.assign(authState, { user: null, hydrated: false, isAuthenticated: false });
    const { rerender } = render(<PatientMessagesPage />);

    expect(screen.getByText("Loading...")).toBeInTheDocument();
    expect(listConversations).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();

    Object.assign(authState, { hydrated: true, verifying: true });
    rerender(<PatientMessagesPage />);

    expect(listConversations).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();

    Object.assign(authState, { user: caregiverUser, verifying: false, isAuthenticated: true });
    rerender(<PatientMessagesPage />);

    expect(screen.getByRole("button", { name: /follow-up visit/i })).toBeInTheDocument();
    expect(screen.getByRole("note")).toHaveTextContent(/read-only for family caregivers/i);
  });

  it("lets caregivers read permitted threads without compose or reply controls", () => {
    render(<PatientMessagesPage />);

    expect(screen.queryByRole("button", { name: /new message/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /follow-up visit/i }));

    expect(listMessages).toHaveBeenLastCalledWith(
      { conversationId: conversation.id, limit: 50 },
      { enabled: true },
    );
    expect(screen.getByText(message.body)).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: /reply/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^send/i })).not.toBeInTheDocument();
    expect(createConversation).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it.each([
    { state: "linked", patient, isLoading: false },
    { state: "loading", patient: null, isLoading: true },
    { state: "unlinked", patient: null, isLoading: false },
  ])("shows a read-only empty state for a $state caregiver record", ({ patient, isLoading }) => {
    Object.assign(patientRecordState, { patient, isLoading });
    conversations = [];
    render(<PatientMessagesPage />);

    expect(screen.getByRole("note")).toHaveTextContent(/read-only for family caregivers/i);
    expect(screen.getByText("No messages yet.")).toBeInTheDocument();
    expect(screen.queryByText(/use "new message"/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /new message/i })).not.toBeInTheDocument();
  });

  it("lets patients compose a conversation and send the initial message", () => {
    authState.user = patientUser;
    conversations = [];
    render(<PatientMessagesPage />);

    expect(screen.queryByRole("note")).not.toBeInTheDocument();
    expect(screen.getByText(/use "new message"/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /new message/i }));
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "provider-1" } });
    fireEvent.change(screen.getByLabelText("Subject"), { target: { value: " Visit question " } });
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: " What should I bring? " } });
    fireEvent.click(screen.getByRole("button", { name: /send message/i }));

    expect(createConversation).toHaveBeenCalledExactlyOnceWith({
      patientId: patient.id,
      subject: "Visit question",
      participantIds: ["provider-1"],
    });
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith({
      conversationId: "new-conversation",
      body: "What should I bring?",
    });
  });

  it("lets patients reply to an existing conversation", () => {
    authState.user = patientUser;
    render(<PatientMessagesPage />);

    fireEvent.click(screen.getByRole("button", { name: /follow-up visit/i }));
    fireEvent.change(screen.getByRole("textbox", { name: /reply/i }), {
      target: { value: " Thank you. " },
    });
    fireEvent.click(screen.getByRole("button", { name: /^send$/i }));

    expect(sendMessage).toHaveBeenCalledExactlyOnceWith({
      conversationId: conversation.id,
      body: "Thank you.",
    });
  });
});
