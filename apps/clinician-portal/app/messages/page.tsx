"use client";

import { useState } from "react";
import { AuthGuard } from "@/lib/auth-guard";
import { useAuth } from "@/lib/auth";
import { trpc } from "@/lib/trpc";

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

function MessagesContent() {
  const { user } = useAuth();
  const utils = trpc.useUtils();

  const conversationsQuery = trpc.messaging.listConversations.useQuery(
    { userId: user?.id ?? "" },
    { enabled: !!user },
  );

  const [selectedConvoId, setSelectedConvoId] = useState<string | null>(null);
  const [replyText, setReplyText] = useState("");

  const messagesQuery = trpc.messaging.listMessages.useQuery(
    { conversationId: selectedConvoId ?? "", userId: user?.id ?? "", limit: 50 },
    { enabled: !!selectedConvoId && !!user },
  );

  const sendMutation = trpc.messaging.sendMessage.useMutation({
    onSuccess: () => {
      setReplyText("");
      utils.messaging.listMessages.invalidate();
      utils.messaging.listConversations.invalidate();
    },
  });

  const conversations = conversationsQuery.data ?? [];
  const messages = messagesQuery.data ?? [];

  function handleSend() {
    if (!selectedConvoId || !user || !replyText.trim()) return;
    sendMutation.mutate({
      conversationId: selectedConvoId,
      senderId: user.id,
      body: replyText.trim(),
    });
  }

  return (
    <div style={{ display: "flex", height: "calc(100vh - 120px)", gap: 0 }}>
      {/* Conversation list */}
      <div style={{
        width: 320,
        borderRight: "1px solid var(--border)",
        overflowY: "auto",
        flexShrink: 0,
      }}>
        <div style={{ padding: "16px", borderBottom: "1px solid var(--border)" }}>
          <h2 style={{ margin: 0, fontSize: "1.1rem" }}>Messages</h2>
          <p style={{ margin: "4px 0 0", color: "var(--text-muted)", fontSize: "0.8rem" }}>
            {conversations.length} conversation{conversations.length !== 1 ? "s" : ""}
          </p>
        </div>

        {conversationsQuery.isLoading && (
          <div style={{ padding: 16, color: "var(--text-muted)" }}>Loading...</div>
        )}

        {conversations.length === 0 && !conversationsQuery.isLoading && (
          <div style={{ padding: 16, color: "var(--text-muted)", fontSize: "0.85rem" }}>
            No conversations yet.
          </div>
        )}

        {conversations.map((convo) => (
          <button
            key={convo.id}
            onClick={() => setSelectedConvoId(convo.id)}
            style={{
              display: "block",
              width: "100%",
              padding: "12px 16px",
              background: selectedConvoId === convo.id ? "var(--bg-active)" : "none",
              border: "none",
              borderBottom: "1px solid var(--border)",
              color: "var(--text)",
              textAlign: "left",
              cursor: "pointer",
            }}
          >
            <div style={{ fontWeight: 600, fontSize: "0.85rem", marginBottom: 2 }}>
              {convo.subject}
            </div>
            <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
              {formatRelative(convo.updated_at)}
            </div>
          </button>
        ))}
      </div>

      {/* Message thread */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
        {!selectedConvoId ? (
          <div style={{
            flex: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--text-muted)",
          }}>
            Select a conversation to view messages
          </div>
        ) : (
          <>
            {/* Messages */}
            <div style={{
              flex: 1,
              overflowY: "auto",
              padding: 16,
              display: "flex",
              flexDirection: "column-reverse",
              gap: 8,
            }}>
              {messagesQuery.isLoading && (
                <div style={{ color: "var(--text-muted)" }}>Loading messages...</div>
              )}

              {messages.map((msg) => {
                const isMe = msg.sender_id === user?.id;
                return (
                  <div
                    key={msg.id}
                    style={{
                      alignSelf: isMe ? "flex-end" : "flex-start",
                      maxWidth: "70%",
                      padding: "10px 14px",
                      borderRadius: 12,
                      backgroundColor: isMe ? "var(--primary)" : "var(--bg-card)",
                      border: isMe ? "none" : "1px solid var(--border)",
                    }}
                  >
                    <div style={{ fontSize: "0.85rem", lineHeight: 1.4 }}>{msg.body}</div>
                    <div style={{
                      fontSize: "0.7rem",
                      color: isMe ? "rgba(255,255,255,0.6)" : "var(--text-muted)",
                      marginTop: 4,
                      textAlign: "right",
                    }}>
                      {formatRelative(msg.created_at)}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Reply composer */}
            <div style={{
              padding: 12,
              borderTop: "1px solid var(--border)",
              display: "flex",
              gap: 8,
            }}>
              <input
                type="text"
                value={replyText}
                onChange={(e) => setReplyText(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && handleSend()}
                placeholder="Type a message..."
                style={{
                  flex: 1,
                  padding: "8px 12px",
                  backgroundColor: "var(--bg-card)",
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  color: "var(--text)",
                  fontSize: "0.85rem",
                }}
              />
              <button
                onClick={handleSend}
                disabled={!replyText.trim() || sendMutation.isPending}
                className="btn btn-primary btn-sm"
              >
                {sendMutation.isPending ? "..." : "Send"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default function MessagesPage() {
  return (
    <AuthGuard>
      <MessagesContent />
    </AuthGuard>
  );
}
