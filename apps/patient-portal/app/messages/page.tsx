"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth";
import { trpc } from "@/lib/trpc";
import { useMyPatientRecord } from "@/lib/use-my-patient";

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const diff = Date.now() - then;
  const min = Math.floor(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

export default function PatientMessagesPage() {
  const { user } = useAuth();
  const router = useRouter();
  const utils = trpc.useUtils();

  const { patient: myRecord, isLoading: patientLoading } = useMyPatientRecord();

  const conversationsQuery = trpc.messaging.listConversations.useQuery(
    undefined,
    { enabled: !!user },
  );

  const careTeamQuery = trpc.patients.careTeam.getByPatient.useQuery(
    { patientId: myRecord?.id ?? "" },
    { enabled: !!myRecord },
  );

  const [selectedConvoId, setSelectedConvoId] = useState<string | null>(null);
  const [replyText, setReplyText] = useState("");
  const [showCompose, setShowCompose] = useState(false);
  const [composeSubject, setComposeSubject] = useState("");
  const [composeBody, setComposeBody] = useState("");
  const [composeRecipient, setComposeRecipient] = useState("");

  const messagesQuery = trpc.messaging.listMessages.useQuery(
    { conversationId: selectedConvoId ?? "", limit: 50 },
    { enabled: !!selectedConvoId && !!user },
  );

  const sendMutation = trpc.messaging.sendMessage.useMutation({
    onSuccess: () => {
      setReplyText("");
      utils.messaging.listMessages.invalidate();
      utils.messaging.listConversations.invalidate();
    },
  });

  const createConvoMutation = trpc.messaging.createConversation.useMutation({
    onSuccess: (data) => {
      setShowCompose(false);
      setComposeSubject("");
      setComposeBody("");
      setComposeRecipient("");
      setSelectedConvoId(data.id);
      // Send the initial message
      if (user && composeBody.trim()) {
        sendMutation.mutate({
          conversationId: data.id,

          body: composeBody.trim(),
        });
      }
      utils.messaging.listConversations.invalidate();
    },
  });

  if (!user) {
    router.push("/login");
    return null;
  }

  const conversations = conversationsQuery.data ?? [];
  const messages = messagesQuery.data ?? [];
  const careTeam = careTeamQuery.data ?? [];

  function handleSend() {
    if (!selectedConvoId || !user || !replyText.trim()) return;
    sendMutation.mutate({
      conversationId: selectedConvoId,
      body: replyText.trim(),
    });
  }

  function handleCompose() {
    if (!user || !myRecord || !composeSubject.trim() || !composeRecipient) return;
    createConvoMutation.mutate({
      patientId: myRecord.id,
      subject: composeSubject.trim(),
      participantIds: [composeRecipient],
    });
  }

  const inputStyle = {
    width: "100%",
    padding: "8px 12px",
    backgroundColor: "#222",
    border: "1px solid #444",
    borderRadius: 6,
    color: "#ededed",
    fontSize: "0.85rem",
  };

  return (
    <div style={{ maxWidth: 800, margin: "0 auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1.5rem" }}>
        <h2 style={{ margin: 0 }}>Messages</h2>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            onClick={() => setShowCompose(!showCompose)}
            style={{
              padding: "6px 14px",
              backgroundColor: "#2563eb",
              border: "none",
              borderRadius: 6,
              color: "#fff",
              cursor: "pointer",
              fontSize: "0.8rem",
            }}
          >
            {showCompose ? "Cancel" : "New Message"}
          </button>
          <button
            onClick={() => router.push("/")}
            style={{ background: "none", border: "1px solid #444", color: "#999", padding: "6px 14px", borderRadius: 6, cursor: "pointer", fontSize: "0.8rem" }}
          >
            Dashboard
          </button>
        </div>
      </div>

      {/* Compose new message */}
      {showCompose && (
        <div style={{ backgroundColor: "#1a1a1a", border: "1px solid #2a2a2a", borderRadius: 8, padding: "1.25rem", marginBottom: "1.5rem" }}>
          <h3 style={{ margin: "0 0 1rem", fontSize: "0.95rem" }}>New Message to Care Team</h3>

          <div style={{ marginBottom: "0.75rem" }}>
            <label style={{ display: "block", marginBottom: 4, fontSize: "0.8rem", color: "#999" }}>To</label>
            <select
              value={composeRecipient}
              onChange={(e) => setComposeRecipient(e.target.value)}
              style={{ ...inputStyle, cursor: "pointer" }}
            >
              <option value="">Select care team member...</option>
              {careTeam.map((member) => (
                <option key={member.provider_id} value={member.provider_id}>
                  {member.role} — {member.specialty ?? "General"}
                </option>
              ))}
            </select>
          </div>

          <div style={{ marginBottom: "0.75rem" }}>
            <label style={{ display: "block", marginBottom: 4, fontSize: "0.8rem", color: "#999" }}>Subject</label>
            <input
              type="text"
              value={composeSubject}
              onChange={(e) => setComposeSubject(e.target.value)}
              placeholder="What is this about?"
              style={inputStyle}
            />
          </div>

          <div style={{ marginBottom: "0.75rem" }}>
            <label style={{ display: "block", marginBottom: 4, fontSize: "0.8rem", color: "#999" }}>Message</label>
            <textarea
              value={composeBody}
              onChange={(e) => setComposeBody(e.target.value)}
              placeholder="Type your message..."
              rows={4}
              style={{ ...inputStyle, resize: "vertical" }}
            />
          </div>

          <button
            onClick={handleCompose}
            disabled={!composeSubject.trim() || !composeRecipient || !composeBody.trim() || createConvoMutation.isPending}
            style={{
              padding: "8px 16px",
              backgroundColor: composeSubject.trim() && composeRecipient ? "#2563eb" : "#333",
              border: "none",
              borderRadius: 6,
              color: composeSubject.trim() && composeRecipient ? "#fff" : "#666",
              cursor: composeSubject.trim() && composeRecipient ? "pointer" : "not-allowed",
              fontSize: "0.85rem",
            }}
          >
            {createConvoMutation.isPending ? "Sending..." : "Send Message"}
          </button>
        </div>
      )}

      {/* Conversation list */}
      {conversationsQuery.isLoading && <p style={{ color: "#999" }}>Loading conversations...</p>}

      {conversations.length === 0 && !conversationsQuery.isLoading && !showCompose && (
        <p style={{ color: "#999", fontSize: "0.85rem" }}>
          No messages yet. Use &quot;New Message&quot; to contact your care team.
        </p>
      )}

      {conversations.map((convo) => (
        <div key={convo.id}>
          <button
            onClick={() => setSelectedConvoId(selectedConvoId === convo.id ? null : convo.id)}
            style={{
              display: "block",
              width: "100%",
              padding: "12px 16px",
              backgroundColor: selectedConvoId === convo.id ? "#1e3a5f" : "#1a1a1a",
              border: "1px solid #2a2a2a",
              borderRadius: selectedConvoId === convo.id ? "8px 8px 0 0" : 8,
              color: "#ededed",
              textAlign: "left",
              cursor: "pointer",
              marginBottom: selectedConvoId === convo.id ? 0 : 8,
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span style={{ fontWeight: 600, fontSize: "0.85rem" }}>{convo.subject}</span>
              <span style={{ fontSize: "0.75rem", color: "#666" }}>{formatRelative(convo.updated_at)}</span>
            </div>
          </button>

          {/* Expanded thread */}
          {selectedConvoId === convo.id && (
            <div style={{
              backgroundColor: "#111",
              border: "1px solid #2a2a2a",
              borderTop: "none",
              borderRadius: "0 0 8px 8px",
              padding: 12,
              marginBottom: 8,
            }}>
              {messagesQuery.isLoading && <p style={{ color: "#999", fontSize: "0.85rem" }}>Loading...</p>}

              <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 12, maxHeight: 300, overflowY: "auto" }}>
                {[...messages].reverse().map((msg) => {
                  const isMe = msg.sender_id === user?.id;
                  return (
                    <div
                      key={msg.id}
                      style={{
                        alignSelf: isMe ? "flex-end" : "flex-start",
                        maxWidth: "80%",
                        padding: "8px 12px",
                        borderRadius: 10,
                        backgroundColor: isMe ? "#2563eb" : "#222",
                        fontSize: "0.85rem",
                      }}
                    >
                      {msg.body}
                      <div style={{ fontSize: "0.7rem", color: isMe ? "rgba(255,255,255,0.5)" : "#666", marginTop: 2, textAlign: "right" }}>
                        {formatRelative(msg.created_at)}
                      </div>
                    </div>
                  );
                })}
              </div>

              <div style={{ display: "flex", gap: 8 }}>
                <input
                  type="text"
                  value={replyText}
                  onChange={(e) => setReplyText(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleSend()}
                  placeholder="Reply..."
                  style={{ ...inputStyle, flex: 1 }}
                />
                <button
                  onClick={handleSend}
                  disabled={!replyText.trim() || sendMutation.isPending}
                  style={{
                    padding: "8px 16px",
                    backgroundColor: replyText.trim() ? "#2563eb" : "#333",
                    border: "none",
                    borderRadius: 6,
                    color: replyText.trim() ? "#fff" : "#666",
                    cursor: replyText.trim() ? "pointer" : "not-allowed",
                    fontSize: "0.85rem",
                  }}
                >
                  Send
                </button>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
