import { trpc } from "@/lib/trpc";

export type CareTeamRecipientStatus = "disabled" | "loading" | "error" | "empty" | "ready";

export function useCareTeamRecipients(enabled: boolean) {
  const query = trpc.messaging.listRecipients.useQuery(undefined, { enabled });
  const recipients = query.data ?? [];

  let status: CareTeamRecipientStatus;
  if (!enabled) {
    status = "disabled";
  } else if (query.status === "pending" || query.fetchStatus !== "idle") {
    status = "loading";
  } else if (query.status === "error") {
    status = "error";
  } else {
    status = recipients.length ? "ready" : "empty";
  }

  return {
    status,
    // TanStack Query may retain data during a refresh or after a failed lookup.
    recipients: status === "ready" ? recipients : [],
    refetch: query.refetch,
  };
}
